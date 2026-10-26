import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateClearReward } from '../src/domain/economy.js';
import { createShop, buyItem, rerollShop, discardShopItem, getShopView } from '../src/domain/shop.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { acquireItem } from '../src/domain/inventory.js';
import { parseRules } from '../src/domain/rules.js';
import { legacyRules as rules, rawLegacyRules as rawRules, cherryBoard, noLineBoard, scriptedRandom, randomForBoard } from './helpers.js';

const zeros = () => ({ nextInt: () => 0 });
const withItems = (ids = []) => createRun(rules, { initialItemIds: ids });
function shopState({ ids = [], coins = 20, config = rules, offers = null } = {}) {
  const state = { ...createRun(config, { initialItemIds: ids }), phase: 'SHOP', completedRounds: 1, coins };
  state.shop = createShop(state, config, zeros()).shop;
  if (offers) state.shop.slots = state.shop.slots.map((slot, index) => ({ ...slot, itemId: offers[index] ?? null, soldOut: false }));
  return state;
}
const firstSlot = (state) => state.shop.slots[0].slotId;

test('ECON-01/02: interest uses pre-settlement coins and is capped', () => {
  const a = calculateClearReward({ ...withItems(), coins: 7, handsRemaining: 2 }, rules, zeros()).settlement;
  assert.deepEqual(a, { coinsBefore: 7, baseReward: 2, itemBaseBonus: 0, handBonus: 2, interest: 1, interestCap: 2, bonusCoins: 0, reward: 5, coinsAfterReward: 12, triggeredItems: [] });
  const b = calculateClearReward({ ...withItems(), coins: 12, handsRemaining: 0 }, rules, zeros()).settlement;
  assert.equal(b.interest, 2);
  assert.equal(b.reward, 4);
  assert.equal(b.coinsAfterReward, 16);
  assert.equal(calculateClearReward({ ...withItems(), coins: 4, handsRemaining: 3 }, rules, zeros()).settlement.interest, 0);
});

test('piggy copies and compound magic change base reward and interest cap from JSON', () => {
  const state = { ...withItems(['piggy_bank', 'piggy_bank', 'compound_magic']), coins: 20, handsRemaining: 2 };
  const reward = calculateClearReward(state, rules, zeros()).settlement;
  assert.equal(reward.itemBaseBonus, 2);
  assert.equal(reward.interestCap, 3);
  assert.equal(reward.interest, 3);
  assert.equal(reward.reward, 9);
  assert.equal(calculateClearReward({ ...withItems(['piggy_bank']), coins: 7, handsRemaining: 2 }, rules, zeros()).settlement.coinsAfterReward, 13);
});

test('payday triggers below 2500 only, uses one draw, and excludes pending items', () => {
  const state = { ...withItems(['lucky_payday']), handsRemaining: 0 };
  const success = calculateClearReward(state, rules, scriptedRandom([2499]));
  assert.equal(success.settlement.bonusCoins, 3);
  assert.equal(success.randomTrace.length, 1);
  assert.equal(success.randomTrace[0].purpose, 'clear_bonus');
  assert.equal(calculateClearReward(state, rules, scriptedRandom([2500])).settlement.bonusCoins, 0);
  const pending = acquireItem(withItems(), 'lucky_payday', rules, { activeFromRound: 2 });
  assert.equal(calculateClearReward({ ...withItems(), ...pending }, rules, scriptedRandom([])).settlement.bonusCoins, 0);
});

test('bad/overflowing coin values fail instead of silently rounding', () => {
  for (const coins of [-1, 0.1, '12', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateClearReward({ ...withItems(), coins }, rules, zeros()));
  }
  assert.throws(() => calculateClearReward({ ...withItems(), coins: Number.MAX_SAFE_INTEGER }, rules, zeros()), { code: 'COIN_OVERFLOW' });
  const s = shopState({ coins: Number.MAX_SAFE_INTEGER });
  const result = buyItem(s, firstSlot(s), rules);
  assert.equal(result.state.coins, Number.MAX_SAFE_INTEGER - 2);
});

test('SHOP-01: purchase debits server price, marks stock sold and activates next round', () => {
  const state = shopState({ coins: 5, offers: ['golden_harvest'] });
  const before = structuredClone(state);
  const result = buyItem(state, firstSlot(state), rules);
  assert.equal(result.state.coins, 2);
  assert.equal(result.state.shop.slots[0].itemId, null);
  assert.equal(result.state.shop.slots[0].soldOut, true);
  assert.equal(result.state.items[0].activeFromRound, 2);
  assert.equal(result.event.price, 3);
  assert.equal(result.event.coinsBefore, 5);
  assert.equal(result.event.coinsAfter, 2);
  assert.deepEqual(state, before);
  assert.throws(() => buyItem(result.state, firstSlot(state), rules), { code: 'SOLD_OUT' });
});

test('SHOP-02: paid rerolls cost 1, 2, 3, replace sold slots and expire old slot IDs', () => {
  let state = shopState({ coins: 10 });
  const oldSlot = firstSlot(state);
  for (const price of [1, 2, 3]) {
    const result = rerollShop(state, rules, zeros());
    assert.equal(result.event.price, price);
    assert.equal(result.state.shop.paidRerolls, price);
    assert.ok(result.state.shop.slots.every((slot) => slot.itemId !== null && !slot.soldOut));
    state = result.state;
  }
  assert.equal(state.coins, 4);
  assert.throws(() => buyItem(state, oldSlot, rules), { code: 'UNKNOWN_SHOP_SLOT' });
  const nextShop = createShop({ ...state, roundIndex: 2 }, rules, zeros()).shop;
  assert.equal(nextShop.paidRerolls, 0);
  assert.equal(nextShop.freeRerollsUsed, 0);
});

test('SHOP-03: VIP can reroll with zero coins without incrementing paid count', () => {
  const state = shopState({ ids: ['vip_pass'], coins: 0 });
  assert.equal(getShopView(state, rules).rerollPrice, 0);
  const result = rerollShop(state, rules, zeros());
  assert.equal(result.state.coins, 0);
  assert.equal(result.state.shop.paidRerolls, 0);
  assert.equal(result.state.shop.freeRerollsUsed, 1);
  assert.equal(result.event.free, true);
  assert.throws(() => rerollShop(result.state, rules, scriptedRandom([])), { code: 'INSUFFICIENT_COINS' });
});

test('new VIP applies next shop, and discard/rebuy cannot reset current free-use history', () => {
  const state = shopState({ offers: ['vip_pass'] });
  const bought = buyItem(state, firstSlot(state), rules).state;
  assert.equal(getShopView(bought, rules).rerollPrice, 1);
  const next = { ...bought, roundIndex: 2, shop: createShop({ ...bought, roundIndex: 2 }, rules, zeros()).shop };
  assert.equal(getShopView(next, rules).rerollPrice, 0);
  const used = rerollShop(next, rules, zeros()).state;
  const discarded = discardShopItem(used, used.items[0].instanceId, rules).state;
  discarded.shop.slots[0] = { ...discarded.shop.slots[0], itemId: 'vip_pass', soldOut: false };
  const repurchased = buyItem(discarded, firstSlot(discarded), rules).state;
  assert.equal(repurchased.shop.freeRerollsUsed, 1);
  assert.equal(getShopView(repurchased, rules).rerollPrice, 1);
});

test('haggler discounts later purchases immediately, never itself or rerolls, and discard removes discount', () => {
  const state = shopState({ offers: ['haggler', 'cherry_farm', 'golden_harvest'] });
  const bought = buyItem(state, firstSlot(state), rules);
  assert.equal(bought.event.price, 8);
  const view = getShopView(bought.state, rules);
  assert.equal(view.slots[1].price, 1);
  assert.equal(view.slots[2].price, 2);
  assert.equal(view.rerollPrice, 1);
  const removed = discardShopItem(bought.state, bought.state.items[0].instanceId, rules);
  assert.equal(removed.state.coins, bought.state.coins);
  assert.equal(getShopView(removed.state, rules).slots[1].price, 2);
  const raw = rawRules(); raw.catalog.items.find((item) => item.id === 'haggler').effect.amount = 100;
  const config = parseRules(raw);
  assert.equal(getShopView(shopState({ ids: ['haggler'], config }), config).slots[0].price, 1);
});

test('SHOP-04: insufficient coins, capped items and full inventories reject without mutation', () => {
  const cases = [
    [shopState({ coins: 1 }), 'INSUFFICIENT_COINS'],
    [shopState({ ids: ['cherry_farm', 'cherry_farm', 'cherry_farm'], offers: ['cherry_farm'] }), 'ITEM_CAP_REACHED'],
    [shopState({ ids: ['miracle_hand', 'joker_mask'], offers: ['magnet_device'] }), 'INVENTORY_FULL'],
  ];
  for (const [state, code] of cases) {
    const before = structuredClone(state);
    assert.throws(() => buyItem(state, firstSlot(state), rules), { code });
    assert.deepEqual(state, before);
    assert.equal(getShopView(state, rules).slots[0].blockedReason, code);
  }
});

test('full permanent slots allow stacking an owned ID and discarding one instance frees the right capacity', () => {
  const ids = rules.catalog.items.filter((item) => item.slot === 'permanent').slice(0, 8).map((item) => item.id);
  const state = shopState({ ids, offers: ['cherry_farm', 'resonant_bell'] });
  assert.equal(getShopView(state, rules).slots[0].canBuy, true);
  assert.equal(getShopView(state, rules).slots[1].blockedReason, 'INVENTORY_FULL');
  const discarded = discardShopItem(state, state.items[1].instanceId, rules).state;
  assert.equal(getShopView(discarded, rules).slots[1].canBuy, true);
  assert.equal(discarded.coins, state.coins);
});

test('offers use rarity-then-uniform draws, no duplicate IDs, and renormalize empty tiers', () => {
  const raw = rawRules();
  raw.catalog.items = raw.catalog.items.filter((item) => ['cherry_farm', 'lemon_orchard', 'jackpot_crown'].includes(item.id));
  const config = parseRules(raw);
  const rng = scriptedRandom([60, 0, 0, 1, 0, 0]);
  const result = createShop(createRun(config), config, rng);
  assert.deepEqual(result.shop.slots.map((slot) => slot.itemId), ['jackpot_crown', 'lemon_orchard', 'cherry_farm']);
  assert.deepEqual(result.randomTrace.map(({ bound }) => bound), [63, 1, 60, 2, 60, 1]);
  assert.equal(rng.draws, 6);
});

test('cap-filtered and exhausted pools leave null slots without extra RNG', () => {
  const raw = rawRules(); raw.catalog.items = raw.catalog.items.filter((item) => item.id === 'vip_pass');
  const config = parseRules(raw);
  const one = createShop(createRun(config), config, scriptedRandom([0, 0]));
  assert.deepEqual(one.shop.slots.map((slot) => slot.itemId), ['vip_pass', null, null]);
  const owned = createShop(createRun(config, { initialItemIds: ['vip_pass'] }), config, scriptedRandom([]));
  assert.ok(owned.shop.slots.every((slot) => slot.itemId === null));
  assert.equal(owned.randomTrace.length, 0);
});

test('unlimited purchases continue beyond three through paid rerolls', () => {
  let state = shopState({ coins: 50 });
  let purchases = 0;
  for (let batch = 0; batch < 2; batch++) {
    for (const slot of state.shop.slots) {
      state = buyItem(state, slot.slotId, rules).state;
      purchases++;
    }
    if (batch === 0) state = rerollShop(state, rules, zeros()).state;
  }
  assert.equal(purchases, 6);
  assert.equal(state.items.length, 6);
  assert.equal(state.coins, 35); // (2+2+3)*2 + one reroll
});

test('9.4: first-Hand claim, farm buy, reroll, next round, failure resets assets', () => {
  let state = createRun(rules);
  state = applyAction(state, { type: 'SPIN' }, rules, randomForBoard(cherryBoard)).state;
  const claimed = applyAction(state, { type: 'CLAIM' }, rules, zeros());
  state = claimed.state;
  assert.equal(state.phase, 'SHOP');
  assert.equal(state.coins, 5);
  assert.equal(claimed.event.settlement.handBonus, 3);
  state = applyAction(state, { type: 'BUY', slotId: firstSlot(state) }, rules).state;
  assert.equal(state.coins, 3);
  assert.equal(state.items[0].itemId, 'cherry_farm');
  state = applyAction(state, { type: 'REROLL' }, rules, zeros()).state;
  assert.equal(state.coins, 2);
  state = applyAction(state, { type: 'CONTINUE' }, rules).state;
  assert.equal(state.roundIndex, 2);
  assert.equal(state.handsRemaining, 4);
  assert.equal(state.roundScore, 0n);
  const weightedRules = { ...rules, symbols: rules.symbols.map((symbol) => ({ ...symbol, weight: symbol.weight + (symbol.id === 'cherry' ? 10 : 0) })) };
  for (let i = 0; i < 4; i++) state = applyAction(state, { type: 'SPIN' }, rules, randomForBoard(noLineBoard, weightedRules)).state;
  assert.equal(state.phase, 'RUN_FAILED');
  assert.equal(state.completedRounds, 1);
  assert.equal(state.coins, 0);
  assert.deepEqual(state.items, []);
  assert.equal(state.shop, null);
});

test('final clear pays and logs the reward then ends without drawing a shop; failure never pays', () => {
  const raw = rawRules(); raw.balance.round.maxRoundMvp = 1; raw.balance.round.roundTargets = [{ round: 1, targetScore: '1' }];
  const config = parseRules(raw);
  let state = createRun(config, { initialItemIds: ['piggy_bank', 'lucky_payday'] });
  state = applyAction(state, { type: 'SPIN' }, config, randomForBoard(cherryBoard)).state;
  const result = applyAction(state, { type: 'CLAIM' }, config, scriptedRandom([0]));
  assert.equal(result.event.settlement.reward, 9);
  assert.equal(result.randomTrace.length, 1);
  assert.equal(result.state.phase, 'RUN_WON');
  assert.equal(result.state.coins, 0);
  assert.equal(result.state.shop, null);
  assert.deepEqual(result.state.items, []);
  const failed = { ...createRun(rules, { initialItemIds: ['lucky_payday'] }), coins: 12, handsRemaining: 1 };
  const loss = applyAction(failed, { type: 'SPIN' }, rules, randomForBoard(noLineBoard));
  assert.equal(loss.state.phase, 'RUN_FAILED');
  assert.equal(loss.event.settlement, null);
  assert.equal(loss.randomTrace.length, 9);
  assert.equal(loss.state.coins, 0);
});
