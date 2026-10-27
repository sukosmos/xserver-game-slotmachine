import { readFileSync } from 'node:fs';
import { loadRules } from '../src/server/load-rules.js';
import { parseRules } from '../src/domain/rules.js';

export const rules = loadRules();
// Keep explicit v0.6 fixtures for stored manual-settlement replay regressions.
export function rawLegacyRules() {
  const raw = rawV08Rules();
  for (const part of Object.values(raw)) part.version = 'v0.6';
  delete raw.balance.round.autoClearOnTarget;
  delete raw.balance.round.maxExtraHands;
  delete raw.balance.economy.clearRewardPerRound;
  raw.catalog.items = raw.catalog.items.filter((item) => item.id !== 'extra_hand');
  for (const item of raw.catalog.items) delete item.minShopRound;
  raw.balance.round.baseHands = 4;
  raw.balance.round.roundTargets = [120,250,550,1200,3000,7500,18000,45000,120000,300000]
    .map((target, index) => ({ round: index + 1, targetScore: String(target) }));
  raw.balance.economy.startingCoins = 0;
  return raw;
}
export const legacyRules = parseRules(rawLegacyRules());
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

export function rawV08Rules() {
  return JSON.parse(readFileSync(new URL('./fixtures/rules-v08.json', import.meta.url), 'utf8'));
}

export function rawV09Rules() {
  return JSON.parse(readFileSync(new URL('./fixtures/rules-v09.json', import.meta.url), 'utf8'));
}

export function rawV010Rules() {
  return JSON.parse(readFileSync(new URL('./fixtures/rules-v010.json', import.meta.url), 'utf8'));
}

export function rawV011Rules() {
  return JSON.parse(readFileSync(new URL('./fixtures/rules-v011.json', import.meta.url), 'utf8'));
}
export const v011Rules = parseRules(rawV011Rules());

export function rawV012Rules() {
  return JSON.parse(readFileSync(new URL('./fixtures/rules-v012.json', import.meta.url), 'utf8'));
}
export const v012Rules = parseRules(rawV012Rules());

export function rawV013Rules() { return JSON.parse(readFileSync(new URL('./fixtures/rules-v013.json', import.meta.url), 'utf8')); }
export const v013Rules = parseRules(rawV013Rules());
