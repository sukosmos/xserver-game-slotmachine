import { requireCondition } from './errors.js';
import { getItem } from './rules.js';
import { acquireItem, discardItem, validateItems, activeItems } from './inventory.js';
import { assertCoins, safeAmount } from './money.js';
import { createWeightedTable, drawSymbol } from './slot.js';
import { drawInt } from './random-draw.js';
import { isItemEnabled } from './selected8-contract.js';
import { hasSelected8 } from './selected8.js';

function assertShop(state) {
  requireCondition(state.phase === 'SHOP' && state.shop !== null && typeof state.shop === 'object', 'INVALID_RUN_PHASE');
  assertCoins(state.coins);
}

/** Stack cap filters the pool; space and affordability are purchase checks. */
export function createShop(state, rules, rng, { offerSequence = 0, paidRerolls = 0, freeRerollsUsed = 0 } = {}) {
  validateItems(state.items, rules);
  for (const value of [offerSequence, paidRerolls, freeRerollsUsed]) {
    requireCondition(Number.isSafeInteger(value) && value >= 0, 'INVALID_SHOP_COUNTER');
  }
  const counts = new Map();
  for (const instance of state.items) counts.set(instance.itemId, (counts.get(instance.itemId) ?? 0) + 1);
  let pool = rules.catalog.items.filter((item) => isItemEnabled(item, rules) && state.roundIndex >= (item.minShopRound ?? 1) && (counts.get(item.id) ?? 0) < item.maxStacks);
  const randomTrace = [];
  const slots = Array.from({ length: rules.balance.shop.slots }, (_, index) => {
    const slotId = `round-${state.roundIndex}-offer-${offerSequence}-slot-${index}`;
    if (pool.length === 0) return { slotId, itemId: null, soldOut: false };
    const rarityWeights = ['common', 'rare', 'epic', 'legendary']
      .filter((rarity) => pool.some((item) => item.rarity === rarity))
      .map((id) => ({ id, weight: rules.balance.shop.rarityWeight[id] }));
    const rarity = drawSymbol(createWeightedTable(rarityWeights), {
      nextInt: (bound) => drawInt(rng, bound, randomTrace, { purpose: 'shop_rarity', slotId }),
    });
    const options = pool.filter((item) => item.rarity === rarity);
    const selected = options[drawInt(rng, options.length, randomTrace, { purpose: 'shop_item', slotId })];
    pool = pool.filter((item) => item.id !== selected.id);
    return { slotId, itemId: selected.id, soldOut: false };
  });
  return { shop: { slots, offerSequence, paidRerolls, freeRerollsUsed }, randomTrace };
}

export function itemPrice(itemId, items, rules) {
  const item = getItem(rules, itemId);
  let discount = 0n;
  let floor = BigInt(rules.balance.shop.discountPriceFloor);
  for (const instance of items) {
    const effect = getItem(rules, instance.itemId).effect;
    // Discount is the documented immediate-ownership exception to activation round.
    if (effect.kind === 'shop_item_cost_subtract') {
      discount += BigInt(effect.amount);
      if (BigInt(effect.minPrice) > floor) floor = BigInt(effect.minPrice);
    }
  }
  const discounted = BigInt(item.price) - discount;
  return safeAmount(discounted < floor ? floor : discounted);
}

function purchaseQuote(state, slot, rules) {
  if (slot.itemId === null) return { price: null, canBuy: false, blockedReason: slot.soldOut ? 'SOLD_OUT' : 'EMPTY_SHOP_SLOT' };
  const price = itemPrice(slot.itemId, state.items, rules);
  let blockedReason = null;
  try { acquireItem(state, slot.itemId, rules, { activeFromRound: state.roundIndex + 1 }); }
  catch (error) {
    if (!['ITEM_CAP_REACHED', 'INVENTORY_FULL', 'ITEM_ORDER_EXHAUSTED'].includes(error.code)) throw error;
    blockedReason = error.code;
  }
  if (blockedReason === null && state.coins < price) blockedReason = 'INSUFFICIENT_COINS';
  return { price, canBuy: blockedReason === null, blockedReason };
}

function rerollQuote(state, rules) {
  let freeAllowance = 0n;
  for (const instance of activeItems(state.items, rules, state.roundIndex)) {
    const effect = getItem(rules, instance.itemId).effect;
    if (effect.kind === 'one_free_reroll_per_shop') freeAllowance += BigInt(effect.amount);
  }
  const remaining = freeAllowance - BigInt(state.shop.freeRerollsUsed);
  const freeRerollsRemaining = safeAmount(remaining > 0n ? remaining : 0n);
  const paidPrice = BigInt(rules.balance.shop.firstPaidRerollPrice)
    + BigInt(state.shop.paidRerolls) * BigInt(rules.balance.shop.rerollPriceIncreasePerPaidReroll);
  const free = freeRerollsRemaining > 0;
  if (!free && paidPrice > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { price: null, free, freeRerollsRemaining, canReroll: false, blockedReason: 'COIN_OVERFLOW' };
  }
  const price = free ? 0 : safeAmount(paidPrice);
  return { price, free, freeRerollsRemaining, canReroll: state.coins >= price, blockedReason: state.coins >= price ? null : 'INSUFFICIENT_COINS' };
}

/** Safe UI projection; never returns rule objects, private RNG, or mutable state. */
export function getShopView(state, rules) {
  if (state.phase !== 'SHOP') return null;
  assertShop(state);
  const reroll = rerollQuote(state, rules);
  return {
    offerSequence: state.shop.offerSequence, paidRerolls: state.shop.paidRerolls, freeRerollsUsed: state.shop.freeRerollsUsed,
    freeRerollsRemaining: reroll.freeRerollsRemaining, rerollPrice: reroll.price,
    canReroll: reroll.canReroll, rerollBlockedReason: reroll.blockedReason,
    slots: state.shop.slots.map(({ slotId, itemId, soldOut }) => ({ slotId, itemId, soldOut, ...purchaseQuote(state, { itemId, soldOut }, rules) })),
  };
}

export function buyItem(previous, slotId, rules) {
  assertShop(previous);
  const slot = previous.shop.slots.find((entry) => entry.slotId === slotId);
  requireCondition(slot !== undefined, 'UNKNOWN_SHOP_SLOT');
  const quote = purchaseQuote(previous, slot, rules);
  requireCondition(quote.canBuy, quote.blockedReason);
  const inventory = acquireItem(previous, slot.itemId, rules, { activeFromRound: previous.roundIndex + 1 });
  let coins = safeAmount(BigInt(previous.coins) - BigInt(quote.price));
  const refunds = [];
  for (const source of activeItems(previous.items, rules, previous.roundIndex)) {
    const effect = getItem(rules, source.itemId).effect;
    if (effect.kind !== 'refund_coins_every_n_item_purchases') continue;
    const instance = inventory.items.find((item) => item.instanceId === source.instanceId);
    instance.purchaseCounter += 1;
    if (instance.purchaseCounter === effect.purchasesPerRefund) {
      instance.purchaseCounter = 0;
      coins = safeAmount(BigInt(coins) + BigInt(effect.refundCoins));
      refunds.push({ type: 'RECEIPT_REFUNDED', instanceId: source.instanceId, itemId: source.itemId, coins: effect.refundCoins });
    }
  }
  return {
    state: {
      ...previous, ...inventory, coins,
      shop: { ...previous.shop, slots: previous.shop.slots.map((entry) => entry.slotId === slotId ? { ...entry, itemId: null, soldOut: true } : { ...entry }) },
    },
    event: { type: 'ITEM_PURCHASED', slotId, itemId: slot.itemId, instanceId: inventory.items.at(-1).instanceId, price: quote.price, coinsBefore: previous.coins, coinsAfter: coins,
      ...(hasSelected8(rules) ? { refunds, refundCoins: refunds.reduce((sum, refund) => sum + refund.coins, 0) } : {}) },
  };
}

export function rerollShop(previous, rules, rng) {
  assertShop(previous);
  const quote = rerollQuote(previous, rules);
  requireCondition(quote.canReroll, quote.blockedReason);
  const offerSequence = safeAmount(BigInt(previous.shop.offerSequence) + 1n, 'SHOP_COUNTER_EXHAUSTED');
  const paidRerolls = safeAmount(BigInt(previous.shop.paidRerolls) + (quote.free ? 0n : 1n), 'SHOP_COUNTER_EXHAUSTED');
  const freeRerollsUsed = safeAmount(BigInt(previous.shop.freeRerollsUsed) + (quote.free ? 1n : 0n), 'SHOP_COUNTER_EXHAUSTED');
  const coins = safeAmount(BigInt(previous.coins) - BigInt(quote.price));
  const { shop, randomTrace } = createShop(previous, rules, rng, { offerSequence, paidRerolls, freeRerollsUsed });
  return {
    state: { ...previous, coins, shop }, randomTrace,
    event: { type: 'SHOP_REROLLED', price: quote.price, free: quote.free, coinsBefore: previous.coins, coinsAfter: coins, offerSequence },
  };
}

export function discardShopItem(previous, instanceId, rules) {
  assertShop(previous);
  const inventory = discardItem(previous, instanceId, rules);
  const removed = previous.items.find((item) => item.instanceId === instanceId);
  return {
    state: { ...previous, ...inventory, ...(hasSelected8(rules) ? { pendingNextHandWeightBuffs: previous.pendingNextHandWeightBuffs.filter((buff) => buff.sourceInstanceId !== instanceId) } : {}) },
    event: { type: 'ITEM_DISCARDED', instanceId, itemId: removed.itemId, coinsBefore: previous.coins, coinsAfter: previous.coins, refund: 0 },
  };
}
