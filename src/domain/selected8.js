import { requireCondition } from './errors.js';
import { getItem } from './rules.js';
import { activeItems } from './inventory.js';

export const hasSelected8 = (rules) => rules.balance.itemRules.selected8Items === true;

export function nextHandSequence(state) {
  const sequence = state.handSequence ?? 0;
  requireCondition(Number.isSafeInteger(sequence) && sequence >= 0 && sequence < Number.MAX_SAFE_INTEGER - 1, 'HAND_SEQUENCE_EXHAUSTED');
  return sequence + 1;
}

/** Only a live source's exact next-draw reservation can change weights. */
export function dueWeightBuffs(state, rules, active = activeItems(state.items, rules, state.roundIndex)) {
  if (!hasSelected8(rules)) return [];
  const target = nextHandSequence(state), pending = state.pendingNextHandWeightBuffs ?? [];
  requireCondition(Array.isArray(pending), 'INVALID_PENDING_BUFF');
  const seen = new Set();
  return pending.filter((buff) => {
    requireCondition(buff && !seen.has(buff.sourceInstanceId), 'INVALID_PENDING_BUFF');
    seen.add(buff.sourceInstanceId);
    const source = active.find((instance) => instance.instanceId === buff.sourceInstanceId);
    if (!source || buff.targetHandSequence !== target || buff.symbol === [state.milestoneReward,...(state.additionalMilestoneRewards ?? state.milestoneRewards?.slice(1) ?? [])].find(r=>r?.removedSymbol)?.removedSymbol) return false;
    const effect = getItem(rules, source.itemId).effect;
    requireCondition(effect.kind === 'queue_next_hand_weight_if_symbol_absent' && buff.symbol === effect.bonusSymbol && buff.amount === effect.bonusWeight, 'INVALID_PENDING_BUFF');
    return true;
  }).map((buff) => ({ ...buff }));
}

export function queueWeightBuffs(board, active, rules, handSequence, removedSymbol = null) {
  return active.flatMap((instance) => {
    const e = getItem(rules, instance.itemId).effect;
    return e.kind === 'queue_next_hand_weight_if_symbol_absent' && e.bonusSymbol !== removedSymbol && !board.includes(e.absentSymbol)
      ? [{ sourceInstanceId: instance.instanceId, symbol: e.bonusSymbol, amount: e.bonusWeight, targetHandSequence: handSequence + 1 }] : [];
  });
}

/** Pure last-chance transition, after scoring but before committing failure/ranking. */
export function rescueHand(state, rules) {
  if (!hasSelected8(rules) || state.phase !== 'ROUND_ACTIVE' || state.handsRemaining !== 0 || state.roundScore >= state.targetScore) return { state, emergency: null };
  const instance = activeItems(state.items, rules, state.roundIndex).find((i) => ['grant_hand_before_run_failed','clear_round_before_run_failed'].includes(getItem(rules, i.itemId).effect.kind));
  if (!instance) return { state, emergency: null };
  const e = getItem(rules, instance.itemId).effect;
  if (e.kind === 'clear_round_before_run_failed' && state.roundScore * BigInt(e.minimumTargetRatio.den) < state.targetScore * BigInt(e.minimumTargetRatio.num)) return {state,emergency:null};
  const items = state.items.flatMap((i) => i.instanceId !== instance.instanceId ? [{ ...i }] : i.remainingCharges > 1 ? [{ ...i, remainingCharges: i.remainingCharges - 1 }] : []);
  if (e.kind === 'clear_round_before_run_failed') return {state:{...state,items},emergency:{type:'EMERGENCY_ROUND_CLEARED',instanceId:instance.instanceId,itemId:instance.itemId}};
  return { state: { ...state, items, handsRemaining: e.handsGranted }, emergency: {
    type: 'EMERGENCY_HAND_GRANTED', instanceId: instance.instanceId, itemId: instance.itemId, handsGranted: e.handsGranted,
  } };
}
