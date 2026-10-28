import { requireCondition } from './errors.js';
import { getItem } from './rules.js';
import { isItemEnabled } from './selected8-contract.js';

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export function createInventory() { return { items: [], nextItemOrder: 1 }; }

export function inventoryGroup(item, rules) {
  if (item.slot === 'none') return 'slotless';
  return rules.balance.shop.upgradeItemIds?.includes(item.id) ? 'upgrade' : item.slot === 'permanent' ? 'permanent' : 'limited';
}

export function inventoryUsage(items, rules) {
  const permanent = new Set(), upgrade = new Set();
  let limited = 0;
  for (const instance of items) {
    const group = inventoryGroup(getItem(rules, instance.itemId), rules);
    if (group === 'upgrade') upgrade.add(instance.itemId);
    else if (group === 'permanent') permanent.add(instance.itemId);
    else if (group === 'limited') limited += 1;
  }
  return { permanent: permanent.size, limited, ...(rules.balance.shop.upgradeItemIds ? { upgrade: upgrade.size } : {}) };
}

export function inventoryLimits(items, rules) {
  let permanent = rules.balance.shop.basePermanentItemSlots, limited = rules.balance.shop.baseLimitedItemSlots;
  for (const instance of items) {
    const e = getItem(rules,instance.itemId).effect;
    if (e.kind === 'expand_inventory_capacity') { permanent += e.permanentSlotsAdded; limited += e.limitedSlotsAdded; }
  }
  requireCondition(Number.isSafeInteger(permanent) && Number.isSafeInteger(limited), 'INVALID_INVENTORY');
  return { permanent, limited };
}

export function validateItems(items, rules) {
  requireCondition(Array.isArray(items), 'INVALID_INVENTORY');
  const ids = new Set();
  const copies = new Map();
  for (const instance of items) {
    requireCondition(instance !== null && typeof instance === 'object' && !Array.isArray(instance), 'INVALID_ITEM_INSTANCE');
    const item = getItem(rules, instance.itemId);
    requireCondition(isItemEnabled(item, rules), 'ITEM_DISABLED');
    const fields = ['instanceId', 'itemId', 'acquiredOrder', 'activeFromRound'];
    if (item.slot === 'charged') fields.push('remainingCharges');
    if (item.slot === 'timed') fields.push('remainingSpins');
    if (item.effect.kind === 'refund_coins_every_n_item_purchases') fields.push('purchaseCounter');
    if (item.effect.triggerPolicy) fields.push('lastTriggeredRound');
    requireCondition(Object.keys(instance).length === fields.length && fields.every((field) => Object.hasOwn(instance, field)), 'INVALID_ITEM_INSTANCE');
    requireCondition(typeof instance.instanceId === 'string' && instance.instanceId.length > 0 && !ids.has(instance.instanceId), 'INVALID_ITEM_INSTANCE');
    requireCondition(positiveInteger(instance.acquiredOrder) && positiveInteger(instance.activeFromRound), 'INVALID_ITEM_INSTANCE');
    if (item.slot === 'charged') requireCondition(positiveInteger(instance.remainingCharges) && instance.remainingCharges <= item.initialCharges, 'INVALID_ITEM_INSTANCE');
    if (item.slot === 'timed') requireCondition(positiveInteger(instance.remainingSpins) && instance.remainingSpins <= item.durationSpins, 'INVALID_ITEM_INSTANCE');
    if (item.effect.kind === 'refund_coins_every_n_item_purchases') requireCondition(Number.isSafeInteger(instance.purchaseCounter) && instance.purchaseCounter >= 0 && instance.purchaseCounter < item.effect.purchasesPerRefund, 'INVALID_ITEM_INSTANCE');
    if (item.effect.triggerPolicy) requireCondition(Number.isSafeInteger(instance.lastTriggeredRound) && instance.lastTriggeredRound >= 0, 'INVALID_ITEM_INSTANCE');
    ids.add(instance.instanceId);
    const count = (copies.get(item.id) ?? 0) + 1;
    requireCondition(item.maxStacks === null || count <= item.maxStacks, 'ITEM_CAP_REACHED');
    copies.set(item.id, count);
  }
  const usage = inventoryUsage(items, rules);
  requireCondition(usage.permanent <= inventoryLimits(items,rules).permanent && usage.limited <= inventoryLimits(items,rules).limited, 'INVENTORY_FULL');
}

function validateInventory(inventory, rules) {
  requireCondition(inventory !== null && typeof inventory === 'object', 'INVALID_INVENTORY');
  validateItems(inventory.items, rules);
  requireCondition(positiveInteger(inventory.nextItemOrder) && inventory.items.every((item) => item.acquiredOrder < inventory.nextItemOrder), 'INVALID_INVENTORY');
}

/** Pure server-side acquisition primitive. Phase 3 supplies the next active round. */
export function acquireItem(inventory, itemId, rules, { activeFromRound } = {}) {
  validateInventory(inventory, rules);
  requireCondition(positiveInteger(activeFromRound), 'INVALID_ACTIVE_ROUND');
  requireCondition(inventory.nextItemOrder < Number.MAX_SAFE_INTEGER, 'ITEM_ORDER_EXHAUSTED');
  const item = getItem(rules, itemId);
  requireCondition(item.effect.kind !== 'choose_one_remaining_destiny_card', 'DESTINY_SELECTION_REQUIRED');
  const instance = { instanceId: `item-${inventory.nextItemOrder}`, itemId, acquiredOrder: inventory.nextItemOrder, activeFromRound };
  if (item.slot === 'charged') instance.remainingCharges = item.initialCharges;
  if (item.slot === 'timed') instance.remainingSpins = item.durationSpins;
  if (item.effect.kind === 'refund_coins_every_n_item_purchases') instance.purchaseCounter = 0;
  if (item.effect.triggerPolicy) instance.lastTriggeredRound = 0;
  const items = [...inventory.items.map((entry) => ({ ...entry })), instance];
  validateItems(items, rules);
  return { items, nextItemOrder: inventory.nextItemOrder + 1 };
}

export function discardItem(inventory, instanceId, rules) {
  validateInventory(inventory, rules);
  requireCondition(inventory.items.some((item) => item.instanceId === instanceId), 'UNKNOWN_ITEM_INSTANCE');
  requireCondition(getItem(rules, inventory.items.find(i=>i.instanceId === instanceId).itemId).effect.discardable !== false, 'ITEM_NOT_DISCARDABLE');
  return { items: inventory.items.filter((item) => item.instanceId !== instanceId).map((item) => ({ ...item })), nextItemOrder: inventory.nextItemOrder };
}

// Locale-independent tie breaking keeps replay identical on all servers.
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function acquisitionOrder(a, b) {
  return a.acquiredOrder - b.acquiredOrder || compareText(a.itemId, b.itemId) || compareText(a.instanceId, b.instanceId);
}

export function activeItems(items, rules, roundIndex) {
  validateItems(items, rules);
  requireCondition(positiveInteger(roundIndex), 'INVALID_ROUND');
  return items.filter((item) => item.activeFromRound <= roundIndex && (getItem(rules,item.itemId).slot !== 'round' || item.activeFromRound === roundIndex)).sort(acquisitionOrder);
}

export function finishItemSpin(items, active, triggeredIds, rules, roundIndex = 1) {
  const activeIds = new Set(active.map((item) => item.instanceId));
  const expiredItems = [];
  const itemsAfterSpin = items.flatMap((original) => {
    const item = { ...original };
    if (activeIds.has(item.instanceId)) {
      const { slot } = getItem(rules, item.itemId);
      if (getItem(rules, item.itemId).effect.triggerPolicy && triggeredIds.has(item.instanceId)) item.lastTriggeredRound = roundIndex;
      if (slot === 'timed') item.remainingSpins -= 1;
      if (slot === 'charged' && triggeredIds.has(item.instanceId)) item.remainingCharges -= 1;
      if (item.remainingSpins === 0 || item.remainingCharges === 0) {
        expiredItems.push({ instanceId: item.instanceId, itemId: item.itemId });
        return [];
      }
    }
    return [item];
  });
  return { itemsAfterSpin, expiredItems };
}
