import { hasExpansion } from './expansion-contract.js';
import { getItem } from './rules.js';
import { createWeightedTable, evaluateLines, validateBoard } from './slot.js';
import { rational, addRational, multiplyRational, floorMultiply, exactInteger } from './exact.js';
import { requireCondition } from './errors.js';

const fraction = (value) => rational(value.num, value.den);

/** Callers pass validated, currently active instances; each entry is one copy. */
export function weightedSymbols(rules, items, pendingBuffs = [], removedSymbol = null) {
  const symbols = rules.symbols.filter((symbol) => symbol.id !== removedSymbol).map((symbol) => ({ ...symbol }));
  for (const instance of items) {
    const effect = getItem(rules, instance.itemId).effect;
    if (effect.kind === 'weight_add' && effect.symbol !== removedSymbol) symbols.find((symbol) => symbol.id === effect.symbol).weight += effect.amount;
  }
  for (const buff of pendingBuffs) if (buff.symbol !== removedSymbol) symbols.find((symbol) => symbol.id === buff.symbol).weight += buff.amount;
  createWeightedTable(symbols); // Reject overflow/nonpositive modified weights before any draw.
  return symbols;
}

/** Unconditional per-symbol values, shared by scoring and the server's build view. */
export function symbolScores(rules, items) {
  const effects = items.map((instance) => getItem(rules, instance.itemId).effect);
  return rules.symbols.map((symbol) => {
    let symbolFactor = rational(1), specialFactor = rational(1), point = symbol.basePoint;
    for (const effect of effects) {
      if (['weight_add', 'symbol_line_add_factor'].includes(effect.kind) && effect.symbol === symbol.id) point += exactInteger(effect.basePointAdd ?? 0);
      if (effect.kind === 'symbol_line_add_factor' && effect.symbol === symbol.id) symbolFactor = addRational(symbolFactor, fraction(effect.extraFactor));
      if (effect.kind === 'conditional_per_line_factor') specialFactor = multiplyRational(specialFactor, fraction(symbol.id === 'seven' ? effect.forSeven : effect.forOther));
      if (effect.kind === 'zero_base_plus_per_real_line_factor') specialFactor = multiplyRational(specialFactor, fraction(effect.perRealLineFactor));
    }
    for (const effect of effects) {
      if (effect.kind === 'multiply_symbol_base_and_line_score' && effect.symbols.includes(symbol.id)) {
        point *= BigInt(effect.baseScoreMultiplier);
        specialFactor = multiplyRational(specialFactor, rational(effect.linePayoutMultiplier));
      }
    }
    const lineFactor = multiplyRational(symbolFactor, specialFactor);
    return { id: symbol.id, point: effects.some((effect) => effect.kind === 'zero_base_plus_per_real_line_factor') ? 0n : point,
      lineFactor, linePayout: floorMultiply(symbol.linePayout, lineFactor) };
  });
}

/** No RNG or mutation. Preview and final scoring use this same exact path. */
export function scoreWithItems(board, rules, items, { consecutiveWinHands = 0, virtualScore = 0n, lineBonus = null, wildMarks = [], physicalChanged = false, spinFactor = null, doublesArmed = false } = {}) {
  validateBoard(board, rules);
  requireCondition(Number.isSafeInteger(consecutiveWinHands) && consecutiveWinHands >= 0 && consecutiveWinHands < Number.MAX_SAFE_INTEGER, 'INVALID_WIN_STREAK');
  virtualScore = exactInteger(virtualScore);
  const effects = items.map((instance) => getItem(rules, instance.itemId).effect);
  const wildCenter = effects.some((effect) => effect.kind === 'wild_center');
  const rawLines = evaluateLines(board, rules, { wildCenter, wildMarks });
  const nextStreak = rawLines.length > 0 ? consecutiveWinHands + 1 : 0;
  const profiles = new Map(symbolScores(rules, items).map((symbol) => [symbol.id, symbol]));
  const rawBaseScore = board.reduce((sum, symbol) => sum + rules.symbolsById[symbol].basePoint, 0n);
  const baseScore = board.reduce((sum, symbol) => sum + profiles.get(symbol).point, 0n);
  const winningLines = rawLines.map((line) => {
    let factor = profiles.get(line.symbol).lineFactor;
    if (lineBonus?.lineId === line.lineId) factor = multiplyRational(factor, fraction(lineBonus.factor));
    for (const effect of effects) {
      if (effect.kind === 'multiply_actual_line_payout_if_physical_board_changed' && physicalChanged) factor = multiplyRational(factor, fraction(effect.factor));
    }
    return { ...line, basePayout: line.score, factor, score: floorMultiply(line.score, factor) };
  });
  let globalMultiplier = spinFactor ? fraction(spinFactor) : rational(1);
  for (const effect of effects) {
    if (effect.kind === 'spin_multiplier') globalMultiplier = multiplyRational(globalMultiplier, fraction(effect.factor));
    if (effect.kind === 'spin_multiplier_if_min_real_lines' && rawLines.length >= effect.minRealWinningLines) globalMultiplier = multiplyRational(globalMultiplier, fraction(effect.factor));
    if (effect.kind === 'consecutive_win_multiplier') {
      const exponent = Math.min(Math.max(nextStreak - 1, 0), effect.maxExponent);
      const factor = fraction(effect.factorPerExtraHit);
      globalMultiplier = multiplyRational(globalMultiplier, rational(factor.num ** BigInt(exponent), factor.den ** BigInt(exponent)));
    }
  }
  const lineScore = winningLines.reduce((sum, line) => sum + line.score, 0n);
  const squareEffects = effects.filter((effect) => effect.kind === 'square_match_bonus');
  const squareFactor = squareEffects.reduce((sum, effect) => addRational(sum, fraction(effect.payoutFactor)), rational(0));
  const winningPatterns = squareEffects.length ? rules.squares.flatMap(({ id, indices }) => {
    const symbol = board[indices[0]];
    if (!indices.every((index) => board[index] === symbol)) return [];
    const basePayout = rules.symbolsById[symbol].linePayout;
    return [{ patternId: id, indices: [...indices], symbol, basePayout, score: floorMultiply(basePayout, squareFactor) }];
  }) : [];
  for (const [kind, group] of Map.groupBy(effects.filter((e) => ['award_pattern_points_if_equal_corners', 'award_pattern_points_for_crossing_cells'].includes(e.kind)), (e) => e.kind)) {
    const e = group[0];
    if (kind === 'award_pattern_points_if_equal_corners' && e.cornerCellIndices.every((i) => board[i] === board[e.cornerCellIndices[0]])) {
      winningPatterns.push({ patternId: 'corners', kind: 'corners', indices: [...e.cornerCellIndices], symbol: board[e.cornerCellIndices[0]],
        score: group.reduce((sum, effect) => sum + exactInteger(effect.pointsPerStack), 0n) });
    }
    if (kind === 'award_pattern_points_for_crossing_cells') {
      const counts = Array(9).fill(0);
      for (const line of rawLines) for (const index of rules.lines.find((l) => l.id === line.lineId).indices) counts[index]++;
      const indices = counts.flatMap((count, i) => count >= e.minDistinctWinningLinesAtCell ? [i] : []);
      if (indices.length) winningPatterns.push({ patternId: 'crossings', kind: 'crossing', indices,
        score: exactInteger(e.pointsPerCell) * BigInt(Math.min(indices.length, e.maxRewardedCells)) });
    }
  }
  const patternScore = winningPatterns.reduce((sum, pattern) => sum + pattern.score, 0n);
  const specialFlatBonus = effects.filter(e=>e.kind === 'bonus_per_physical_symbol_base_value').reduce((sum,e)=>
    sum + BigInt(board.filter(s=>s===e.symbol).length) * rules.symbolsById[e.symbol].basePoint * BigInt(e.bonusMultiplier),0n);
  const doublesApplied = doublesArmed && effects.some(e=>e.kind === 'double_next_actual_hand_after_no_line');
  return {
    ...(hasExpansion(rules) ? { specialFlatBonus, doublesApplied } : {}),
    rawBaseScore, baseScore, lineScore, virtualScore, globalMultiplier, winningLines,
    // Old snapshots must replay with the exact original audit event shape.
    ...(rules.lineDefinitions.squares !== undefined ? { patternScore, winningPatterns } : {}),
    spinScore: floorMultiply(baseScore + lineScore + virtualScore + patternScore + specialFlatBonus, globalMultiplier) * (doublesApplied ? 2n : 1n), consecutiveWinHands: nextStreak,
  };
}
