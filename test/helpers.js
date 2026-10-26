import { loadRules } from '../src/server/load-rules.js';

export const rules = loadRules();
export const seed = '0123456789abcdef'.repeat(4);
export const cherryBoard = Array(9).fill('cherry');
export const sevenBoard = Array(9).fill('seven');
export const noLineBoard = [
  'cherry', 'lemon', 'bell',
  'diamond', 'seven', 'cherry',
  'lemon', 'bell', 'diamond',
];

export function scriptedRandom(values) {
  let index = 0;
  return {
    nextInt(bound) {
      if (index >= values.length) throw new Error('Scripted RNG exhausted');
      const value = values[index++];
      if (!Number.isSafeInteger(value) || value < 0 || value >= bound) {
        throw new Error(`Scripted value ${value} outside [0, ${bound})`);
      }
      return value;
    },
    get draws() { return index; },
  };
}

export function randomForBoard(board, config = rules, extra = []) {
  const weights = config.symbols;
  const draws = board.map((id) => {
    const position = weights.findIndex((symbol) => symbol.id === id);
    if (position < 0) throw new Error(`Unknown test symbol ${id}`);
    return weights.slice(0, position).reduce((sum, symbol) => sum + symbol.weight, 0);
  });
  return scriptedRandom([...draws, ...extra]);
}

export function rawRules() {
  return structuredClone({ balance: rules.balance, lines: rules.lineDefinitions, catalog: rules.catalog });
}
