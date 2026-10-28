export const expansionContracts = {
  "bonus_once_if_physical_symbol_present": {
    "category": "score",
    "slot": "permanent",
    "fields": {
      "symbol": "diamond",
      "baseValueSource": "upgraded_symbol_point",
      "bonusMultiplier": 100,
      "maxAwardsPerSpin": 1,
      "board": "finalPhysicalBoard",
      "scoreBucket": "specialFlatBonus",
      "affectedByLineOnlyMultipliers": false,
      "affectedByGlobalScoreMultipliers": true
    }
  },
  "expand_inventory_capacity": {
    "category": "capacity",
    "slot": "none",
    "fields": {
      "permanentSlotsAdded": 2,
      "limitedSlotsAdded": 1,
      "applyAt": "purchase_commit",
      "discardable": false,
      "occupiesSlots": 0
    }
  },
  "bonus_per_physical_symbol_base_value": {
    "category": "score",
    "slot": "permanent",
    "fields": {
      "symbol": "diamond",
      "baseValueSource": "symbol_catalog_raw_base_score",
      "rawBaseScore": 5,
      "bonusMultiplier": 100,
      "board": "finalPhysicalBoard",
      "scoreBucket": "specialFlatBonus",
      "affectedByLineOnlyMultipliers": false,
      "affectedByGlobalScoreMultipliers": true
    }
  },
  "choose_one_remaining_destiny_card": {
    "category": "destiny",
    "slot": "none",
    "fields": {
      "trigger": "shop_purchase_selection_commit",
      "selectionSource": "eligible_unclaimed_destiny_cards",
      "selectionScope": "all_eligible",
      "selectionRequired": true,
      "grantPrice": 0,
      "ownershipPolicy": "existing_destiny_card_rules",
      "occupiesSlots": 0,
      "hideOfferWhenChoicesEmpty": true
    }
  },
  "complete_one_random_two_match_line": {
    "category": "board",
    "slot": "round",
    "optionalFields": { "protectCompletedLines": true },
    "fields": {
      "durationRounds": 1,
      "startsAt": "next_round_after_purchase",
      "maxPhysicalEditsPerHand": 1,
      "procChanceBasisPoints": 10000,
      "priority": "before_existing_physical_edits",
      "candidateDefinition": "exactly_two_equal_one_different_physical_symbols",
      "candidateWeight": "uniform_by_line_tuple",
      "canTriggerOnMultipleHandsInRound": true,
      "roundEndExpiration": "always",
      "consumesPhysicalEditSlot": true
    }
  },
  "modify_item_proc_chances": {
    "category": "proc",
    "slot": "permanent",
    "fields": {
      "relativeIncreaseNumerator": 1,
      "relativeIncreaseDenominator": 2,
      "appliesTo": "probabilistic_item_effect_checks",
      "excludes": [
        "shop_offer_weights",
        "shop_rarity",
        "symbol_draw_weights",
        "guaranteed_effects",
        "non_item_rng"
      ],
      "stackWithModulator": "additive_on_base_probability",
      "rounding": "floor_basis_points",
      "maxChanceBasisPoints": 10000
    }
  },
  "coin_on_round_clear_per_physical_symbol_count": {
    "category": "economy",
    "slot": "permanent",
    "fields": {
      "symbol": "diamond",
      "board": "finalPhysicalBoard",
      "diamondsPerCoin": 2,
      "maxCoinsPerRound": 3,
      "carryBetweenRounds": false,
      "payoutOnlyOnRoundClear": true,
      "countWhenActive": "hands_from_first_active_round",
      "rounding": "floor"
    }
  },
  "double_next_actual_hand_after_no_line": {
    "category": "score",
    "slot": "permanent",
    "fields": {
      "lineCountSource": "actualWinningLines",
      "scoreMultiplierNumerator": 2,
      "scoreMultiplierDenominator": 1,
      "multiplierScope": "entire_final_spin_score",
      "oneSpinOnly": true,
      "doesNotCompoundAcrossConsecutiveMisses": true,
      "persistsAcrossRoundBoundaries": true,
      "ignorePreviousHandsBeforeItemActivation": true
    }
  },
  "multiply_symbol_base_and_line_score": {
    "category": "score",
    "slot": "permanent",
    "fields": {
      "symbols": [
        "cherry",
        "lemon"
      ],
      "baseScoreMultiplier": 3,
      "linePayoutMultiplier": 3,
      "multiplyProcRates": false,
      "stackWithSameSymbolItems": "multiplicative_distinct_family",
      "baseScoreUsesPhysicalSymbols": true,
      "lineScoreUsesResolvedWinningSymbol": true
    }
  }
};
export const hasExpansion = (rules) => rules.balance.itemRules.expansion8Items === true;
export const isExpansion = (item) => Object.hasOwn(expansionContracts, item.effect.kind);
