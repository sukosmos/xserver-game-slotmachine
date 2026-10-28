import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, rawRules, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun } from '../src/domain/run.js';
import { createShop, getShopView, buyItem, rerollShop } from '../src/domain/shop.js';
import { eligibleDestinyCards } from '../src/domain/milestone.js';
import { CounterRandom } from '../src/server/random.js';
import { GameSession, restoreSession } from '../src/server/session.js';

const last = { nextInt: bound => bound - 1 };
function ready(overrides = {}) {
  const state = { ...createRun(rules), phase: 'SHOP', roundIndex: 5, coins: 100,
    milestoneReward: { cardId: 'windfall' }, ...overrides };
  return { ...state, shop: createShop(state, rules, last).shop };
}
const emil = state => state.shop.slots.find(slot => slot.itemId === 'emils_shop');

test('the three unowned cards can occupy all six shuffled orders', () => {
  const raw = rawRules(), keep = new Set([...raw.balance.shop.upgradeItemIds, 'emils_shop']);
  raw.catalog.items = raw.catalog.items.filter(item => keep.has(item.id));
  const config = parseRules(raw), state = { ...createRun(config), phase: 'SHOP', roundIndex: 5, milestoneReward: { cardId: 'windfall' } };
  const orders = new Set();
  for (let first = 0; first < 3; first++) for (let second = 0; second < 2; second++) {
    const draws = [0, 0, 0, 0, 0, 0, first, second];
    const result = createShop(state, config, { nextInt: () => draws.shift() });
    orders.add(emil({ shop: result.shop }).destinyCards.map(card => card.cardId).join(','));
    assert.equal(result.randomTrace.filter(draw => draw.purpose === 'shop_destiny_shuffle').length, 2);
    assert.equal(draws.length, 0);
  }
  assert.equal(orders.size, 6);
});

test('Emil shuffles unowned cards once and exposes only stable position IDs', () => {
  const state = ready(), slot = emil(state), before = structuredClone(state);
  assert.equal(slot.destinyCards.length, 3);
  assert.deepEqual(new Set(slot.destinyCards.map(c => c.cardId)), new Set(eligibleDestinyCards(state, rules).map(c => c.id)));
  const publicSlot = emil({ shop: getShopView(state, rules) });
  assert.deepEqual(publicSlot.destinyChoices, slot.destinyCards.map(({ slotId }) => ({ slotId })));
  assert.ok(!('destinyCards' in publicSlot));
  assert.doesNotMatch(JSON.stringify(publicSlot), /cardId|summary|windfall|evolve|wild/);
  assert.deepEqual(getShopView(state, rules), getShopView(state, rules));
  assert.deepEqual(state, before);
  const a = createShop(state, rules, new CounterRandom(seed)), b = createShop(state, rules, new CounterRandom(seed));
  assert.deepEqual(a, b);
});

test('each hidden position grants its fixed card once; identities and unknown positions cannot select a reward', () => {
  const state = ready(), slot = emil(state), snapshot = structuredClone(state);
  for (const card of slot.destinyCards) {
    const result = buyItem(state, slot.slotId, rules, { selectedDestinySlotId: card.slotId, rng: new CounterRandom(seed) });
    assert.equal(result.event.destinyReward.cardId, card.cardId);
    assert.equal(result.state.coins, 90);
    assert.equal(result.state.additionalMilestoneRewards.length, 1);
    assert.equal(result.state.shop.slots.find(s => s.slotId === slot.slotId).soldOut, true);
    assert.throws(() => buyItem(result.state, slot.slotId, rules, { selectedDestinySlotId: card.slotId }), { code: 'SOLD_OUT' });
  }
  assert.throws(() => buyItem(state, slot.slotId, rules, { selectedDestinyCardId: slot.destinyCards[0].cardId }), { code: 'INVALID_DESTINY_CARD' });
  assert.throws(() => buyItem(state, slot.slotId, rules, { selectedDestinySlotId: 'fake' }), { code: 'UNKNOWN_CARD_SLOT' });
  assert.throws(() => buyItem(state, slot.slotId, rules), { code: 'DESTINY_SELECTION_REQUIRED' });
  assert.deepEqual(state, snapshot);
});

test('rerolls invalidate old hidden positions and failed purchases preserve coins and the offer', () => {
  const state = ready(), old = emil(state), next = rerollShop(state, rules, last).state, slot = emil(next);
  assert.ok(slot.destinyCards.every(card => !old.destinyCards.some(c => c.slotId === card.slotId)));
  assert.throws(() => buyItem(next, slot.slotId, rules, { selectedDestinySlotId: old.destinyCards[0].slotId }), { code: 'UNKNOWN_CARD_SLOT' });
  const poor = { ...next, coins: 0 }, before = structuredClone(poor);
  assert.throws(() => buyItem(poor, slot.slotId, rules, { selectedDestinySlotId: slot.destinyCards[0].slotId }), { code: 'INSUFFICIENT_COINS' });
  assert.deepEqual(poor, before);
});

test('hidden selections and legacy public selections replay without changing RNG or duplicate rewards', () => {
  for (const hidden of [true, false]) {
    const raw = rawRules();
    if (!hidden) delete raw.catalog.items.find(i => i.id === 'emils_shop').effect.hiddenSelection;
    raw.balance.round.roundTargets.forEach(r => { r.targetScore = '1'; });
    raw.balance.economy.startingCoins = 100;
    const keep = new Set([...raw.balance.shop.upgradeItemIds, 'emils_shop']);
    raw.catalog.items = raw.catalog.items.filter(i => keep.has(i.id));
    const config = parseRules(raw), session = new GameSession(config, { userId: 'test', seed });
    let state = session.getState('test');
    const act = (type, extra = {}) => {
      const result = session.execute('test', { type, ...extra, expectedRevision: state.revision, idempotencyKey: `step-${state.revision}` });
      state = result.state; return result;
    };
    for (let round = 1; round <= 5; round++) {
      act('SPIN');
      if (state.phase === 'CARD_CHOICE') act('CHOOSE_CARD', { slotId: state.cardChoice.slots[0].slotId });
      if (round < 5) act('CONTINUE');
    }
    const slot = emil(state), choice = slot.destinyChoices[0];
    assert.deepEqual(restoreSession(config, session.exportAudit()).getState('test'), state);
    const command = { type: 'BUY_DESTINY', slotId: slot.slotId, expectedRevision: state.revision, idempotencyKey: 'buy',
      ...(hidden ? { selectedDestinySlotId: choice.slotId } : { selectedDestinyCardId: choice.cardId }) };
    const result = session.execute('test', command), audit = session.exportAudit();
    assert.deepEqual(session.execute('test', command), result);
    assert.deepEqual(session.exportAudit(), audit);
    assert.deepEqual(restoreSession(config, audit).exportAudit(), audit);
  }
});
