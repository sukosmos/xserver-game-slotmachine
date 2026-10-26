# NINE TO RUIN — Slot Roguelite (working title)

**프로젝트 상태:** 규칙 v0.11 / 클리어 보상·목표 완화·3라운드 카드 선택
**목적:** 서버가 계산하고 저장하는 슬롯 로그라이트를 브라우저에서 플레이한다.

> `NINE TO RUIN`은 **가제**이며 외부 브랜드/상표/도메인 사용 가능 여부를 확인하지 않았다.

## 현재 실행 가능한 범위
Node.js **22.13 이상**에서 실행하며 외부 패키지 설치가 필요 없다. 검증 환경은 22.23.2이고 내장 SQLite의 실험적 기능 경고가 표시될 수 있다.

```sh
npm run play           # http://127.0.0.1:3000 로컬 게임 화면
npm run play:shared    # NINE_SHARE_ORIGIN 지정 시 별도 저장소의 임시 게스트 공유 서버
npm run check          # JSON 스키마·문서 일치 검사 + 자동 테스트
npm run demo           # 서버 전용 메모리 세션으로 런 진행 (JSON 출력)
npm run demo:items     # 서버가 정한 시작 빌드로 아이템 발동·만료 확인
npm run demo:shop      # 고정 테스트 시드로 정산·구매·리롤·다음 라운드 확인
npm run test:balance   # 고정 시드, 10만 라운드 확률/통과율 검사
npm run test:items     # 기적/거울/와일드 발동 확률·균등 선택, 세븐 강화 분포 검사
npm run simulate:runs # 10,000회 전체 런 분석 (고정 정책)
npm run simulate      # 같은 밸런스 실험의 상세 통계
npm run account:create -- player-one  # 로컬 계정용 토큰 발급 (한 번 출력)
npm start             # 플레이 키를 입력하는 일반 인증 모드
```

- 구현: 3×3 가중치 추첨, 8개 라인, BigInt 점수/유리수 연산, 5 Hand, 자동 클리어/실패/10라운드 승리, 시드·액션 로그 재현, **전투·점수 29종 + 경제 6종 + Hand 2종**과 인벤토리.
- `GameSession`은 Node 서버 전용 실행 계층이다. 서버가 보드/점수를 만들고 소유자·revision·중복 요청을 검사하며 공개 응답의 점수는 십진 문자열이다. 난수 시드와 감사 기록은 서버 내부용이다.
- 카탈로그 37종의 구조/참조를 검증하고 기본 10종·결과 조작·와일드·시너지 효과, 중첩 상한, 영구8/제한2 슬롯, charged/timed 수명을 처리한다. 아이템 데모는 서버 전용 시작 빌드를 주입하며 일반 런은 아이템 없이 시작한다.
- 클리어 시 잔여 Hand 보너스·이자·경제 효과를 정산하고 상점 4칸을 추첨한다. 구매/품절/폐기, 유료 리롤 1→2→3, VIP 무료 리롤과 흥정 할인을 처리한다. 구매 가능 여부·거절 이유·다음 리롤 가격을 반환한다.
- 새 런은 3코인으로 시작한다. 목표 달성 스핀 → 자동 보상 → 상점 → 다음 라운드 순서다. 3라운드는 상점 전에 뒤집힌 카드3장 중 한 장을 선택한다. 모든 명령에 소유자·revision·중복 검증을 적용하며 `slot-audit-v3`로 경제·상품·카드·난수까지 재현한다. 저장된 v0.6~v0.10 런은 당시 규칙을 유지한다.
- HTTP API는 서버 발급 Bearer 토큰으로 소유자를 확인한다. SQLite에 암호화된 런/액션 기록과 규칙 스냅샷을 저장하고 재시작 후 상태·난수·중복 응답을 복구한다. 같은 DB를 공유하는 연결은 트랜잭션으로 처리한다.
- 실패/승리가 확정되면 같은 트랜잭션에서 계정별 최고 기록을 갱신한다. 완료 라운드 → 정확한 누적 점수 → 서버 종료 시각 순으로 정렬하며 점수 제출 API는 없다.
- 브라우저에서 슬롯·목표·Hand·코인·상점·아이템 도감·랭킹을 확인하고 저장된 도전을 이어간다. `npm run play`는 이 컴퓨터의 로컬 계정으로 바로 연결한다. 운영 로그인/HTTPS 연동은 후속 범위다. 로컬 데이터와 암호화 키는 `.runtime/`에 저장한다. 기존 `demo` 명령은 메모리 실행이며 실제 저장 확인은 서버 API를 사용한다. 실행·요청·복구 방법은 [로컬 서버 안내](docs/13-LOCAL_SERVER.md)를 따른다.
- 기존 `python3 scripts/validate_specs.py`와 `python3 validate_specs.py`도 동일한 Node 사양 검사를 실행한다.

v0.11의 10,000회 고정 정책 실험에서 첫 라운드 통과율은 99.74%, 2라운드는 90.92%, 10라운드 완주는 0회였다. 이는 최적 플레이의 성공률을 뜻하지 않으며 후반 튜닝이 더 필요하다. 분석과 한계는 [분석 보고서](docs/14-PLAYTEST_REPORT.md)에 기록했다.

구현 범위·잠정 결정은 [결정 기록](docs/10-DECISIONS.md), 테스트 대응표는 [테스트 기준](docs/09-TEST_CASES.md)에 기록한다.

지인에게 임시 링크를 공유하려면 [임시 공유 실행 안내](docs/13-LOCAL_SERVER.md)를 따른다. 방문자마다 별도 게스트 기록을 사용하며 원래 로컬 기록은 공개하지 않는다. 컴퓨터와 공유 서버·터널이 실행 중인 동안만 접속할 수 있다.

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

## 게임 기획 30초 요약 (전체 MVP 목표)
- 장르: 웹 기반 싱글플레이 **3×3 슬롯머신 로그라이트** + 랭킹.
- 한 판(run) = 라운드 연속 도전. 라운드마다 **5 Hand**로 목표 **점수** 달성.
- 가로 3·세로 3·대각선 2 = **8개 페이라인**. 점수는 심벌 기본 점수 + 라인 배당 + 아이템 증폭.
- **베팅칩/베팅 배율은 현재 구현 범위에서 제외**. 점수와 상점 **코인**은 분리.
- 첫 라운드 시작 코인 3개. 목표 달성 시 남은 Hand를 보너스로 자동 정산하고 상점으로 이동한다.
- 클리어 보상 = `3 + (라운드 - 1) + 남은 Hand + min(2, floor(정산 직전 보유 코인 / 5))` 코인(아이템 보정 전).
- 3라운드의 [카드 보상](docs/18-MILESTONE_CARDS.md)은 심벌 하나 삭제 / 모든 심벌 점수·배당 한 단계 강화 / 매 라운드 첫 스핀 중앙 와일드 중 무작위로 배치된 한 장을 선택한다.
- 라운드 종료 시 상점 4개가 나오고 코인이 허용하는 한 계속 구매/새로고침 가능.
- 확률/배당/결과 조작/경제 아이템으로 시너지 구축. 런 실패 시 코인과 아이템 초기화.
- 랭킹: **최고 완료 라운드**, 동률 시 **런 누적 점수**, 다시 동률이면 서버 종료 시각.

## Codex 시작 순서
1. [`AGENTS.md`](AGENTS.md) 읽기: 구현 작업 규칙과 범위.
2. [`docs/00-INDEX.md`](docs/00-INDEX.md) 읽기: 문서 간 우선순위.
3. [`data/balance.v0.json`](data/balance.v0.json), [`data/items.v0.json`](data/items.v0.json), [`data/lines.v0.json`](data/lines.v0.json) 데이터로 도메인 로직부터 테스트.
4. [`docs/08-IMPLEMENTATION_PLAN.md`](docs/08-IMPLEMENTATION_PLAN.md)의 Phase 0 → 순서대로 진행.

## 파일 지도
| 파일 | 용도 |
|---|---|
| `docs/01-GAME_VISION.md` | 게임 정체성, 플레이 루프, 제외 범위 |
| `docs/02-CORE_RULES.md` | 슬롯 규칙, 점수 산식, Hand 처리, 확률 |
| `docs/03-ITEM_SYSTEM.md` | 아이템 적용 순서, 지속시간, 후보라인 무작위 |
| `docs/04-ECONOMY_SHOP.md` | 코인 정산, 이자, 가격, 무제한 구매 |
| `docs/05-PROGRESSION_RANKING.md` | 라운드, 실패, 랭킹, 일일 챌린지 |
| `docs/06-ARCHITECTURE.md` | 프레임워크 중립 아키텍처, 보안/정수/난수 |
| `docs/07-API_DATA_MODEL.md` | 권장 API, 상태, 이벤트, 데이터 모델 |
| `docs/08-IMPLEMENTATION_PLAN.md` | Codex 단계별 작업 지시 |
| `docs/09-TEST_CASES.md` | 인수 조건 및 테스트 벡터 |
| `docs/10-DECISIONS.md` | 확정/잠정/보류 사항과 확인 질문 |
| `docs/11-UX_FLOW.md` | 화면 흐름 및 최소 UI 요구사항 |
| `docs/12-PROJECT_NAMING.md` | 게임 이름 후보와 추천 |
| `docs/13-LOCAL_SERVER.md` | 로컬 실행, 토큰, HTTP 예제, 저장/복구와 한계 |
| `docs/14-PLAYTEST_REPORT.md` | 10,000런 분석, 브라우저 인수 결과와 한계 |
| `CODEX_HANDOFF.md` | Codex에 복사할 첫 작업 지시문 |
| `data/*.json` | 초깃값, 라인 좌표, 아이템 정의의 기계 판독용 초안 |

## 문서 우선순위
- 변경/추가 논의 시 `docs/10-DECISIONS.md`의 확정값과 `docs/02-CORE_RULES.md`를 먼저 갱신한다.
- 수치와 아이템 목록의 **실행 시 단일 출처(single source of truth)**는 `data/*.json`이다. 설명 문서는 이를 풀어쓴 것.
- 숫자는 **초기 프로토타입 값**이며 플레이테스트 후 조정 가능. 임의 변경 시 데이터·테스트·문서를 함께 갱신.
