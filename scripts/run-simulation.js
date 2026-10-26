import { createHash } from 'node:crypto';
import { createRun, applyAction, canClaim } from '../src/domain/run.js';
import { getShopView } from '../src/domain/shop.js';
import { CounterRandom } from '../src/server/random.js';
import { requireCondition } from '../src/domain/errors.js';

const average = (sum, count) => count ? `${sum / BigInt(count)}.${(sum % BigInt(count) * 100n / BigInt(count)).toString().padStart(2, '0')}` : null;
export function simulateRuns(rules, { trials = 10000, seed = 'nine-phase5-v1', shopping = true } = {}) {
  requireCondition(Number.isSafeInteger(trials) && trials > 0, 'INVALID_SIMULATION_SIZE');
  const rounds = rules.targets.map((target, i) => ({ round: i + 1, target: String(target), attempts: 0, clears: 0, rewards: 0n, purchaseSpend: 0n, rerollSpend: 0n }));
  const items = Object.fromEntries(rules.catalog.items.map((item) => [item.id, { purchases: 0, activeRounds: 0, clearedActiveRounds: 0 }]));
  const definitions = new Map(rules.catalog.items.map((item) => [item.id, item]));
  let totalScore = 0n, maxScore = 0n, won = 0, spins = 0, actions = 0, peakCoins = 0;
  for (let trial = 0; trial < trials; trial++) {
    const rng = new CounterRandom(createHash('sha256').update(`${seed}:${trial}`).digest('hex'));
    let state = createRun(rules), observedRound = 0, active = new Set();
    while (!['RUN_FAILED', 'RUN_WON'].includes(state.phase)) {
      const row = rounds[state.roundIndex - 1];
      if (state.phase === 'ROUND_ACTIVE' && observedRound !== state.roundIndex) {
        observedRound = state.roundIndex; row.attempts++;
        active = new Set(state.items.filter((item) => item.activeFromRound <= state.roundIndex).map((item) => item.itemId));
        for (const id of active) items[id].activeRounds++;
      }
      let action;
      if (state.phase === 'ROUND_ACTIVE') action = { type: canClaim(state) ? 'CLAIM' : 'SPIN' };
      else {
        const shop = getShopView(state, rules);
        // Fixed policy: affordable non-economy first, then cheaper, then stable ID.
        const offers = shop.slots.filter((slot) => slot.canBuy).sort((a, b) => {
          const x = definitions.get(a.itemId), y = definitions.get(b.itemId);
          return Number(x.category === 'economy') - Number(y.category === 'economy') || a.price - b.price || a.itemId.localeCompare(b.itemId, 'en');
        });
        if (shopping && offers.length) action = { type: 'BUY', slotId: offers[0].slotId };
        else if (shopping && shop.canReroll && (shop.freeRerollsRemaining > 0 || (shop.paidRerolls === 0 && state.coins >= shop.rerollPrice + Math.min(...rules.catalog.items.map((item) => item.price))))) action = { type: 'REROLL' };
        else action = { type: 'CONTINUE' };
      }
      const result = applyAction(state, action, rules, rng); state = result.state; actions++;
      requireCondition(Number.isSafeInteger(state.coins) && state.coins >= 0 && state.handsRemaining >= 0 && state.handsRemaining <= rules.balance.round.baseHands, 'SIMULATION_INVARIANT');
      peakCoins = Math.max(peakCoins, state.coins);
      if (action.type === 'SPIN') spins++;
      if (result.event.settlement) {
        row.clears++; row.rewards += BigInt(result.event.settlement.reward);
        for (const id of active) items[id].clearedActiveRounds++;
      }
      if (action.type === 'BUY') { row.purchaseSpend += BigInt(result.event.price); items[result.event.itemId].purchases++; }
      if (action.type === 'REROLL') row.rerollSpend += BigInt(result.event.price);
    }
    if (state.phase === 'RUN_WON') won++;
    totalScore += state.runTotalScore; if (state.runTotalScore > maxScore) maxScore = state.runTotalScore;
  }
  return {
    rulesVersion: rules.rulesVersion, trials, seed, policy: shopping ? 'claim-early-buy-non-economy-cheapest-v1' : 'claim-early-no-shopping-v1',
    won, failed: trials - won, spins, actions, peakCoins, meanRunScore: average(totalScore, trials), maxRunScore: String(maxScore),
    rounds: rounds.map(({ rewards, purchaseSpend, rerollSpend, ...row }) => ({ ...row, conditionalClearRate: row.attempts ? row.clears / row.attempts : null,
      meanRewardPerClear: average(rewards, row.clears), totalRewards: String(rewards), totalPurchaseSpend: String(purchaseSpend), totalRerollSpend: String(rerollSpend) })),
    items,
    interpretation: 'Fixed-policy sample. Item possession and clears are correlated observations, not isolated causal item strength. No balance values changed.',
  };
}
