# NINE TO RUIN — Slot Roguelite (working title)

**프로젝트 상태:** 기획 v0.4 / 구현 전 / 2026-10-25  
**목적:** Codex 또는 개발자가 바로 프로토타입을 만들 수 있도록 규칙, 데이터, 구현 순서를 정의한다.

> `NINE TO RUIN`은 **가제**이며 외부 브랜드/상표/도메인 사용 가능 여부를 확인하지 않았다.

## 30초 요약
- 장르: 웹 기반 싱글플레이 **3×3 슬롯머신 로그라이트** + 랭킹.
- 한 판(run) = 라운드 연속 도전. 라운드마다 **4 Hand**(초안; 3 Hand 비교 테스트 예정)로 목표 **점수** 달성.
- 가로 3·세로 3·대각선 2 = **8개 페이라인**. 점수는 심벌 기본 점수 + 라인 배당 + 아이템 증폭.
- **베팅칩/베팅 배율은 현재 구현 범위에서 제외**. 점수와 상점 **코인**은 분리.
- 목표 달성 시 즉시 정산하거나 남은 Hand로 기록을 더 높일 수 있다.
- 클리어 보상 = `2 + 남은 Hand + min(2, floor(정산 직전 보유 코인 / 5))` 코인(아이템 보정 전).
- 라운드 종료 시 상점 3개가 나오고 코인이 허용하는 한 계속 구매/새로고침 가능.
- 확률/배당/결과 조작/경제 아이템으로 시너지 구축. 런 실패 시 코인과 아이템 초기화.
- 랭킹: **최고 완료 라운드**, 동률 시 **런 누적 점수** (예정).

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
| `CODEX_HANDOFF.md` | Codex에 복사할 첫 작업 지시문 |
| `data/*.json` | 초깃값, 라인 좌표, 아이템 정의의 기계 판독용 초안 |

## 문서 우선순위
- 변경/추가 논의 시 `docs/10-DECISIONS.md`의 확정값과 `docs/02-CORE_RULES.md`를 먼저 갱신한다.
- 수치와 아이템 목록의 **실행 시 단일 출처(single source of truth)**는 `data/*.json`이다. 설명 문서는 이를 풀어쓴 것.
- 숫자는 **초기 프로토타입 값**이며 플레이테스트 후 조정 가능. 임의 변경 시 데이터·테스트·문서를 함께 갱신.
