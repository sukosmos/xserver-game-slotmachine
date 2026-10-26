import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateRuns } from '../scripts/run-simulation.js';
import { rules, rawRules } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';

test('full-run sampling is reproducible and clear counts obey round boundaries', () => {
  const a = simulateRuns(rules, { trials: 100 }), b = simulateRuns(rules, { trials: 100 });
  assert.deepEqual(a, b); assert.equal(a.won + a.failed, 100);
  assert.equal(a.rounds[0].attempts, 100);
  for (let i = 0; i < a.rounds.length; i++) {
    assert.ok(a.rounds[i].clears <= a.rounds[i].attempts);
    if (i) assert.equal(a.rounds[i].attempts, a.rounds[i - 1].clears);
  }
  for (const row of Object.values(a.items)) assert.ok(row.clearedActiveRounds <= row.activeRounds);
});

test('full-run sampler reaches all ten rounds and records final rewards', () => {
  const raw = rawRules(); raw.balance.round.roundTargets.forEach((target) => { target.targetScore = '1'; });
  const report = simulateRuns(parseRules(raw), { trials: 3, shopping: false });
  assert.equal(report.won, 3); assert.equal(report.spins, 30);
  assert.ok(report.rounds.every((row) => row.clears === 3 && BigInt(row.totalRewards) > 0n && row.totalPurchaseSpend === '0'));
});
