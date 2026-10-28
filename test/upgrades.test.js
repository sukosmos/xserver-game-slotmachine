import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun } from '../src/domain/run.js';
import { acquireItem, discardItem, finishItemSpin } from '../src/domain/inventory.js';
import { scoreWithItems } from '../src/domain/item-scoring.js';
import { upgradeView } from '../src/server/upgrades.js';
import { parseRules } from '../src/domain/rules.js';
import { rules, rawRules, rawLegacyRockRules } from './helpers.js';

const symbol = (view, id = 'cherry') => view.symbols.find((row) => row.id === id);

test('hootie stats match scoring after upgrades and only apply to cherry and lemon', () => {
  const state = createRun(rules, { initialItemIds: ['hootie_fruitie', 'golden_harvest', 'lemon_syrup'] });
  const view = upgradeView(state, rules).current;
  assert.equal(symbol(view).point, '9'); assert.equal(symbol(view).linePayout, '270');
  assert.equal(symbol(view, 'lemon').point, '18'); assert.equal(symbol(view, 'lemon').linePayout, '450');
  for (const row of view.symbols) {
    const spin = scoreWithItems(Array(9).fill(row.id), rules, state.items);
    assert.equal(spin.baseScore, BigInt(row.point) * 9n);
    assert.ok(spin.winningLines.every(line => String(line.score) === row.linePayout));
    assert.equal(row.sources.some(source => source.itemId === 'hootie_fruitie'), ['cherry', 'lemon'].includes(row.id));
  }
});

test('hootie purchase preview and discard respect activation, including the zero-base contract', () => {
  let state = { ...createRun(rules, { initialItemIds: ['devils_contract'] }), phase: 'SHOP' };
  state = { ...state, ...acquireItem(state, 'hootie_fruitie', rules, { activeFromRound: 2 }) };
  const view = upgradeView(state, rules);
  assert.equal(symbol(view.current).point, '0'); assert.equal(symbol(view.next).point, '0');
  assert.equal(symbol(view.current).linePayout, '120'); assert.equal(symbol(view.next).linePayout, '360');
  state = { ...state, ...discardItem(state, state.items.at(-1).instanceId, rules) };
  assert.equal(symbol(upgradeView(state, rules).next).linePayout, '120');
});

test('legacy rock bottom shows its physical-cell bonus separately without changing base or line values', () => {
  const rules = parseRules(rawLegacyRockRules());
  const state = createRun(rules, { initialItemIds: ['rock_bottom', 'gem_appraiser', 'devils_contract'] });
  const view = upgradeView(state, rules).current, row = symbol(view, 'diamond');
  assert.equal(row.point, '0'); assert.equal(row.physicalBonus, '500'); assert.equal(row.physicalPoint, '500');
  const spin = scoreWithItems(Array(9).fill('diamond'), rules, state.items);
  assert.equal(BigInt(row.physicalPoint) * 9n, spin.baseScore + spin.specialFlatBonus);
  assert.ok(spin.winningLines.every(line => String(line.score) === row.linePayout));
  assert.equal(symbol(view).physicalBonus, undefined);
  const future = { ...state, phase: 'SHOP', items: state.items.map(i => i.itemId === 'rock_bottom' ? { ...i, activeFromRound: 2 } : i) };
  assert.equal(symbol(upgradeView(future, rules).current, 'diamond').physicalBonus, undefined);
  assert.equal(symbol(upgradeView(future, rules).next, 'diamond').physicalPoint, '500');
  const removed = { ...state, ...discardItem({ ...state, phase: 'SHOP' }, state.items[0].instanceId, rules) };
  assert.equal(symbol(upgradeView(removed, rules).current, 'diamond').physicalBonus, undefined);
});

test('legacy physical symbol bonuses stay exact above Number range', () => {
  const raw = rawLegacyRockRules(); raw.balance.symbols.find(s => s.id === 'diamond').basePoint = '9007199254740993';
  const config = parseRules(raw), state = createRun(config, { initialItemIds: ['rock_bottom'] });
  const row = symbol(upgradeView(state, config).current, 'diamond');
  assert.equal(row.physicalBonus, String(9007199254740993n * 100n));
  assert.equal(row.physicalPoint, String(9007199254740993n * 101n));
});

test('baseline shows exact points, line payout and normalized draw chance', () => {
  const view = upgradeView(createRun(rules), rules);
  assert.equal(view.next, null);
  assert.deepEqual(symbol(view.current), { id: 'cherry', basePoint: '1', point: '1', baseLinePayout: '30', linePayout: '30', baseWeight: 30, weight: 30, baseProbability: '30.00%', probability: '30.00%', sources: [] });
});

test('weight changes probabilities; payout stacks raise cell points and line payout', () => {
  const state = createRun(rules, { initialItemIds: ['cherry_farm', 'golden_harvest', 'golden_harvest'] });
  const view = upgradeView(state, rules).current;
  assert.equal(view.totalWeight, 110);
  assert.equal(symbol(view).probability, '36.36%');
  assert.equal(symbol(view, 'lemon').probability, '22.73%');
  assert.equal(symbol(view).point, '5'); assert.equal(symbol(view).linePayout, '150');
  assert.deepEqual(symbol(view).sources, [{ itemId: 'cherry_farm', stacks: 1 }, { itemId: 'golden_harvest', stacks: 2 }]);
});

test('shop preview separates active and future stacks, then updates after discard and continue', () => {
  let state = { ...createRun(rules, { initialItemIds: ['golden_harvest'] }), phase: 'SHOP' };
  state = { ...state, ...acquireItem(state, 'golden_harvest', rules, { activeFromRound: 2 }) };
  const before = structuredClone(state), view = upgradeView(state, rules);
  assert.equal(symbol(view.current).linePayout, '90'); assert.equal(symbol(view.next).linePayout, '150');
  assert.deepEqual(state, before);
  assert.deepEqual(upgradeView({ ...state, phase: 'ROUND_ACTIVE', roundIndex: 2 }, rules).current, view.next);
  state = { ...state, ...discardItem(state, state.items.at(-1).instanceId, rules) };
  assert.equal(symbol(upgradeView(state, rules).next).linePayout, '90');
});

test('symbol modifiers match real scoring, including reduced payouts and zero base points', () => {
  const state = createRun(rules, { initialItemIds: ['golden_harvest', 'jackpot_crown', 'devils_contract'] });
  const view = upgradeView(state, rules).current;
  assert.equal(symbol(view).point, '0'); assert.equal(symbol(view).linePayout, '180');
  assert.equal(symbol(view, 'seven').linePayout, '60000');
  for (const row of view.symbols) {
    const spin = scoreWithItems(Array(9).fill(row.id), rules, state.items);
    assert.equal(spin.baseScore, BigInt(row.point) * 9n);
    assert.ok(spin.winningLines.every((line) => String(line.score) === row.linePayout));
  }
  const crown = upgradeView(createRun(rules, { initialItemIds: ['jackpot_crown'] }), rules).current;
  assert.equal(symbol(crown).linePayout, '15');
});

test('conditional spin effects stay separate; expired effects disappear', () => {
  const state = createRun(rules, { initialItemIds: ['resonant_bell', 'win_streak', 'joker_mask'] });
  const view = upgradeView(state, rules).current;
  assert.equal(symbol(view).linePayout, '30');
  assert.deepEqual(view.effects.map((effect) => effect.itemId), ['resonant_bell', 'win_streak', 'joker_mask']);
  const expiring = state.items;
  const finished = finishItemSpin(expiring, expiring, new Set([expiring.find(i=>i.itemId==='joker_mask').instanceId]), rules);
  assert.ok(!upgradeView({ ...state, items: finished.itemsAfterSpin }, rules).current.effects.some((effect) => effect.itemId === 'joker_mask'));
});

test('immediate ownership discount is visible while future economic effects wait', () => {
  let state = { ...createRun(rules), phase: 'SHOP' };
  for (const itemId of ['haggler', 'piggy_bank']) state = { ...state, ...acquireItem(state, itemId, rules, { activeFromRound: 2 }) };
  const view = upgradeView(state, rules);
  assert.deepEqual(view.current.effects, [{ itemId: 'haggler', stacks: 1 }]);
  assert.equal(view.next.effects.length, 2);
});

test('display scores remain exact above Number range and probabilities use arbitrary total weights', () => {
  const raw = rawRules(); raw.balance.symbols[0].linePayout = '9007199254740993123456789';
  raw.balance.symbols[0].weight = 50;
  const config = parseRules(raw), state = createRun(config, { initialItemIds: ['golden_harvest'] });
  const row = symbol(upgradeView(state, config).current);
  assert.equal(row.linePayout, String(9007199254740993123456789n * 3n));
  assert.equal(row.probability, '41.67%');
  assert.doesNotThrow(() => JSON.stringify(upgradeView(state, config)));
});
