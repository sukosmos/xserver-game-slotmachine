# 07. API 및 데이터 모델 계약 초안

> 엔드포인트 이름은 **프레임워크 중립의 권장 설계**. 실제 서버에 기존 API 라우팅/인증 체계가 있다면 맞춘다.

## 7.1 상태 모델(TypeScript 개념 인터페이스)
```ts
type RunPhase = 'ROUND_ACTIVE' | 'ROUND_CLEAR' | 'SHOP' | 'RUN_FAILED' | 'RUN_WON';
type ItemLifetime = 'permanent' | 'charged' | 'timed';
interface ItemInstance {
  instanceId: string;
  itemId: string;              // data/items.v0.json 참조
  acquiredOrder: number;       // 동시 발동 순위
  remainingCharges?: number;
  remainingSpins?: number;
}
interface RunState {
  id: string;
  userId: string;
  rulesVersion: string;
  catalogVersion: string;
  phase: RunPhase;
  roundIndex: number;          // 1부터 시작
  roundScore: string;          // decimal BigInt string
  runTotalScore: string;       // decimal BigInt string
  targetScore: string;
  handsRemaining: number;
  coins: number;
  items: ItemInstance[];
  consecutiveWinHands: number;
  shop?: { slots: Array<{ slotId: string; itemId: string|null }>;
           paidRerolls: number; vipFreeRerollUsed: boolean };
  rngStateRef: string;         // DB 내부 참조; 클라이언트에 공개하지 않음
  revision: number;            // optimistic concurrency
}
```

## 7.2 REST API 권고
| 메서드 | URL | 작업/제약 |
|---|---|---|
| POST | `/api/game/v1/runs` | 새 런 생성, Round 1 / Hand 4 / 0 Coin |
| GET | `/api/game/v1/runs/:id` | 내 런 상태 조회(민감 RNG 제외) |
| POST | `/api/game/v1/runs/:id/spins` | Hand 1 소비, 서버 추첨/아이템/점수 계산 |
| POST | `/api/game/v1/runs/:id/claim` | 목표 달성 시 조기 성공 정산; **중복 정산 금지** |
| POST | `/api/game/v1/runs/:id/shop/purchases` | `slotId`로 상품 구매, 돈/슬롯 동시 갱신 |
| POST | `/api/game/v1/runs/:id/shop/rerolls` | 상품 3칸 재추첨 및 코인 비용 차감 |
| POST | `/api/game/v1/runs/:id/shop/continue` | 다음 라운드 진입 또는 런 종료 |
| GET | `/api/game/v1/leaderboard` | 확정 서버 기록 기준 상위 N명 |

### Spin 응답 예시
```json
{
  "runId":"run_123",
  "roundIndex":1,
  "board":["lemon","cherry","diamond","bell","lemon","seven","diamond","bell","lemon"],
  "winningLines":[{"lineId":"diag_main","symbol":"lemon","score":"60"}],
  "triggeredItems":[{"itemId":"miracle_hand","description":"diag_main: cherry -> lemon"}],
  "spinScore":"93",
  "roundScore":"188",
  "runTotalScore":"188",
  "handsRemaining":2,
  "canClaim":true,
  "phase":"ROUND_ACTIVE",
  "revision":3
}
```
**주의:** 위 JSON은 응답 **모양을 보여주기 위한 가상 예시**이며, 특정 액션 로그의 완전한 재현 테스트 벡터는 아니다. 정확성 검증은 `09-TEST_CASES.md`를 사용한다.

## 7.3 실패/동시성
- 에러 예: `INVALID_RUN_PHASE`, `NO_HANDS_LEFT`, `TARGET_NOT_MET`, `INSUFFICIENT_COINS`, `ITEM_CAP_REACHED`, `STALE_REVISION`, `NOT_OWNER`, `ALREADY_CLAIMED`.
- 사용자 입력에는 `runId`, `slotId`, 의도한 액션만 포함. **클라이언트가 score, coins, 결과 board를 정해 보내지 않음**.
- GET 요청은 부작용 없음. 모든 POST에 Idempotency-Key와 서버 revision 검증 권장.
- 운영 DB는 runs + run_events + item_instances + leaderboard_records 테이블/컬렉션을 권장.

## 7.4 이벤트 로그
- `RUN_STARTED`, `SPIN_RESOLVED`, `ROUND_CLAIMED`, `ROUND_AUTO_CLEARED`, `RUN_FAILED`, `SHOP_REROLLED`, `ITEM_PURCHASED`, `ITEM_DISCARDED`, `ROUND_STARTED`, `RUN_WON`.
- 스핀 이벤트에는 아이템 ID/발동과 실제 RNG 소모 정보(서버용), 보드 전후, 라인별 결과, 점수 단계별 분해 내역, 상태 revision 기록.
- 클라이언트에 난수/시드를 무제한 노출하지 말 것.

## 7.5 영속성/복구
- 새로고침/재접속해도 같은 런 상태 복구. 스핀 중 클라이언트가 끊겨도 Hand와 점수가 중복 계산되지 않도록 `GET run`으로 복구.
- 밸런스 버전 변경 시 **이미 시작된 런은 시작 당시 rulesVersion을 유지**하는 정책 권장.
