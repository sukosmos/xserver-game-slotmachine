import { CounterRandom } from '../src/server/random.js';
import { spin } from '../src/domain/slot.js';
import { requireCondition } from '../src/domain/errors.js';

// Public test fixture only; production sessions always generate private seeds.
export const BALANCE_SEED = '6e696e652d746f2d7275696e2d62616c616e63652d7631'.padEnd(64, '0');

export function simulateFirstRound(rules, { trials = 100000, seed = BALANCE_SEED } = {}) {
  requireCondition(Number.isSafeInteger(trials) && trials > 0, 'INVALID_SIMULATION_SIZE');
  const rng = new CounterRandom(seed);
  const counts = Object.fromEntries(rules.symbols.map((symbol) => [symbol.id, 0]));
  const baseHands = rules.balance.round.baseHands;
  const target = rules.targets[0];
  let clears = 0;
  let threeHandClears = 0;
  let totalScore = 0n;
  let maxRoundScore = 0n;
  for (let trial = 0; trial < trials; trial++) {
    let roundScore = 0n;
    // Always draw all Hands, even after success, to measure a fixed sample.
    for (let hand = 1; hand <= baseHands; hand++) {
      const result = spin(rules, rng);
      roundScore += result.spinScore;
      for (const symbol of result.board) counts[symbol] += 1;
      if (hand === 3 && roundScore >= target) threeHandClears += 1;
    }
    if (roundScore >= target) clears += 1;
    totalScore += roundScore;
    if (roundScore > maxRoundScore) maxRoundScore = roundScore;
  }
  const totalSymbols = trials * baseHands * rules.balance.board.rows * rules.balance.board.cols;
  const totalWeight = rules.symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
  return {
    trials, seed, rulesVersion: rules.rulesVersion, rngVersion: rng.snapshot().algorithm,
    hands: baseHands, targetScore: target.toString(), clears, clearRate: clears / trials,
    threeHandClearRate: baseHands >= 3 ? threeHandClears / trials : null,
    totalSymbols, randomWordsConsumed: rng.snapshot().counter,
    totalScore: totalScore.toString(), maxRoundScore: maxRoundScore.toString(),
    symbols: rules.symbols.map((symbol) => ({
      id: symbol.id, count: counts[symbol.id], observed: counts[symbol.id] / totalSymbols, expected: symbol.weight / totalWeight,
    })),
  };
}
