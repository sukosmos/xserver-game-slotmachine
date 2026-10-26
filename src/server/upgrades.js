import { activeItems } from '../domain/inventory.js';
import { weightedSymbols, symbolScores } from '../domain/item-scoring.js';
import { getItem } from '../domain/rules.js';
import { roundHands } from '../domain/hands.js';
import { dueWeightBuffs } from '../domain/selected8.js';
import { scoringItems, milestoneRewardView } from '../domain/milestone.js';

function percentage(weight, total) {
  const hundredths = (BigInt(weight) * 10000n + BigInt(total) / 2n) / BigInt(total);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}%`;
}
function grouped(instances) {
  const counts = new Map();
  for (const instance of instances) counts.set(instance.itemId, (counts.get(instance.itemId) ?? 0) + 1);
  return [...counts].map(([itemId, stacks]) => ({ itemId, stacks }));
}

/** Derived display data only: never stored inside v3 audit responses or used as input. */
export function upgradeView(state, rules) {
  const baseTotal = rules.symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
  function snapshot(roundIndex) {
    const active = activeItems(state.items, rules, roundIndex);
    const scores = new Map(symbolScores(rules, scoringItems(state, rules, active)).map((symbol) => [symbol.id, symbol]));
    const pending = dueWeightBuffs(state, rules, active);
    const removedSymbol = state.milestoneReward?.removedSymbol;
    const weighted = weightedSymbols(rules, active, pending, removedSymbol);
    const totalWeight = weighted.reduce((sum, symbol) => sum + symbol.weight, 0);
    // Ownership discount applies immediately, unlike next-round spin effects.
    const effectItems = state.items.filter((instance) => instance.activeFromRound <= roundIndex
      || getItem(rules, instance.itemId).effect.kind === 'shop_item_cost_subtract');
    return {
      roundIndex, totalWeight, hands: roundIndex === state.roundIndex ? (state.roundHands ?? rules.balance.round.baseHands) : roundHands(rules, state.items, roundIndex),
      ...(state.milestoneReward ? { milestoneReward:milestoneRewardView(state,rules) } : {}),
      symbols: rules.symbols.map((baseSymbol) => {
        const symbol = weighted.find((s) => s.id === baseSymbol.id) ?? { ...baseSymbol, weight:0 };
        const base = rules.symbolsById[symbol.id], score = scores.get(symbol.id);
        return { id: symbol.id, basePoint: String(base.basePoint), point: String(score.point),
          baseLinePayout: String(base.linePayout), linePayout: String(score.linePayout),
          baseWeight: base.weight, weight: symbol.weight, baseProbability: percentage(base.weight, baseTotal), probability: percentage(symbol.weight, totalWeight),
          ...(symbol.id === removedSymbol ? { removed:true } : {}),
          sources: grouped(active.filter((instance) => {
            const effect = getItem(rules, instance.itemId).effect;
            return effect.symbol === symbol.id || pending.some((buff) => buff.sourceInstanceId === instance.instanceId && buff.symbol === symbol.id)
              || ['conditional_per_line_factor', 'zero_base_plus_per_real_line_factor'].includes(effect.kind);
          })),
        };
      }),
      effects: grouped(effectItems.filter((instance) => !['weight_add', 'symbol_line_add_factor'].includes(getItem(rules, instance.itemId).effect.kind))),
    };
  }
  return { revision: state.revision, current: snapshot(state.roundIndex), next: state.phase === 'SHOP' ? snapshot(state.roundIndex + 1) : null };
}
