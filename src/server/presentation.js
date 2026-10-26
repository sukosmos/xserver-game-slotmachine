import { getItem } from '../domain/rules.js';
import { decimalRatio, percent } from './display.js';

/** Display projection of an already resolved spin. No draws, state changes or audit fields. */
export function spinPresentation(event, rules) {
  if (event?.type !== 'SPIN_RESOLVED') return null;
  const effects = [], lines = event.winningLines;
  const add = (itemId, label, stage = 'score') => effects.push({ itemId, name: getItem(rules, itemId).nameKo, label, stage });
  for (const trigger of event.triggeredItems) {
    const e = getItem(rules, trigger.itemId).effect;
    const labels = {
      wild_center: '중앙 WILD', reroll_last_column: '오른쪽 열 재추첨',
      convert_random_nonseven_to_seven: '세븐 +1칸', best_candidate_edit: '최고 득점 완성',
      random_candidate_edit: e.selectedLineMultiplier ? `라인 완성 · ×${decimalRatio(e.selectedLineMultiplier)}` : '라인 완성',
      virtual_cherry_line_bonus: `+${trigger.bonus ?? 0}점`,
    };
    add(trigger.itemId, labels[e.kind], e.kind === 'virtual_cherry_line_bonus' ? 'score' : 'board');
  }
  const counts = new Map();
  for (const active of event.activeEffects) counts.set(active.itemId, (counts.get(active.itemId) ?? 0) + 1);
  for (const [itemId, stacks] of counts) {
    const e = getItem(rules, itemId).effect;
    if (e.kind === 'weight_add') add(itemId, `가중치 +${BigInt(e.amount) * BigInt(stacks)}`, 'draw');
    if (e.kind === 'symbol_line_add_factor' && lines.some((line) => line.symbol === e.symbol))
      add(itemId, `배당 +${percent({ num: BigInt(e.extraFactor.num) * BigInt(stacks), den: e.extraFactor.den })}`);
    if (e.kind === 'spin_multiplier_if_min_real_lines' && lines.length >= e.minRealWinningLines) add(itemId, `×${decimalRatio(e.factor)}`);
    if (e.kind === 'consecutive_win_multiplier') {
      const exponent = BigInt(Math.min(Math.max(event.consecutiveWinHands - 1, 0), e.maxExponent)) * BigInt(stacks);
      if (exponent > 0n) add(itemId, `×${decimalRatio({ num: BigInt(e.factorPerExtraHit.num) ** exponent, den: BigInt(e.factorPerExtraHit.den) ** exponent })}`);
    }
    if (e.kind === 'conditional_per_line_factor' && lines.length) {
      const factors = [...new Set(lines.map((line) => decimalRatio(line.symbol === 'seven' ? e.forSeven : e.forOther)))];
      add(itemId, `라인 ${factors.map((f) => `×${f}`).join(' · ')}`);
    }
    if (e.kind === 'zero_base_plus_per_real_line_factor') add(itemId, `기본 0${lines.length ? ` · 배당 ×${decimalRatio(e.perRealLineFactor)}` : ''}`);
  }
  const settlement = event.settlement;
  if (settlement?.itemBaseBonus) add(rules.catalog.items.find((item) => item.effect.kind === 'clear_base_coins_add').id, `+${settlement.itemBaseBonus}코인`, 'clear');
  if (settlement?.interest > rules.balance.economy.interestCap) add(rules.catalog.items.find((item) => item.effect.kind === 'interest_cap_add').id, `이자 +${settlement.interest}코인`, 'clear');
  for (const trigger of settlement?.triggeredItems ?? []) add(trigger.itemId, `+${trigger.coins}코인`, 'clear');
  effects.sort((a, b) => ['draw', 'board', 'score', 'clear'].indexOf(a.stage) - ['draw', 'board', 'score', 'clear'].indexOf(b.stage));
  return { multiplier: `×${decimalRatio(event.globalMultiplier)}`, effects,
    expired: event.expiredItems.map((item) => ({ itemId: item.itemId, name: getItem(rules, item.itemId).nameKo })) };
}
