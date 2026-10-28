import { hasExpansion } from './expansion-contract.js';
import { getItem } from './rules.js';

export { hasExpansion };
export const hasEffect = (items, rules, kind) => items.some(i => getItem(rules, i.itemId).effect.kind === kind);

// Basis points are rounded once after additive relative boosts, never via floating point.
export function procChance(baseBp, hasKaiji, hasModulator = false) {
  return Math.min(10000, Number(BigInt(baseBp) * BigInt(2 + Number(hasKaiji) + Number(hasModulator)) / 2n));
}
export function procDetails(baseBp, active, rules) {
  const sources = active.filter(i => getItem(rules,i.itemId).effect.kind === 'modify_item_proc_chances');
  return { baseBp, effectiveBp: procChance(baseBp, sources.length > 0), sources: sources.map(i=>i.itemId) };
}
export function finishExpansionRound(state, rules) {
  if (!hasExpansion(rules)) return [];
  const expired = state.items.filter(i => getItem(rules,i.itemId).slot === 'round' && i.activeFromRound <= state.roundIndex);
  state.items = state.items.filter(i => !expired.includes(i));
  state.midasDiamondCountThisRound = 0;
  return expired.map(({instanceId,itemId})=>({instanceId,itemId}));
}
