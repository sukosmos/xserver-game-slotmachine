import test from 'node:test';
import assert from 'node:assert/strict';
import { CounterRandom } from '../src/server/random.js';
import { loadRules } from '../src/server/load-rules.js';
import { spinWithItems } from '../src/domain/items.js';
import { weightedSymbols } from '../src/domain/item-scoring.js';
import { createInventory, acquireItem } from '../src/domain/inventory.js';
import { drawBoard, evaluateLines } from '../src/domain/slot.js';

const rules = loadRules();
const seed = '019f'.repeat(16); // Public simulation fixture, never a production seed.
const build = (ids) => ids.reduce((inventory, id) => acquireItem(inventory, id, rules, { activeFromRound: 1 }), createInventory()).items;

test('100k eligible miracle Hands trigger about 8%, each candidate receives one third of hits', (t) => {
  const rng = new CounterRandom(seed);
  // Fix the documented board; only the effect rolls use the real seeded RNG.
  const boardRolls = [0, 0, 75, 55, 30, 90, 75, 55, 30];
  const items = build(['miracle_hand']);
  const counts = { row_top: 0, diag_main: 0, diag_anti: 0 };
  const trials = 100000;
  for (let trial = 0; trial < trials; trial++) {
    let cell = 0;
    const source = { nextInt: (bound) => cell < 9 ? boardRolls[cell++] : rng.nextInt(bound) };
    const result = spinWithItems(rules, source, { items });
    if (result.triggeredItems.length) counts[result.triggeredItems[0].lineId] += 1;
  }
  const hits = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(hits / trials - 0.08) < 6 * Math.sqrt(0.08 * 0.92 / trials));
  for (const count of Object.values(counts)) assert.ok(Math.abs(count / hits - 1 / 3) < 6 * Math.sqrt((1 / 3) * (2 / 3) / hits));
  t.diagnostic(JSON.stringify({ trials, hits, triggerRate: hits / trials, counts }));
});

test('100k boards per build: three seven blessings increase seven frequency and seven lines', (t) => {
  const baselineRng = new CounterRandom(seed);
  const boostedRng = new CounterRandom(seed);
  const boostedSymbols = weightedSymbols(rules, build(['sevens_blessing', 'sevens_blessing', 'sevens_blessing']));
  const trials = 100000;
  const counts = { baselineSymbols: 0, boostedSymbols: 0, baselineLines: 0, boostedLines: 0 };
  for (let trial = 0; trial < trials; trial++) {
    const baseline = drawBoard(rules, baselineRng);
    const boosted = drawBoard(rules, boostedRng, boostedSymbols);
    counts.baselineSymbols += baseline.filter((symbol) => symbol === 'seven').length;
    counts.boostedSymbols += boosted.filter((symbol) => symbol === 'seven').length;
    counts.baselineLines += evaluateLines(baseline, rules).filter((line) => line.symbol === 'seven').length;
    counts.boostedLines += evaluateLines(boosted, rules).filter((line) => line.symbol === 'seven').length;
  }
  const expected = 22 / 112;
  assert.ok(Math.abs(counts.boostedSymbols / (trials * 9) - expected) < 6 * Math.sqrt(expected * (1 - expected) / (trials * 9)));
  assert.ok(counts.boostedSymbols > counts.baselineSymbols);
  assert.ok(counts.boostedLines > counts.baselineLines * 5);
  t.diagnostic(JSON.stringify({ trialsPerBuild: trials, ...counts, expectedBoostedProbability: expected }));
});
