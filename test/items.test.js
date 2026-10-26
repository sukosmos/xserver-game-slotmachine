import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventory, acquireItem, discardItem, inventoryUsage, validateItems } from '../src/domain/inventory.js';
import { weightedSymbols, scoreWithItems } from '../src/domain/item-scoring.js';
import { candidateLines, spinWithItems } from '../src/domain/items.js';
import { rawV09Rules as rawRules, noLineBoard, cherryBoard, sevenBoard, scriptedRandom } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
const rules = parseRules(rawRules());

export function buildItems(ids, config = rules, activeFromRound = 1) {
  return ids.reduce((inventory, id) => acquireItem(inventory, id, config, { activeFromRound }), createInventory());
}

const candidatesBoard = ['cherry', 'cherry', 'diamond', 'bell', 'lemon', 'seven', 'diamond', 'bell', 'lemon'];
const singleCherry = ['cherry', 'cherry', 'cherry', 'lemon', 'bell', 'diamond', 'bell', 'diamond', 'seven'];
function play(board, ids, extra = [], options = {}) {
  const config = options.rules ?? rules;
  const items = options.items ?? buildItems(ids, config).items;
  const active = items.filter((item) => item.activeFromRound <= (options.roundIndex ?? 1));
  const symbols = weightedSymbols(config, active);
  const rolls = board.map((id) => symbols.slice(0, symbols.findIndex((symbol) => symbol.id === id)).reduce((sum, symbol) => sum + symbol.weight, 0));
  const rng = scriptedRandom([...rolls, ...extra]);
  const result = spinWithItems(config, rng, { items, roundIndex: options.roundIndex ?? 1, consecutiveWinHands: options.consecutiveWinHands ?? 0 });
  return { ...result, draws: rng.draws };
}

test('SLOT-03: cherry farm changes weights to 40/110 and stacking adds weights', () => {
  assert.deepEqual(weightedSymbols(rules, buildItems(['cherry_farm']).items).map((s) => s.weight), [40, 25, 20, 15, 10]);
  assert.deepEqual(weightedSymbols(rules, buildItems(['cherry_farm', 'cherry_farm', 'sevens_blessing']).items).map((s) => s.weight), [50, 25, 20, 15, 14]);
  assert.deepEqual(play(noLineBoard, ['cherry_farm']).board, noLineBoard);
});

test('SLOT-04: two golden harvest copies add factors to x5, not x9', () => {
  const result = play(singleCherry, ['golden_harvest', 'golden_harvest']);
  assert.equal(result.winningLines.length, 1);
  assert.equal(result.lineScore, 150n);
});

for (const [symbol, weightId, weight, payoutId, payout] of [
  ['cherry', 'cherry_farm', 40, 'golden_harvest', 90n],
  ['lemon', 'lemon_orchard', 34, 'lemon_syrup', 150n],
  ['bell', 'bell_foundry', 28, 'resonance_hammer', 270n],
  ['diamond', 'gem_mine', 21, 'gem_appraiser', 600n],
  ['seven', 'sevens_blessing', 14, 'lucky_crown', 2625n],
]) {
  test(`both basic ${symbol} items follow catalog data`, () => {
    assert.equal(weightedSymbols(rules, buildItems([weightId]).items).find((s) => s.id === symbol).weight, weight);
    const result = play(Array(9).fill(symbol), [payoutId]);
    assert.ok(result.winningLines.every((line) => line.score === payout));
  });
}

test('candidate tuples match the documented three lines, in data order', () => {
  assert.deepEqual(candidateLines(candidatesBoard, rules), [
    { lineId: 'row_top', changeIndex: 2, newSymbol: 'cherry' },
    { lineId: 'diag_main', changeIndex: 0, newSymbol: 'lemon' },
    { lineId: 'diag_anti', changeIndex: 4, newSymbol: 'diamond' },
  ]);
  assert.deepEqual(candidateLines(cherryBoard, rules), []);
});

test('each miracle candidate has a selectable slot and 1600 is the exclusive trigger boundary', () => {
  const candidates = candidateLines(candidatesBoard, rules);
  for (let index = 0; index < candidates.length; index++) {
    const result = play(candidatesBoard, ['miracle_hand'], [1599, index]);
    assert.equal(result.board[candidates[index].changeIndex], candidates[index].newSymbol);
    assert.equal(result.triggeredItems[0].lineId, candidates[index].lineId);
    assert.equal(result.itemsAfterSpin[0].remainingCharges, 1);
    assert.equal(result.draws, 11);
  }
  const missed = play(candidatesBoard, ['miracle_hand'], [1600]);
  assert.deepEqual(missed.board, candidatesBoard);
  assert.equal(missed.itemsAfterSpin[0].remainingCharges, 2);
  assert.equal(missed.draws, 10);
  assert.equal(play(cherryBoard, ['miracle_hand']).draws, 9);
});

test('equal edits are separate candidates; volatile joker boosts only the chosen line', () => {
  const board = [...cherryBoard]; board[4] = 'lemon';
  const candidates = candidateLines(board, rules);
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((candidate) => candidate.changeIndex === 4));
  const result = play(board, ['volatile_joker'], [0, 2]);
  assert.equal(result.lineScore, 300n);
  assert.equal(result.spinScore, 309n);
  assert.equal(result.winningLines.filter((line) => line.score === 90n).length, 1);
  assert.equal(result.winningLines.find((line) => line.score === 90n).lineId, candidates[2].lineId);
});

test('wild center preserves the visible symbol/base score and requires matching other cells', () => {
  const board = [...cherryBoard]; board[4] = 'seven';
  const result = play(board, ['joker_mask']);
  assert.deepEqual(result.board, board);
  assert.equal(result.winningLines.length, 8);
  assert.equal(result.baseScore, 18n);
  assert.equal(result.spinScore, 258n);
  assert.equal(result.itemsAfterSpin[0].remainingSpins, 1);
  const last = play(board, [], [], { items: result.itemsAfterSpin });
  assert.equal(last.spinScore, 258n);
  assert.deepEqual(last.itemsAfterSpin, []);
  assert.equal(last.expiredItems.length, 1);
  assert.equal(play(board, []).winningLines.length, 4);
  assert.equal(play(noLineBoard, ['joker_mask']).winningLines.length, 0);
});

test('lever rerolls exactly the last column using modified weights; at most one modifier fires', () => {
  const result = play(candidatesBoard, ['miracle_hand', 'broken_lever', 'cherry_farm'], [0, 0, 0, 0]);
  assert.deepEqual(result.board, ['cherry', 'cherry', 'cherry', 'bell', 'lemon', 'cherry', 'diamond', 'bell', 'cherry']);
  assert.equal(result.triggeredItems[0].itemId, 'broken_lever');
  assert.equal(result.triggeredItems.length, 1);
  assert.equal(result.itemsAfterSpin.find((item) => item.itemId === 'miracle_hand').remainingCharges, 2);
  assert.equal(result.draws, 13);
  assert.equal(play(cherryBoard, ['broken_lever']).draws, 9);
});

test('failed earlier modifier falls through; same-group order is acquisition order', () => {
  assert.equal(play(candidatesBoard, ['miracle_hand', 'broken_lever'], [6000, 0, 0]).triggeredItems[0].itemId, 'miracle_hand');
  assert.equal(play(candidatesBoard, ['magnet_device', 'miracle_hand'], [0, 0]).triggeredItems[0].itemId, 'magnet_device');
  assert.equal(play(candidatesBoard, ['miracle_hand', 'magnet_device'], [0, 0]).triggeredItems[0].itemId, 'miracle_hand');
});

test('wild and physical modifier coexist and eligibility checks raw lines', () => {
  const board = ['lemon', 'cherry', 'bell', 'cherry', 'seven', 'cherry', 'diamond', 'cherry', 'lemon'];
  const result = play(board, ['joker_mask', 'broken_lever'], [0, 55, 0, 30]);
  assert.ok(result.triggeredItems.some((item) => item.itemId === 'broken_lever'));
  assert.ok(result.triggeredItems.some((item) => item.itemId === 'joker_mask'));
});

test('seven mirror checks two sevens, samples only nonseven cells, and exhausts charges', () => {
  const board = [...noLineBoard]; board[0] = 'seven';
  const result = play(board, ['future_mirror'], [999, 0]);
  assert.equal(result.board[1], 'seven');
  assert.equal(result.draws, 11);
  assert.equal(play(noLineBoard, ['future_mirror']).draws, 9);
  assert.equal(play(sevenBoard, ['future_mirror']).draws, 9);
  const last = play(board, [], [0, 0], { items: result.itemsAfterSpin });
  assert.deepEqual(last.itemsAfterSpin, []);
});

test('virtual bonus never counts as a real line or receives symbol/real-line multipliers', () => {
  const result = play(noLineBoard, ['scammers_card', 'golden_harvest', 'devils_contract', 'resonant_bell', 'win_streak'], [599]);
  assert.equal(result.spinScore, 30n);
  assert.equal(result.baseScore, 0n);
  assert.equal(result.winningLines.length, 0);
  assert.equal(result.consecutiveWinHands, 0);
  assert.equal(play(noLineBoard, ['scammers_card'], [600]).spinScore, 32n);
  assert.equal(play(cherryBoard, ['scammers_card']).draws, 9);
});

test('resonant bell, jackpot crown and devil contract apply to their documented scopes', () => {
  assert.equal(play(cherryBoard, ['resonant_bell']).spinScore, 996n);
  assert.equal(play(singleCherry, ['resonant_bell']).spinScore, play(singleCherry, []).spinScore);
  assert.equal(play(sevenBoard, ['jackpot_crown']).spinScore, 120090n);
  assert.equal(play(cherryBoard, ['jackpot_crown']).spinScore, 129n);
  assert.equal(play(cherryBoard, ['devils_contract']).spinScore, 960n);
});

test('all per-line factors multiply before one floor; global product floors only once', () => {
  const raw = rawRules(); raw.balance.symbols[0].linePayout = 31;
  const config = parseRules(raw);
  assert.equal(play(singleCherry, ['golden_harvest', 'jackpot_crown', 'devils_contract'], [], { rules: config }).lineScore, 186n);
  assert.equal(play(cherryBoard, ['win_streak'], [], { consecutiveWinHands: 1 }).spinScore, 373n);
  assert.equal(play(cherryBoard, ['win_streak', 'resonant_bell'], [], { consecutiveWinHands: 1 }).spinScore, 1494n);
  assert.equal(play(cherryBoard, ['win_streak'], [], { consecutiveWinHands: 100 }).spinScore, 1260n);
  assert.equal(play(noLineBoard, ['win_streak'], [], { consecutiveWinHands: 5 }).consecutiveWinHands, 0);
});

test('calculated miracle maximizes exact final delta with no selection RNG', () => {
  const result = play(candidatesBoard, ['calculated_miracle'], [999]);
  assert.equal(result.triggeredItems[0].lineId, 'diag_anti');
  assert.equal(result.draws, 10);
  assert.deepEqual(result.itemsAfterSpin, []);
  assert.equal(play(candidatesBoard, ['calculated_miracle'], [1000]).itemsAfterSpin[0].remainingCharges, 1);
});

test('calculated miracle skips nonpositive candidates after real-line special scoring', () => {
  const board = [...cherryBoard]; board[4] = 'seven';
  const result = play(board, ['calculated_miracle', 'joker_mask']);
  assert.deepEqual(result.board, board); // Raw edit loses 9 base points; wild already completes all lines.
  assert.equal(result.draws, 9);
  assert.equal(result.itemsAfterSpin.find((item) => item.itemId === 'calculated_miracle').remainingCharges, 1);
});

test('calculated miracle shares one virtual roll across every preview and final result', () => {
  const result = play(candidatesBoard, ['calculated_miracle', 'scammers_card'], [0, 0]);
  assert.equal(result.virtualScore, 30n);
  assert.equal(result.draws, 11); // nine board + shared virtual + miracle trigger
  assert.equal(result.triggeredItems.filter((item) => item.itemId === 'scammers_card').length, 1);
  assert.equal(result.randomTrace.filter((draw) => draw.purpose === 'virtual_bonus').length, 1);
});

test('editing recomputes all lines, including a previously won line that is destroyed', () => {
  const board = ['cherry', 'cherry', 'lemon', 'bell', 'lemon', 'lemon', 'diamond', 'lemon', 'lemon'];
  const result = play(board, ['miracle_hand'], [0, 0]);
  assert.equal(result.spinScore, 49n);
  assert.deepEqual(result.winningLines.map((line) => line.lineId), ['row_top']);
  assert.equal(play(board, []).spinScore, 80n);
});

test('same-symbol lever reroll still consumes a charge and prevents a second modifier', () => {
  const result = play(candidatesBoard, ['broken_lever', 'miracle_hand'], [0, 75, 90, 30]);
  assert.deepEqual(result.board, candidatesBoard);
  assert.equal(result.itemsAfterSpin[0].remainingCharges, 2);
  assert.equal(result.itemsAfterSpin[1].remainingCharges, 2);
  assert.equal(result.triggeredItems.length, 1);
});

test('equal acquisition order uses item ID for a stable modifier tie break', () => {
  const items = buildItems(['miracle_hand', 'magnet_device']).items;
  items[1].acquiredOrder = 1;
  assert.equal(play(candidatesBoard, [], [0, 0], { items }).triggeredItems[0].itemId, 'magnet_device');
});

test('best candidate ties use line order; shared virtual rolls respect the final condition', () => {
  const board = [...cherryBoard]; board[4] = 'lemon';
  const result = play(board, ['calculated_miracle', 'scammers_card'], [0, 0]);
  assert.equal(result.triggeredItems[0].lineId, 'row_middle');
  assert.equal(result.virtualScore, 0n);
  assert.equal(result.triggeredItems.length, 1);
  assert.equal(result.draws, 11);
  assert.equal(result.spinScore, 249n);
  const raw = rawRules(); raw.balance.symbols[0].linePayout = 1;
  const noGain = play(board, ['calculated_miracle', 'scammers_card'], [0], { rules: parseRules(raw) });
  assert.deepEqual(noGain.board, board);
  assert.equal(noGain.spinScore, 44n);
  assert.equal(noGain.draws, 10); // Bonus loss makes every edit negative; no miracle trigger draw.
  assert.equal(noGain.itemsAfterSpin[0].remainingCharges, 1);
});

test('a virtual bonus does not turn one real line into the resonant two-line threshold', () => {
  const result = play(singleCherry, ['scammers_card', 'resonant_bell'], [0]);
  assert.equal(result.winningLines.length, 1);
  assert.equal(result.spinScore, 91n);
  assert.deepEqual(result.globalMultiplier, { num: 1n, den: 1n });
});

test('modifier priority is read from balance JSON', () => {
  const raw = rawRules();
  raw.balance.itemRules.boardModifierPriority = ['random_candidate_edit', 'reroll_last_column', 'best_candidate_edit', 'seven_transform'];
  const result = play(candidatesBoard, ['broken_lever', 'miracle_hand'], [0, 0], { rules: parseRules(raw) });
  assert.equal(result.triggeredItems[0].itemId, 'miracle_hand');
});

test('inactive timed/charged/permanent copies neither apply nor decay; active timed expires even on miss', () => {
  const pending = buildItems(['joker_mask', 'miracle_hand', 'golden_harvest'], rules, 2).items;
  const before = structuredClone(pending);
  const result = play(candidatesBoard, [], [], { items: pending });
  assert.deepEqual(result.itemsAfterSpin, before);
  assert.deepEqual(pending, before);
  const active = play(candidatesBoard, [], [9999], { items: pending, roundIndex: 2 });
  assert.equal(active.itemsAfterSpin.find((item) => item.itemId === 'joker_mask').remainingSpins, 1);
  assert.equal(active.itemsAfterSpin.find((item) => item.itemId === 'miracle_hand').remainingCharges, 2);
  const magnet = buildItems(['magnet_device']).items;
  magnet[0].remainingSpins = 1;
  assert.equal(play(cherryBoard, [], [], { items: magnet }).itemsAfterSpin.length, 0);
});

test('inventory shares permanent slots, enforces caps and preserves separate activation dates', () => {
  let inventory = buildItems(['cherry_farm']);
  inventory = acquireItem(inventory, 'cherry_farm', rules, { activeFromRound: 2 });
  assert.deepEqual(inventoryUsage(inventory.items, rules), { permanent: 1, limited: 0 });
  assert.equal(inventory.items.length, 2);
  const active = play(noLineBoard, [], [], { items: inventory.items });
  assert.equal(active.randomTrace[0].bound, 110);
  const next = play(noLineBoard, [], [], { items: inventory.items, roundIndex: 2 });
  assert.equal(next.randomTrace[0].bound, 120);
  inventory = acquireItem(inventory, 'cherry_farm', rules, { activeFromRound: 2 });
  assert.throws(() => acquireItem(inventory, 'cherry_farm', rules, { activeFromRound: 2 }), { code: 'ITEM_CAP_REACHED' });
  const discarded = discardItem(inventory, inventory.items[1].instanceId, rules);
  assert.equal(discarded.items.length, 2);
  assert.equal(inventory.items.length, 3);
  assert.equal(discarded.nextItemOrder, inventory.nextItemOrder);
  assert.throws(() => discardItem(inventory, 'unknown', rules), { code: 'UNKNOWN_ITEM_INSTANCE' });
});

test('eight permanent IDs and two limited instances are separate capacity limits', () => {
  const ids = rules.catalog.items.filter((item) => item.slot === 'permanent').slice(0, 8).map((item) => item.id);
  const full = buildItems([...ids, 'miracle_hand', 'joker_mask']);
  assert.deepEqual(inventoryUsage(full.items, rules), { permanent: 8, limited: 2 });
  assert.throws(() => acquireItem(full, 'resonant_bell', rules, { activeFromRound: 2 }), { code: 'INVENTORY_FULL' });
  assert.throws(() => acquireItem(full, 'magnet_device', rules, { activeFromRound: 2 }), { code: 'INVENTORY_FULL' });
  assert.throws(() => acquireItem(full, 'miracle_hand', rules, { activeFromRound: 2 }), { code: 'ITEM_CAP_REACHED' });
  assert.equal(acquireItem(full, 'cherry_farm', rules, { activeFromRound: 2 }).items.length, 11);
});

test('invalid item states fail before any draw; unknown effects are never silently ignored', () => {
  const items = buildItems(['miracle_hand']).items;
  for (const change of [{ remainingCharges: 0 }, { remainingCharges: 3 }, { activeFromRound: 0 }, { itemId: 'fake' }, { acquiredOrder: -1 }, { extra: true }]) {
    assert.throws(() => spinWithItems(rules, { nextInt() { assert.fail('invalid inventory drew RNG'); } }, { items: [{ ...items[0], ...change }] }));
  }
  assert.throws(() => validateItems([items[0], items[0]], rules));
  assert.throws(() => acquireItem(createInventory(), 'cherry_farm', rules, {}));
});

test('score calculations remain exact beyond safe Number range with item multipliers', () => {
  const raw = rawRules(); raw.balance.symbols[4].linePayout = '9007199254740993';
  const config = parseRules(raw);
  const items = buildItems(['lucky_crown', 'jackpot_crown'], config).items;
  const result = scoreWithItems(sevenBoard, config, items);
  assert.equal(result.lineScore, ((9007199254740993n * 7n * 10n) / 4n) * 8n);
  assert.equal(result.spinScore, result.lineScore + 90n);
});
