import { requireCondition } from './errors.js';
import { activeItems } from './inventory.js';
import { weightedSymbols } from './item-scoring.js';
import { dueWeightBuffs } from './selected8.js';
import { createWeightedTable, drawSymbol } from './slot.js';
import { drawInt } from './random-draw.js';

export const hasMilestone = (rules) => Boolean(rules.balance.round.milestoneCards);
export const rewardDefinition = (state, rules) => rules.balance.round.milestoneCards?.cards.find((c) => c.id === state.milestoneReward?.cardId);

/** Extra score effects are permanent run rewards, never inventory instances. */
export function scoringItems(state, rules, items) {
  const effect = rewardDefinition(state, rules)?.effect;
  return effect?.kind === 'grant_symbol_upgrades'
    ? [...items, ...effect.itemIds.map((itemId) => ({ itemId, instanceId: `milestone-${itemId}` }))] : items;
}

export function milestoneRewardView(state, rules) {
  const card = rewardDefinition(state, rules);
  if (!card) return null;
  const symbol = state.milestoneReward.removedSymbol;
  const names = { cherry:'체리', lemon:'레몬', bell:'종', diamond:'다이아', seven:'세븐' };
  const summary = card.effect.kind === 'remove_weighted_symbol' ? `${names[symbol]} 제외 · 남은 확률 재분배`
    : card.effect.kind === 'grant_symbol_upgrades' ? '모든 심벌 점수·배당 +1단계' : '매 라운드 첫 스핀 · 중앙 WILD';
  return { cardId: card.id, name: card.nameKo, summary, ...(symbol ? { removedSymbol: symbol } : {}) };
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
  const reward = { cardId: card.id }, randomTrace = [];
  if (card.effect.kind === 'remove_weighted_symbol') {
    const active = activeItems(previous.items, rules, previous.roundIndex + 1);
    const symbols = weightedSymbols(rules, active, dueWeightBuffs(previous, rules, active));
    reward.removedSymbol = drawSymbol(createWeightedTable(symbols), {
      nextInt: (bound) => drawInt(rng, bound, randomTrace, { purpose:'milestone_remove_symbol' }),
    });
  }
  const state = { ...previous, phase:'SHOP', cardOffer:null, milestoneReward:reward,
    ...(previous.pendingNextHandWeightBuffs ? { pendingNextHandWeightBuffs: previous.pendingNextHandWeightBuffs.filter((b) => b.symbol !== reward.removedSymbol) } : {}) };
  return { state, event:{ type:'CARD_SELECTED', slotId, reward:milestoneRewardView(state,rules) }, randomTrace };
}
