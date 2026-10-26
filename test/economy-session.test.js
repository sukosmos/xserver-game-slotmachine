import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, replayAudit, rulesFingerprint } from '../src/server/session.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { createShop, rerollShop } from '../src/domain/shop.js';
import { rawRules, seed, cherryBoard, randomForBoard } from './helpers.js';

const owner = 'owner';
function fixture({ coins = 20, initialItemIds = [], itemIds = null, edit = () => {} } = {}) {
  const raw = rawRules();
  raw.balance.round.roundTargets.forEach((target) => { target.targetScore = '1'; });
  raw.balance.economy.startingCoins = coins;
  if (itemIds) raw.catalog.items = raw.catalog.items.filter((item) => itemIds.includes(item.id));
  edit(raw);
  const rules = parseRules(raw);
  return { rules, session: new GameSession(rules, { userId: owner, runId: 'economy-test', seed, initialItemIds }) };
}
const stateOf = (session) => session.getState(owner);
const request = (session, action, key = `action-${stateOf(session).revision}`) => ({ ...action, expectedRevision: stateOf(session).revision, idempotencyKey: key });
const execute = (session, action) => session.execute(owner, request(session, action));
function enterShop(session) {
  execute(session, { type: 'SPIN' });
  return execute(session, { type: 'CLAIM' });
}

test('SEC-02: claim, purchase, reroll, discard and continue retries execute exactly once', () => {
  const { rules, session } = fixture({ itemIds: ['cherry_farm', 'lemon_orchard', 'golden_harvest'] });
  execute(session, { type: 'SPIN' });
  for (const makeAction of [
    () => ({ type: 'CLAIM' }),
    () => ({ type: 'BUY', slotId: stateOf(session).shop.slots[0].slotId }),
    () => ({ type: 'REROLL' }),
    () => ({ type: 'DISCARD', instanceId: stateOf(session).items[0].instanceId }),
    () => ({ type: 'CONTINUE' }),
  ]) {
    const command = request(session, makeAction());
    const first = session.execute(owner, command);
    const audit = session.exportAudit();
    assert.deepEqual(session.execute(owner, command), first);
    assert.deepEqual(session.exportAudit(), audit);
    assert.throws(() => session.execute('intruder', command), { code: 'NOT_OWNER' });
  }
  assert.equal(stateOf(session).roundIndex, 2);
  assert.equal(session.exportAudit().actions.length, 6);
  assert.deepEqual(replayAudit(rules, JSON.parse(JSON.stringify(session.exportAudit()))), stateOf(session));
});

test('purchase reads server price; payload/price/coin forgery and key conflicts are rejected', () => {
  const { session } = fixture(); enterShop(session);
  const slots = stateOf(session).shop.slots;
  const buy = request(session, { type: 'BUY', slotId: slots[0].slotId });
  const initial = session.exportAudit();
  for (const field of ['price', 'itemId', 'coins', 'activeFromRound']) {
    assert.throws(() => session.execute(owner, { ...buy, [field]: 0 }), { code: 'INVALID_COMMAND' });
  }
  for (const action of [{ type: 'BUY' }, { type: 'BUY', slotId: 1 }, { type: 'BUY', slotId: '' }, { type: 'DISCARD', instanceId: null }, { type: 'REROLL', free: true }]) {
    assert.throws(() => session.execute(owner, request(session, action)), { code: 'INVALID_COMMAND' });
  }
  assert.deepEqual(session.exportAudit(), initial);
  const result = session.execute(owner, buy);
  assert.equal(result.event.price, slots[0].price);
  assert.equal(result.state.coins, initial.finalState.coins - slots[0].price);
  assert.throws(() => session.execute(owner, { ...buy, slotId: slots[1].slotId }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => session.execute(owner, { ...buy, idempotencyKey: 'new-key' }), { code: 'STALE_REVISION' });
  assert.throws(() => execute(session, { type: 'BUY', slotId: slots[0].slotId }), { code: 'SOLD_OUT' });
});

test('failed commands preserve state/RNG/audit and do not reserve idempotency keys', () => {
  const { session } = fixture({ coins: 0, itemIds: ['jackpot_crown'] }); enterShop(session);
  const before = session.exportAudit();
  const buy = request(session, { type: 'BUY', slotId: stateOf(session).shop.slots[0].slotId }, 'retry');
  assert.equal(stateOf(session).shop.slots[0].blockedReason, 'INSUFFICIENT_COINS');
  assert.throws(() => session.execute(owner, buy), { code: 'INSUFFICIENT_COINS' });
  assert.throws(() => execute(session, { type: 'CLAIM' }), { code: 'INVALID_RUN_PHASE' });
  assert.throws(() => execute(session, { type: 'DISCARD', instanceId: 'missing' }), { code: 'UNKNOWN_ITEM_INSTANCE' });
  assert.deepEqual(session.exportAudit(), before);
  session.execute(owner, request(session, { type: 'REROLL' }, 'retry'));
  const after = session.exportAudit();
  assert.throws(() => execute(session, { type: 'BUY', slotId: buy.slotId }), { code: 'UNKNOWN_SHOP_SLOT' });
  assert.deepEqual(session.exportAudit(), after);
});

test('full inventory rejection can be resolved by discard then reusing the failed purchase key', () => {
  const raw = rawRules();
  const ids = raw.catalog.items.filter((i) => i.slot === 'permanent').slice(0, 8).map((i) => i.id);
  const { session } = fixture({ initialItemIds: ids, itemIds: [...ids, 'resonant_bell'], edit(config) {
    for (const item of config.catalog.items) if (ids.includes(item.id)) item.maxStacks = 1;
  } }); enterShop(session);
  const slot = stateOf(session).shop.slots.find((s) => s.itemId === 'resonant_bell');
  assert.ok(slot);
  const before = session.exportAudit();
  assert.equal(slot.blockedReason, 'INVENTORY_FULL');
  assert.throws(() => session.execute(owner, request(session, { type: 'BUY', slotId: slot.slotId }, 'retry-buy')), { code: 'INVENTORY_FULL' });
  assert.deepEqual(session.exportAudit(), before);
  execute(session, { type: 'DISCARD', instanceId: stateOf(session).items[0].instanceId });
  const bought = session.execute(owner, request(session, { type: 'BUY', slotId: slot.slotId }, 'retry-buy'));
  assert.equal(bought.event.itemId, 'resonant_bell');
});

test('automatic settlement logs spin then payday then offers; purchase/discard/continue use no RNG', () => {
  const { rules, session } = fixture({ initialItemIds: ['lucky_payday'], itemIds: ['lucky_payday', 'cherry_farm', 'golden_harvest'] });
  for (let i = 0; i < 4; i++) execute(session, { type: 'SPIN' });
  const finalSpin = session.exportAudit().actions.at(-1);
  assert.equal(finalSpin.response.event.outcome, 'ROUND_AUTO_CLEARED');
  assert.equal(finalSpin.response.event.settlement.handBonus, 0);
  assert.equal(finalSpin.randomTrace[9].purpose, 'clear_bonus');
  assert.deepEqual(finalSpin.randomTrace.slice(10).map((x) => x.purpose), ['shop_rarity', 'shop_item', 'shop_rarity', 'shop_item']);
  execute(session, { type: 'BUY', slotId: stateOf(session).shop.slots[0].slotId });
  execute(session, { type: 'DISCARD', instanceId: stateOf(session).items.at(-1).instanceId });
  execute(session, { type: 'CONTINUE' });
  for (const record of session.exportAudit().actions.slice(-3)) {
    assert.equal(record.rngBefore, record.rngAfter);
    assert.deepEqual(record.randomTrace, []);
  }
  assert.deepEqual(replayAudit(rules, session.exportAudit()), stateOf(session));
});

test('overflow after a payday draw rolls back the entire claim or final spin', () => {
  for (const auto of [false, true]) {
    const { session } = fixture({ coins: Number.MAX_SAFE_INTEGER - (auto ? 5 : 7), initialItemIds: ['lucky_payday'], edit(raw) {
      raw.catalog.items.find((i) => i.id === 'lucky_payday').effect.triggerChanceBasisPoints = 10000;
    } });
    for (let i = 0; i < (auto ? 3 : 1); i++) execute(session, { type: 'SPIN' });
    const before = session.exportAudit();
    assert.throws(() => execute(session, { type: auto ? 'SPIN' : 'CLAIM' }), { code: 'COIN_OVERFLOW' });
    assert.deepEqual(session.exportAudit(), before);
  }
});

test('shop actions outside SHOP and references from previous rounds are rejected', () => {
  const { session } = fixture();
  for (const action of [{ type: 'BUY', slotId: 'fake' }, { type: 'REROLL' }, { type: 'DISCARD', instanceId: 'fake' }]) {
    assert.throws(() => execute(session, action), { code: 'INVALID_RUN_PHASE' });
  }
  enterShop(session);
  const slotId = stateOf(session).shop.slots[0].slotId;
  execute(session, { type: 'CONTINUE' }); enterShop(session);
  const before = session.exportAudit();
  assert.throws(() => execute(session, { type: 'BUY', slotId }), { code: 'UNKNOWN_SHOP_SLOT' });
  assert.deepEqual(session.exportAudit(), before);
});

test('public shop/reward views do not expose RNG and cannot mutate stock or inventory', () => {
  const { session } = fixture({ initialItemIds: ['lucky_payday', 'vip_pass'] });
  const response = enterShop(session);
  const before = session.exportAudit();
  const json = JSON.stringify(response);
  for (const secret of [seed, 'randomTrace', 'rngBefore', 'rngAfter', 'initialSeed', 'counter']) assert.ok(!json.includes(secret));
  response.state.shop.slots[0].price = 0;
  response.state.items[0].remainingCharges = 999;
  response.event.settlement.reward = 999;
  assert.deepEqual(session.exportAudit(), before);
});

test('v3 replay verifies coins, shop inventory, reward RNG, and canonical rarity order', () => {
  const { rules, session } = fixture({ initialItemIds: ['lucky_payday', 'vip_pass'] }); enterShop(session);
  execute(session, { type: 'REROLL' });
  execute(session, { type: 'BUY', slotId: stateOf(session).shop.slots.find((s) => s.canBuy).slotId });
  const audit = session.exportAudit();
  for (const mutate of [
    (a) => { a.actions[1].response.event.settlement.reward++; },
    (a) => { a.actions[1].randomTrace[0].value++; },
    (a) => { a.finalState.shop.slots[0].price = 0; },
    (a) => { a.finalState.coins++; },
  ]) {
    const corrupted = structuredClone(audit); mutate(corrupted);
    assert.throws(() => replayAudit(rules, corrupted), { code: 'REPLAY_MISMATCH' });
  }
  assert.throws(() => replayAudit(rules, { ...audit, format: 'slot-audit-v2' }), { code: 'INVALID_AUDIT' });
  const raw = { balance: structuredClone(rules.balance), catalog: rules.catalog, lines: rules.lineDefinitions };
  raw.balance.shop.rarityWeight = Object.fromEntries(Object.entries(raw.balance.shop.rarityWeight).reverse());
  const reordered = parseRules(raw);
  assert.equal(rulesFingerprint(reordered), rulesFingerprint(rules));
  assert.deepEqual(replayAudit(reordered, audit), stateOf(session));
});

test('late shop RNG failure leaves the pure transition input intact', () => {
  const { rules } = fixture();
  const state = applyAction(createRun(rules), { type: 'SPIN' }, rules, randomForBoard(cherryBoard)).state;
  const before = structuredClone(state);
  let draws = 0;
  assert.throws(() => applyAction(state, { type: 'CLAIM' }, rules, { nextInt() { if (++draws === 4) throw new Error('RNG unavailable'); return 0; } }), /RNG unavailable/);
  assert.deepEqual(state, before);
});

test('reroll counter exhaustion rejects before consuming coins or RNG', () => {
  const { rules } = fixture();
  const state = { ...createRun(rules), phase: 'SHOP' };
  state.shop = createShop(state, rules, { nextInt: () => 0 }).shop;
  state.shop.offerSequence = Number.MAX_SAFE_INTEGER;
  const before = structuredClone(state);
  assert.throws(() => rerollShop(state, rules, { nextInt() { assert.fail('must reject before RNG'); } }), { code: 'SHOP_COUNTER_EXHAUSTED' });
  assert.deepEqual(state, before);
});
