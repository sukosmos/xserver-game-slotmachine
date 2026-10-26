import { getItem } from './rules.js';
import { requireCondition } from './errors.js';
import { exactInteger } from './exact.js';
import { activeItems, acquisitionOrder, finishItemSpin } from './inventory.js';
import { weightedSymbols, scoreWithItems } from './item-scoring.js';
import { createWeightedTable, drawBoard, drawSymbol, evaluateLines, validateBoard } from './slot.js';
import { hasSelected8, nextHandSequence, dueWeightBuffs, queueWeightBuffs } from './selected8.js';
import { selected8Contracts } from './selected8-contract.js';
import { hasMilestone, scoringItems, rewardDefinition } from './milestone.js';

const spinKinds = new Set([
  'weight_add', 'symbol_line_add_factor', 'random_candidate_edit', 'wild_center', 'reroll_last_column',
  'virtual_cherry_line_bonus', 'convert_random_nonseven_to_seven', 'best_candidate_edit',
  'spin_multiplier_if_min_real_lines', 'conditional_per_line_factor', 'zero_base_plus_per_real_line_factor', 'consecutive_win_multiplier',
  'square_match_bonus',
  ...Object.keys(selected8Contracts).filter((kind) => !['refund_coins_every_n_item_purchases', 'grant_hand_before_run_failed'].includes(kind)),
]);
// Settlement/shop/round-start effects never consume a spin trigger.
const economicKinds = new Set(['clear_base_coins_add', 'interest_cap_add', 'one_free_reroll_per_shop', 'shop_item_cost_subtract', 'chance_coins_on_clear', 'round_hands_add', 'refund_coins_every_n_item_purchases', 'grant_hand_before_run_failed']);

export function candidateLines(board, rules) {
  validateBoard(board, rules);
  return rules.lines.flatMap(({ id, indices }) => {
    const counts = new Map();
    for (const index of indices) counts.set(board[index], (counts.get(board[index]) ?? 0) + 1);
    const pair = [...counts].find(([, count]) => count === 2);
    if (!pair) return [];
    return [{ lineId: id, changeIndex: indices.find((index) => board[index] !== pair[0]), newSymbol: pair[0] }];
  });
}

function edit(board, candidate) {
  const changed = [...board];
  changed[candidate.changeIndex] = candidate.newSymbol;
  return changed;
}

/** All spin effects share one ordered RNG stream. randomTrace is server-private. */
export function spinWithItems(rules, rng, state = {}) {
  const { items = [], roundIndex = 1, consecutiveWinHands = 0 } = state;
  const extended = hasSelected8(rules);
  const active = activeItems(items, rules, roundIndex);
  const scoringActive = scoringItems(state, rules, active);
  const removedSymbol = state.milestoneReward?.removedSymbol;
  const milestoneWild = Boolean(state.roundWildAvailable && rewardDefinition(state, rules)?.effect.kind === 'first_hand_wild_each_round');
  for (const instance of active) {
    const kind = getItem(rules, instance.itemId).effect.kind;
    requireCondition(spinKinds.has(kind) || economicKinds.has(kind), 'UNSUPPORTED_ITEM_EFFECT');
  }
  requireCondition(Number.isSafeInteger(consecutiveWinHands) && consecutiveWinHands >= 0 && consecutiveWinHands < Number.MAX_SAFE_INTEGER, 'INVALID_WIN_STREAK');
  const consumedWeightBuffs = dueWeightBuffs(state, rules, active);
  const symbols = weightedSymbols(rules, active, consumedWeightBuffs, removedSymbol);
  const table = createWeightedTable(symbols);
  const randomTrace = [];
  const draw = (bound, purpose, instanceId = null) => {
    const value = rng.nextInt(bound);
    requireCondition(Number.isSafeInteger(value) && value >= 0 && value < bound, 'INVALID_RANDOM_VALUE');
    randomTrace.push({ purpose, instanceId, bound, value });
    return value;
  };
  const rawBoard = drawBoard(rules, { nextInt: (bound) => draw(bound, 'board_cell') }, symbols);
  let board = [...rawBoard];
  let lineBonus = null;
  const triggeredItems = [];
  const triggeredIds = new Set();
  const trigger = (instance, details = {}) => {
    triggeredIds.add(instance.instanceId);
    triggeredItems.push({ instanceId: instance.instanceId, itemId: instance.itemId, kind: getItem(rules, instance.itemId).effect.kind, ...details });
  };

  const virtualItems = active.filter((instance) => getItem(rules, instance.itemId).effect.kind === 'virtual_cherry_line_bonus');
  const virtualRolls = new Map();
  const wildCenter = milestoneWild || active.some((instance) => getItem(rules, instance.itemId).effect.kind === 'wild_center');
  const wildMarks = wildCenter ? [4] : [];
  const changed = (candidateBoard) => candidateBoard.some((symbol, i) => symbol !== rawBoard[i]);
  function virtualBonus(candidateBoard, recordTriggers = false) {
    if (virtualItems.length === 0 || evaluateLines(candidateBoard, rules, { wildCenter, wildMarks }).length === rules.lines.length) return 0n;
    let bonus = 0n;
    for (const instance of virtualItems) {
      const effect = getItem(rules, instance.itemId).effect;
      if (!virtualRolls.has(instance.instanceId)) virtualRolls.set(instance.instanceId, draw(10000, 'virtual_bonus', instance.instanceId));
      if (virtualRolls.get(instance.instanceId) < effect.triggerChanceBasisPoints) {
        bonus += exactInteger(effect.fixedPoints);
        if (recordTriggers) trigger(instance, { bonus: exactInteger(effect.fixedPoints) });
      }
    }
    return bonus;
  }
  const preview = (candidateBoard) => scoreWithItems(candidateBoard, rules, scoringActive, { consecutiveWinHands, wildMarks, virtualScore: virtualBonus(candidateBoard), physicalChanged: changed(candidateBoard) }).spinScore;
  const priorities = rules.balance.itemRules.boardModifierPriority;
  const modifiers = active.filter((instance) => getItem(rules, instance.itemId).effect.boardPriority !== undefined).sort((a, b) => {
    return priorities.indexOf(getItem(rules, a.itemId).effect.boardPriority) - priorities.indexOf(getItem(rules, b.itemId).effect.boardPriority) || acquisitionOrder(a, b);
  });
  for (const instance of modifiers) {
    const effect = getItem(rules, instance.itemId).effect;
    let candidates;
    let selected;
    let nonsevens;
    if (effect.kind === 'reroll_last_column') {
      if (evaluateLines(board, rules).length !== 0) continue;
    } else if (effect.kind === 'convert_random_nonseven_to_seven') {
      if (removedSymbol === 'seven') continue;
      nonsevens = board.flatMap((symbol, index) => symbol !== 'seven' ? [index] : []);
      if (board.length - nonsevens.length < 2 || nonsevens.length === 0) continue;
    } else if (effect.kind === 'copy_physical_column') {
      if (effect.sourceCellIndices.every((index, i) => board[index] === board[effect.targetCellIndices[i]])) continue;
    } else {
      candidates = candidateLines(board, rules);
      if (candidates.length === 0) continue;
      if (effect.kind === 'best_candidate_edit') {
        const before = preview(board);
        let bestDelta = 0n;
        for (const candidate of candidates) {
          const delta = preview(edit(board, candidate)) - before;
          if (delta > bestDelta) { bestDelta = delta; selected = { ...candidate, scoreDelta: delta }; }
        }
        if (!selected) continue;
      }
    }
    if (draw(10000, 'board_trigger', instance.instanceId) >= effect.triggerChanceBasisPoints) continue;
    if (effect.kind === 'reroll_last_column') {
      const before = [...board];
      const indices = [];
      for (let row = 0; row < rules.balance.board.rows; row++) {
        const index = row * rules.balance.board.cols + rules.balance.board.cols - 1;
        indices.push(index);
        board[index] = drawSymbol(table, { nextInt: (bound) => draw(bound, 'reroll_cell', instance.instanceId) });
      }
      if (extended && board.every((symbol, i) => symbol === before[i])) continue;
      trigger(instance, { indices });
    } else if (effect.kind === 'convert_random_nonseven_to_seven') {
      const changeIndex = nonsevens[draw(nonsevens.length, 'seven_selection', instance.instanceId)];
      board[changeIndex] = 'seven';
      trigger(instance, { changeIndex, newSymbol: 'seven' });
    } else if (effect.kind === 'copy_physical_column') {
      effect.targetCellIndices.forEach((index, i) => { board[index] = board[effect.sourceCellIndices[i]]; });
      trigger(instance, { indices: [...effect.targetCellIndices] });
    } else {
      selected ??= candidates[draw(candidates.length, 'candidate_selection', instance.instanceId)];
      board = edit(board, selected);
      if (effect.selectedLineMultiplier) lineBonus = { lineId: selected.lineId, factor: effect.selectedLineMultiplier };
      trigger(instance, selected);
    }
    break; // Maximum one successful physical modifier per Hand.
  }

  for (const instance of active) {
    if (getItem(rules, instance.itemId).effect.kind === 'wild_center') trigger(instance);
  }
  for (const instance of active) {
    const effect = getItem(rules, instance.itemId).effect;
    if (effect.kind !== 'place_random_temporary_wild_mark') continue;
    const candidates = board.flatMap((_, i) => wildMarks.includes(i) ? [] : [i]);
    if (!candidates.length || draw(10000, 'wild_trigger', instance.instanceId) >= effect.triggerChanceBasisPoints) continue;
    const index = candidates[draw(candidates.length, 'wild_selection', instance.instanceId)];
    wildMarks.push(index); trigger(instance, { index });
  }
  wildMarks.sort((a, b) => a - b);
  const virtualScore = virtualBonus(board, true);
  const scoring = scoreWithItems(board, rules, scoringActive, { consecutiveWinHands, virtualScore, lineBonus, wildMarks, physicalChanged: changed(board) });
  const handSequence = extended ? nextHandSequence(state) : null;
  return {
    rawBoard, board, ...scoring, triggeredItems, randomTrace,
    ...(extended ? { wildMarks, physicalChanged: changed(board), handSequence, consumedWeightBuffs,
      pendingNextHandWeightBuffs: queueWeightBuffs(board, active, rules, handSequence, removedSymbol) } : {}),
    ...(hasMilestone(rules) ? { milestoneWild } : {}),
    effectiveWeights: symbols.map(({ id, weight }) => ({ symbol: id, weight })),
    activeEffects: active.filter((instance) => !economicKinds.has(getItem(rules, instance.itemId).effect.kind))
      .map((instance) => ({ instanceId: instance.instanceId, itemId: instance.itemId, kind: getItem(rules, instance.itemId).effect.kind })),
    ...finishItemSpin(items, active, triggeredIds, rules),
  };
}
