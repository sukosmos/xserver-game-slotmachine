# 07. API 및 데이터 모델 계약 초안

## v0.13 Endless 확장
- 새 규칙의 공개 상태에 `mode:standard|endless`, `canStartEndless:boolean`을 추가한다. 시작 가능 여부는 서버가 판정한다.
- `POST /api/game/v1/runs/:id/endless/start`는 `{expectedRevision}`과 Idempotency-Key만 받으며 내부 명령은 `START_ENDLESS`다. 임의 목표·모드·점수·아이템은 거절한다.
- 표준 R10 `RUN_WON`에서만 가능하다. 자산을 보존한 `SHOP`, `mode:endless`, `ENDLESS_STARTED` 이벤트를 반환한다. 추가 정산은 없다. 같은 키는 원래 응답, 다른 동시 요청은 revision 충돌이다.
- 다음 `CONTINUE`부터 R11 이상의 목표를 JSON 비율로 서버에서 정확히 계산한다. Endless 성공은 계속 `SHOP`으로 이동한다. 구버전은 확장을 허용하지 않고 기존 응답 형태를 유지한다.
- R10 승리 시 랭킹을 저장한다. Endless 진입하면 런의 `endedAt`은 null로 돌아가고 기존 최고 기록은 유지하며, 실패 시 최종 기록을 비교하여 갱신한다.

## v0.12 아이템·카드 확장
- 카탈로그의 `maxStacks:null`은 중첩 무제한이다. 가중치 아이템은 `maxStacks:5`이며 슬롯은 같은 ID끼리 공유한다.
- 소모 아이템의 `lastTriggeredRound`는 마지막으로 실제 발동한 라운드(미사용0)다. 서버는 같은 라운드의 중복 발동을 막고 남은 Hand 기준 확률을 계산한다.
- 비상 레버의 스핀 `emergency`는 `{type:'EMERGENCY_ROUND_CLEARED',instanceId,itemId}`이며 `presentation.emergency.roundCleared:true`와 `label:'ROUND SAVED'`로 표시한다. 정산은 같은 트랜잭션에서 한 번만 수행한다.
- R3 성공 시 정산 후 `CARD_CHOICE`, `shop:null`이 된다. `cardChoice.slots`에는 `{slotId}`4개만 포함하고 순서별 카드 효과·난수는 공개하지 않는다. v0.11 저장 런은 기존3장을 유지한다.
- `POST /api/game/v1/runs/:id/cards/choice`: `{expectedRevision,slotId}`와 Idempotency-Key를 받는다. 내부 명령은 `CHOOSE_CARD`다. 카드 ID·삭제 심벌·수치는 클라이언트 입력으로 받지 않는다.
- 선택 응답은 `CARD_SELECTED` 이벤트, 공개 `milestoneReward`, 갱신된 강화 표와 `SHOP` 상태다. 선택과 상점 생성은 한 트랜잭션이며 재전송/동시 선택을 보호한다.
- 돈벼락의 공개 보상에는 `coinsGranted:30`, 영구 조커에는 `includesLastHand:true`가 추가된다. 돈벼락 지급도 카드 선택과 같은 트랜잭션에서 처리한다. 전체 강화는 `milestoneSpinFactor`로 추가 배수를 기록한다.
- `roundWildAvailable`은 해당 라운드 첫 Hand의 영구 조커 대기 여부다. 스핀 이벤트 `milestoneWild`와 `wildMarks`는 실제 적용을 표시한다. 과거 규칙 응답에는 신규 필드를 추가하지 않는다.
- 기존 정산 후 즉시 SHOP 규칙은 카드 단계가 없는 라운드에 적용된다. 세부 계약은 [카드 보상](18-MILESTONE_CARDS.md)을 따른다.

> 엔드포인트 이름은 **프레임워크 중립의 권장 설계**. 실제 서버에 기존 API 라우팅/인증 체계가 있다면 맞춘다.

**현재 구현 범위:** Phase 4는 아래 REST 경로를 구현했다. `GameStore`가 저장과 복구를 담당하고 내부 `GameSession.execute(userId, command)`가 게임 명령을 검증한다. `userId`는 서버 인증 문맥에서만 전달한다. 액션 응답은 `{state, event, upgrades}`이며 점수는 십진 문자열, 코인·가격은 안전 정수다. 서버 전용 `initialItemIds`는 테스트 빌드 주입용이며 HTTP에서는 허용하지 않는다. `exportAudit()`의 `slot-audit-v3`에는 비밀 시드와 난수 추첨값이 있어 암호화해 저장하며 외부에 노출하지 않는다. 구버전 감사 포맷은 자동 이관하지 않는다.

```ts
type Command = { expectedRevision: number; idempotencyKey: string } & (
  | { type: 'SPIN' | 'CLAIM' | 'CONTINUE' | 'REROLL' }
  | { type: 'BUY'; slotId: string }
  | { type: 'DISCARD'; instanceId: string }
);
```

추가 필드는 `INVALID_COMMAND`로 거절한다. 구매 가격·itemId·할인·무료 리롤 여부는 서버가 계산한다. 정산은 보상 지급과 상품 생성을 한 번에 처리하므로 공개 상태에 `ROUND_CLEAR`는 없고 `SHOP` 또는 최종 `RUN_WON`이 된다. v0.11의 R3는 먼저 `CARD_CHOICE`로 이동하고 선택 후 상품을 생성한다. 성공 이벤트의 `settlement`에는 `coinsBefore`, `baseReward`, `itemBaseBonus`, `handBonus`, `interest`, `interestCap`, `bonusCoins`, `reward`, `coinsAfterReward`, `triggeredItems`가 있다. 일반/실패 스핀은 `settlement: null`이다. 최종 승리에서는 지급 내역을 기록한 뒤 공개 상태의 코인과 아이템을 초기화한다.

## 7.1 상태 모델(TypeScript 개념 인터페이스)
```ts
type RunPhase = 'ROUND_ACTIVE' | 'CARD_CHOICE' | 'SHOP' | 'RUN_FAILED' | 'RUN_WON';
type ItemLifetime = 'permanent' | 'charged' | 'timed';
interface ItemInstance {
  instanceId: string;
  itemId: string;              // data/items.v0.json 참조
  acquiredOrder: number;       // 동시 발동 순위
  activeFromRound: number;     // 이 라운드부터 효과/수명 소모; 구매 시 다음 라운드
  remainingCharges?: number;
  remainingSpins?: number;
  lastTriggeredRound?: number;
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
Phase 5 강화 표 추가: HTTP 생성은 `{state,upgrades}`, 액션은 `{state,event,upgrades}`, 상태 조회도 `upgrades`를 함께 반환한다. `GameSession`과 v3 감사 로그는 기존 응답 구조를 유지한다.

게임 데이터 경로는 `Authorization: Bearer <token>` 또는 로컬 플레이 쿠키가 필요하다. 공개 bootstrap은 모드만 반환한다. 로컬 연결 POST는 동일 출처/loopback를 검증하고 빈 본문만 받으며 idempotency 키를 요구하지 않는다. 게임 명령 POST는 `Content-Type: application/json`과 `Idempotency-Key`를 요구한다. 생성 본문은 `{}`, 나머지 액션 본문은 `expectedRevision`과 필요한 slotId/instanceId만 허용한다. type은 경로에서 결정한다. [실행 예제](13-LOCAL_SERVER.md)를 참고한다.

| 메서드 | URL | 작업/제약 |
|---|---|---|
| GET | `/api/game/v1/bootstrap` | 공개 `{localPlay}` 모드 조회 |
| POST | `/api/game/v1/local-session` | 명시적으로 켠 로컬 플레이만 고정 계정 쿠키 발급/재사용. 일반 모드 404, 다른 Origin 403 |
| GET | `/api/game/v1/catalog` | 현재 JSON에서 만든 설명·심벌·라인·목표·슬롯·초기 코인 |
| GET | `/api/game/v1/runs/:id/catalog` | 소유자 확인 후 해당 런에 고정된 규칙의 공개 카탈로그 |
| GET | `/api/game/v1/me` | 내 불투명 playerId |
| GET | `/api/game/v1/runs?limit=20` | 내 최신 런 목록; limit 1~100 |
| POST | `/api/game/v1/runs` | 새 런 생성, Round 1 / Hand 5 / 3 Coin |
| GET | `/api/game/v1/runs/:id` | `{state,upgrades,lastEvent,lastSpin,createdAt,updatedAt,endedAt}` 복구; 없는/타인 런은 404 |
| POST | `/api/game/v1/runs/:id/spins` | Hand 1 소비, 서버 추첨/아이템/점수 계산 |
| POST | `/api/game/v1/runs/:id/claim` | 과거 v0.6 런 복구용. v0.7은 성공 스핀에서 자동 정산하므로 호출 불필요 |
| POST | `/api/game/v1/runs/:id/shop/purchases` | `slotId`로 상품 구매, 돈/슬롯 동시 갱신 |
| POST | `/api/game/v1/runs/:id/shop/rerolls` | 상품 4칸 재추첨 및 코인 비용 차감 |
| POST | `/api/game/v1/runs/:id/shop/discards` | `instanceId`로 1개 폐기, 환불 없음 |
| POST | `/api/game/v1/runs/:id/shop/continue` | 다음 라운드 진입; 최종 라운드는 정산 시 종료 |
| GET | `/api/game/v1/leaderboard?limit=20` | `{entries:[{rank,playerId,runId,completedRounds,runTotalScore,endedAt,rulesVersion}]}`; limit 1~100 |

### Spin 응답 예시
`upgrades`는 응답 상태의 revision과 함께 계산하는 표시 전용 정보다. `current`는 현재 라운드, `next`는 SHOP일 때 다음 라운드 미리보기이며 다른 상태에서는 null이다. 각 표는 `roundIndex`, `totalWeight`, `symbols`, `effects`로 구성된다.

심벌 행은 `id`, `basePoint/point`, `baseLinePayout/linePayout`, `baseWeight/weight`, `baseProbability/probability`, `sources:[{itemId,stacks}]`다. 점수는 정확한 십진 문자열, 확률은 서버가 소수 둘째 자리까지 반올림한 문자열이다. 화면에서는 소수점 뒤 불필요한 0만 생략한다. 확률은 보드 조작 전 최초 추첨 기준이다.

`effects:[{itemId,stacks}]`는 가중치/심벌 배당 외의 활성 효과다. 스핀 전체 배수·확률 발동은 고정 심벌 배당에 미리 곱하지 않는다. 할인은 구매 즉시 current에 표시한다. 카탈로그의 `upgrades`는 해당 규칙의 기본 표이고 아이템 `summary`는 JSON에서 만든 짧은 설명이다. 과거 중복 요청도 당시 상태와 고정 규칙으로 계산한다. 이 정보는 RNG를 소비하지 않고 게임 입력으로 받지 않는다.

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
**주의:** 위 JSON은 초기 기획의 평탄화된 가상 예시다. 실제 HTTP 액션 응답은 `{state,event,upgrades}`이며 `event.board`, `event.spinScore`, `state.roundScore` 등으로 구분한다. 완전한 재현 테스트 벡터는 `09-TEST_CASES.md`를 사용한다.

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

### v0.8 Hand 및 연출 투영
- 새 규칙의 공개 상태에는 라운드 시작에 고정한 `roundHands`가 포함된다. `handsRemaining`은 이 수 이하이며 다음 라운드 시작에 다시 계산한다. 과거 규칙의 감사 상태에는 새 필드를 삽입하지 않는다.
- 강화 표의 각 snapshot은 현재/다음 라운드 총 `hands`도 제공한다.
- SPIN 응답과 GET 런의 `presentation`은 `multiplier`, `effects:[{itemId,name,label,stage}]`, `expired:[{itemId,name}]`를 제공한다. stage는 draw/board/score/clear이며 실제 이벤트와 고정 규칙에서 서버가 계산한다. 스핀 외 액션은 null이다.
- `presentation`은 `upgrades`처럼 감사 로그 밖의 표시용 투영이다. 중복 요청은 원래 이벤트 기준으로 재계산하며 클라이언트가 발동 여부/보상/배율을 제출하지 않는다.

### v0.9 사각형 보너스와 순차 강조
- 새 규칙의 스핀 이벤트는 `patternScore`(십진 문자열)와 `winningPatterns:[{patternId,indices,symbol,basePayout,score}]`를 포함한다. 배당 두 필드 역시 십진 문자열이다. 아이템이 없거나 일치하지 않으면 `"0"`, `[]`다. 기존 v0.6~v0.8 감사 이벤트에는 추가하지 않는다.
- `presentation.awards:[{kind,id,label,indices,symbol,score}]`는 당첨 라인 다음 사각형 순서다. kind는 `line`/`square`, indices는 서버가 확정한 3개/4개 칸 좌표, score는 전체 배수 적용 전 해당 영역의 배당 문자열이다. 클라이언트는 이 순서와 좌표로 표시만 한다.
- `upgrades.current/next.symbols[].point`에는 가중치 아이템의 `basePointAdd` 중첩도 반영한다. 모든 확률·배당·최종 점수는 서버에서 계산한다.

### v0.10 선택8종
- 1칸 점수 추가는 가중치에서 배당 증가 아이템5종으로 이동한다. 강화 표는 같은 서버 계산 함수로 반영한다.
- 새 런 상태는 `handSequence`, `pendingNextHandWeightBuffs:[{sourceInstanceId,symbol,amount,targetHandSequence}]`를 제공한다. 영수증 인스턴스에는 `purchaseCounter`가 추가된다. 이전 규칙에는 필드가 추가되지 않는다.
- 스핀 이벤트에 `physicalChanged`, `wildMarks`, `handSequence`, `consumedWeightBuffs`, `pendingNextHandWeightBuffs`, `emergency`가 추가된다. 비상 지급은 `{type:'EMERGENCY_HAND_GRANTED',instanceId,itemId,handsGranted}` 또는 null이며 같은 스핀 트랜잭션에 포함된다. 물리 보드는 기존 `rawBoard`/`board`를 유지한다.
- 새 패턴은 `winningPatterns`에 kind `corners`/`crossing`으로 기록되고 합계 `patternScore`에 포함된다. 표시 `presentation.awards`는 line/square/corners/crossing을 지원하고, 효과 stage `next`는 다음 스핀 예약이다. 와일드·강조·배당은 서버 확정 결과다.
- 구매 이벤트에는 `refundCoins`, `refunds:[{type:'RECEIPT_REFUNDED',instanceId,itemId,coins}]`가 포함된다. 구매와 환급/카운터/재고는 함께 커밋되고 동일 요청은 전체 원래 응답을 반환한다. 입력 API 필드는 추가하지 않는다.
