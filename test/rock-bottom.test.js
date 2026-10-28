import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, rawRules, rawLegacyRockRules, randomForBoard, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun } from '../src/domain/run.js';
import { acquireItem, discardItem } from '../src/domain/inventory.js';
import { scoreWithItems } from '../src/domain/item-scoring.js';
import { spinWithItems } from '../src/domain/items.js';
import { upgradeView } from '../src/server/upgrades.js';
import { GameSession, restoreSession } from '../src/server/session.js';
import { spinPresentation } from '../src/server/presentation.js';
import { publicCatalog } from '../src/server/catalog.js';

const board = count => Array.from({ length: 9 }, (_, i) => i < count ? 'diamond' : 'cherry');
const state = (...ids) => createRun(rules, { initialItemIds: ['rock_bottom', ...ids] });
const row = view => view.symbols.find(s => s.id === 'diamond');

test('rock bottom awards upgraded diamond points once for one, two or nine diamonds, zero when absent', () => {
  for (const stacks of [0, 1, 2, 5]) {
    const s = state(...Array(stacks).fill('gem_appraiser'));
    for (const count of [0, 1, 2, 9]) {
      const result = scoreWithItems(board(count), rules, s.items);
      assert.equal(result.specialFlatBonus, count ? BigInt(5 + 10 * stacks) * 100n : 0n);
      assert.equal(result.spinScore, result.baseScore + result.lineScore + result.specialFlatBonus);
    }
  }
});

test('card upgrades affect rock bottom, line multipliers do not, global factors and doubles apply afterwards', () => {
  const s = state('gem_appraiser', 'jackpot_crown', 'score_puffer', 'doubles');
  s.milestoneReward = { cardId: rules.balance.round.milestoneCards.cards.find(c => c.effect.kind === 'grant_symbol_upgrades').id };
  s.doublesArmedForNextHand = true;
  const b = ['diamond','cherry','lemon','bell','seven','cherry','lemon','bell','diamond'];
  const result = spinWithItems(rules, randomForBoard(b), s);
  assert.equal(result.specialFlatBonus, 2500n);
  assert.equal(result.spinScore, (result.baseScore + result.lineScore + result.specialFlatBonus) * 15n / 8n * 2n);
  assert.equal(row(upgradeView(s, rules).current).presenceBonus, '2500');
});

test('rock bottom follows the actual cell point including a zero-point contract', () => {
  const s = state('gem_appraiser', 'devils_contract');
  assert.equal(scoreWithItems(board(9), rules, s.items).specialFlatBonus, 0n);
  const r = row(upgradeView(s, rules).current);
  assert.equal(r.point, '0'); assert.equal(r.presenceBonus, '0');
});

test('only physical diamonds qualify, including diamonds that are marked wild', () => {
  const s = state('gem_appraiser');
  assert.equal(scoreWithItems(board(0), rules, s.items, { wildMarks: [0] }).specialFlatBonus, 0n);
  assert.equal(scoreWithItems(board(1), rules, s.items, { wildMarks: [0] }).specialFlatBonus, 1500n);
  const changed = state('help_hand');
  const b = ['diamond','diamond','cherry','bell','lemon','seven','cherry','bell','lemon'];
  const result = spinWithItems(rules, randomForBoard(b, rules, [0]), changed);
  assert.equal(result.board[2], 'diamond'); assert.equal(result.specialFlatBonus, 500n);
});

test('presence bonus is separate from per-cell stats, previews activation, and disappears after discard', () => {
  let s = { ...createRun(rules, { initialItemIds: ['gem_appraiser'] }), phase: 'SHOP' };
  s = { ...s, ...acquireItem(s, 'rock_bottom', rules, { activeFromRound: 2 }) };
  const view = upgradeView(s, rules);
  assert.equal(row(view.current).presenceBonus, undefined);
  assert.equal(row(view.next).presenceBonus, '1500');
  assert.equal(row(view.next).point, '15'); assert.equal(row(view.next).physicalPoint, undefined);
  assert.equal(row(view.next).linePayout, row(view.current).linePayout);
  s = { ...s, ...discardItem(s, s.items.at(-1).instanceId, rules) };
  assert.equal(row(upgradeView(s, rules).next).presenceBonus, undefined);
});

test('large upgraded values retain exact arithmetic and decimal display', () => {
  const raw = rawRules(); raw.catalog.items.find(i => i.id === 'gem_appraiser').effect.basePointAdd = '9007199254740993';
  const config = parseRules(raw), s = createRun(config, { initialItemIds: ['rock_bottom','gem_appraiser'] });
  const expected = (9007199254740993n + 5n) * 100n;
  assert.equal(scoreWithItems(board(9), config, s.items).specialFlatBonus, expected);
  assert.equal(row(upgradeView(s, config).current).presenceBonus, String(expected));
});

test('old and new rock-bottom rules replay, repeat requests, and show their own descriptions and effects', () => {
  for (const config of [rules, parseRules(rawLegacyRockRules())]) {
    const session = new GameSession(config, { userId: 'test', seed, initialItemIds: ['rock_bottom','gem_appraiser'] });
    const command = { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'rock-spin' };
    const result = session.execute('test', command);
    assert.deepEqual(session.execute('test', command), result);
    assert.deepEqual(restoreSession(config, session.exportAudit()).exportAudit(), session.exportAudit());
    const event = result.event;
    if (BigInt(event.specialFlatBonus) > 0n) assert.ok(spinPresentation(event, config).effects.some(e => e.itemId === 'rock_bottom' && e.label === `+${event.specialFlatBonus}점`));
  }
  const item = publicCatalog(rules).items.find(i => i.id === 'rock_bottom');
  assert.match(item.description, /스핀당 한 번/); assert.match(item.description, /강화/);
  const raw = rawRules(); raw.catalog.items.find(i => i.id === 'rock_bottom').effect.maxAwardsPerSpin = 2;
  assert.throws(() => parseRules(raw), { code: 'INVALID_RULES' });
});
