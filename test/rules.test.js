import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, getItem } from '../src/domain/rules.js';
import { loadRules } from '../src/server/load-rules.js';
import { rules, rawRules } from './helpers.js';

test('load and freeze all three catalogs; compile scores to BigInt', () => {
  assert.equal(rules.catalog.items.length, 37);
  assert.equal(rules.lines.length, 8);
  assert.equal(rules.symbolsById.seven.linePayout, 1500n);
  assert.equal(getItem(rules, 'miracle_hand').effect.triggerChanceBasisPoints, 2000);
  assert.throws(() => getItem(rules, 'unknown'), { code: 'UNKNOWN_ITEM' });
  assert.throws(() => getItem(rules, 'toString'), { code: 'UNKNOWN_ITEM' });
  assert.throws(() => { rules.catalog.items[0].price = 99; }, TypeError);
  const raw = rawRules();
  const parsed = parseRules(raw);
  raw.balance.symbols[0].weight = 90;
  assert.equal(parsed.symbols[0].weight, 30);
});

const invalidCases = [
  ['negative cell bonus', (r) => { r.catalog.items[0].effect.basePointAdd = '-1'; }],
  ['unsafe numeric cell bonus', (r) => { r.catalog.items[0].effect.basePointAdd = 9007199254740992; }],
  ['missing square geometry', (r) => { delete r.lines.squares; }],
  ['invalid square geometry', (r) => { r.lines.squares[0].indices = [0, 1, 2, 3]; }],
  ['duplicate square', (r) => { r.lines.squares[1] = r.lines.squares[0]; }],
  ['unsupported square wild', (r) => { r.catalog.items.at(-1).effect.usesWildCenter = true; }],
  ['negative reward growth', (r) => { r.balance.economy.clearRewardPerRound = -1; }],
  ['fractional Hand cap', (r) => { r.balance.round.maxExtraHands = 1.5; }],
  ['unsafe total Hands', (r) => { r.balance.round.maxExtraHands = Number.MAX_SAFE_INTEGER; }],
  ['missing Hand cap', (r) => { delete r.balance.round.maxExtraHands; }],
  ['invalid shop unlock', (r) => { r.catalog.items[0].minShopRound = 0; }],
  ['timed Hand item', (r) => { const i = r.catalog.items.find((i) => i.id === 'extra_hand'); i.slot = 'timed'; i.durationSpins = 2; }],
  ['zero symbol weight', (r) => { r.balance.symbols[0].weight = 0; }],
  ['negative symbol weight', (r) => { r.balance.symbols[0].weight = -1; }],
  ['fractional weight', (r) => { r.balance.symbols[0].weight = 1.1; }],
  ['total outside random range', (r) => { r.balance.symbols[0].weight = 2 ** 32; }],
  ['unsafe numeric payout', (r) => { r.balance.symbols[0].linePayout = 9007199254740992; }],
  ['negative score', (r) => { r.balance.symbols[0].basePoint = -1; }],
  ['duplicate symbol ID', (r) => { r.balance.symbols[0].id = 'seven'; }],
  ['unknown symbol ID', (r) => { r.balance.symbols[0].id = 'wild'; }],
  ['wrong board dimensions', (r) => { r.balance.board.rows = 4; }],
  ['zero Hands', (r) => { r.balance.round.baseHands = 0; }],
  ['missing target', (r) => { r.balance.round.roundTargets.pop(); }],
  ['duplicate round', (r) => { r.balance.round.roundTargets[1].round = 1; }],
  ['non-decimal target', (r) => { r.balance.round.roundTargets[0].targetScore = '1e10'; }],
  ['zero target', (r) => { r.balance.round.roundTargets[0].targetScore = '0'; }],
  ['invalid carry policy', (r) => { r.balance.round.carryRoundScore = true; }],
  ['zero interest divisor', (r) => { r.balance.economy.interestPerCoins = 0; }],
  ['nonzero failure reward', (r) => { r.balance.economy.failedRoundReward = 1; }],
  ['timed economic item', (r) => { const item = r.catalog.items.find((i) => i.id === 'piggy_bank'); item.slot = 'timed'; item.durationSpins = 2; }],
  ['unsupported offer selection', (r) => { r.balance.shop.offerSelection = 'uniform_all_items'; }],
  ['unsupported immediate VIP', (r) => { r.balance.shop.vipActivation = 'immediate'; }],
  ['unsupported full-inventory filtering', (r) => { r.balance.shop.excludeFullInventoryItems = true; }],
  ['fractional item slots', (r) => { r.balance.shop.baseLimitedItemSlots = 2.5; }],
  ['invalid rarity weight', (r) => { r.balance.shop.rarityWeight.common = -1; }],
  ['wrong rounding policy', (r) => { r.balance.itemRules.perLineRounding = 'ceil'; }],
  ['missing modifier priority', (r) => { r.balance.itemRules.boardModifierPriority.pop(); }],
  ['duplicate modifier priority', (r) => { r.balance.itemRules.boardModifierPriority[0] = 'best_candidate_edit'; }],
  ['unknown modifier priority', (r) => { r.balance.itemRules.boardModifierPriority[0] = 'unknown'; }],
  ['unsupported best-candidate RNG policy', (r) => { r.balance.itemRules.bestCandidateVirtualRolls = 'reroll_per_candidate'; }],
  ['ranking order', (r) => { r.balance.ranking.sortOrder.reverse(); }],
  ['line index out of bounds', (r) => { r.lines.lines[0].indices[2] = 9; }],
  ['duplicate cell', (r) => { r.lines.lines[0].indices[2] = 1; }],
  ['duplicate line ID', (r) => { r.lines.lines[1].id = 'row_top'; }],
  ['false diagonal geometry', (r) => { r.lines.lines[6].indices = [0, 4, 7]; }],
  ['missing line', (r) => { r.lines.lines.pop(); }],
  ['mismatched version', (r) => { r.lines.version = 'v0.3'; }],
  ['mismatched catalog', (r) => { r.catalog.version = 'v0.3'; }],
  ['duplicate item ID', (r) => { r.catalog.items[0].id = r.catalog.items[1].id; }],
  ['unknown item symbol', (r) => { r.catalog.items[0].effect.symbol = 'unknown'; }],
  ['unknown effect kind', (r) => { r.catalog.items[0].effect.kind = 'ignored_effect'; }],
  ['unknown effect parameter', (r) => { r.catalog.items[0].effect.ammount = 99; }],
  ['invalid category', (r) => { r.catalog.items[0].category = 'board'; }],
  ['zero price', (r) => { r.catalog.items[0].price = 0; }],
  ['zero stacks', (r) => { r.catalog.items[0].maxStacks = 0; }],
  ['zero fraction denominator', (r) => { r.catalog.items[5].effect.extraFactor.den = 0; }],
  ['missing charges', (r) => { delete r.catalog.items.find(i=>i.slot==='charged').initialCharges; }],
  ['missing duration', (r) => { const i=r.catalog.items[11];i.slot='timed';delete i.initialCharges; }],
  ['unknown consumable policy', (r) => { r.catalog.items[11].effect.triggerPolicy='always'; }],
  ['unlimited charged item', (r) => { r.catalog.items[11].maxStacks=null; }],
  ['invalid rescue threshold', (r) => { r.catalog.items.find(i=>i.id==='emergency_lever').effect.minimumTargetRatio={num:1,den:1}; }],
  ['charges on permanent item', (r) => { r.catalog.items[0].initialCharges = 2; }],
  ['chance above 100%', (r) => { r.catalog.items[10].effect.triggerChanceBasisPoints = 10001; }],
  ['non-uniform miracle', (r) => { r.catalog.items[10].effect.candidateSelection = 'highest_payout'; }],
  ['unknown top level field', (r) => { r.balance.smybols = []; }],
];
for (const [name, mutate] of invalidCases) {
  test(`schema rejects ${name}`, () => {
    const raw = rawRules();
    mutate(raw);
    assert.throws(() => parseRules(raw), { code: 'INVALID_RULES' });
  });
}

test('rule loader reports missing files', () => {
  assert.throws(() => loadRules(new URL('./does-not-exist/', import.meta.url)), { code: 'INVALID_RULES' });
});

test('weights do not have to sum to 100; large decimal score config is valid', () => {
  const raw = rawRules();
  raw.balance.symbols[0].weight = 40;
  raw.balance.symbols[1].linePayout = '10000000000000000000000000000000000';
  const result = parseRules(raw);
  assert.equal(result.symbols.reduce((sum, symbol) => sum + symbol.weight, 0), 110);
  assert.equal(result.symbols[1].linePayout, 10000000000000000000000000000000000n);
});
