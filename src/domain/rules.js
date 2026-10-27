import { exactInteger } from './exact.js';
import { GameError, requireCondition } from './errors.js';
import { selected8Contracts } from './selected8-contract.js';

export const MAX_RANDOM_BOUND = 2 ** 32;
const symbolIds = ['cherry', 'lemon', 'bell', 'diamond', 'seven'];
const rarities = ['common', 'rare', 'epic', 'legendary'];
const lineGeometry = {
  row_top: [0, 1, 2], row_middle: [3, 4, 5], row_bottom: [6, 7, 8],
  col_left: [0, 3, 6], col_middle: [1, 4, 7], col_right: [2, 5, 8],
  diag_main: [0, 4, 8], diag_anti: [2, 4, 6],
};
const squareGeometry = {
  square_top_left: [0, 1, 4, 3], square_top_right: [1, 2, 5, 4],
  square_bottom_left: [3, 4, 7, 6], square_bottom_right: [4, 5, 8, 7],
};

function fail(path, message) { throw new GameError('INVALID_RULES', `${path}: ${message}`); }
function check(condition, path, message) { if (!condition) fail(path, message); }
function object(value, path) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), path, 'expected object');
}
function keys(value, required, optional, path) {
  object(value, path);
  for (const key of required) check(Object.hasOwn(value, key), `${path}.${key}`, 'required field');
  for (const key of Object.keys(value)) check(required.includes(key) || optional.includes(key), `${path}.${key}`, 'unknown field');
}
function integer(value, path, min = 0, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, path, `expected integer in [${min}, ${max}]`);
}
function text(value, path) { check(typeof value === 'string' && value.length > 0, path, 'expected nonempty string'); }
function id(value, path) { check(typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value), path, 'invalid ID'); }
function oneOf(value, allowed, path) { check(allowed.includes(value), path, `expected one of ${allowed.join(', ')}`); }
function literal(value, expected, path) { check(value === expected, path, `expected ${JSON.stringify(expected)}`); }
function score(value, path, positive = false) {
  try { check(exactInteger(value) >= (positive ? 1n : 0n), path, 'must be positive'); }
  catch (error) { if (error.code === 'INVALID_RULES') throw error; fail(path, 'expected exact nonnegative integer (large values must be decimal strings)'); }
}
function fraction(value, path) {
  keys(value, ['num', 'den'], [], path);
  score(value.num, `${path}.num`);
  score(value.den, `${path}.den`, true);
}
function array(value, path) { check(Array.isArray(value), path, 'expected array'); }
function unique(values, path) { check(new Set(values).size === values.length, path, 'duplicate IDs or entries'); }

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Catalog validation is deliberately separate from effect execution (Phase 2+).
const effectSpecs = {
  weight_add: ['weight', ['symbol', 'amount'], ['basePointAdd']],
  symbol_line_add_factor: ['payout', ['symbol', 'extraFactor'], ['basePointAdd']],
  random_candidate_edit: ['board', ['triggerChanceBasisPoints', 'candidateSelection', 'boardPriority'], ['selectedLineMultiplier']],
  wild_center: ['board', ['changesVisualSymbol']],
  reroll_last_column: ['board', ['condition', 'triggerChanceBasisPoints', 'boardPriority']],
  virtual_cherry_line_bonus: ['score', ['condition', 'triggerChanceBasisPoints', 'fixedPoints', 'countsAsRealWinningLine']],
  convert_random_nonseven_to_seven: ['board', ['condition', 'triggerChanceBasisPoints', 'boardPriority']],
  best_candidate_edit: ['board', ['triggerChanceBasisPoints', 'candidateSelection', 'boardPriority']],
  spin_multiplier_if_min_real_lines: ['score', ['minRealWinningLines', 'factor']],
  spin_multiplier: ['score', ['factor']],
  clear_round_before_run_failed: ['hand', ['minimumTargetRatio', 'automatic', 'chargeOn']],
  conditional_per_line_factor: ['score', ['forSeven', 'forOther']],
  zero_base_plus_per_real_line_factor: ['score', ['perRealLineFactor', 'doesNotMultiplyVirtualBonus']],
  consecutive_win_multiplier: ['score', ['factorPerExtraHit', 'maxExponent', 'resetOnNoLine']],
  clear_base_coins_add: ['economy', ['amount']],
  interest_cap_add: ['economy', ['amount']],
  one_free_reroll_per_shop: ['economy', ['amount']],
  shop_item_cost_subtract: ['economy', ['amount', 'minPrice']],
  chance_coins_on_clear: ['economy', ['triggerChanceBasisPoints', 'coins']],
  round_hands_add: ['resource', ['amount']],
  square_match_bonus: ['score', ['payoutFactor', 'usesWildCenter', 'countsAsRealWinningLine']],
  ...Object.fromEntries(Object.entries(selected8Contracts).map(([kind, spec]) => [kind, [spec.category, spec.fields]])),
};

function validateItem(item, path) {
  keys(item, ['id', 'nameKo', 'rarity', 'price', 'category', 'slot', 'maxStacks', 'effect'], ['initialCharges', 'durationSpins', 'minShopRound'], path);
  if (Object.hasOwn(item, 'minShopRound')) integer(item.minShopRound, `${path}.minShopRound`, 1);
  id(item.id, `${path}.id`);
  text(item.nameKo, `${path}.nameKo`);
  oneOf(item.rarity, rarities, `${path}.rarity`);
  integer(item.price, `${path}.price`, 1);
  if (item.maxStacks === null) literal(item.slot, 'permanent', `${path}.slot`);
  else integer(item.maxStacks, `${path}.maxStacks`, 1);
  oneOf(item.slot, ['permanent', 'charged', 'timed'], `${path}.slot`);
  if (item.slot === 'charged') integer(item.initialCharges, `${path}.initialCharges`, 1);
  else check(!Object.hasOwn(item, 'initialCharges'), path, 'initialCharges only allowed on charged items');
  if (item.slot === 'timed') integer(item.durationSpins, `${path}.durationSpins`, 1);
  else check(!Object.hasOwn(item, 'durationSpins'), path, 'durationSpins only allowed on timed items');

  const effect = item.effect;
  object(effect, `${path}.effect`);
  check(Object.hasOwn(effectSpecs, effect.kind), `${path}.effect.kind`, 'unknown effect kind');
  const [category, required, optional = []] = effectSpecs[effect.kind];
  literal(item.category, category, `${path}.category`);
  if (['economy', 'resource'].includes(category)) literal(item.slot, 'permanent', `${path}.slot`);
  if (effect.kind === 'square_match_bonus') {
    literal(item.slot, 'permanent', `${path}.slot`);
    literal(item.maxStacks, 1, `${path}.maxStacks`);
  }
  const scheduled = effect.triggerPolicy !== undefined;
  const scheduledKinds = ['random_candidate_edit','wild_center','reroll_last_column','virtual_cherry_line_bonus','convert_random_nonseven_to_seven','best_candidate_edit','copy_physical_column'];
  if (scheduled) {
    oneOf(effect.kind, scheduledKinds, `${path}.effect.kind`);
    oneOf(item.slot, ['charged','timed'], `${path}.slot`);
    literal(effect.triggerPolicy, 'remaining_hands_once_per_round', `${path}.effect.triggerPolicy`);
  }
  keys(effect, ['kind', ...required.filter((key) => !(scheduled && key === 'triggerChanceBasisPoints'))], [...optional, ...(scheduled ? ['triggerPolicy'] : [])], `${path}.effect`);
  if (effect.kind === 'spin_multiplier') literal(item.slot, 'permanent', `${path}.slot`);
  if (effect.kind === 'clear_round_before_run_failed') {
    literal(item.slot, 'charged', `${path}.slot`); literal(item.initialCharges, 1, `${path}.initialCharges`);
    literal(item.maxStacks, 1, `${path}.maxStacks`); literal(effect.automatic, true, `${path}.effect.automatic`);
    literal(effect.chargeOn, 'round_cleared', `${path}.effect.chargeOn`);
    fraction(effect.minimumTargetRatio, `${path}.effect.minimumTargetRatio`);
    check(exactInteger(effect.minimumTargetRatio.num) > 0n && exactInteger(effect.minimumTargetRatio.num) < exactInteger(effect.minimumTargetRatio.den), path, 'threshold must be between zero and one');
  }
  const selected = selected8Contracts[effect.kind];
  if (selected) {
    literal(item.slot, selected.slot, `${path}.slot`);
    if (effect.kind === 'queue_next_hand_weight_if_symbol_absent') oneOf(item.maxStacks, [1,5], `${path}.maxStacks`);
    else literal(item.maxStacks, selected.maxStacks, `${path}.maxStacks`);
    if (effect.kind === 'grant_hand_before_run_failed') literal(item.initialCharges, 1, `${path}.initialCharges`);
    for (const [key, value] of Object.entries(selected.constants)) {
      check(JSON.stringify(effect[key]) === JSON.stringify(value), `${path}.effect.${key}`, 'unsupported policy');
    }
  }
  for (const [key, value] of Object.entries(effect)) {
    const field = `${path}.effect.${key}`;
    if (key === 'symbol') oneOf(value, symbolIds, field);
    if (['amount', 'minPrice', 'coins', 'maxExponent', 'bonusWeight', 'purchasesPerRefund', 'refundCoins'].includes(key)) integer(value, field, 1);
    if (key === 'maxRewardedCells') integer(value, field, 1, 9);
    if (key === 'minRealWinningLines') integer(value, field, 1, 8);
    if (key === 'triggerChanceBasisPoints') integer(value, field, 1, 10000);
    if (['fixedPoints', 'basePointAdd', 'pointsPerStack', 'pointsPerCell'].includes(key)) score(value, field);
    if (['extraFactor', 'selectedLineMultiplier', 'factor', 'forSeven', 'forOther', 'perRealLineFactor', 'factorPerExtraHit', 'payoutFactor'].includes(key)) fraction(value, field);
  }
  const constants = {
    random_candidate_edit: { candidateSelection: 'uniform_per_line', boardPriority: 'random_candidate_edit' },
    best_candidate_edit: { candidateSelection: 'best_delta_after_all_scoring', boardPriority: 'best_candidate_edit' },
    reroll_last_column: { condition: 'no_completed_raw_lines', boardPriority: 'reroll_last_column' },
    convert_random_nonseven_to_seven: { condition: 'at_least_two_sevens', boardPriority: 'seven_transform' },
    virtual_cherry_line_bonus: { condition: 'at_least_one_incomplete_final_line', countsAsRealWinningLine: false },
    wild_center: { changesVisualSymbol: false },
    zero_base_plus_per_real_line_factor: { doesNotMultiplyVirtualBonus: true },
    consecutive_win_multiplier: { resetOnNoLine: true },
    square_match_bonus: { usesWildCenter: false, countsAsRealWinningLine: false },
  };
  for (const [key, expected] of Object.entries(constants[effect.kind] ?? {})) literal(effect[key], expected, `${path}.effect.${key}`);
}

/** Validate JSON and compile exact scoring values. Never mutates the caller's data. */
export function parseRules(input) {
  keys(input, ['balance', 'lines', 'catalog'], [], 'rules');
  const { balance, lines, catalog } = structuredClone(input);
  keys(balance, ['version', 'status', 'board', 'symbols', 'round', 'economy', 'shop', 'itemRules', 'ranking'], [], 'balance');
  text(balance.version, 'balance.version');
  text(balance.status, 'balance.status');
  keys(balance.board, ['rows', 'cols', 'paylines'], [], 'balance.board');
  for (const [key, expected] of Object.entries({ rows: 3, cols: 3, paylines: 8 })) literal(balance.board[key], expected, `balance.board.${key}`);
  array(balance.symbols, 'balance.symbols');
  check(balance.symbols.length === 5, 'balance.symbols', 'expected five symbols');
  for (const [index, symbol] of balance.symbols.entries()) {
    const path = `balance.symbols[${index}]`;
    keys(symbol, ['id', 'display', 'weight', 'basePoint', 'linePayout'], [], path);
    oneOf(symbol.id, symbolIds, `${path}.id`);
    text(symbol.display, `${path}.display`);
    integer(symbol.weight, `${path}.weight`, 1, MAX_RANDOM_BOUND);
    score(symbol.basePoint, `${path}.basePoint`);
    score(symbol.linePayout, `${path}.linePayout`);
  }
  unique(balance.symbols.map((symbol) => symbol.id), 'balance.symbols');
  check(balance.symbols.reduce((sum, symbol) => sum + symbol.weight, 0) <= MAX_RANDOM_BOUND, 'balance.symbols', 'weight total exceeds RNG range');

  const round = balance.round;
  keys(round, ['baseHands', 'maxRoundMvp', 'roundTargets', 'carryRoundScore', 'carryCoins', 'carryItems'], ['autoClearOnTarget', 'maxExtraHands', 'milestoneCards', 'endless'], 'balance.round');
  if (Object.hasOwn(round, 'autoClearOnTarget')) literal(round.autoClearOnTarget, true, 'balance.round.autoClearOnTarget');
  integer(round.baseHands, 'balance.round.baseHands', 1);
  if (Object.hasOwn(round, 'maxExtraHands')) integer(round.maxExtraHands, 'balance.round.maxExtraHands', 0, Number.MAX_SAFE_INTEGER - round.baseHands);
  integer(round.maxRoundMvp, 'balance.round.maxRoundMvp', 1);
  if (round.endless !== undefined) {
    keys(round.endless, ['targetGrowth', 'targetRounding'], [], 'balance.round.endless');
    fraction(round.endless.targetGrowth, 'balance.round.endless.targetGrowth');
    check(exactInteger(round.endless.targetGrowth.num) > exactInteger(round.endless.targetGrowth.den), 'balance.round.endless.targetGrowth', 'target must increase');
    literal(round.endless.targetRounding, 'ceil', 'balance.round.endless.targetRounding');
    literal(round.autoClearOnTarget, true, 'balance.round.autoClearOnTarget');
  }
  literal(round.carryRoundScore, false, 'balance.round.carryRoundScore');
  literal(round.carryCoins, true, 'balance.round.carryCoins');
  literal(round.carryItems, true, 'balance.round.carryItems');
  array(round.roundTargets, 'balance.round.roundTargets');
  check(round.roundTargets.length === round.maxRoundMvp, 'balance.round.roundTargets', 'one target per round required');
  for (const [index, target] of round.roundTargets.entries()) {
    keys(target, ['round', 'targetScore'], [], `roundTargets[${index}]`);
    literal(target.round, index + 1, `roundTargets[${index}].round`);
    check(typeof target.targetScore === 'string', `roundTargets[${index}].targetScore`, 'expected decimal string');
    score(target.targetScore, `roundTargets[${index}].targetScore`, true);
  }

  const economicFields = ['startingCoins', 'baseClearReward', 'unusedHandReward', 'interestPerCoins', 'interestCap', 'failedRoundReward'];
  keys(balance.economy, economicFields, ['clearRewardPerRound'], 'balance.economy');
  if (Object.hasOwn(balance.economy, 'clearRewardPerRound')) integer(balance.economy.clearRewardPerRound, 'balance.economy.clearRewardPerRound');
  for (const key of economicFields) integer(balance.economy[key], `balance.economy.${key}`, key === 'interestPerCoins' ? 1 : 0);
  literal(balance.economy.failedRoundReward, 0, 'balance.economy.failedRoundReward');
  const shop = balance.shop;
  const shopNumbers = ['slots', 'firstPaidRerollPrice', 'rerollPriceIncreasePerPaidReroll', 'basePermanentItemSlots', 'baseLimitedItemSlots', 'discountPriceFloor'];
  const shopFlags = {
    unlimitedPurchases: true, paidRerollCountResetsPerShop: true, allowDuplicateIdsInSameOffer: false,
    offerSelection: 'rarity_then_uniform_without_replacement', excludeFullInventoryItems: false,
    allowPreviousOfferItems: true, emptySlotsOnPoolExhaustion: true, vipActivation: 'next_round',
  };
  keys(shop, [...shopNumbers, ...Object.keys(shopFlags), 'rarityWeight'], [], 'balance.shop');
  for (const key of shopNumbers) integer(shop[key], `balance.shop.${key}`, 1);
  for (const [key, value] of Object.entries(shopFlags)) literal(shop[key], value, `balance.shop.${key}`);
  keys(shop.rarityWeight, rarities, [], 'balance.shop.rarityWeight');
  for (const rarity of rarities) integer(shop.rarityWeight[rarity], `balance.shop.rarityWeight.${rarity}`, 1, MAX_RANDOM_BOUND);
  check(Object.values(shop.rarityWeight).reduce((sum, value) => sum + value, 0) <= MAX_RANDOM_BOUND, 'balance.shop.rarityWeight', 'weight total exceeds RNG range');
  const itemFlags = {
    oneBoardModifierPerHand: true, defaultAutotrigger: true, stackSameItemPayoutBonusesAdditively: true,
    perLineRounding: 'floor', globalMultiplierRounding: 'floor', maxScoreFormat: 'decimal_string',
    bestCandidateTieBreak: 'line_definition_order', bestCandidateVirtualRolls: 'shared_lazy_per_spin',
    consecutiveWinsCarryAcrossRounds: true,
  };
  keys(balance.itemRules, [...Object.keys(itemFlags), 'boardModifierPriority'], ['selected8Items','consumableActivation'], 'balance.itemRules');
  if (balance.itemRules.consumableActivation !== undefined) literal(balance.itemRules.consumableActivation, 'once_per_round_remaining_hands', 'balance.itemRules.consumableActivation');
  if (Object.hasOwn(balance.itemRules, 'selected8Items')) check(typeof balance.itemRules.selected8Items === 'boolean', 'balance.itemRules.selected8Items', 'expected boolean');
  for (const [key, value] of Object.entries(itemFlags)) literal(balance.itemRules[key], value, `balance.itemRules.${key}`);
  const priorities = balance.itemRules.boardModifierPriority;
  array(priorities, 'balance.itemRules.boardModifierPriority');
  unique(priorities, 'balance.itemRules.boardModifierPriority');
  const allowedPriorities = ['reroll_last_column', 'best_candidate_edit', 'random_candidate_edit', 'seven_transform'];
  if (Object.hasOwn(balance.itemRules, 'selected8Items')) allowedPriorities.push('mirror_copier');
  check(priorities.length === allowedPriorities.length, 'balance.itemRules.boardModifierPriority', 'expected all groups');
  for (const priority of priorities) oneOf(priority, allowedPriorities, 'balance.itemRules.boardModifierPriority');
  keys(balance.ranking, ['sortOrder', 'oneBestRecordPerAccount'], [], 'balance.ranking');
  check(JSON.stringify(balance.ranking.sortOrder) === JSON.stringify(['completedRounds_desc', 'runTotalScore_desc', 'endedAt_asc']), 'balance.ranking.sortOrder', 'unsupported ranking order');
  literal(balance.ranking.oneBestRecordPerAccount, true, 'balance.ranking.oneBestRecordPerAccount');

  keys(lines, ['version', 'lines'], ['squares'], 'lines');
  literal(lines.version, balance.version, 'lines.version');
  array(lines.lines, 'lines.lines');
  check(lines.lines.length === 8, 'lines.lines', 'expected eight paylines');
  unique(lines.lines.map((line) => line?.id), 'lines.lines');
  for (const [index, line] of lines.lines.entries()) {
    const path = `lines.lines[${index}]`;
    keys(line, ['id', 'indices'], [], path);
    check(Object.hasOwn(lineGeometry, line.id), `${path}.id`, 'unknown line ID');
    array(line.indices, `${path}.indices`);
    check(line.indices.length === 3, path, 'expected three cells');
    for (const cell of line.indices) integer(cell, `${path}.indices`, 0, 8);
    unique(line.indices, `${path}.indices`);
    check(JSON.stringify([...line.indices].sort()) === JSON.stringify(lineGeometry[line.id]), path, 'line ID does not match row/column/diagonal geometry');
  }

  if (Object.hasOwn(lines, 'squares')) {
    array(lines.squares, 'lines.squares');
    check(lines.squares.length === 4, 'lines.squares', 'expected four squares');
    unique(lines.squares.map((square) => square?.id), 'lines.squares');
    for (const [index, square] of lines.squares.entries()) {
      const path = `lines.squares[${index}]`;
      keys(square, ['id', 'indices'], [], path);
      check(Object.hasOwn(squareGeometry, square.id), `${path}.id`, 'unknown square ID');
      array(square.indices, `${path}.indices`);
      check(JSON.stringify(square.indices) === JSON.stringify(squareGeometry[square.id]), path, 'expected clockwise 2x2 geometry');
    }
  }

  keys(catalog, ['version', 'chanceUnits', 'items'], [], 'catalog');
  literal(catalog.version, balance.version, 'catalog.version');
  literal(catalog.chanceUnits, 'basis_points: 10000 = 100%', 'catalog.chanceUnits');
  array(catalog.items, 'catalog.items');
  check(catalog.items.length > 0, 'catalog.items', 'empty catalog');
  for (const [index, item] of catalog.items.entries()) validateItem(item, `catalog.items[${index}]`);
  for (const item of catalog.items) if (item.effect.triggerPolicy) literal(balance.itemRules.consumableActivation, 'once_per_round_remaining_hands', 'balance.itemRules.consumableActivation');
  if (catalog.items.some((item) => item.effect.kind === 'square_match_bonus')) check(lines.squares?.length === 4, 'lines.squares', 'square item requires geometry');
  if (catalog.items.some((item) => item.effect.kind === 'round_hands_add')) integer(round.maxExtraHands, 'balance.round.maxExtraHands', 1);
  unique(catalog.items.map((item) => item.id), 'catalog.items');
  if (round.milestoneCards !== undefined) {
    const config = round.milestoneCards;
    keys(config, ['afterRound','cards'], ['offerCount'], 'milestoneCards');
    integer(config.afterRound, 'milestoneCards.afterRound', 1);
    array(config.cards, 'milestoneCards.cards');
    if (config.offerCount !== undefined) integer(config.offerCount, 'milestoneCards.offerCount', 3, 4);
    check(config.cards.length === (config.offerCount ?? 3), 'milestoneCards.cards', 'card count must match offer count');
    unique(config.cards.map((c) => c.id), 'milestoneCards.cards');
    const kinds = ['remove_weighted_symbol','grant_symbol_upgrades','first_hand_wild_each_round','first_and_last_hand_wild_each_round','grant_coins'];
    unique(config.cards.map((c) => c.effect?.kind), 'milestoneCards.effects');
    for (const card of config.cards) {
      keys(card, ['id','nameKo','effect'], [], 'milestoneCards.card');
      text(card.id, 'milestoneCards.id'); text(card.nameKo, 'milestoneCards.nameKo');
      oneOf(card.effect.kind, kinds, 'milestoneCards.kind');
      if (card.effect.kind === 'remove_weighted_symbol') {
        keys(card.effect, ['kind','redistribution'], [], 'milestoneCards.effect');
        literal(card.effect.redistribution, 'proportional', 'milestoneCards.redistribution');
      } else if (card.effect.kind === 'grant_symbol_upgrades') {
        keys(card.effect, ['kind','itemIds'], ['spinFactor'], 'milestoneCards.effect');
        if (card.effect.spinFactor !== undefined) fraction(card.effect.spinFactor, 'milestoneCards.spinFactor');
        array(card.effect.itemIds, 'milestoneCards.itemIds'); unique(card.effect.itemIds, 'milestoneCards.itemIds');
        check(card.effect.itemIds.length === 5, 'milestoneCards.itemIds', 'one upgrade per symbol required');
        const upgrades = card.effect.itemIds.map((id) => catalog.items.find((i) => i.id === id)?.effect);
        check(upgrades.every((e) => e?.kind === 'symbol_line_add_factor' && e.basePointAdd !== undefined), 'milestoneCards.itemIds', 'requires score and payout upgrades');
        unique(upgrades.map((e) => e.symbol), 'milestoneCards.symbols');
      } else if (card.effect.kind === 'grant_coins') {
        keys(card.effect, ['kind','coins'], [], 'milestoneCards.effect');
        integer(card.effect.coins, 'milestoneCards.coins', 1);
      } else {
        keys(card.effect, ['kind','cellIndex'], [], 'milestoneCards.effect');
        literal(card.effect.cellIndex, 4, 'milestoneCards.cellIndex');
      }
    }
  }
  const symbols = balance.symbols.map((symbol) => ({ ...symbol, basePoint: exactInteger(symbol.basePoint), linePayout: exactInteger(symbol.linePayout) }));
  return deepFreeze({
    balance, catalog, lineDefinitions: lines,
    rulesVersion: balance.version, catalogVersion: catalog.version, linesVersion: lines.version,
    symbols, symbolsById: Object.fromEntries(symbols.map((symbol) => [symbol.id, symbol])),
    lines: lines.lines, squares: lines.squares ?? [],
    itemsById: Object.fromEntries(catalog.items.map((item) => [item.id, item])),
    targets: round.roundTargets.map((target) => exactInteger(target.targetScore)),
  });
}

export function getItem(rules, itemId) {
  requireCondition(typeof itemId === 'string' && Object.hasOwn(rules.itemsById, itemId), 'UNKNOWN_ITEM', `Unknown item ID: ${itemId}`);
  return rules.itemsById[itemId];
}
