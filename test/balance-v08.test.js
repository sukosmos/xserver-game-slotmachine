import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, rawRules, rawLegacyRules, cherryBoard, randomForBoard, scriptedRandom, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { createShop, rerollShop } from '../src/domain/shop.js';
import { calculateClearReward } from '../src/domain/economy.js';
import { GameSession, replayAudit } from '../src/server/session.js';
import { upgradeView } from '../src/server/upgrades.js';

test('clear base grows each round; Hand and pre-settlement interest still add exactly', () => {
  for (let roundIndex = 1; roundIndex <= 10; roundIndex++) {
    const state = { ...createRun(rules), roundIndex, coins: 10, handsRemaining: 4 };
    const { settlement } = calculateClearReward(state, rules);
    assert.equal(settlement.baseReward, roundIndex + 1);
    assert.equal(settlement.reward, roundIndex + 7);
  }
  const raw = rawRules(); raw.balance.economy.clearRewardPerRound = Number.MAX_SAFE_INTEGER;
  assert.throws(() => calculateClearReward({ ...createRun(rules), roundIndex: 3 }, parseRules(raw)), { code: 'COIN_OVERFLOW' });
});

test('weight items are excluded from offers and rerolls until the round-three shop', () => {
  const raw = rawRules(); raw.catalog.items = raw.catalog.items.filter((i) => ['cherry_farm', 'golden_harvest'].includes(i.id));
  const config = parseRules(raw);
  for (const roundIndex of [1, 2, 3]) {
    let state = { ...createRun(config), roundIndex, phase: 'SHOP', coins: 20 };
    const rng = scriptedRandom(Array(20).fill(0));
    state.shop = createShop(state, config, rng).shop;
    const offered = (s) => s.shop.slots.some((slot) => slot.itemId === 'cherry_farm');
    assert.equal(offered(state), roundIndex === 3);
    assert.equal(offered(rerollShop(state, config, rng).state), roundIndex === 3);
  }
});

test('Hand purchases apply next round, stack to seven, pay unused Hands, and discard next-round benefit', () => {
  const raw = rawRules(); raw.balance.round.roundTargets.forEach((t) => { t.targetScore = '1'; });
  raw.balance.economy.startingCoins = 20;
  raw.catalog.items = raw.catalog.items.filter((i) => i.id === 'extra_hand');
  const config = parseRules(raw);
  let state = createRun(config);
  const spin = () => { const r = applyAction(state, { type: 'SPIN' }, config, randomForBoard(cherryBoard, config, [0, 0])); state = r.state; return r; };
  const command = (action) => { state = applyAction(state, action, config).state; };
  for (const total of [6, 7]) {
    spin(); command({ type: 'BUY', slotId: state.shop.slots[0].slotId });
    assert.equal(state.roundHands, total - 1);
    assert.equal(upgradeView(state, config).next.hands, total);
    command({ type: 'CONTINUE' });
    assert.equal(state.roundHands, total); assert.equal(state.handsRemaining, total);
  }
  const cleared = spin();
  assert.equal(cleared.event.settlement.handBonus, 6);
  assert.ok(state.shop.slots.every((slot) => slot.itemId === null));
  command({ type: 'DISCARD', instanceId: state.items[0].instanceId });
  assert.equal(state.roundHands, 7);
  assert.equal(upgradeView(state, config).next.hands, 6);
  command({ type: 'CONTINUE' }); assert.equal(state.handsRemaining, 6);
});

test('Hand cap, seeded replay and v0.7 state shape remain compatible', () => {
  const raw = rawRules(); raw.catalog.items.find((i) => i.id === 'extra_hand').effect.amount = 10;
  assert.equal(createRun(parseRules(raw), { initialItemIds: ['extra_hand'] }).roundHands, 7);
  const session = new GameSession(rules, { userId: 'alice', seed, initialItemIds: ['extra_hand'] });
  session.execute('alice', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin' });
  assert.deepEqual(replayAudit(rules, session.exportAudit()), session.getState('alice'));
  const old = rawLegacyRules();
  for (const part of Object.values(old)) part.version = 'v0.7';
  old.balance.round.baseHands = 5; old.balance.round.autoClearOnTarget = true; old.balance.economy.startingCoins = 2;
  const oldRules = parseRules(old), legacy = new GameSession(oldRules, { userId: 'alice', seed });
  const response = legacy.execute('alice', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin' });
  assert.equal(Object.hasOwn(response.state, 'roundHands'), false);
  assert.equal(calculateClearReward({ ...createRun(oldRules), roundIndex: 4 }, oldRules).settlement.baseReward, 2);
  assert.deepEqual(replayAudit(oldRules, legacy.exportAudit()), response.state);
});
