import { requireCondition } from './errors.js';
import { spinWithItems } from './items.js';
import { createInventory, acquireItem } from './inventory.js';
import { calculateClearReward } from './economy.js';
import { createShop, buyItem, rerollShop, discardShopItem } from './shop.js';
import { roundHands } from './hands.js';

/** @typedef {{ type: 'SPIN' | 'CLAIM' | 'CONTINUE' | 'REROLL' } | { type: 'BUY', slotId: string } | { type: 'DISCARD', instanceId: string }} RunAction */

export function validateAction(action, code = 'INVALID_ACTION') {
  requireCondition(action !== null && typeof action === 'object' && !Array.isArray(action), code);
  requireCondition(['SPIN', 'CLAIM', 'CONTINUE', 'BUY', 'REROLL', 'DISCARD'].includes(action.type), code);
  const fields = ['type'];
  if (action.type === 'BUY') fields.push('slotId');
  if (action.type === 'DISCARD') fields.push('instanceId');
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
    ...(rules.balance.round.maxExtraHands !== undefined ? { roundHands: hands } : {}),
    ...inventory, consecutiveWinHands: 0, coins: rules.balance.economy.startingCoins, shop: null,
  };
}

export function canClaim(state) {
  return state.phase === 'ROUND_ACTIVE' && state.roundScore >= state.targetScore;
}

function completeRound(state, rules, rng) {
  const { settlement, randomTrace } = calculateClearReward(state, rules, rng);
  state.coins = settlement.coinsAfterReward;
  state.completedRounds = state.roundIndex;
  state.phase = state.roundIndex === rules.balance.round.maxRoundMvp ? 'RUN_WON' : 'SHOP';
  if (state.phase === 'RUN_WON') { state.items = []; state.coins = 0; state.shop = null; }
  else {
    const offer = createShop(state, rules, rng);
    state.shop = offer.shop;
    randomTrace.push(...offer.randomTrace);
  }
  return { settlement, randomTrace };
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
    state.consecutiveWinHands = result.consecutiveWinHands;
    state.handsRemaining -= 1;
    state.roundScore += result.spinScore;
    state.runTotalScore += result.spinScore;
    let settlement = null;
    if (state.handsRemaining === 0 || (rules.balance.round.autoClearOnTarget && state.roundScore >= state.targetScore)) {
      if (state.roundScore >= state.targetScore) {
        const cleared = completeRound(state, rules, rng);
        settlement = cleared.settlement;
        randomTrace.push(...cleared.randomTrace);
      } else { state.phase = 'RUN_FAILED'; state.items = []; state.coins = 0; state.shop = null; }
    }
    event = {
      type: 'SPIN_RESOLVED', ...result, settlement,
      outcome: state.phase === 'ROUND_ACTIVE' ? null : state.phase === 'SHOP' ? 'ROUND_AUTO_CLEARED' : state.phase,
    };
  } else if (action.type === 'CLAIM') {
    requireCondition(state.phase === 'ROUND_ACTIVE', 'INVALID_RUN_PHASE');
    requireCondition(canClaim(state), 'TARGET_NOT_MET');
    const cleared = completeRound(state, rules, rng);
    randomTrace = cleared.randomTrace;
    event = { type: 'ROUND_CLAIMED', unusedHands: state.handsRemaining, outcome: state.phase, settlement: cleared.settlement };
  } else if (action.type === 'CONTINUE') {
    requireCondition(state.phase === 'SHOP', 'INVALID_RUN_PHASE');
    state.roundIndex += 1;
    state.roundScore = 0n;
    state.targetScore = rules.targets[state.roundIndex - 1];
    state.handsRemaining = roundHands(rules, state.items, state.roundIndex);
    if (rules.balance.round.maxExtraHands !== undefined) state.roundHands = state.handsRemaining;
    state.phase = 'ROUND_ACTIVE';
    state.shop = null;
    event = { type: 'ROUND_STARTED', roundIndex: state.roundIndex };
  } else {
    const result = action.type === 'BUY' ? buyItem(state, action.slotId, rules)
      : action.type === 'DISCARD' ? discardShopItem(state, action.instanceId, rules)
        : rerollShop(state, rules, rng);
    state = result.state;
    event = result.event;
    randomTrace = result.randomTrace ?? [];
  }
  return { state, event: { ...event, revision: state.revision }, randomTrace };
}
