# 규칙 데이터 초안

- `balance.v0.json`: 심벌 확률/점수, Hand, 라운드 목표, 경제와 상점.
- `lines.v0.json`: 8개 페이라인 정의(인덱스 0~8).
- `items.v0.json`: **27종** 아이템의 효과·등급·가격·수명·중첩 정의.

`items[].effect.kind`는 아직 코드 구현 전의 선언적 사양이다. 프로덕션에서 사용하기 전 파서/스키마를 구축하고 **지원하지 않는 kind는 무시하지 말고 오류**를 반환할 것.

`triggerChanceBasisPoints`: 800=8%, 3000=30%, 2500=25%. 확률 검사는 독립인 설정이지만 동일 PRNG 스트림을 순서대로 소비하므로 순서가 재현되어야 한다.

고급 점수/라인 조작은 `docs/02-CORE_RULES.md`, `docs/03-ITEM_SYSTEM.md`를 우선 참고하고 불명확한 부분은 `docs/10-DECISIONS.md`에 기록.
