import { getItem } from './rules.js';
import { createWeightedTable, evaluateLines, validateBoard } from './slot.js';
import { rational, addRational, multiplyRational, floorMultiply, exactInteger } from './exact.js';
import { requireCondition } from './errors.js';

const fraction = (value) => rational(value.num, value.den);

/** Callers pass validated, currently active instances; each entry is one copy. */
export function weightedSymbols(rules, items) {
  const symbols = rules.symbols.map((symbol) => ({ ...symbol }));
  for (const instance of items) {
    const effect = getItem(rules, instance.itemId).effect;
    if (effect.kind === 'weight_add') symbols.find((symbol) => symbol.id === effect.symbol).weight += effect.amount;
  }
  createWeightedTable(symbols); // Reject overflow/nonpositive modified weights before any draw.
  return symbols;
}

/** Unconditional per-symbol values, shared by scoring and the server's build view. */
export function symbolScores(rules, items) {
  const effects = items.map((instance) => getItem(rules, instance.itemId).effect);
  return rules.symbols.map((symbol) => {
    let symbolFactor = rational(1), specialFactor = rational(1);
    for (const effect of effects) {
      if (effect.kind === 'symbol_line_add_factor' && effect.symbol === symbol.id) symbolFactor = addRational(symbolFactor, fraction(effect.extraFactor));
      if (effect.kind === 'conditional_per_line_factor') specialFactor = multiplyRational(specialFactor, fraction(symbol.id === 'seven' ? effect.forSeven : effect.forOther));
      if (effect.kind === 'zero_base_plus_per_real_line_factor') specialFactor = multiplyRational(specialFactor, fraction(effect.perRealLineFactor));
    }
    const lineFactor = multiplyRational(symbolFactor, specialFactor);
    return { id: symbol.id, point: effects.some((effect) => effect.kind === 'zero_base_plus_per_real_line_factor') ? 0n : symbol.basePoint,
      lineFactor, linePayout: floorMultiply(symbol.linePayout, lineFactor) };
  });
}

/** No RNG or mutation. Preview and final scoring use this same exact path. */
export function scoreWithItems(board, rules, items, { consecutiveWinHands = 0, virtualScore = 0n, lineBonus = null } = {}) {
  validateBoard(board, rules);
  requireCondition(Number.isSafeInteger(consecutiveWinHands) && consecutiveWinHands >= 0 && consecutiveWinHands < Number.MAX_SAFE_INTEGER, 'INVALID_WIN_STREAK');
  virtualScore = exactInteger(virtualScore);
  const effects = items.map((instance) => getItem(rules, instance.itemId).effect);
  const wildCenter = effects.some((effect) => effect.kind === 'wild_center');
  const rawLines = evaluateLines(board, rules, { wildCenter });
  const nextStreak = rawLines.length > 0 ? consecutiveWinHands + 1 : 0;
  const profiles = new Map(symbolScores(rules, items).map((symbol) => [symbol.id, symbol]));
  const rawBaseScore = board.reduce((sum, symbol) => sum + rules.symbolsById[symbol].basePoint, 0n);
  const baseScore = board.reduce((sum, symbol) => sum + profiles.get(symbol).point, 0n);
  const winningLines = rawLines.map((line) => {
    let factor = profiles.get(line.symbol).lineFactor;
    if (lineBonus?.lineId === line.lineId) factor = multiplyRational(factor, fraction(lineBonus.factor));
    return { ...line, basePayout: line.score, factor, score: floorMultiply(line.score, factor) };
  });
  let globalMultiplier = rational(1);
  for (const effect of effects) {
    if (effect.kind === 'spin_multiplier_if_min_real_lines' && rawLines.length >= effect.minRealWinningLines) globalMultiplier = multiplyRational(globalMultiplier, fraction(effect.factor));
    if (effect.kind === 'consecutive_win_multiplier') {
      const exponent = Math.min(Math.max(nextStreak - 1, 0), effect.maxExponent);
      const factor = fraction(effect.factorPerExtraHit);
      globalMultiplier = multiplyRational(globalMultiplier, rational(factor.num ** BigInt(exponent), factor.den ** BigInt(exponent)));
    }
  }
  const lineScore = winningLines.reduce((sum, line) => sum + line.score, 0n);
  return {
    rawBaseScore, baseScore, lineScore, virtualScore, globalMultiplier, winningLines,
    spinScore: floorMultiply(baseScore + lineScore + virtualScore, globalMultiplier), consecutiveWinHands: nextStreak,
  };
}
