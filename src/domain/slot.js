import { requireCondition } from './errors.js';
import { MAX_RANDOM_BOUND } from './rules.js';

/** @typedef {{ nextInt(upperExclusive: number): number }} RandomSource */

export function createWeightedTable(symbols) {
  requireCondition(Array.isArray(symbols) && symbols.length > 0, 'INVALID_WEIGHTS');
  let totalWeight = 0;
  const seen = new Set();
  const entries = symbols.map(({ id, weight }) => {
    requireCondition(typeof id === 'string' && id.length > 0 && !seen.has(id), 'INVALID_WEIGHTS');
    requireCondition(Number.isSafeInteger(weight) && weight > 0, 'INVALID_WEIGHTS');
    seen.add(id);
    totalWeight += weight;
    requireCondition(totalWeight <= MAX_RANDOM_BOUND, 'INVALID_WEIGHTS');
    return { id, upperExclusive: totalWeight };
  });
  return { entries, totalWeight };
}

/** Exactly nine independent draws, in row-major order. */
export function drawBoard(rules, rng, symbols = rules.symbols) {
  const table = createWeightedTable(symbols);
  return Array.from({ length: rules.balance.board.rows * rules.balance.board.cols }, () => {
    return drawSymbol(table, rng);
  });
}

export function drawSymbol({ entries, totalWeight }, rng) {
  const draw = rng.nextInt(totalWeight);
  requireCondition(Number.isSafeInteger(draw) && draw >= 0 && draw < totalWeight, 'INVALID_RANDOM_VALUE');
  return entries.find((entry) => draw < entry.upperExclusive).id;
}

export function validateBoard(board, rules) {
  requireCondition(Array.isArray(board) && board.length === rules.balance.board.rows * rules.balance.board.cols, 'INVALID_BOARD');
  // Iteration also checks sparse array holes.
  for (const symbol of board) {
    requireCondition(typeof symbol === 'string' && Object.hasOwn(rules.symbolsById, symbol), 'INVALID_BOARD');
  }
}

function winningLines(board, rules, wildCenter = false) {
  return rules.lines.flatMap(({ id, indices }) => {
    const matchedIndices = wildCenter ? indices.filter((index) => index !== 4) : indices;
    const symbol = board[matchedIndices[0]];
    return matchedIndices.every((index) => board[index] === symbol)
      ? [{ lineId: id, symbol, score: rules.symbolsById[symbol].linePayout }] : [];
  });
}

export function evaluateLines(board, rules, { wildCenter = false } = {}) {
  validateBoard(board, rules);
  return winningLines(board, rules, wildCenter);
}

export function scoreBoard(board, rules) {
  validateBoard(board, rules);
  const lines = winningLines(board, rules);
  const baseScore = board.reduce((sum, symbol) => sum + rules.symbolsById[symbol].basePoint, 0n);
  const lineScore = lines.reduce((sum, line) => sum + line.score, 0n);
  return { baseScore, lineScore, spinScore: baseScore + lineScore, winningLines: lines };
}

export function spin(rules, rng) {
  const board = drawBoard(rules, rng);
  return { board, ...scoreBoard(board, rules) };
}
