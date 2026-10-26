import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rawV010Rules as rawRules, rawV09Rules, cherryBoard, noLineBoard, scriptedRandom as sequenceRandom, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { spinWithItems } from '../src/domain/items.js';
import { scoreWithItems } from '../src/domain/item-scoring.js';
import { evaluateLines } from '../src/domain/slot.js';
import { acquireItem } from '../src/domain/inventory.js';
import { buyItem, discardShopItem, rerollShop, createShop } from '../src/domain/shop.js';
import { rescueHand } from '../src/domain/selected8.js';
import { upgradeView } from '../src/server/upgrades.js';
import { spinPresentation } from '../src/server/presentation.js';
import { GameSession, replayAudit } from '../src/server/session.js';
import { CounterRandom } from '../src/server/random.js';

const rules = parseRules(rawRules());
const vectors = JSON.parse(readFileSync(new URL('./fixtures/selected8-vectors.json', import.meta.url))).testCases;
const selected = JSON.parse(readFileSync(new URL('./fixtures/selected8-catalog.json', import.meta.url))).items;
const build = (ids, config = rules) => createRun(config, { initialItemIds: ids });
const draw = (board, extra = [], weights = rules.symbols) => sequenceRandom([...board.map((id) => {
  let start = 0; for (const symbol of weights) { if (symbol.id === id) return start; start += symbol.weight; }
}), ...extra]);
const play = (board, ids, extra = [], state = {}) => spinWithItems(rules, draw(board, extra), { ...build(ids), ...state });
const receiptShop = (coins = 7) => ({ ...build(['receipt_collector']), phase: 'SHOP', coins,
  shop: { slots: [0, 1, 2].map((i) => ({ slotId: `s${i}`, itemId: 'cherry_farm', soldOut: false })), offerSequence: 0, paidRerolls: 0, freeRerollsUsed: 0 } });

for (const vector of vectors) test(`${vector.id}: ${vector.title}`, () => {
  const { given, expected, activeItems: ids } = vector;
  if (vector.id === 'S8-11') {
    let state = receiptShop();
    for (let i = 0; i < 3; i++) {
      const result = buyItem(state, `s${i}`, rules); state = result.state;
      assert.equal(state.coins, expected.coinsAfterEach[i]);
      assert.equal(state.items[0].purchaseCounter, expected.purchaseCounterAfterEach[i]);
      assert.equal(result.event.refundCoins, i === 2 ? 1 : 0);
    }
    return;
  }
  if (['S8-12', 'S8-13'].includes(vector.id)) {
    const before = { ...build(ids), ...given, roundScore: BigInt(given.roundScore), targetScore: BigInt(given.targetScore) };
    delete before.remainingCharges;
    const result = rescueHand(before, rules);
    assert.equal(result.state.handsRemaining, expected.handsRemaining);
    assert.equal(result.state.items[0]?.remainingCharges ?? 0, expected.remainingCharges);
    assert.equal(Boolean(result.emergency), vector.id === 'S8-12'); return;
  }
  const repeated = ids.flatMap((id) => Array(given[`stacks.${id}`] ?? 1).fill(id));
  const extra = Object.values(vector.rngOverrides ?? {});
  const state = { handSequence: (given.currentHandSequence ?? 1) - 1 };
  const result = play(given.drawnBoard ?? given.finalPhysicalBoard, repeated, extra, state);
  for (const [external, internal] of Object.entries({ finalPhysicalBoard: 'board', physicalChanged: 'physicalChanged', wildMarks: 'wildMarks', baseScore: 'baseScore', actualLineScore: 'lineScore', patternBonus: 'patternScore', spinScore: 'spinScore' })) {
    if (external in expected) assert.deepEqual(typeof result[internal] === 'bigint' ? String(result[internal]) : result[internal], expected[external], external);
  }
  if (expected.actualWinningLineIds) assert.deepEqual(result.winningLines.map((l) => l.lineId), expected.actualWinningLineIds);
  if (expected.crossingCellIndices) assert.deepEqual(result.winningPatterns.find((p) => p.kind === 'crossing').indices, expected.crossingCellIndices);
  if (expected.eligibleCrossingCellCount) assert.equal(result.winningPatterns.find((p) => p.kind === 'crossing').indices.length, expected.eligibleCrossingCellCount);
  for (const id of repeated.filter((id) => rules.itemsById[id].slot === 'charged')) {
    const count = expected[`remainingCharges.${id}`] ?? expected.remainingCharges;
    if (count !== undefined) assert.equal(result.itemsAfterSpin.find((i) => i.itemId === id)?.remainingCharges ?? 0, count);
  }
  if (vector.id === 'S8-01' || vector.id === 'S8-10') {
    assert.equal(result.pendingNextHandWeightBuffs.length, 1);
    assert.equal(result.pendingNextHandWeightBuffs[0].targetHandSequence, vector.id === 'S8-01' ? 6 : 9);
  }
});

test('only selected eight are appended with exact source definitions; payout items own larger cell bonuses', () => {
  assert.equal(rules.catalog.items.length, 37);
  for (const item of selected) assert.deepEqual(rules.itemsById[item.id], item);
  for (const symbol of rules.symbols) {
    const weight = rules.catalog.items.find((i) => i.effect.kind === 'weight_add' && i.effect.symbol === symbol.id);
    const payout = rules.catalog.items.find((i) => i.effect.kind === 'symbol_line_add_factor' && i.effect.symbol === symbol.id);
    assert.equal(weight.effect.basePointAdd, undefined);
    const baseline = scoreWithItems(Array(9).fill(symbol.id), rules, build([weight.id]).items);
    const boosted = scoreWithItems(Array(9).fill(symbol.id), rules, build([payout.id, payout.id]).items);
    assert.equal(baseline.baseScore, symbol.basePoint * 9n);
    assert.equal(boosted.baseScore, symbol.basePoint * 45n);
    assert.equal(upgradeView(build([payout.id, payout.id]), rules).current.symbols.find((s) => s.id === symbol.id).point, String(symbol.basePoint * 5n));
  }
  assert.equal(play(cherryBoard, ['golden_harvest', 'devils_contract']).baseScore, 0n);
});

test('mirror eligibility, probability boundary, priority, and no-op reroll use deterministic RNG', () => {
  const board = vectors[1].given.drawnBoard;
  const miss = play(board, ['mirror_copier'], [1000]);
  assert.deepEqual(miss.board, board); assert.equal(miss.itemsAfterSpin[0].remainingCharges, 2);
  const equal = play(cherryBoard, ['mirror_copier']);
  assert.equal(equal.randomTrace.length, 9);
  const first = play(vectors[3].given.drawnBoard, ['miracle_hand', 'mirror_copier'], [0, 0]);
  assert.equal(first.triggeredItems.filter((i) => i.itemId === 'mirror_copier').length, 0);
  const candidate = vectors[3].given.drawnBoard;
  const same = [75, 90, 30]; // Original right column: diamond, seven, lemon.
  const result = play(candidate, ['broken_lever', 'mirror_copier'], [0, ...same, 0]);
  assert.equal(result.itemsAfterSpin.find((i) => i.itemId === 'broken_lever').remainingCharges, 3);
  assert.equal(result.itemsAfterSpin.find((i) => i.itemId === 'mirror_copier').remainingCharges, 1);
});

test('wild excludes center, preserves physical cells, consumes on no win, expires each Hand', () => {
  const board = vectors[3].given.drawnBoard;
  const fail = play(board, ['temporary_wild'], [1200]);
  assert.deepEqual(fail.wildMarks, []); assert.equal(fail.itemsAfterSpin[0].remainingCharges, 2);
  const centered = play(board, ['joker_mask', 'temporary_wild'], [0, 4]);
  assert.deepEqual(centered.wildMarks, [4, 5]);
  const noWin = play(noLineBoard, ['temporary_wild', 'editors_proof'], [0, 0]);
  assert.equal(noWin.itemsAfterSpin[0].remainingCharges, 1); assert.equal(noWin.physicalChanged, false);
  const next = spinWithItems(rules, draw(board, [1200]), { ...build([]), items: noWin.itemsAfterSpin });
  assert.deepEqual(next.wildMarks, []);
  assert.deepEqual(evaluateLines(board, rules, { wildMarks: [0, 1, 2] }).filter((l) => l.lineId === 'row_top'), []);
});

test('tracker queues final physical board; applies once across shop, and discard removes pending source', () => {
  const state = { ...build(['seven_tracker']), targetScore: 1n };
  const cleared = applyAction(state, { type: 'SPIN' }, rules, draw(cherryBoard, Array(8).fill(0)));
  assert.equal(cleared.state.phase, 'SHOP');
  assert.equal(cleared.state.pendingNextHandWeightBuffs.length, 1);
  assert.equal(upgradeView(cleared.state, rules).next.symbols.find((s) => s.id === 'seven').probability, '13.46%');
  const rerolled = rerollShop({ ...cleared.state, coins: 10 }, rules, new CounterRandom(seed));
  assert.deepEqual(rerolled.state.pendingNextHandWeightBuffs, cleared.state.pendingNextHandWeightBuffs);
  const next = applyAction(cleared.state, { type: 'CONTINUE' }, rules).state;
  const used = spinWithItems(rules, sequenceRandom(Array(9).fill(90)), next);
  assert.equal(used.effectiveWeights.at(-1).weight, 14);
  assert.deepEqual(used.pendingNextHandWeightBuffs, []);
  const discarded = discardShopItem(cleared.state, state.items[0].instanceId, rules).state;
  assert.deepEqual(discarded.pendingNextHandWeightBuffs, []);
  assert.equal(upgradeView(discarded, rules).next.symbols.find((s) => s.id === 'seven').probability, '10.00%');
  const fresh = applyAction(discarded, { type: 'CONTINUE' }, rules).state;
  assert.equal(spinWithItems(rules, draw(cherryBoard), fresh).effectiveWeights.at(-1).weight, 10);
});

test('patterns use physical corners and unique real crossing cells, global multipliers include patterns only once', () => {
  const ids = ['corner_collector', 'crossroads_bonus', 'square_seal', 'resonant_bell', 'devils_contract'];
  const result = play(cherryBoard, ids);
  assert.equal(result.patternScore, 1220n); assert.equal(result.baseScore, 0n);
  assert.equal(result.spinScore, (960n + 1220n) * 4n);
  assert.equal(result.winningLines.length, 8);
  const board = [...vectors[5].given.drawnBoard]; board[0] = 'seven';
  const wild = play(board, ['corner_collector', 'temporary_wild'], [0, 0]);
  assert.equal(wild.patternScore, 0n);
  const virtual = play(noLineBoard, ['scammers_card', 'crossroads_bonus'], [0]);
  assert.equal(virtual.patternScore, 0n);
});

test('receipt activation, cross-shop counter, exact payment, failed purchase, and discard are isolated', () => {
  let state = receiptShop(6); state.items[0].activeFromRound = 2;
  state = buyItem(state, 's0', rules).state;
  assert.equal(state.items[0].purchaseCounter, 0);
  state.roundIndex = 2;
  state = buyItem(state, 's1', rules).state;
  state.roundIndex = 3; state.items[0].purchaseCounter = 2;
  const result = buyItem(state, 's2', rules);
  assert.equal(result.state.coins, 1); assert.equal(result.state.items[0].purchaseCounter, 0);
  const before = structuredClone(result.state);
  assert.throws(() => buyItem(result.state, 's2', rules)); assert.deepEqual(result.state, before);
  const gone = discardShopItem(result.state, result.state.items[0].instanceId, rules).state;
  const boughtAgain = acquireItem(gone, 'receipt_collector', rules, { activeFromRound: 4 });
  assert.equal(boughtAgain.items.at(-1).purchaseCounter, 0);
});

test('emergency grants one actual next Hand with tracker bonus, then failure clears reservations', () => {
  const state = { ...build(['emergency_lever', 'seven_tracker']), handsRemaining: 1, targetScore: 100000n };
  const first = applyAction(state, { type: 'SPIN' }, rules, draw(cherryBoard));
  assert.equal(first.state.phase, 'ROUND_ACTIVE'); assert.equal(first.state.handsRemaining, 1);
  assert.equal(first.event.emergency.type, 'EMERGENCY_HAND_GRANTED');
  assert.equal(first.state.items.some((i) => i.itemId === 'emergency_lever'), false);
  const second = applyAction(first.state, { type: 'SPIN' }, rules, sequenceRandom(Array(9).fill(90)));
  assert.equal(second.event.effectiveWeights.at(-1).weight, 14);
  assert.equal(second.state.phase, 'RUN_FAILED'); assert.deepEqual(second.state.pendingNextHandWeightBuffs, []);
  const success = applyAction({ ...state, targetScore: 1n }, { type: 'SPIN' }, rules, draw(cherryBoard, Array(8).fill(0)));
  assert.equal(success.event.emergency, null); assert.equal(success.state.phase, 'SHOP');
});

test('new event/state replay and idempotency preserve receipt counter and emergency; old v0.9 stays pinned', () => {
  const raw = rawRules(); raw.balance.round.roundTargets.forEach((t) => { t.targetScore = '999999999'; });
  const config = parseRules(raw), session = new GameSession(config, { userId: 'p', seed, initialItemIds: ['emergency_lever', 'seven_tracker'] });
  for (let i = 0; i < 5; i++) {
    const command = { type: 'SPIN', expectedRevision: i, idempotencyKey: `s${i}` };
    const result = session.execute('p', command);
    assert.deepEqual(session.execute('p', command), result);
    assert.throws(() => session.execute('p', { ...command, idempotencyKey: `other${i}` }), /STALE_REVISION/);
  }
  assert.equal(session.getState('p').handsRemaining, 1);
  assert.deepEqual(replayAudit(config, session.exportAudit()), session.getState('p'));
  const old = parseRules(rawV09Rules()), oldSession = new GameSession(old, { userId: 'p', seed, initialItemIds: ['cherry_farm'] });
  const before = oldSession.execute('p', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'old' });
  assert.equal(before.event.handSequence, undefined);
  assert.equal(before.event.wildMarks, undefined);
  assert.equal(before.state.handSequence, undefined);
  assert.deepEqual(replayAudit(old, oldSession.exportAudit()), before.state);
});

test('new scoring stays exact above Number range and editor never multiplies pattern points', () => {
  const raw = rawRules(); raw.balance.symbols[0].linePayout = '900719925474099312345';
  raw.catalog.items.find((i) => i.id === 'corner_collector').effect.pointsPerStack = '900719925474099312347';
  raw.catalog.items.find((i) => i.id === 'golden_harvest').effect.basePointAdd = '900719925474099312349';
  const config = parseRules(raw), state = build(['corner_collector', 'editors_proof', 'golden_harvest'], config);
  const result = scoreWithItems(cherryBoard, config, state.items, { physicalChanged: true });
  assert.equal(result.lineScore, 900719925474099312345n * 3n * 2n * 8n);
  assert.equal(result.patternScore, 900719925474099312347n);
  assert.equal(result.baseScore, (900719925474099312349n + 1n) * 9n);
});

test('selected8 flag disables only the eight new items and keeps prior rules usable', () => {
  const raw = rawRules(); raw.balance.itemRules.selected8Items = false;
  const config = parseRules(raw), state = { ...createRun(config), phase: 'SHOP', roundIndex: 3 };
  for (const item of selected) assert.throws(() => build([item.id], config), { code: 'ITEM_DISABLED' });
  const offers = createShop(state, config, new CounterRandom(seed)).shop.slots;
  assert.ok(offers.every((slot) => !selected.some((item) => item.id === slot.itemId)));
  assert.equal(state.handSequence, undefined);
});

test('selected8 policies and malformed state fail closed', () => {
  for (const [id, field, value] of [
    ['temporary_wild', 'changesPhysicalBoard', true], ['mirror_copier', 'sourceCellIndices', [1, 4, 7]],
    ['corner_collector', 'pointsPerStack', -1], ['crossroads_bonus', 'pointsPerCell', Number.MAX_SAFE_INTEGER + 1],
    ['receipt_collector', 'purchasesPerRefund', 0], ['emergency_lever', 'handsGranted', 2],
  ]) {
    const raw = rawRules(); raw.catalog.items.find((i) => i.id === id).effect[field] = value;
    assert.throws(() => parseRules(raw), { code: 'INVALID_RULES' });
  }
  const state = build(['receipt_collector']); state.items[0].purchaseCounter = 3;
  assert.throws(() => spinWithItems(rules, draw(cherryBoard), state), { code: 'INVALID_ITEM_INSTANCE' });
  assert.throws(() => spinWithItems(rules, draw(cherryBoard), { ...build([]), handSequence: Number.MAX_SAFE_INTEGER }), { code: 'HAND_SEQUENCE_EXHAUSTED' });
});

test('new presentation distinguishes square, corner, crossing, wild and next-Hand effects', () => {
  const result = play(cherryBoard, ['square_seal', 'corner_collector', 'crossroads_bonus', 'seven_tracker']);
  const view = spinPresentation({ type: 'SPIN_RESOLVED', ...result }, rules);
  assert.equal(view.awards.filter((a) => a.kind === 'square').length, 4);
  assert.equal(view.awards.find((a) => a.kind === 'corners').score, '500');
  assert.equal(view.awards.find((a) => a.kind === 'crossing').indices.length, 9);
  assert.equal(view.effects.find((e) => e.itemId === 'square_seal').label, '2×2 4개 · +120점');
  assert.equal(view.effects.find((e) => e.itemId === 'seven_tracker').stage, 'next');
});
