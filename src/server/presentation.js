import { getItem } from '../domain/rules.js';
import { decimalRatio, percent } from './display.js';

/** Display projection of an already resolved spin. No draws, state changes or audit fields. */
export function spinPresentation(event, rules) {
  if (event?.type !== 'SPIN_RESOLVED') return null;
  const effects = [], lines = event.winningLines;
  if (event.milestoneWild) effects.push({ itemId:null, name:'영구 조커', label:'중앙 WILD · 이번 라운드 1회', stage:'board' });
  const add = (itemId, label, stage = 'score') => effects.push({ itemId, name: getItem(rules, itemId).nameKo, label, stage });
  for (const trigger of event.triggeredItems) {
    const e = getItem(rules, trigger.itemId).effect;
    const labels = {
      wild_center: '중앙 WILD', reroll_last_column: '오른쪽 열 재추첨',
      convert_random_nonseven_to_seven: '세븐 +1칸', best_candidate_edit: '최고 득점 완성',
      random_candidate_edit: e.selectedLineMultiplier ? `라인 완성 · ×${decimalRatio(e.selectedLineMultiplier)}` : '라인 완성',
      virtual_cherry_line_bonus: `+${trigger.bonus ?? 0}점`,
      copy_physical_column: '오른쪽 열 복사', place_random_temporary_wild_mark: '임시 WILD +1칸',
    };
    add(trigger.itemId, labels[e.kind], e.kind === 'virtual_cherry_line_bonus' ? 'score' : 'board');
  }
  const counts = new Map();
  for (const active of event.activeEffects) counts.set(active.itemId, (counts.get(active.itemId) ?? 0) + 1);
  for (const [itemId, stacks] of counts) {
    const e = getItem(rules, itemId).effect;
    if (e.kind === 'weight_add') add(itemId, `가중치 +${BigInt(e.amount) * BigInt(stacks)}${e.basePointAdd ? ` · 1칸 +${BigInt(e.basePointAdd) * BigInt(stacks)}점` : ''}`, 'draw');
    if (e.kind === 'square_match_bonus') {
      const squares = (event.winningPatterns ?? []).filter((p) => !p.kind || p.kind === 'square');
      if (squares.length) add(itemId, `2×2 ${squares.length}개 · +${squares.reduce((sum, p) => sum + BigInt(p.score), 0n)}점`);
    }
    if (e.kind === 'queue_next_hand_weight_if_symbol_absent') {
      if (event.consumedWeightBuffs?.some((b) => event.activeEffects.some((a) => a.itemId === itemId && a.instanceId === b.sourceInstanceId))) add(itemId, `세븐 가중치 +${e.bonusWeight}`, 'draw');
      if (!['RUN_WON', 'RUN_FAILED'].includes(event.outcome) && event.pendingNextHandWeightBuffs?.some((b) => event.activeEffects.some((a) => a.itemId === itemId && a.instanceId === b.sourceInstanceId))) add(itemId, `다음 스핀 세븐 +${e.bonusWeight}`, 'next');
    }
    if (['award_pattern_points_if_equal_corners', 'award_pattern_points_for_crossing_cells'].includes(e.kind)) {
      const pattern = event.winningPatterns?.find((p) => p.kind === (e.kind === 'award_pattern_points_if_equal_corners' ? 'corners' : 'crossing'));
      if (pattern) add(itemId, `+${pattern.score}점`);
    }
    if (e.kind === 'multiply_actual_line_payout_if_physical_board_changed' && event.physicalChanged && lines.length) add(itemId, `라인 ×${decimalRatio(e.factor)}`);
    if (e.kind === 'symbol_line_add_factor' && lines.some((line) => line.symbol === e.symbol))
      add(itemId, `배당 +${percent({ num: BigInt(e.extraFactor.num) * BigInt(stacks), den: e.extraFactor.den })}${e.basePointAdd ? ` · 1칸 +${BigInt(e.basePointAdd) * BigInt(stacks)}` : ''}`);
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
  effects.sort((a, b) => ['draw', 'board', 'score', 'next', 'clear'].indexOf(a.stage) - ['draw', 'board', 'score', 'next', 'clear'].indexOf(b.stage));
  const names = { row_top: '가로 1', row_middle: '가로 2', row_bottom: '가로 3', col_left: '세로 1', col_middle: '세로 2', col_right: '세로 3', diag_main: '대각선 ↘', diag_anti: '대각선 ↙' };
  const awards = [
    ...lines.map((line) => ({ kind: 'line', id: line.lineId, label: names[line.lineId], indices: rules.lines.find((l) => l.id === line.lineId).indices, symbol: line.symbol, score: String(line.score) })),
    ...(event.winningPatterns ?? []).map((pattern) => ({ kind: pattern.kind ?? 'square', id: pattern.patternId,
      label: pattern.kind === 'corners' ? '모서리' : pattern.kind === 'crossing' ? '교차' : '2×2', indices: pattern.indices, symbol: pattern.symbol, score: String(pattern.score) })),
  ];
  return { multiplier: `×${decimalRatio(event.globalMultiplier)}`, effects, awards,
    ...(event.emergency ? { emergency: { name: getItem(rules, event.emergency.itemId).nameKo, handsGranted: event.emergency.handsGranted } } : {}),
    expired: event.expiredItems.map((item) => ({ itemId: item.itemId, name: getItem(rules, item.itemId).nameKo })) };
}
