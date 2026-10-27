import test from 'node:test';
import assert from 'node:assert/strict';
import { spinPresentation } from '../src/server/presentation.js';
import { publicCatalog } from '../src/server/catalog.js';
import { spinWithItems } from '../src/domain/items.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { parseRules } from '../src/domain/rules.js';
import { rules, rawRules, cherryBoard, noLineBoard, randomForBoard } from './helpers.js';

test('descriptions use percentages and exact current streak multipliers reach the UI', () => {
  const catalog = publicCatalog(rules);
  for (const item of catalog.items) assert.doesNotMatch(item.description + item.summary, /\d+\/\d+/);
  assert.match(catalog.items.find((i) => i.id === 'lemon_syrup').description, /150%/);
  const initial = createRun(rules, { initialItemIds: ['win_streak', 'golden_harvest'] });
  for (const [consecutiveWinHands, multiplier] of [[0, '1'], [1, '1.5'], [2, '2.25'], [10, '5.0625']]) {
    const event = { type: 'SPIN_RESOLVED', ...spinWithItems(rules, randomForBoard(cherryBoard), { ...initial, consecutiveWinHands }) };
    const view = spinPresentation(event, rules);
    assert.equal(view.multiplier, `×${multiplier}`);
    assert.equal(view.effects.some((e) => e.itemId === 'win_streak'), consecutiveWinHands > 0);
    assert.equal(view.effects.find((e) => e.itemId === 'golden_harvest').label, '배당 +200% · 1칸 +2');
  }
});
test('inactive conditions do not claim activation; real board triggers and expiry are shown', () => {
  const initial = createRun(rules, { initialItemIds: ['win_streak', 'resonant_bell', 'golden_harvest'] });
  const event = { type: 'SPIN_RESOLVED', ...spinWithItems(rules, randomForBoard(noLineBoard), initial) };
  assert.deepEqual(spinPresentation(event, rules).effects, []);
  const wild = createRun(rules, { initialItemIds: ['joker_mask'] });
  const first = spinWithItems(rules, randomForBoard(cherryBoard,rules,[0]), wild);
  const second = { type: 'SPIN_RESOLVED', ...spinWithItems(rules, randomForBoard(cherryBoard), { ...wild, items: first.itemsAfterSpin }) };
  assert.deepEqual(second.triggeredItems, []);
  const view = spinPresentation({ type:'SPIN_RESOLVED', ...first }, rules);
  assert.equal(view.effects[0].label, '중앙 WILD');
  assert.equal(view.expired[0].itemId, 'joker_mask');
  assert.equal(spinPresentation({ type: 'ITEM_PURCHASED' }, rules), null);
});

test('board and economic cues follow actual triggers without changing the resolved result', () => {
  const raw = rawRules(); raw.balance.round.roundTargets[0].targetScore = '1';
  const config = parseRules(raw);
  const state = createRun(config, { initialItemIds: ['miracle_hand', 'piggy_bank', 'lucky_payday'] });
  const candidateBoard = ['cherry', 'cherry', 'diamond', 'bell', 'lemon', 'seven', 'diamond', 'bell', 'lemon'];
  const { event } = applyAction(state, { type: 'SPIN' }, config, randomForBoard(candidateBoard, config, Array(14).fill(0)));
  const before = structuredClone(event), view = spinPresentation(event, config);
  assert.ok(event.rawBoard.some((symbol, index) => symbol !== event.board[index]));
  assert.equal(view.effects.find((e) => e.itemId === 'miracle_hand').label, '라인 완성');
  assert.equal(view.effects.find((e) => e.itemId === 'piggy_bank').label, '+1코인');
  assert.equal(view.effects.find((e) => e.itemId === 'lucky_payday').label, '+3코인');
  assert.deepEqual(event, before);
});
