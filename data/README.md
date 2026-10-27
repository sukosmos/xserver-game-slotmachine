# 규칙 데이터 초안

- `balance.v0.json`: 심벌 확률/점수, Hand, 라운드 목표, 경제와 상점.
- `lines.v0.json`: 8개 페이라인 정의(인덱스 0~8).
- `items.v0.json`: **37종** 아이템의 효과·등급·가격·수명·중첩 정의.

`items[].effect.kind`는 선언적 사양이다. `src/domain/rules.js`는 전체 카탈로그의 필수 필드, 심벌 참조, 효과 종류/인수, 가격·수명·배율을 검증하고 **알 수 없는 kind/필드는 오류**를 반환한다. 전투/점수 29종은 `items.js`·`item-scoring.js`·`selected8.js`, Hand 2종은 `hands.js`·`selected8.js`, 경제 6종은 `economy.js`·`shop.js`에서 실행한다. 구매 명령은 서버가 제시한 slotId만 받으며 아이템 ID·가격·수량을 클라이언트가 지정하지 않는다.

규칙 로딩 후 데이터는 읽기 전용이다. 심벌 가중치는 양의 안전 정수이고 합계는 100으로 고정하지 않는다(RNG v1의 합계 범위는 2^32 이하). 점수 필드는 작은 안전 정수 또는 십진 문자열을 받으며 런타임에는 BigInt를 쓴다. 라운드 목표는 십진 문자열만 허용한다. 규칙/라인/카탈로그 버전은 현재 함께 일치해야 하며 리플레이는 데이터 지문도 확인한다.

현재 버전은 **v0.12**다. `economy.startingCoins=3`, `round.autoClearOnTarget=true`로 시작 코인과 자동 정산을 지정한다. `balance.itemRules.boardModifierPriority`가 조작 그룹 순서를 지정한다. 최고점 후보 동률은 `bestCandidateTieBreak`, 후보별 가상 배당 난수 공유는 `bestCandidateVirtualRolls`, 라운드 간 연속 당첨 유지는 `consecutiveWinsCarryAcrossRounds`로 명시한다. 현재 엔진이 지원하지 않는 정책 값은 로더에서 거절한다.

`balance.shop`의 `offerSelection`, `excludeFullInventoryItems`, `allowPreviousOfferItems`, `emptySlotsOnPoolExhaustion`, `vipActivation`은 등급별 추첨·진열·VIP 활성 시점을 명시한다. v0.8의 `economy.clearRewardPerRound=1`은 라운드별 기본 보상 증가량, `round.maxExtraHands=2`는 추가 Hand 상한이다. `items[].minShopRound`는 최초 등장 상점의 완료 라운드를 지정한다. 등급 추첨 구간 순서는 common→rare→epic→legendary이며 JSON 키 순서에 영향받지 않는다. 경제 아이템은 영구 슬롯만 허용하고 실패 보상은 0만 지원한다.

`triggerChanceBasisPoints`: 1600=16%, 6000=60%, 2500=25%. 확률 검사는 독립인 설정이지만 동일 PRNG 스트림을 순서대로 소비하므로 순서가 재현되어야 한다.

고급 점수/라인 조작은 `docs/02-CORE_RULES.md`, `docs/03-ITEM_SYSTEM.md`를 우선 참고하고 불명확한 부분은 `docs/10-DECISIONS.md`에 기록.

v0.10는 상점 4칸과 기존 charged 5종의 상향된 발동 확률을 유지한다. 1칸 점수는 `symbol_line_add_factor.basePointAdd`(정확한 점수 정수)로 지정하며, `weight_add.basePointAdd`는 과거 저장 규칙의 재현에만 사용한다. `lines.v0.json.squares`는 네 개 2×2를 시계방향 좌표로 정의한다. `square_match_bonus` 아이템의 `payoutFactor`는 기본 라인 배당 대비 보너스 비율이며 `usesWildCenter=false`, `countsAsRealWinningLine=false`를 명시한다. 과거 규칙에서 새 선택 필드는 생략 가능하다.

선택 8종은 현재 카탈로그에만 병합하며 `balance.itemRules.selected8Items`로 새 런의 활성화를 제어한다. 1칸 점수 보너스는 이제 배당 증가 5종에 있으며 가중치 5종에는 없다. 신규 효과의 상수 정책/조건도 로더가 검증한다.

v0.11의 `round.milestoneCards`는 등장 라운드와3개 효과를 정의한다. 전체 강화의 `itemIds`는 각 심벌의 점수·배당 보너스를 가진5종을 가리킨다. 삭제/와일드 정책과 참조를 엄격히 검사한다. `economy.baseClearReward=3`, 목표 배열 완화를 함께 적용한다. 이전 규칙은 이 선택 필드 없이 재현된다.

v0.12: `consumableActivation`과 소모 효과의 `triggerPolicy`로 라운드당1회/남은 Hand 역수 추첨을 정의한다. `lastTriggeredRound`는 서버 아이템 인스턴스에 기록한다. 비상 레버70%는 정확한 `minimumTargetRatio`, 뻥튀기는 `spin_multiplier.factor`, 전체 강화는 `spinFactor`, 돈벼락은 `grant_coins.coins=30`, 카드 수는 `offerCount=4`로 정의한다. 기본 보상은4다.
# v0.13 Endless
`balance.round.endless`가 있는 규칙은10라운드 승리 이후 명시적으로 Endless를 시작할 수 있다. `targetGrowth`19/10과 `targetRounding`ceil은 이후 목표에만 적용한다. 스핀 점수·다중 라인 배당에는 자동 성장 배율을 추가하지 않는다. 저장된 이전 규칙은 기존 종료 정책을 유지한다.
