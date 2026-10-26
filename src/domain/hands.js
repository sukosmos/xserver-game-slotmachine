import { activeItems } from './inventory.js';
import { getItem } from './rules.js';
import { safeAmount } from './money.js';

/** Fixed at round start; buying or discarding in a shop affects the next round. */
export function roundHands(rules, items, roundIndex) {
  const extra = activeItems(items, rules, roundIndex).reduce((sum, instance) => {
    const effect = getItem(rules, instance.itemId).effect;
    return sum + (effect.kind === 'round_hands_add' ? BigInt(effect.amount) : 0n);
  }, 0n);
  const cap = BigInt(rules.balance.round.maxExtraHands ?? 0);
  return safeAmount(BigInt(rules.balance.round.baseHands) + (extra < cap ? extra : cap), 'INVALID_HANDS');
}
