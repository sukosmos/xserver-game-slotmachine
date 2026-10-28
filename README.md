# NINE TO RUN
슬롯 머신 로그라이크 게임

```
npm run play           # http://127.0.0.1:3000 로컬 게임 화면
npm run play:shared    # NINE_SHARE_ORIGIN 지정 시 별도 저장소의 임시 게스트 공유 서버
```

v0.15: 신규 아이템8종과 전용 아이콘을 추가했습니다(총45종). 에밀의 카드 선택, 슬롯 확장, 라운드 한정 효과를 지원하며 기존 저장은 시작 당시 규칙을 유지합니다. 자세한 내용은 [신규8종](docs/20-EXPANSION8.md)을 참고하세요.

# To. Claude

who's gonna install this repository to your server, please consider below.
- you must rename this game title as "slotmachine"
- it already have rank page, so you can change its location, layout and ranking system.



## files

| 경로 | 책임 |
|---|---|
| `src/domain/rules.js` | 세 JSON의 엄격한 스키마/참조 검증, 읽기 전용 규칙 로딩 |
| `src/domain/slot.js` | 주입 가능한 난수로 추첨, 순수 라인 판정/점수 계산 |
| `src/domain/exact.js` | BigInt/유리수 연산, 십진 문자열 직렬화 |
| `src/domain/inventory.js` | 서버 전용 획득/폐기, 인스턴스·슬롯·스택·활성 라운드 |
| `src/domain/item-scoring.js` | 가중치, 와일드/전용·라인·전역 배율, 정확한 내림 |
| `src/domain/items.js` | 후보 선택, 보드 조작 순서, 가상 배당, 수명과 발동 로그 |
| `src/domain/economy.js` | 정산 전 잔액 기준 이자, Hand·아이템 보상, 급여일 추첨 |
| `src/domain/shop.js` | 등급별 진열, 구매/폐기/리롤, 할인·무료 횟수·구매 가능성 |
| `src/domain/money.js` | 코인 안전 정수 검증과 정확한 중간 연산 |
| `src/domain/run.js` | 불변 라운드 전환, 목표/Hand/점수, 정산·상점의 원자적 연결 |
| `src/server/random.js` | 비밀 시드 생성, 버전 지정 RNG, 서버 내부 스냅샷 |
| `src/server/session.js` | 서버 세션, 액션 검증, 중복 방지, 감사 로그/리플레이 |
| `src/server/store.js` | SQLite 트랜잭션, 규칙 고정, 재검산 복구, 토큰 해시·최고 기록 |
| `src/server/vault.js`, `runtime.js` | 감사 로그 인증 암호화, 비밀 키/저장 파일 권한 |
| `web/` | 반응형 플레이·상점·도감·랭킹, 정확한 점수 표시, 요청 재시도 |
| `src/server/catalog.js` | JSON 기반 공개 설명과 런 고정 카탈로그 |
| `src/server/upgrades.js` | 심벌별 현재/다음 라운드 점수·배당·확률과 적용 아이템 표시 |
| `scripts/run-simulation.js` | 전체 런 정책 시뮬레이터 |
| `src/server/http.js` | 인증된 REST API, 입력/크기/시간/요청 빈도 검증 |
| `src/domain/ranking.js` | 완료 라운드·BigInt 점수·종료 시각 비교 |
| `test/` | 슬롯·상태 전환·오류·재현·사양·분포 테스트 |

