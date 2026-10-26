# 13. 로컬 서버 실행과 복구

Node.js 22.13 이상, 검증 환경은 22.23.2다. 외부 패키지 설치 없이 내장 HTTP/SQLite를 사용한다. Node가 SQLite 실험적 기능 경고를 출력할 수 있다. 같은 서버가 게임 화면과 API를 제공한다.

## 시작
저장소 루트에서 `npm run play`를 실행하고 [게임 화면](http://127.0.0.1:3000)을 연다. 별도 패키지 설치나 플레이 키 입력 없이 로컬 계정으로 시작한다. 서버를 종료하면 페이지에 연결할 수 없으며 같은 명령으로 다시 실행하면 저장된 게임을 복구한다.

`play`는 loopback에서만 실행한다. 서버가 지정한 `local-player`에 HttpOnly/SameSite=Strict 쿠키로 연결하며, 같은 컴퓨터에서 이 주소를 사용하는 브라우저는 해당 로컬 계정을 공유한다. 임의 사용자 ID는 받지 않고 동일 출처 POST만 허용한다. 쿠키가 없어지면 같은 계정의 새 자격으로 다시 연결한다.

여러 계정 또는 기존 Bearer 인증을 확인하려면 다음을 실행한다.

```sh
npm run account:create -- player-one
npm start
```

첫 명령은 `{userId,token}`을 한 번 출력한다. 이후 요청의 Bearer 토큰으로 사용하며 DB에는 토큰 해시만 남긴다. 같은 계정에 여러 토큰을 발급할 수 있다. 일반 모드의 게임 화면에서 이 값을 플레이 키로 입력한다(탭 저장소 보관). 토큰은 로컬 서버용 계정 자격이며 공개 문서나 클라이언트 소스에 넣지 않는다.

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

생성 응답은 `{state,upgrades}`, 액션은 `{state,event,upgrades}`다. `state.revision`을 다음 요청에 사용한다. 새 런은 3코인으로 시작하며 목표 달성 스핀에서 자동 정산한다. `shop/purchases`에 `{expectedRevision,slotId}`, `shop/rerolls`에 `{expectedRevision}`, `shop/discards`에 `{expectedRevision,instanceId}`, `shop/continue`에 `{expectedRevision}`를 보낸다. 점수·코인·가격·시드는 보내지 않는다. 전체 경로는 [API 계약](07-API_DATA_MODEL.md)에 있다.

## 브라우저 조작
- 새 런(3코인) → 스핀 → 목표 달성 시 자동 정산·상점 → 다음 라운드. 모든 선택 결과는 서버 응답을 따른다.
- 아이템 카드를 눌러 설명을 보고, 상점에서 보유 아이템을 눌러 폐기할 수 있다. 제한 아이템은 남은 Hand/발동 횟수를 표시한다.
- 지난 런에서 저장된 런을 다시 연다. 응답을 받지 못한 선택은 ‘결과 확인’으로 원래 요청을 재전송한다. 새로고침도 같은 키를 보존한다.
- 점수를 누르면 축약 전 전체 정수를 확인한다. 설정에서 효과음·빠른 연출·모션 줄이기를 선택한다. 입력창/대화상자 외의 Space로 스핀할 수 있다.

## 중단·재개와 계정 폐기
심벌 강화 표에서 기본 값과 적용 값을 비교한다. 상점의 ‘다음 Rn’은 새 아이템을 포함한 다음 라운드 미리보기다. ‘현재’는 현재 활성 아이템만 반영한다. 심벌을 누르면 정확한 숫자와 적용 아이템을 확인한다. HTTP 응답의 `upgrades`는 서버에서 상태와 같은 revision으로 계산한다.

서버를 Ctrl+C로 중단했다 다시 실행해도 같은 토큰으로 `GET /api/game/v1/runs`와 `GET /api/game/v1/runs/:id`에서 이어간다. 조회에는 마지막 액션과 마지막 스핀도 포함된다. 목록은 최신 20개(최대 100개)이며 기존 runId로도 직접 조회할 수 있다. 중복 응답도 저장돼 이미 처리된 스핀/구매를 재전송해도 재실행하지 않는다.

```sh
npm run account:revoke -- player-one
```

이 계정의 모든 토큰을 폐기한다. 런/최고 기록은 남고 같은 계정 ID로 새 토큰을 발급하면 다시 접근할 수 있다. 일반 모드에는 임의 계정 생성 HTTP API나 게스트 가입 기능이 없다. 로컬 플레이 모드만 고정 계정 연결을 제공한다.

## 저장 파일과 한계
- `.runtime/game.sqlite` 및 WAL/SHM 파일: 런·규칙·토큰 해시·랭킹. 전체 감사 기록은 암호화된다.
- `.runtime/master.key`: 암호화 키. DB와 별도로 보관하며 HTTP로 제공하지 않는다.
- 디렉터리 0700, DB/키 0600. 파일은 Git에서 제외한다.
- 백업은 같은 DB를 사용하는 서버/프로세스를 모두 종료한 뒤 데이터 디렉터리 전체를 보관한다. 복원에도 DB와 기존 키가 모두 필요하다. 키가 없거나 다르면 기존 데이터에 새 키를 덮어쓰지 않고 실패한다.
- 동일 호스트 SQLite 공유까지 검증했다. 네트워크 파일시스템/분산 서버 구성, 운영 계정 공급자, 자동 키 교체는 별도 작업이다. 현재는 매 요청 전체 로그를 재생하므로 긴 런/큰 트래픽에는 스냅샷 최적화가 필요하다.

## 확인
`npm run check`는 기존 게임 규칙과 함께 실제 로컬 HTTP, 파일 저장/재시작, 동시 연결, 저장 실패 롤백, 정확한 랭킹 비교를 검사한다. 테스트가 로컬 포트를 열 수 있는 실행 환경이 필요하다. 실패/승리 완료 시 서버가 랭킹을 자동 갱신하며 클라이언트 점수 제출 경로는 없다.

## 지인용 임시 공유
Cloudflare 공식 `cloudflared` 실행 파일로 별도 공유 서버를 연결한다. 기존 `--local-play` 서버를 외부로 연결하지 않는다.

```sh
cloudflared tunnel --url http://127.0.0.1:3006
# 위 명령이 출력한 실제 HTTPS 주소를 그대로 지정해 다른 터미널에서 실행
NINE_SHARE_ORIGIN=https://<발급된-주소>.trycloudflare.com npm run play:shared
```

공유 서버는 127.0.0.1:3006과 `.runtime/shared-play`만 사용한다. 이 컴퓨터와 두 프로세스가 실행 중이어야 접속할 수 있고 터널 재시작마다 주소가 바뀐다. 링크를 아는 사람은 접속할 수 있다. 브라우저별 게스트 기록과 공유용 랭킹을 사용하며 원래 개인 기록과 분리된다. 쿠키를 지우거나 주소가 바뀌면 이전 게스트로 자동 복구되지 않는다.

`POST /api/game/v1/guest-session`은 지정 HTTPS Origin·Host와 loopback 프록시 연결에서만 동작한다. 빈 JSON만 받으며 서버가 계정을 생성한다. 쿠키는 HttpOnly/Secure/SameSite=Strict이고 API 경로에만 전달한다. 신규 게스트는 분당32개, 프록시 전체 API는 분당480회, 계정별 API는 분당120회까지로 소규모 테스트를 제한한다. 임의 전달 헤더는 인증/요청 제한의 근거로 사용하지 않는다. 일반 서버의 게스트 기능은 비활성이다.

[Cloudflare Quick Tunnels 공식 안내](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)에 따라 가동 보장과 고정 주소가 없는 개발용 공유다. 상시 서비스는 별도 배포가 필요하다.
