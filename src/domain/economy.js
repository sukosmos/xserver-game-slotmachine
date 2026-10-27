import { requireCondition } from './errors.js';
import { activeItems } from './inventory.js';
import { getItem } from './rules.js';
import { assertCoins, safeAmount } from './money.js';
import { drawInt } from './random-draw.js';

/** Reward calculation only. The run transition enforces success and pays once. */
export function calculateClearReward(state, rules, rng) {
  const coinsBefore = assertCoins(state.coins);
  requireCondition(Number.isSafeInteger(state.handsRemaining) && state.handsRemaining >= 0
    && state.handsRemaining <= (state.roundHands ?? rules.balance.round.baseHands), 'INVALID_HANDS');
  requireCondition(Number.isSafeInteger(state.roundIndex) && state.roundIndex >= 1
    && (state.roundIndex <= rules.balance.round.maxRoundMvp || (rules.balance.round.endless && state.mode === 'endless')), 'INVALID_ROUND');
  const active = activeItems(state.items, rules, state.roundIndex).filter((instance) => getItem(rules, instance.itemId).slot === 'permanent');
  const economy = rules.balance.economy;
  let itemBaseBonus = 0n;
  let cap = BigInt(economy.interestCap);
  for (const instance of active) {
    const effect = getItem(rules, instance.itemId).effect;
    if (effect.kind === 'clear_base_coins_add') itemBaseBonus += BigInt(effect.amount);
    if (effect.kind === 'interest_cap_add') cap += BigInt(effect.amount);
  }
  const baseReward = BigInt(economy.baseClearReward) + BigInt(state.roundIndex - 1) * BigInt(economy.clearRewardPerRound ?? 0);
  const handBonus = BigInt(state.handsRemaining) * BigInt(economy.unusedHandReward);
  const earnedInterest = BigInt(coinsBefore) / BigInt(economy.interestPerCoins);
  const interest = earnedInterest < cap ? earnedInterest : cap;
  // Reject deterministic overflow before consuming reward randomness.
  safeAmount(BigInt(coinsBefore) + baseReward + itemBaseBonus + handBonus + interest);
  let bonusCoins = 0n;
  const triggeredItems = [];
  const randomTrace = [];
  for (const instance of active) {
    const effect = getItem(rules, instance.itemId).effect;
    if (effect.kind !== 'chance_coins_on_clear') continue;
    const roll = drawInt(rng, 10000, randomTrace, { purpose: 'clear_bonus', instanceId: instance.instanceId });
    if (roll < effect.triggerChanceBasisPoints) {
      bonusCoins += BigInt(effect.coins);
      triggeredItems.push({ instanceId: instance.instanceId, itemId: instance.itemId, coins: effect.coins });
    }
  }
  const reward = baseReward + itemBaseBonus + handBonus + interest + bonusCoins;
  return {
    settlement: {
      coinsBefore, baseReward: safeAmount(baseReward), itemBaseBonus: safeAmount(itemBaseBonus), handBonus: safeAmount(handBonus),
      interest: safeAmount(interest), interestCap: safeAmount(cap), bonusCoins: safeAmount(bonusCoins),
      reward: safeAmount(reward), coinsAfterReward: safeAmount(BigInt(coinsBefore) + reward), triggeredItems,
    },
    randomTrace,
  };
}
