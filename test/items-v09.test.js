import test from 'node:test';
import assert from 'node:assert/strict';
import { rawV09Rules as rawRules, rawV08Rules, cherryBoard, noLineBoard, randomForBoard, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
const rules = parseRules(rawRules());
import { createRun } from '../src/domain/run.js';
import { scoreWithItems } from '../src/domain/item-scoring.js';
import { spinWithItems } from '../src/domain/items.js';
import { upgradeView } from '../src/server/upgrades.js';
import { GameSession, replayAudit } from '../src/server/session.js';
import { spinPresentation } from '../src/server/presentation.js';
import { createShop, rerollShop } from '../src/domain/shop.js';
import { CounterRandom } from '../src/server/random.js';

const build = (ids, config = rules) => createRun(config, { initialItemIds: ids });
const score = (board, ids, config = rules, options) => scoreWithItems(board, config, build(ids, config).items, options);
const candidateBoard = ['cherry', 'cherry', 'diamond', 'bell', 'lemon', 'seven', 'diamond', 'bell', 'lemon'];
const oneSquare = ['cherry', 'cherry', 'lemon', 'cherry', 'cherry', 'bell', 'lemon', 'diamond', 'seven'];

for (const [id, board, extra] of [
  ['miracle_hand', candidateBoard, [0]], ['broken_lever', noLineBoard, [0, 0, 0]],
  ['future_mirror', ['seven', ...noLineBoard.slice(1)], [0]],
  ['calculated_miracle', candidateBoard, []], ['volatile_joker', candidateBoard, [0]],
]) test(`${id}: doubled probability has exact hit/miss boundary and consumes only successful charges`, () => {
  const item = rules.itemsById[id], before = rawV08Rules().catalog.items.find((i) => i.id === id);
  const chance = item.effect.triggerChanceBasisPoints;
  assert.equal(chance, before.effect.triggerChanceBasisPoints * 2);
  const state = build([id]);
  const hit = spinWithItems(rules, randomForBoard(board, rules, [chance - 1, ...extra]), state);
  const miss = spinWithItems(rules, randomForBoard(board, rules, [chance]), state);
  assert.equal(hit.triggeredItems[0].itemId, id);
  assert.equal(hit.itemsAfterSpin[0]?.remainingCharges ?? 0, item.initialCharges - 1);
  assert.equal(miss.triggeredItems.length, 0);
  assert.equal(miss.itemsAfterSpin[0].remainingCharges, item.initialCharges);
});

test('all weight items boost base cells, stack, activate next round and agree with upgrades', () => {
  for (const item of rules.catalog.items.filter((item) => item.effect.kind === 'weight_add')) {
    const state = build([item.id, item.id]), symbol = item.effect.symbol, base = rules.symbolsById[symbol];
    const actual = scoreWithItems(Array(9).fill(symbol), rules, state.items);
    assert.equal(actual.baseScore, base.basePoint * 27n);
    assert.equal(actual.lineScore, base.linePayout * 8n);
    assert.equal(upgradeView(state, rules).current.symbols.find((s) => s.id === symbol).point, String(base.basePoint * 3n));
    const pending = { ...state, phase: 'SHOP', items: state.items.map((i) => ({ ...i, activeFromRound: 2 })) };
    assert.equal(upgradeView(pending, rules).current.symbols.find((s) => s.id === symbol).point, String(base.basePoint));
    assert.equal(upgradeView(pending, rules).next.symbols.find((s) => s.id === symbol).point, String(base.basePoint * 3n));
    assert.equal(upgradeView({ ...pending, items: [] }, rules).next.symbols.find((s) => s.id === symbol).point, String(base.basePoint));
  }
  assert.equal(score(cherryBoard, ['cherry_farm', 'devils_contract']).baseScore, 0n);
  const raw = rawRules(); raw.catalog.items[0].effect.basePointAdd = '9007199254740993000000';
  const exact = parseRules(raw);
  assert.equal(score(cherryBoard, ['cherry_farm'], exact).baseScore, (9007199254740993000000n + 1n) * 9n);
});

test('four square geometries, overlap, ownership and visible-symbol matching', () => {
  for (const square of rules.squares) {
    const board = [...noLineBoard]; square.indices.forEach((i) => { board[i] = 'cherry'; });
    const result = score(board, ['square_seal']);
    assert.equal(result.winningPatterns.length, 1);
    assert.equal(result.winningPatterns[0].patternId, square.id);
    assert.deepEqual(result.winningPatterns[0].indices, square.indices);
    assert.equal(result.patternScore, 30n);
  }
  assert.equal(score(cherryBoard, ['square_seal']).patternScore, 120n);
  assert.equal(score(cherryBoard, []).patternScore, 0n);
  assert.equal(score(noLineBoard, ['square_seal']).patternScore, 0n);
  const wild = [...oneSquare]; wild[4] = 'seven';
  assert.equal(score(wild, ['square_seal', 'joker_mask']).patternScore, 0n);
  const pending = build(['square_seal']); pending.items[0].activeFromRound = 2;
  assert.equal(spinWithItems(rules, randomForBoard(cherryBoard), pending).patternScore, 0n);
});

test('square bonuses do not count as real lines, inherit only global multipliers, and use exact integers', () => {
  const single = score(oneSquare, ['square_seal', 'golden_harvest', 'resonant_bell', 'win_streak'], rules, { consecutiveWinHands: 3 });
  assert.equal(single.winningLines.length, 0); assert.equal(single.consecutiveWinHands, 0);
  assert.equal(single.patternScore, 30n); assert.equal(single.spinScore, 56n);
  assert.equal(score(oneSquare, ['square_seal', 'devils_contract']).spinScore, 30n);
  assert.equal(score(cherryBoard, ['square_seal', 'resonant_bell']).spinScore, 1476n);
  assert.equal(score(cherryBoard, ['square_seal', 'golden_harvest']).spinScore, 849n);
  const raw = rawRules(); raw.balance.symbols[0].linePayout = '900719925474099312345';
  assert.equal(score(cherryBoard, ['square_seal'], parseRules(raw)).patternScore, 900719925474099312345n * 4n);
});

test('best-candidate evaluation includes square gains before choosing a cell', () => {
  const board = ['cherry','cherry','lemon','cherry','lemon','cherry','bell','diamond','seven'];
  const run = (ids) => spinWithItems(rules, randomForBoard(board, rules, [0]), build(ids));
  assert.equal(run(['calculated_miracle']).triggeredItems[0].lineId, 'diag_anti');
  const square = run(['calculated_miracle', 'square_seal']);
  assert.equal(square.triggeredItems[0].lineId, 'row_middle');
  assert.equal(square.patternScore, 30n);
});

test('four-slot offers and rerolls are unique; v0.8 retains three slots and audit event shape', () => {
  const state = { ...createRun(rules), phase: 'SHOP', coins: 50 }, rng = new CounterRandom(seed);
  state.shop = createShop(state, rules, rng).shop;
  for (const shop of [state.shop, rerollShop(state, rules, rng).state.shop]) {
    assert.equal(shop.slots.length, 4);
    assert.equal(new Set(shop.slots.map((s) => s.itemId)).size, 4);
  }
  const raw = rawV08Rules(); raw.balance.round.roundTargets[0].targetScore = '1';
  const old = parseRules(raw), session = new GameSession(old, { userId: 'test', seed });
  const result = session.execute('test', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'old-spin' });
  assert.equal(result.state.shop.slots.length, 3);
  assert.equal(Object.hasOwn(result.event, 'patternScore'), false);
  assert.equal(Object.hasOwn(result.event, 'winningPatterns'), false);
  assert.deepEqual(replayAudit(old, session.exportAudit()), result.state);
});

test('server presentation emits ordered line/square coordinates and pre-global payouts', () => {
  const event = { type: 'SPIN_RESOLVED', ...spinWithItems(rules, randomForBoard(cherryBoard), build(['square_seal', 'resonant_bell'])) };
  const view = spinPresentation(event, rules);
  assert.equal(view.awards.length, 12);
  assert.deepEqual(view.awards.slice(0, 8).map((a) => a.id), rules.lines.map((l) => l.id));
  assert.deepEqual(view.awards.slice(8).map((a) => a.indices), rules.squares.map((s) => s.indices));
  assert.ok(view.awards.every((a) => a.score === '30'));
  assert.equal(view.effects.find((e) => e.itemId === 'square_seal').label, '2×2 4개 · +120점');
  const raw = rawRules(); raw.balance.symbols[0].weight = 100000;
  const fixture = parseRules(raw), session = new GameSession(fixture, { userId: 'test', seed, initialItemIds: ['square_seal', 'cherry_farm'] });
  const resolved = session.execute('test', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'new-spin' });
  assert.equal(resolved.event.patternScore, '120');
  assert.equal(resolved.event.baseScore, '18');
  assert.deepEqual(replayAudit(fixture, session.exportAudit()), session.getState('test'));
});
