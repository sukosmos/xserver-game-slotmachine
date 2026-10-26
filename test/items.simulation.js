import test from 'node:test';
import assert from 'node:assert/strict';
import { CounterRandom } from '../src/server/random.js';
import { loadRules } from '../src/server/load-rules.js';
import { spinWithItems } from '../src/domain/items.js';
import { weightedSymbols } from '../src/domain/item-scoring.js';
import { createInventory, acquireItem } from '../src/domain/inventory.js';
import { drawBoard, evaluateLines } from '../src/domain/slot.js';
import { createRun } from '../src/domain/run.js';
import { createCardOffer, chooseMilestone } from '../src/domain/milestone.js';

const rules = loadRules();
const seed = '019f'.repeat(16); // Public simulation fixture, never a production seed.
const build = (ids) => ids.reduce((inventory, id) => acquireItem(inventory, id, rules, { activeFromRound: 1 }), createInventory()).items;

test('100k hidden offers and deletion draws follow uniform permutations and effective weights', (t) => {
  const rng=new CounterRandom(seed), permutations=new Map(), deleted=Object.fromEntries(rules.symbols.map((s)=>[s.id,0]));
  const state={...createRun(rules,{initialItemIds:['cherry_farm']}),roundIndex:3,phase:'CARD_CHOICE',cardOffer:[{slotId:'s',cardId:'prune'}]};
  const trials=100000;
  for(let i=0;i<trials;i++) {
    const order=createCardOffer(rules,rng).cardOffer.map((c)=>c.cardId).join(',');permutations.set(order,(permutations.get(order)??0)+1);
    deleted[chooseMilestone(state,'s',rules,rng).state.milestoneReward.removedSymbol]++;
  }
  assert.equal(permutations.size,24);
  for(const count of permutations.values()) assert.ok(Math.abs(count/trials-1/24)<6*Math.sqrt((1/24)*(23/24)/trials));
  for(const s of weightedSymbols(rules,state.items)) {
    const p=s.weight/110;assert.ok(Math.abs(deleted[s.id]/trials-p)<6*Math.sqrt(p*(1-p)/trials));
  }
  t.diagnostic(JSON.stringify({trials,permutations:Object.fromEntries(permutations),deleted}));
});

test('100k eligible miracle Hands trigger about 20%, each candidate receives one third of hits', (t) => {
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
  assert.ok(Math.abs(hits / trials - 0.20) < 6 * Math.sqrt(0.20 * 0.80 / trials));
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


test('100k rounds trigger an eligible consumable exactly once with uniform first-trigger Hands', (t) => {
 const rng=new CounterRandom(seed),counts=Array(5).fill(0),trials=100000,boardRolls=[0,0,75,55,30,90,75,55,30];
 for(let trial=0;trial<trials;trial++) {
  let state=createRun(rules,{initialItemIds:['mirror_copier']}),hits=0;
  for(let h=5;h>=1;h--) {
   let cell=0;const result=spinWithItems(rules,{nextInt:bound=>cell<9?boardRolls[cell++]:rng.nextInt(bound)},{...state,handsRemaining:h});
   if(result.triggeredItems.length){hits++;counts[5-h]++;}state={...state,items:result.itemsAfterSpin};
  }
  assert.equal(hits,1);assert.equal(state.items[0].remainingCharges,1);
 }
 for(const count of counts)assert.ok(Math.abs(count/trials-.2)<6*Math.sqrt(.2*.8/trials));
 t.diagnostic(JSON.stringify({trials,counts}));
});
