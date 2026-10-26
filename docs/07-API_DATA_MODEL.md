# 07. API 및 데이터 모델 계약 초안

> 엔드포인트 이름은 **프레임워크 중립의 권장 설계**. 실제 서버에 기존 API 라우팅/인증 체계가 있다면 맞춘다.

**현재 구현 범위:** Phase 4는 아래 REST 경로를 구현했다. `GameStore`가 저장과 복구를 담당하고 내부 `GameSession.execute(userId, command)`가 게임 명령을 검증한다. `userId`는 서버 인증 문맥에서만 전달한다. 액션 응답은 `{state, event}`이며 점수는 십진 문자열, 코인·가격은 안전 정수다. 서버 전용 `initialItemIds`는 테스트 빌드 주입용이며 HTTP에서는 허용하지 않는다. `exportAudit()`의 `slot-audit-v3`에는 비밀 시드와 난수 추첨값이 있어 암호화해 저장하며 외부에 노출하지 않는다. 구버전 감사 포맷은 자동 이관하지 않는다.

```ts
type Command = { expectedRevision: number; idempotencyKey: string } & (
  | { type: 'SPIN' | 'CLAIM' | 'CONTINUE' | 'REROLL' }
  | { type: 'BUY'; slotId: string }
  | { type: 'DISCARD'; instanceId: string }
);
```

추가 필드는 `INVALID_COMMAND`로 거절한다. 구매 가격·itemId·할인·무료 리롤 여부는 서버가 계산한다. 정산은 보상 지급과 상품 생성을 한 번에 처리하므로 공개 상태에 `ROUND_CLEAR`는 없고 바로 `SHOP` 또는 최종 `RUN_WON`이 된다. 성공 이벤트의 `settlement`에는 `coinsBefore`, `baseReward`, `itemBaseBonus`, `handBonus`, `interest`, `interestCap`, `bonusCoins`, `reward`, `coinsAfterReward`, `triggeredItems`가 있다. 일반/실패 스핀은 `settlement: null`이다. 최종 승리에서는 지급 내역을 기록한 뒤 공개 상태의 코인과 아이템을 초기화한다.

## 7.1 상태 모델(TypeScript 개념 인터페이스)
```ts
type RunPhase = 'ROUND_ACTIVE' | 'SHOP' | 'RUN_FAILED' | 'RUN_WON';
type ItemLifetime = 'permanent' | 'charged' | 'timed';
interface ItemInstance {
  instanceId: string;
  itemId: string;              // data/items.v0.json 참조
  acquiredOrder: number;       // 동시 발동 순위
  activeFromRound: number;     // 이 라운드부터 효과/수명 소모; 구매 시 다음 라운드
  remainingCharges?: number;
  remainingSpins?: number;
}
interface RunView {
  runId: string;
  rulesVersion: string;
  catalogVersion: string;
  linesVersion: string;
  phase: RunPhase;
  roundIndex: number;          // 1부터 시작
  completedRounds: number;
  roundScore: string;          // decimal BigInt string
  runTotalScore: string;       // decimal BigInt string
  targetScore: string;
  handsRemaining: number;
  canClaim: boolean;
  coins: number;               // 안전 정수; 범위 초과는 COIN_OVERFLOW
  items: ItemInstance[];
  consecutiveWinHands: number;
  shop: null | {
    slots: Array<{ slotId: string; itemId: string|null; soldOut: boolean;
                   price: number|null; canBuy: boolean; blockedReason: string|null }>;
    offerSequence: number;
    paidRerolls: number;
    freeRerollsUsed: number;
    freeRerollsRemaining: number;
    rerollPrice: number|null;
    canReroll: boolean;
    rerollBlockedReason: string|null;
  };
  revision: number;            // optimistic concurrency
}
```

소유자, RNG 시드/커서, `nextItemOrder`와 중복 응답 캐시는 서버 내부에만 보관한다. 슬롯 ID는 라운드·진열 세대·위치를 포함하고 리롤/다음 상점에서 바뀐다. 상품 부족으로 비운 칸은 `soldOut: false`, 구매한 칸은 `soldOut: true`이며 둘 다 `itemId/price: null`이다. 구매 후 자동 보충은 없고 리롤로 교체한다. 구매 가능성과 가격은 구매/폐기 후 매번 다시 계산한다.

## 7.2 구현된 REST API
모든 `/api/game/v1` 경로에 `Authorization: Bearer <token>`이 필요하다. POST는 `Content-Type: application/json`과 `Idempotency-Key`를 요구한다. 생성 본문은 `{}`, 나머지 액션 본문은 `expectedRevision`과 필요한 slotId/instanceId만 허용한다. type은 경로에서 결정한다. [실행 예제](13-LOCAL_SERVER.md)를 참고한다.

| 메서드 | URL | 작업/제약 |
|---|---|---|
| GET | `/api/game/v1/me` | 내 불투명 playerId |
| GET | `/api/game/v1/runs?limit=20` | 내 최신 런 목록; limit 1~100 |
| POST | `/api/game/v1/runs` | 새 런 생성, Round 1 / Hand 4 / 0 Coin |
| GET | `/api/game/v1/runs/:id` | `{state,lastEvent,lastSpin,createdAt,updatedAt,endedAt}` 복구; 없는/타인 런은 404 |
| POST | `/api/game/v1/runs/:id/spins` | Hand 1 소비, 서버 추첨/아이템/점수 계산 |
| POST | `/api/game/v1/runs/:id/claim` | 목표 달성 시 조기 성공 정산; **중복 정산 금지** |
| POST | `/api/game/v1/runs/:id/shop/purchases` | `slotId`로 상품 구매, 돈/슬롯 동시 갱신 |
| POST | `/api/game/v1/runs/:id/shop/rerolls` | 상품 3칸 재추첨 및 코인 비용 차감 |
| POST | `/api/game/v1/runs/:id/shop/discards` | `instanceId`로 1개 폐기, 환불 없음 |
| POST | `/api/game/v1/runs/:id/shop/continue` | 다음 라운드 진입; 최종 라운드는 정산 시 종료 |
| GET | `/api/game/v1/leaderboard?limit=20` | `{entries:[{rank,playerId,runId,completedRounds,runTotalScore,endedAt,rulesVersion}]}`; limit 1~100 |

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
**주의:** 위 JSON은 초기 기획의 평탄화된 가상 예시다. 실제 HTTP 액션 응답은 `{state,event}`이며 `event.board`, `event.spinScore`, `state.roundScore` 등으로 구분한다. 완전한 재현 테스트 벡터는 `09-TEST_CASES.md`를 사용한다.

## 7.3 실패/동시성
- 에러 예: `INVALID_COMMAND`, `INVALID_RUN_PHASE`, `NO_HANDS_LEFT`, `TARGET_NOT_MET`, `INSUFFICIENT_COINS`, `ITEM_CAP_REACHED`, `INVENTORY_FULL`, `SOLD_OUT`, `UNKNOWN_SHOP_SLOT`, `UNKNOWN_ITEM_INSTANCE`, `COIN_OVERFLOW`, `STALE_REVISION`, `NOT_OWNER`, `IDEMPOTENCY_CONFLICT`.
- 사용자 입력에는 `runId`, `slotId`, 의도한 액션만 포함. **클라이언트가 score, coins, 결과 board를 정해 보내지 않음**.
- GET 요청은 게임 상태를 바꾸지 않는다. 모든 POST에 Idempotency-Key를 요구하며 액션 POST는 expectedRevision을 검증한다. 생성 POST는 revision 없이 생성 키의 최초 응답을 복구한다.
- 메모리 세션은 같은 키+같은 명령에 최초 응답을 돌려주고 재실행하지 않는다. 같은 키의 다른 명령은 충돌이며, 새 키라도 이미 정산한 상태에서 CLAIM하면 `INVALID_RUN_PHASE`다. 오류는 상태·코인·RNG·감사 로그·중복 캐시를 바꾸지 않아 실패한 키를 재사용할 수 있다.
- 오류 본문은 `{error:{code}}`. 잘못된 본문/키/쿼리는 400, 인증 실패 401, 없는/타인 런 404, 상태/잔액/revision 충돌 409, 본문 4KiB 초과 413, 빈도 제한 429, 저장 실패 503이다. 내부 오류 메시지·SQL·파일 경로는 노출하지 않는다. 기본 제한은 계정 120회/분, IP 480회/분이며 프로세스별로 적용한다.

## 7.4 이벤트 로그
- `RUN_STARTED`, `SPIN_RESOLVED`, `ROUND_CLAIMED`, `ROUND_AUTO_CLEARED`, `RUN_FAILED`, `SHOP_REROLLED`, `ITEM_PURCHASED`, `ITEM_DISCARDED`, `ROUND_STARTED`, `RUN_WON`.
- 현재 구현은 액션당 이벤트 1개다. 자동 클리어/실패/최종 승리는 `SPIN_RESOLVED.outcome` 또는 `ROUND_CLAIMED.outcome`에 기록한다. 구매/리롤/폐기 이벤트에는 차감 금액과 전후 코인을 포함한다.
- 스핀 이벤트에는 아이템 ID/발동과 실제 RNG 소모 정보(서버용), 보드 전후, 라인별 결과, 점수 단계별 분해 내역, 상태 revision 기록.
- 클라이언트에 난수/시드를 무제한 노출하지 말 것.

## 7.5 영속성/복구
- 새로고침/재접속해도 같은 런 상태 복구. 스핀 중 클라이언트가 끊겨도 Hand와 점수가 중복 계산되지 않도록 `GET run`으로 복구.
- 밸런스 버전 변경 시 **이미 시작된 런은 시작 당시 rulesVersion을 유지**하는 정책 권장.
- 구현은 규칙 원본을 지문별로 저장하고 시작 당시 규칙으로 감사 로그를 재검산한다. 전체 로그 안에 초기 시드·RNG 커서·인벤토리·코인·진열·중복 응답이 들어 있어 DB 재연결/서버 재시작 후에도 복구된다. 런 종료의 endedAt은 서버 밀리초 시각이고 랭킹과 함께 원자적으로 저장한다.
