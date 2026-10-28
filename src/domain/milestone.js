import { requireCondition } from './errors.js';
import { activeItems } from './inventory.js';
import { weightedSymbols } from './item-scoring.js';
import { dueWeightBuffs } from './selected8.js';
import { createWeightedTable, drawSymbol } from './slot.js';
import { drawInt } from './random-draw.js';
import { safeAmount } from './money.js';
import { percent } from '../server/display.js';

export const hasMilestone = (rules) => Boolean(rules.balance.round.milestoneCards);
export const milestoneRewards = (state) => [state.milestoneReward, ...(state.additionalMilestoneRewards ?? state.milestoneRewards?.slice(1) ?? [])].filter(Boolean);
export const removedSymbol = (state) => milestoneRewards(state).find(r=>r.removedSymbol)?.removedSymbol;
export const rewardDefinitions = (state,rules) => milestoneRewards(state).map(r=>rules.balance.round.milestoneCards?.cards.find(c=>c.id===r.cardId)).filter(Boolean);
export const rewardDefinition = (state, rules) => rules.balance.round.milestoneCards?.cards.find((c) => c.id === state.milestoneReward?.cardId);
export const isWildReward = (state, rules) => rewardDefinitions(state,rules).some(c=>['first_hand_wild_each_round','first_and_last_hand_wild_each_round'].includes(c.effect.kind));
export const rewardSpinFactor = (state, rules) => rewardDefinitions(state,rules).find(c=>c.effect.spinFactor)?.effect.spinFactor ?? null;
export const milestoneWildActive = (state, rules) => isWildReward(state,rules) && (state.roundWildAvailable || (rewardDefinitions(state,rules).some(c=>c.effect.kind === 'first_and_last_hand_wild_each_round') && state.handsRemaining === 1));

/** Extra score effects are permanent run rewards, never inventory instances. */
export function scoringItems(state, rules, items) {
  const effect = rewardDefinitions(state, rules).find(c=>c.effect.kind === 'grant_symbol_upgrades')?.effect;
  return effect?.kind === 'grant_symbol_upgrades'
    ? [...items, ...effect.itemIds.map((itemId) => ({ itemId, instanceId: `milestone-${itemId}` }))] : items;
}

export function milestoneRewardViews(state,rules) {
  return milestoneRewards(state).map(reward=>milestoneRewardView({...state,milestoneReward:reward},rules));
}
export function eligibleDestinyCards(state,rules) {
  const owned = new Set(milestoneRewards(state).map(r=>r.cardId));
  return (rules.balance.round.milestoneCards?.cards ?? []).filter(c=>!owned.has(c.id));
}
export function milestoneRewardView(state, rules) {
  const card = rewardDefinition(state, rules);
  if (!card) return null;
  const symbol = state.milestoneReward.removedSymbol;
  const names = { cherry:'체리', lemon:'레몬', bell:'종', diamond:'다이아', seven:'세븐' };
  const summary = card.effect.kind === 'remove_weighted_symbol' ? `${symbol ? names[symbol] + ' 제외' : '심벌 1종 무작위 제외'} · 남은 확률 재분배`
    : card.effect.kind === 'grant_symbol_upgrades' ? `모든 심벌 점수·배당 +1단계${card.effect.spinFactor ? ` · 스핀 ${percent(card.effect.spinFactor)}` : ''}`
    : card.effect.kind === 'grant_coins' ? `즉시 ${card.effect.coins}코인`
    : card.effect.kind === 'first_and_last_hand_wild_each_round' ? '첫·마지막 스핀 · 중앙 WILD' : '매 라운드 첫 스핀 · 중앙 WILD';
  return { cardId: card.id, name: card.nameKo, summary, ...(symbol ? { removedSymbol: symbol } : {}),
    ...(card.effect.kind === 'grant_coins' ? { coinsGranted:card.effect.coins } : {}),
    ...(card.effect.kind === 'first_and_last_hand_wild_each_round' ? { includesLastHand:true } : {}) };
}

/** Shuffle once at the round boundary. Only slot IDs are included in public state. */
export function createCardOffer(rules, rng) {
  const cards = rules.balance.round.milestoneCards.cards.map((c) => c.id), randomTrace = [];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = drawInt(rng, i + 1, randomTrace, { purpose:'milestone_shuffle' });
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return { cardOffer: cards.map((cardId, i) => ({ slotId:`milestone-card-${i}`, cardId })), randomTrace };
}

export function chooseMilestone(previous, slotId, rules, rng) {
  requireCondition(hasMilestone(rules) && previous.phase === 'CARD_CHOICE' && !previous.milestoneReward, 'INVALID_RUN_PHASE');
  const chosen = previous.cardOffer.find((c) => c.slotId === slotId);
  requireCondition(chosen, 'UNKNOWN_CARD_SLOT');
  const card = rules.balance.round.milestoneCards.cards.find((c) => c.id === chosen.cardId);
  const granted = grantDestinyCard(previous,card.id,rules,rng);
  const state = { ...granted.state, phase:'SHOP', cardOffer:null, milestoneReward:granted.reward };
  return { state, event:{ type:'CARD_SELECTED', slotId, reward:milestoneRewardView(state,rules) }, randomTrace:granted.randomTrace };
}

export function grantDestinyCard(previous,cardId,rules,rng) {
  const card = eligibleDestinyCards(previous,rules).find(c=>c.id===cardId);
  requireCondition(card, 'INVALID_DESTINY_CARD');
  const reward = { cardId: card.id }, randomTrace = [];
  if (card.effect.kind === 'remove_weighted_symbol') {
    const active = activeItems(previous.items, rules, previous.roundIndex + 1);
    const symbols = weightedSymbols(rules, active, dueWeightBuffs(previous, rules, active), removedSymbol(previous));
    reward.removedSymbol = drawSymbol(createWeightedTable(symbols), {
      nextInt: (bound) => drawInt(rng, bound, randomTrace, { purpose:'milestone_remove_symbol' }),
    });
  }
  const state = { ...previous,
    ...(card.effect.kind === 'grant_coins' ? { coins:safeAmount(BigInt(previous.coins)+BigInt(card.effect.coins)) } : {}),
    ...(previous.pendingNextHandWeightBuffs ? { pendingNextHandWeightBuffs: previous.pendingNextHandWeightBuffs.filter((b) => b.symbol !== reward.removedSymbol) } : {}) };
  return { state, reward, randomTrace };
}
