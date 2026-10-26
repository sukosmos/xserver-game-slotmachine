# 06. 시스템 아키텍처 권고

## 6.1 기술 스택 선택 원칙
2026-10-25 저장소 조사 결과 기존 서비스 코드, 프레임워크, DB, 인증 연동은 없었다. Phase 0~1은 Node.js 22 ES modules와 내장 테스트 러너로 구현했다. `src/domain`은 순수 규칙/점수/라운드 전환이고 `src/server`는 파일 로딩, 비밀 RNG, 메모리 세션을 담당한다. 프로덕션 웹 프레임워크·DB·인증 선택은 보류하며 이후 연동 대상이 생기면 해당 환경을 우선 사용한다.

Phase 2에서 `inventory.js`, `item-scoring.js`, `items.js`로 인벤토리와 아이템 실행을 추가했다. Phase 3은 `economy.js`, `shop.js`, `money.js`로 보상·상품·결제를 연결한다. 공개할 결과와 서버 전용 난수 추첨 기록을 분리하며, 세션은 난수 기록을 `slot-audit-v3` 감사 로그에만 보관한다. 서버가 주입한 시작 아이템도 리플레이 입력에 포함한다.

메모리 `GameSession`은 순수 전환과 중복 응답을 관리하며 Phase 4의 `GameStore`가 내구성을 담당한다. 명령은 SQLite 쓰기 트랜잭션 안에서 저장된 규칙/감사 로그로 세션을 복구하고, 복제한 RNG로 계산한 뒤 런과 최고 기록을 함께 커밋한다. 커밋 전 오류가 나면 메모리 캐시도 유지하지 않아 다음 요청은 마지막 저장 상태에서 시작한다. 내장 Node HTTP와 토큰 검증을 연결했고 브라우저 UI와 운영 로그인 공급자 연동은 후속이다. 세부 범위와 RNG 명세는 `10-DECISIONS.md` 10.5~10.8을 따른다.

SQLite 파일은 WAL/FULL 모드이며 [BEGIN IMMEDIATE](https://www.sqlite.org/lang_transaction.html)로 여러 연결의 쓰기를 직렬화한다. 물리 테이블은 `runs`(암호화된 전체 액션/스냅샷), `rulesets`(규칙 원본), `creations`(런 생성 중복 응답), `tokens`(인증 토큰 해시), `leaderboard`(계정별 최고 기록), `metadata`(키 확인)다. 현재 전체 로그 재생은 구현을 단순하게 유지하는 MVP 선택이며 긴 런/대규모 트래픽에서는 스냅샷 최적화가 필요하다.

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
