import { hasExpansion, finishExpansionRound } from './expansion8.js';
import { getItem } from './rules.js';
import { requireCondition } from './errors.js';
import { spinWithItems } from './items.js';
import { createInventory, acquireItem } from './inventory.js';
import { calculateClearReward } from './economy.js';
import { createShop, buyItem, rerollShop, discardShopItem } from './shop.js';
import { roundHands } from './hands.js';
import { hasSelected8, rescueHand } from './selected8.js';
import { hasMilestone, createCardOffer, chooseMilestone, isWildReward } from './milestone.js';

/** @typedef {{ type: 'SPIN' | 'CLAIM' | 'CONTINUE' | 'REROLL' | 'START_ENDLESS' } | { type: 'BUY' | 'CHOOSE_CARD', slotId: string } | { type: 'DISCARD', instanceId: string }} RunAction */

export function validateAction(action, code = 'INVALID_ACTION') {
  requireCondition(action !== null && typeof action === 'object' && !Array.isArray(action), code);
  requireCondition(['SPIN', 'CLAIM', 'CONTINUE', 'BUY', 'REROLL', 'DISCARD', 'CHOOSE_CARD', 'START_ENDLESS', 'BUY_DESTINY'].includes(action.type), code);
  const fields = ['type'];
  if (['BUY', 'CHOOSE_CARD', 'BUY_DESTINY'].includes(action.type)) fields.push('slotId');
  if (action.type === 'DISCARD') fields.push('instanceId');
  if (action.type === 'BUY_DESTINY') fields.push('selectedDestinyCardId');
  requireCondition(Object.keys(action).length === fields.length && fields.every((field) => Object.hasOwn(action, field)), code);
  for (const field of fields.slice(1)) {
    requireCondition(typeof action[field] === 'string' && action[field].length > 0 && action[field].length <= 128, code);
  }
}

export function createRun(rules, { initialItemIds = [] } = {}) {
  requireCondition(Array.isArray(initialItemIds), 'INVALID_INVENTORY');
  const inventory = initialItemIds.reduce((current, id) => acquireItem(current, id, rules, { activeFromRound: 1 }), createInventory());
  const hands = roundHands(rules, inventory.items, 1);
  return {
    rulesVersion: rules.rulesVersion, catalogVersion: rules.catalogVersion, linesVersion: rules.linesVersion,
    phase: 'ROUND_ACTIVE', roundIndex: 1, completedRounds: 0,
    roundScore: 0n, runTotalScore: 0n, targetScore: rules.targets[0],
    handsRemaining: hands, revision: 0,
    ...(rules.balance.round.endless ? { mode: 'standard' } : {}),
    ...(rules.balance.round.maxExtraHands !== undefined ? { roundHands: hands } : {}),
    ...(hasSelected8(rules) ? { handSequence: 0, pendingNextHandWeightBuffs: [] } : {}),
    ...(hasMilestone(rules) ? { cardOffer:null, milestoneReward:null, roundWildAvailable:false } : {}),
    ...(hasExpansion(rules) ? { purchasedUniqueItemIds:initialItemIds.filter(id=>getItem(rules,id).uniquePerRun),
      additionalMilestoneRewards:[], doublesArmedForNextHand:false, midasDiamondCountThisRound:0 } : {}),
    ...inventory, consecutiveWinHands: 0, coins: rules.balance.economy.startingCoins, shop: null,
  };
}

export function canClaim(state) {
  return state.phase === 'ROUND_ACTIVE' && state.roundScore >= state.targetScore;
}

export function canStartEndless(state, rules) {
  return Boolean(rules.balance.round.endless && state.mode === 'standard' && state.phase === 'RUN_WON'
    && state.roundIndex === rules.balance.round.maxRoundMvp && state.completedRounds === state.roundIndex);
}

function nextTarget(state, rules) {
  const target = rules.targets[state.roundIndex];
  if (target !== undefined) return target;
  requireCondition(rules.balance.round.endless && state.mode === 'endless', 'INVALID_RUN_PHASE');
  const { num, den } = rules.balance.round.endless.targetGrowth;
  return (state.targetScore * BigInt(num) + BigInt(den) - 1n) / BigInt(den);
}

function completeRound(state, rules, rng) {
  const { settlement, randomTrace } = calculateClearReward(state, rules, rng);
  const expiredItems = finishExpansionRound(state,rules);
  state.coins = settlement.coinsAfterReward;
  state.completedRounds = state.roundIndex;
  state.phase = state.roundIndex === rules.balance.round.maxRoundMvp && state.mode !== 'endless' ? 'RUN_WON' : 'SHOP';
  if (state.phase === 'RUN_WON') {
    state.shop = null;
    if (!rules.balance.round.endless) { state.items = []; state.coins = 0; if (hasSelected8(rules)) state.pendingNextHandWeightBuffs = []; }
  }
  else if (hasMilestone(rules) && state.roundIndex === rules.balance.round.milestoneCards.afterRound && !state.milestoneReward) {
    state.phase = 'CARD_CHOICE';
    state.shop = null;
    const offer = createCardOffer(rules, rng);
    state.cardOffer = offer.cardOffer;
    randomTrace.push(...offer.randomTrace);
  } else {
    const offer = createShop(state, rules, rng);
    state.shop = offer.shop;
    randomTrace.push(...offer.randomTrace);
  }
  return { settlement, randomTrace, expiredItems };
}

/**
 * Pure transition; input state is server-owned. Client board/score fields are rejected.
 * @param {ReturnType<typeof createRun>} previous
 * @param {RunAction} action
 * @param {ReturnType<typeof import('./rules.js').parseRules>} rules
 * @param {import('./slot.js').RandomSource} [rng]
 */
export function applyAction(previous, action, rules, rng) {
  validateAction(action);
  requireCondition(previous.rulesVersion === rules.rulesVersion && previous.catalogVersion === rules.catalogVersion
    && previous.linesVersion === rules.linesVersion, 'RULES_VERSION_MISMATCH');
  requireCondition(Number.isSafeInteger(previous.revision) && previous.revision < Number.MAX_SAFE_INTEGER, 'REVISION_EXHAUSTED');
  let state = { ...previous, revision: previous.revision + 1 };
  let event;
  let randomTrace = [];

  if (action.type === 'SPIN') {
    requireCondition(state.phase === 'ROUND_ACTIVE', 'INVALID_RUN_PHASE');
    requireCondition(state.handsRemaining > 0, 'NO_HANDS_LEFT');
    const { randomTrace: draws, ...result } = spinWithItems(rules, rng, state);
    randomTrace = draws;
    state.items = result.itemsAfterSpin;
    if (hasExpansion(rules)) {
      state.doublesArmedForNextHand = result.doublesArmedForNextHand;
      state.midasDiamondCountThisRound = result.midasDiamondCountThisRound;
    }
    state.consecutiveWinHands = result.consecutiveWinHands;
    state.handsRemaining -= 1;
    state.roundScore += result.spinScore;
    state.runTotalScore += result.spinScore;
    if (hasMilestone(rules)) state.roundWildAvailable = false;
    if (hasSelected8(rules)) {
      state.handSequence = result.handSequence;
      state.pendingNextHandWeightBuffs = result.pendingNextHandWeightBuffs;
    }
    const rescued = rescueHand(state, rules);
    state = rescued.state;
    if (rescued.emergency) {
      result.itemsAfterSpin = state.items;
      result.expiredItems.push({ instanceId: rescued.emergency.instanceId, itemId: rescued.emergency.itemId });
    }
    let settlement = null;
    if (state.handsRemaining === 0 || (rules.balance.round.autoClearOnTarget && state.roundScore >= state.targetScore)) {
      if (state.roundScore >= state.targetScore || rescued.emergency?.type === 'EMERGENCY_ROUND_CLEARED') {
        const cleared = completeRound(state, rules, rng);
        settlement = cleared.settlement;
        if (hasExpansion(rules)) { result.expiredItems.push(...cleared.expiredItems); result.itemsAfterSpin = state.items; }
        randomTrace.push(...cleared.randomTrace);
      } else { if (hasExpansion(rules)) { result.expiredItems.push(...finishExpansionRound(state,rules)); state.doublesArmedForNextHand = false; } state.phase = 'RUN_FAILED'; state.items = []; state.coins = 0; state.shop = null; if (hasSelected8(rules)) state.pendingNextHandWeightBuffs = []; }
    }
    event = {
      type: 'SPIN_RESOLVED', ...result, settlement,
      ...(hasSelected8(rules) ? { emergency: rescued.emergency } : {}),
      outcome: state.phase === 'ROUND_ACTIVE' ? null : ['SHOP', 'CARD_CHOICE'].includes(state.phase) ? 'ROUND_AUTO_CLEARED' : state.phase,
    };
  } else if (action.type === 'CLAIM') {
    requireCondition(state.phase === 'ROUND_ACTIVE', 'INVALID_RUN_PHASE');
    requireCondition(canClaim(state), 'TARGET_NOT_MET');
    const cleared = completeRound(state, rules, rng);
    randomTrace = cleared.randomTrace;
    event = { type: 'ROUND_CLAIMED', unusedHands: state.handsRemaining, outcome: state.phase, settlement: cleared.settlement };
  } else if (action.type === 'START_ENDLESS') {
    requireCondition(canStartEndless(state, rules), 'INVALID_RUN_PHASE');
    state.mode = 'endless';
    state.phase = 'SHOP';
    const offer = createShop(state, rules, rng);
    state.shop = offer.shop; randomTrace = offer.randomTrace;
    event = { type: 'ENDLESS_STARTED', roundIndex: state.roundIndex };
  } else if (action.type === 'CONTINUE') {
    requireCondition(state.phase === 'SHOP', 'INVALID_RUN_PHASE');
    requireCondition(Number.isSafeInteger(state.roundIndex) && state.roundIndex < Number.MAX_SAFE_INTEGER, 'ROUND_EXHAUSTED');
    state.targetScore = nextTarget(state, rules);
    state.roundIndex += 1;
    state.roundScore = 0n;
    if (hasExpansion(rules)) state.midasDiamondCountThisRound = 0;
    state.handsRemaining = roundHands(rules, state.items, state.roundIndex);
    if (rules.balance.round.maxExtraHands !== undefined) state.roundHands = state.handsRemaining;
    if (hasMilestone(rules)) state.roundWildAvailable = isWildReward(state, rules);
    state.phase = 'ROUND_ACTIVE';
    state.shop = null;
    event = { type: 'ROUND_STARTED', roundIndex: state.roundIndex };
  } else if (action.type === 'CHOOSE_CARD') {
    const chosen = chooseMilestone(state, action.slotId, rules, rng);
    state = chosen.state; event = chosen.event; randomTrace = chosen.randomTrace;
    const offer = createShop(state, rules, rng);
    state.shop = offer.shop; randomTrace.push(...offer.randomTrace);
  } else {
    if (action.type === 'BUY_DESTINY') requireCondition(hasExpansion(rules), 'INVALID_ACTION');
    const result = action.type === 'BUY' || action.type === 'BUY_DESTINY' ? buyItem(state, action.slotId, rules, {selectedDestinyCardId:action.selectedDestinyCardId,rng})
      : action.type === 'DISCARD' ? discardShopItem(state, action.instanceId, rules)
        : rerollShop(state, rules, rng);
    state = result.state;
    event = result.event;
    randomTrace = result.randomTrace ?? [];
  }
  return { state, event: { ...event, revision: state.revision }, randomTrace };
}
