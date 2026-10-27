import { requireCondition } from '../domain/errors.js';
import { inventoryGroup } from '../domain/inventory.js';
import { getItem } from '../domain/rules.js';
import { upgradeView } from './upgrades.js';
import { describeItem, summarizeItem } from './catalog.js';
import { decimalRatio } from './display.js';

/** Input is an already replay-verified server audit. Explicit public allowlists only. */
export function createRankSnapshot(audit, rules, record) {
  const endIndex = audit.actions.findIndex(({ response: { state } }) =>
    ['RUN_WON','RUN_FAILED'].includes(state.phase) && state.completedRounds === record.completedRounds
    && state.runTotalScore === record.runTotalScore);
  requireCondition(endIndex >= 0, 'STORAGE_CORRUPT');
  const final = audit.actions[endIndex].response.state;
  const spinIndex = audit.actions.slice(0, endIndex + 1).findLastIndex(a => a.command.type === 'SPIN');
  requireCondition(spinIndex >= 0, 'STORAGE_CORRUPT');
  const before = spinIndex ? audit.actions[spinIndex - 1].response.state : audit.initialState;
  const spin = audit.actions[spinIndex].response.event;
  const groups = new Map();
  for (const instance of before.items) {
    const item = getItem(rules, instance.itemId);
    if (!groups.has(item.id)) groups.set(item.id, {
      itemId: item.id, name: item.nameKo, group: inventoryGroup(item, rules), rarity: item.rarity,
      description: describeItem(item), summary: summarizeItem(item), instances: [],
    });
    groups.get(item.id).instances.push({
      active: instance.activeFromRound <= before.roundIndex,
      ...(instance.remainingCharges !== undefined ? { remainingCharges: instance.remainingCharges } : {}),
      ...(instance.remainingSpins !== undefined ? { remainingSpins: instance.remainingSpins } : {}),
      triggered: spin.triggeredItems.some(i => i.instanceId === instance.instanceId) || spin.emergency?.instanceId === instance.instanceId,
      consumed: spin.expiredItems.some(i => i.instanceId === instance.instanceId),
    });
  }
  const build = upgradeView(before, rules).current;
  return {
    version: 1, basis: 'before_last_spin', rulesVersion: final.rulesVersion, mode: final.mode ?? 'standard', outcome: final.phase,
    roundIndex: final.roundIndex, completedRounds: final.completedRounds, roundScore: final.roundScore,
    targetScore: final.targetScore, runTotalScore: final.runTotalScore, handsRemaining: final.handsRemaining,
    consecutiveWinHands: spin.consecutiveWinHands, coinsBeforeSpin: before.coins,
    permanentSlots: rules.balance.shop.basePermanentItemSlots, limitedSlots: rules.balance.shop.baseLimitedItemSlots,
    hasUpgradeGroup: Boolean(rules.balance.shop.upgradeItemIds), build,
    items: [...groups.values()].map(item => ({ ...item, stacks: item.instances.length })),
    lastSpin: {
      board: spin.board, wildMarks: spin.wildMarks ?? (spin.milestoneWild || spin.activeEffects.some(e => e.kind === 'wild_center') ? [4] : []),
      baseScore: spin.baseScore, lineScore: spin.lineScore, virtualScore: spin.virtualScore,
      patternScore: spin.patternScore ?? '0', spinScore: spin.spinScore, globalMultiplier: spin.globalMultiplier,
      multiplier: `×${decimalRatio(spin.globalMultiplier)}`, winningLines: spin.winningLines.length,
    },
  };
}
