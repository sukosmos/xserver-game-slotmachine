// Supported policies for the eight selected effects; tunable numbers remain in data/*.json.
export const selected8Contracts = {
  "queue_next_hand_weight_if_symbol_absent": {
    "category": "weight",
    "slot": "permanent",
    "maxStacks": 1,
    "fields": [
      "observedBoard",
      "absentSymbol",
      "bonusSymbol",
      "bonusWeight",
      "bonusScope",
      "durationHands",
      "pendingPolicy",
      "consumesOn"
    ],
    "constants": {
      "observedBoard": "finalPhysicalBoard",
      "absentSymbol": "seven",
      "bonusSymbol": "seven",
      "bonusScope": "all_cells",
      "durationHands": 1,
      "pendingPolicy": "replace_same_instance",
      "consumesOn": "next_actual_hand_draw"
    }
  },
  "copy_physical_column": {
    "category": "board",
    "slot": "charged",
    "maxStacks": 1,
    "fields": [
      "condition",
      "triggerChanceBasisPoints",
      "sourceCellIndices",
      "targetCellIndices",
      "boardPriority",
      "consumesPhysicalEditSlot",
      "chargeOn"
    ],
    "constants": {
      "condition": "left_and_right_columns_differ",
      "sourceCellIndices": [
        0,
        3,
        6
      ],
      "targetCellIndices": [
        2,
        5,
        8
      ],
      "boardPriority": "mirror_copier",
      "consumesPhysicalEditSlot": true,
      "chargeOn": "at_least_one_physical_cell_changed"
    }
  },
  "place_random_temporary_wild_mark": {
    "category": "board",
    "slot": "charged",
    "maxStacks": 1,
    "fields": [
      "triggerChanceBasisPoints",
      "candidateCells",
      "candidateSelection",
      "appliesAfter",
      "wildDuration",
      "changesPhysicalBoard",
      "chargeOn"
    ],
    "constants": {
      "candidateCells": "all_unmarked_indices",
      "candidateSelection": "uniform_by_cell",
      "appliesAfter": "physical_board_modification",
      "wildDuration": "current_hand_only",
      "changesPhysicalBoard": false,
      "chargeOn": "mark_placed_even_without_new_win"
    }
  },
  "award_pattern_points_if_equal_corners": {
    "category": "score",
    "slot": "permanent",
    "maxStacks": 2,
    "fields": [
      "sourceBoard",
      "cornerCellIndices",
      "pointsPerStack",
      "scoreBucket",
      "countsAsActualLine"
    ],
    "constants": {
      "sourceBoard": "finalPhysicalBoard",
      "cornerCellIndices": [
        0,
        2,
        6,
        8
      ],
      "scoreBucket": "patternBonus",
      "countsAsActualLine": false
    }
  },
  "award_pattern_points_for_crossing_cells": {
    "category": "score",
    "slot": "permanent",
    "maxStacks": 1,
    "fields": [
      "lineSource",
      "minDistinctWinningLinesAtCell",
      "pointsPerCell",
      "maxRewardedCells",
      "countUniqueCells",
      "includeWildResolvedActualLines",
      "excludeVirtualLines",
      "scoreBucket"
    ],
    "constants": {
      "lineSource": "actualWinningLines",
      "minDistinctWinningLinesAtCell": 2,
      "countUniqueCells": true,
      "includeWildResolvedActualLines": true,
      "excludeVirtualLines": true,
      "scoreBucket": "patternBonus"
    }
  },
  "refund_coins_every_n_item_purchases": {
    "category": "economy",
    "slot": "permanent",
    "maxStacks": 1,
    "fields": [
      "triggerEvent",
      "eligibleEvent",
      "purchasesPerRefund",
      "refundCoins",
      "counterScope",
      "counterReset",
      "activeFrom",
      "refundTime",
      "includeOwnAcquisition",
      "excludeRerollsAndDiscards"
    ],
    "constants": {
      "triggerEvent": "ITEM_PURCHASED",
      "eligibleEvent": "successful_item_purchase_after_payment",
      "counterScope": "per_item_instance_across_shops",
      "counterReset": "subtract_threshold_after_refund",
      "activeFrom": "following_round",
      "refundTime": "same_purchase_transaction",
      "includeOwnAcquisition": false,
      "excludeRerollsAndDiscards": true
    }
  },
  "grant_hand_before_run_failed": {
    "category": "hand",
    "slot": "charged",
    "maxStacks": 1,
    "fields": [
      "triggerEvent",
      "requiredHandsRemaining",
      "requiresRoundScoreBelowTarget",
      "handsGranted",
      "ignoreRoundStartHandCap",
      "automatic",
      "chargeOn",
      "maxActivationsPerInstance"
    ],
    "constants": {
      "triggerEvent": "HAND_RESOLVED_BEFORE_FAILURE_CHECK",
      "requiredHandsRemaining": 0,
      "requiresRoundScoreBelowTarget": true,
      "handsGranted": 1,
      "ignoreRoundStartHandCap": true,
      "automatic": true,
      "chargeOn": "hand_granted",
      "maxActivationsPerInstance": 1
    }
  },
  "multiply_actual_line_payout_if_physical_board_changed": {
    "category": "score",
    "slot": "permanent",
    "maxStacks": 1,
    "fields": [
      "condition",
      "lineSource",
      "factor",
      "doesNotModify",
      "includesWildResolvedActualLines"
    ],
    "constants": {
      "condition": "physicalChanged",
      "lineSource": "actualWinningLines",
      "doesNotModify": [
        "baseScore",
        "virtualBonus",
        "patternBonus"
      ],
      "includesWildResolvedActualLines": true
    }
  }
};

export const isSelected8 = (item) => Object.hasOwn(selected8Contracts, item.effect.kind);
export const isItemEnabled = (item, rules) => !isSelected8(item) || rules.balance.itemRules.selected8Items === true;
