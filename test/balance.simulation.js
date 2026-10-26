import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules } from '../src/server/load-rules.js';
import { simulateFirstRound } from '../scripts/simulation.js';

test('100k first rounds: 5 Hands at target 120 clear at least 99%; symbol distribution matches weights', (t) => {
  const result = simulateFirstRound(loadRules());
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.trials, 100000);
  assert.equal(result.hands, 5);
  assert.equal(result.targetScore, '120');
  assert.equal(result.totalSymbols, 4500000);
  assert.ok(result.clearRate >= 0.99 && result.clearRate <= 1, `clear rate ${result.clearRate}`);
  for (const symbol of result.symbols) {
    const tolerance = 6 * Math.sqrt(symbol.expected * (1 - symbol.expected) / result.totalSymbols) + 1 / result.totalSymbols;
    assert.ok(Math.abs(symbol.observed - symbol.expected) <= tolerance, `${symbol.id}: ${symbol.observed} vs ${symbol.expected}`);
  }
});
