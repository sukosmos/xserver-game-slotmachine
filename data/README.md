# 규칙 데이터 초안

- `balance.v0.json`: 심벌 확률/점수, Hand, 라운드 목표, 경제와 상점.
- `lines.v0.json`: 8개 페이라인 정의(인덱스 0~8).
- `items.v0.json`: **27종** 아이템의 효과·등급·가격·수명·중첩 정의.

`items[].effect.kind`는 선언적 사양이다. `src/domain/rules.js`는 전체 카탈로그의 필수 필드, 심벌 참조, 효과 종류/인수, 가격·수명·배율을 검증하고 **알 수 없는 kind/필드는 오류**를 반환한다. `src/domain/items.js`와 `item-scoring.js`는 22종 전투/점수 효과를 실행한다. 경제 5종은 `economy.js`/`shop.js`에서 실행한다. 구매 명령은 서버가 제시한 slotId만 받으며 아이템 ID·가격·수량을 클라이언트가 지정하지 않는다.

규칙 로딩 후 데이터는 읽기 전용이다. 심벌 가중치는 양의 안전 정수이고 합계는 100으로 고정하지 않는다(RNG v1의 합계 범위는 2^32 이하). 점수 필드는 작은 안전 정수 또는 십진 문자열을 받으며 런타임에는 BigInt를 쓴다. 라운드 목표는 십진 문자열만 허용한다. 규칙/라인/카탈로그 버전은 현재 함께 일치해야 하며 리플레이는 데이터 지문도 확인한다.

현재 버전은 **v0.6**다. `balance.itemRules.boardModifierPriority`가 조작 그룹 순서를 지정한다. 최고점 후보 동률은 `bestCandidateTieBreak`, 후보별 가상 배당 난수 공유는 `bestCandidateVirtualRolls`, 라운드 간 연속 당첨 유지는 `consecutiveWinsCarryAcrossRounds`로 명시한다. 현재 엔진이 지원하지 않는 정책 값은 로더에서 거절한다.

`balance.shop`의 `offerSelection`, `excludeFullInventoryItems`, `allowPreviousOfferItems`, `emptySlotsOnPoolExhaustion`, `vipActivation`은 등급별 추첨·진열·VIP 활성 시점을 명시한다. 가격/가중치/보상은 v0.5와 동일하다. 등급 추첨 구간 순서는 common→rare→epic→legendary이며 JSON 키 순서에 영향받지 않는다. 경제 아이템은 영구 슬롯만 허용하고 실패 보상은 0만 지원한다.

`triggerChanceBasisPoints`: 800=8%, 3000=30%, 2500=25%. 확률 검사는 독립인 설정이지만 동일 PRNG 스트림을 순서대로 소비하므로 순서가 재현되어야 한다.

고급 점수/라인 조작은 `docs/02-CORE_RULES.md`, `docs/03-ITEM_SYSTEM.md`를 우선 참고하고 불명확한 부분은 `docs/10-DECISIONS.md`에 기록.
