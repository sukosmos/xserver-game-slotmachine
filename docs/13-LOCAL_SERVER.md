# 13. 로컬 서버 실행과 복구

Node.js 22.13 이상, 검증 환경은 22.23.2다. 외부 패키지 설치 없이 내장 HTTP/SQLite를 사용한다. Node가 SQLite 실험적 기능 경고를 출력할 수 있다. 현재는 API 서버이며 브라우저 게임 화면은 Phase 5에서 추가한다.

## 시작
저장소 루트에서 실행한다.

```sh
npm run account:create -- player-one
npm start
```

첫 명령은 `{userId,token}`을 한 번 출력한다. 이후 요청의 Bearer 토큰으로 사용하며 DB에는 토큰 해시만 남긴다. 같은 계정에 여러 토큰을 발급할 수 있다. 토큰은 로컬 서버용 계정 자격이며 공개 문서나 클라이언트 소스에 넣지 않는다.

기본 주소는 `http://127.0.0.1:3000`이다. `HOST`, `PORT`, `NINE_DATA_DIR`로 바꿀 수 있으며 두 명령은 같은 데이터 디렉터리를 사용해야 한다. 데이터 디렉터리 기본값은 현재 작업 디렉터리의 `.runtime/`다. 외부 서비스 배포에는 별도의 HTTPS와 로그인 연동이 필요하다.

## 요청 예제
아래 `<TOKEN>`과 `<RUN_ID>`는 실제 발급/응답값으로 교체한다. 액션마다 새로운 키를 사용하고 통신 실패 후 재시도에는 원래 키·본문을 그대로 보낸다.

```sh
curl http://127.0.0.1:3000/api/game/v1/runs \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-1' \
  -d '{}'

curl 'http://127.0.0.1:3000/api/game/v1/runs/<RUN_ID>/spins' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: spin-1' \
  -d '{"expectedRevision":0}'

curl 'http://127.0.0.1:3000/api/game/v1/runs/<RUN_ID>' \
  -H 'Authorization: Bearer <TOKEN>'

curl http://127.0.0.1:3000/api/game/v1/leaderboard \
  -H 'Authorization: Bearer <TOKEN>'
```

생성 응답은 `{state}`, 액션은 `{state,event}`다. `state.revision`을 다음 요청에 사용한다. 목표 달성 후 `claim`으로 정산하고 `shop/purchases`에 `{expectedRevision,slotId}`, `shop/rerolls`에 `{expectedRevision}`, `shop/discards`에 `{expectedRevision,instanceId}`, `shop/continue`에 `{expectedRevision}`를 보낸다. 점수·코인·가격·시드는 보내지 않는다. 전체 경로는 [API 계약](07-API_DATA_MODEL.md)에 있다.

## 중단·재개와 계정 폐기
서버를 Ctrl+C로 중단했다 다시 실행해도 같은 토큰으로 `GET /api/game/v1/runs`와 `GET /api/game/v1/runs/:id`에서 이어간다. 조회에는 마지막 액션과 마지막 스핀도 포함된다. 목록은 최신 20개(최대 100개)이며 기존 runId로도 직접 조회할 수 있다. 중복 응답도 저장돼 이미 처리된 스핀/구매를 재전송해도 재실행하지 않는다.

```sh
npm run account:revoke -- player-one
```

이 계정의 모든 토큰을 폐기한다. 런/최고 기록은 남고 같은 계정 ID로 새 토큰을 발급하면 다시 접근할 수 있다. 임의 계정 생성 HTTP API나 게스트 가입 기능은 없다.

## 저장 파일과 한계
- `.runtime/game.sqlite` 및 WAL/SHM 파일: 런·규칙·토큰 해시·랭킹. 전체 감사 기록은 암호화된다.
- `.runtime/master.key`: 암호화 키. DB와 별도로 보관하며 HTTP로 제공하지 않는다.
- 디렉터리 0700, DB/키 0600. 파일은 Git에서 제외한다.
- 백업은 같은 DB를 사용하는 서버/프로세스를 모두 종료한 뒤 데이터 디렉터리 전체를 보관한다. 복원에도 DB와 기존 키가 모두 필요하다. 키가 없거나 다르면 기존 데이터에 새 키를 덮어쓰지 않고 실패한다.
- 동일 호스트 SQLite 공유까지 검증했다. 네트워크 파일시스템/분산 서버 구성, 운영 계정 공급자, 자동 키 교체는 별도 작업이다. 현재는 매 요청 전체 로그를 재생하므로 긴 런/큰 트래픽에는 스냅샷 최적화가 필요하다.

## 확인
`npm run check`는 기존 게임 규칙과 함께 실제 로컬 HTTP, 파일 저장/재시작, 동시 연결, 저장 실패 롤백, 정확한 랭킹 비교를 검사한다. 테스트가 로컬 포트를 열 수 있는 실행 환경이 필요하다. 실패/승리 완료 시 서버가 랭킹을 자동 갱신하며 클라이언트 점수 제출 경로는 없다.
