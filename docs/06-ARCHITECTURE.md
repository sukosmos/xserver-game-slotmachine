# 06. 시스템 아키텍처 권고

## 6.1 기술 스택 선택 원칙
기존 서비스의 언어, 프레임워크, DB를 **아직 확인하지 않았다**. Codex는 저장소를 먼저 조사하고 기존 환경을 우선 재사용할 것. 신규 프로젝트라면 타입 안정적인 서버/클라이언트 구현을 권장하지만 특정 라이브러리를 확정하지 않는다.

## 6.2 책임 분리
```text
Client UI
 ├─ 슬롯 애니메이션(서버 확정 결과를 표현)
 ├─ Hand/목표/점수/코인/아이템 및 상점 상태 렌더
 └─ 입력: start / spin / claim / buy / reroll / next
       │ HTTPS
Game API (authoritative)
 ├─ authentication / authorization
 ├─ RunStateMachine + round/hand transitions
 ├─ SlotEngine (weight, RNG, lines, exact scoring)
 ├─ ItemEngine (priority, charges, timed lifecycle)
 ├─ EconomyShopEngine (settle, buy, reroll)
 ├─ Replay / audit event log
 └─ LeaderboardService
       │
Database (runs, item instances, snapshots, actions, leaderboards)
```

## 6.3 중요 불변식
- Spin 요청에 **클라이언트 심벌 배열/점수/코인**을 포함시키지 않는다. 서버가 생성.
- `runId` 주인은 인증된 사용자만 조작 가능.
- 서버에 각 런별 RNG 상태/시드(비밀 또는 보호된 형태), 소비 카운터를 저장; 같은 액션 순서로 재생 가능하게.
- 점수는 **BigInt 계열 정수**로 계산(최종 직렬화는 `"12345678901234567890"`). 수량·라운드 수·코인은 안전한 범위의 정수.
- 실수 배율은 `(numerator,denominator)`로 표현하고 지정된 내림 시점에만 정수 변환.
- 스핀/클레임/구매/리롤은 **트랜잭션**으로 원자 처리.
- 재전송 안전: `Idempotency-Key`를 받아 같은 요청이 중복으로 돈/Hand를 소모하지 않도록 함.
- 서버 기록(아이템·코인·스핀 수)이 랭킹의 유일한 출처.
- DB 저장 시 아이템 정의 `catalogVersion`, 밸런스 `rulesVersion` 기록(업데이트 이후 리플레이 가능).

## 6.4 결정적 난수 처리 권고
- PRNG 알고리즘과 정수 샘플링 알고리즘을 명시하고 버전화.
- 모든 9칸 독립 추첨을 고정 순서로 수행. 리롤/변환/코인 보너스 등 추가 난수 사용 순서도 이벤트에 기록.
- 서버 비밀 시드를 클라이언트에 미리 노출할 필요 없음.
- 일일 챌린지에서 같은 시작 시드를 공유하더라도, 결과를 서버가 처리해야 기록 조작을 막을 수 있음.
- 테스트에서는 주입 가능한 `RandomSource` 인터페이스를 사용하여 일정한 슬롯/아이템 발동 결과를 재현.

## 6.5 점수 계산 함수(의사코드)
```ts
function spin(state: RunState, rng: RandomSource): SpinResult {
  assert(state.phase === 'ROUND_ACTIVE' && state.handsRemaining > 0);
  const weights = applyWeightItems(baseWeights, state.items);
  let board = drawNineSymbols(weights, rng);
  board = applyAtMostOneBoardModifier(board, state.items, rng);
  const lines = evaluateEightLines(board, state.items); // center wildcard possible
  const base = hasDevilsContract(state.items) ? 0n : sumSymbolPoints(board);
  const line = sumLinePayoutsWithExactRationals(lines, state.items);
  const virtual = evaluateVirtualScoreEffects(board, lines, state.items, rng);
  const score = floorRational((base + line + virtual) * globalMultiplier(lines, state));
  return updateHandRoundAndItemTimers(state, board, lines, score);
}
```

모든 '변환 아이템'의 단계/우선순위와 `세븐 2개` 조건은 `03-ITEM_SYSTEM.md`를 참고한다. 예시 의사코드는 실제 숫자 타입을 선택하지 않은 추상 형태.

## 6.6 비기능 요구사항
- 서버 액션마다 권한 검증·유효 상태 확인·요청 빈도 제한.
- 모바일 중심 레이아웃(3×3 정사각형), 효과음/진동/애니메이션 끄기 옵션.
- 슬롯 애니메이션은 로직과 분리: 애니메이션이 끊겨도 서버 결과는 동일.
- 큰 점수 축약 표기(예: `1.2M`, `5.4B`)는 UI 전용. 원본 문자열 확인 가능.
- 게임 메트릭: 라운드별 성공률, 평균 Hand 사용, 평균 구매/리롤, 아이템 pick/win rate를 익명 집계.
