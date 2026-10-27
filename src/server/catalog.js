import { inventoryGroup } from '../domain/inventory.js';
import { createRun } from '../domain/run.js';
import { percent } from './display.js';
import { upgradeView } from './upgrades.js';
import { isItemEnabled } from '../domain/selected8-contract.js';

const names = { cherry: '체리', lemon: '레몬', bell: '종', diamond: '다이아', seven: '세븐' };
const ratio = percent;
function describeEffect(item) {
  const e = item.effect;
  const chance = e.triggerPolicy ? '남은 Hand 수의 역수' : `${e.triggerChanceBasisPoints / 100}%`;
  switch (e.kind) {
    case 'weight_add': return `${names[e.symbol]} 등장 가중치 +${e.amount}${e.basePointAdd ? `, 1칸 점수 +${e.basePointAdd}` : ''}. 중첩은 합산됩니다.`;
    case 'symbol_line_add_factor': return `${names[e.symbol]} 라인 배당에 기본 배당의 ${ratio(e.extraFactor)} 추가${e.basePointAdd ? `, 1칸 점수 +${e.basePointAdd}` : ''}. 중첩은 합산됩니다.`;
    case 'random_candidate_edit': return `${chance} 확률로 완성 가능한 라인 하나를 균등 선택해 1칸을 바꿉니다.${e.selectedLineMultiplier ? ` 선택한 라인 배당 ${ratio(e.selectedLineMultiplier)}.` : ''}`;
    case 'wild_center': return `${e.triggerPolicy ? `${chance} 확률로 ` : ''}가운데 칸을 이번 스핀의 라인 판정에서 와일드로 사용합니다. 보이는 심벌은 유지합니다.`;
    case 'reroll_last_column': return `원본 보드에 당첨이 없으면 ${chance} 확률로 오른쪽 열을 다시 추첨합니다.`;
    case 'virtual_cherry_line_bonus': return `미완성 라인이 있으면 ${chance} 확률로 ${e.fixedPoints}점의 가상 배당. 실제 당첨 라인에는 포함되지 않습니다.`;
    case 'convert_random_nonseven_to_seven': return `세븐이 2개 이상이면 ${chance} 확률로 다른 심벌 한 칸을 세븐으로 바꿉니다.`;
    case 'best_candidate_edit': return `${chance} 확률로 최종 점수가 가장 많이 오르는 후보 라인을 완성합니다.`;
    case 'spin_multiplier_if_min_real_lines': return `실제 당첨 ${e.minRealWinningLines}라인 이상이면 스핀 점수 ${ratio(e.factor)}.`;
    case 'spin_multiplier': return `모든 스핀 점수 ${ratio(e.factor)}. 최대 ${item.maxStacks}개를 각각 곱해서 중첩합니다.`;
    case 'clear_round_before_run_failed': return `마지막 Hand 후 목표의 ${percent(e.minimumTargetRatio)} 이상 달성했으면 비상 레버를 소모하고 라운드를 통과합니다. 실제 점수는 유지하며 정상 보상을 받습니다.`;
    case 'conditional_per_line_factor': return `세븐 라인 ${ratio(e.forSeven)}, 나머지 라인 ${ratio(e.forOther)}.`;
    case 'zero_base_plus_per_real_line_factor': return `심벌 기본 점수는 0. 실제 당첨 라인 배당 ${ratio(e.perRealLineFactor)}.`;
    case 'consecutive_win_multiplier': return `두 번째 연속 당첨부터 매번 점수 ${ratio(e.factorPerExtraHit)}로 증폭, 최대 ${e.maxExponent}단계. 무당첨이면 초기화합니다.`;
    case 'round_hands_add': return `다음 라운드부터 매 라운드 Hand +${e.amount}. 최대 ${item.maxStacks}개 중첩.`;
    case 'square_match_bonus': return `같은 심벌 2×2마다 기본 라인 배당의 ${percent(e.payoutFactor)} 추가. 겹침 허용, 와일드와 라인 전용 강화 제외. 전역 배율은 적용됩니다.`;
    case 'clear_base_coins_add': return `클리어 기본 보상 +${e.amount}코인.`;
    case 'interest_cap_add': return `클리어 정산의 이자 상한 +${e.amount}코인.`;
    case 'one_free_reroll_per_shop': return `다음 상점부터 매 상점 ${e.amount}회 무료 새로고침.`;
    case 'shop_item_cost_subtract': return `구매 직후 이후 아이템 가격 −${e.amount}코인, 최소 ${e.minPrice}코인. 새로고침 제외.`;
    case 'chance_coins_on_clear': return `클리어 정산 시 ${chance} 확률로 +${e.coins}코인.`;
    case 'queue_next_hand_weight_if_symbol_absent': return `최종 보드에 세븐이 없으면 다음 스핀의 세븐 가중치 +${e.bonusWeight}. 라운드가 바뀌어도 한 번 적용됩니다.`;
    case 'copy_physical_column': return `좌우 열이 다를 때 ${chance} 확률로 왼쪽 열을 오른쪽에 복사합니다. 다른 보드 조작 뒤에 판정합니다.`;
    case 'place_random_temporary_wild_mark': return `${chance} 확률로 무작위 한 칸이 이번 스핀 동안 와일드가 됩니다. 실제 심벌과 1칸 점수는 유지합니다.`;
    case 'award_pattern_points_if_equal_corners': return `실제 네 모서리가 같은 심벌이면 +${e.pointsPerStack}점. 최대 ${item.maxStacks}개 합산, 전체 배수 적용.`;
    case 'award_pattern_points_for_crossing_cells': return `당첨 라인이 교차하는 칸당 +${e.pointsPerCell}점, 최대 ${e.maxRewardedCells}칸. 같은 칸은 한 번만 세며 전체 배수를 적용합니다.`;
    case 'refund_coins_every_n_item_purchases': return `다음 라운드 이후 성공한 아이템 구매 ${e.purchasesPerRefund}회마다 ${e.refundCoins}코인 환급. 구매 횟수는 상점을 넘어 유지됩니다.`;
    case 'grant_hand_before_run_failed': return `목표 미달로 Hand가 소진되면 자동으로 Hand +${e.handsGranted}. 성공 시에는 소모하지 않습니다.`;
    case 'multiply_actual_line_payout_if_physical_board_changed': return `실제 보드가 바뀐 스핀의 라인 배당 ${percent(e.factor)}. 와일드만 발동한 경우와 패턴 보너스는 제외합니다.`;
    default: throw new Error('Unsupported item description');
  }
}
export function describeItem(item) {
  return describeEffect(item) + (item.effect.triggerPolicy ? ' 라운드당 최대 1회 발동. 5 Hand 기준 20%→25%→약33.33%→50%→100%로 증가하며 조건을 만족해야 합니다.' : '');
}
export function publicCatalog(rules) {
  return {
    upgrades: upgradeView(createRun(rules), rules),
    rulesVersion: rules.rulesVersion, maxRounds: rules.balance.round.maxRoundMvp, baseHands: rules.balance.round.baseHands, targets: rules.targets.map(String),
    ...(rules.balance.round.endless ? { endless: rules.balance.round.endless } : {}),
    permanentSlots: rules.balance.shop.basePermanentItemSlots, limitedSlots: rules.balance.shop.baseLimitedItemSlots,
    ...(rules.balance.shop.upgradeItemIds ? { upgradeItemIds: rules.balance.shop.upgradeItemIds, offerGroups: rules.balance.shop.offerGroups } : {}),
    startingCoins: rules.balance.economy.startingCoins,
    symbols: rules.symbols.map((s) => ({ id: s.id, name: names[s.id], basePoint: s.basePoint.toString(), linePayout: s.linePayout.toString() })),
    lines: rules.lines,
    items: rules.catalog.items.filter((item) => isItemEnabled(item, rules)).map((item) => ({ ...item, inventoryGroup: inventoryGroup(item, rules), description: describeItem(item), summary: summarizeItem(item) })),
  };
}

export function summarizeItem(item) {
  const e = item.effect, chance = e.triggerPolicy ? '라운드당 최대 1회' : `${e.triggerChanceBasisPoints / 100}%`;
  const factor = percent;
  switch (e.kind) {
    case 'weight_add': return `${names[e.symbol]} 가중치 +${e.amount}${e.basePointAdd ? ` · 1칸 +${e.basePointAdd}점` : ''}`;
    case 'symbol_line_add_factor': return `${names[e.symbol]} 배당 +${percent(e.extraFactor)}${e.basePointAdd ? ` · 1칸 +${e.basePointAdd}점` : ''}`;
    case 'random_candidate_edit': return `${chance} · 라인 1칸 완성${e.selectedLineMultiplier ? ` · 해당 배당 ${factor(e.selectedLineMultiplier)}` : ''}`;
    case 'wild_center': return `${e.triggerPolicy ? '라운드당 최대 1회 · ' : ''}중앙 와일드`;
    case 'reroll_last_column': return `무당첨 시 ${chance} · 오른쪽 열 재추첨`;
    case 'virtual_cherry_line_bonus': return `미완성 라인 시 ${chance} · +${e.fixedPoints}점`;
    case 'convert_random_nonseven_to_seven': return `세븐 2개 이상 · ${chance}로 세븐 +1칸`;
    case 'best_candidate_edit': return `${chance} · 최고 득점 라인 완성`;
    case 'spin_multiplier_if_min_real_lines': return `${e.minRealWinningLines}라인 이상 · 스핀 ${factor(e.factor)}`;
    case 'spin_multiplier': return `스핀 점수 ${factor(e.factor)} · 곱중첩`;
    case 'clear_round_before_run_failed': return `마지막 Hand · 목표 ${percent(e.minimumTargetRatio)} 이상이면 통과`;
    case 'conditional_per_line_factor': return `세븐 배당 ${factor(e.forSeven)} · 나머지 ${factor(e.forOther)}`;
    case 'zero_base_plus_per_real_line_factor': return `기본점수 0 · 라인 배당 ${factor(e.perRealLineFactor)}`;
    case 'consecutive_win_multiplier': return `연속 당첨마다 ${factor(e.factorPerExtraHit)} · 최대 ${e.maxExponent}단계`;
    case 'round_hands_add': return `매 라운드 Hand +${e.amount}`;
    case 'square_match_bonus': return `같은 심벌 2×2 · 기본 배당 ${percent(e.payoutFactor)}`;
    case 'clear_base_coins_add': return `클리어 보상 +${e.amount}코인`;
    case 'interest_cap_add': return `이자 상한 +${e.amount}코인`;
    case 'one_free_reroll_per_shop': return `상점당 무료 새로고침 ${e.amount}회`;
    case 'shop_item_cost_subtract': return `구매가 −${e.amount}코인 · 즉시 적용`;
    case 'chance_coins_on_clear': return `클리어 시 ${chance} · +${e.coins}코인`;
    case 'queue_next_hand_weight_if_symbol_absent': return `세븐 없을 때 · 다음 스핀 세븐 가중치 +${e.bonusWeight}`;
    case 'copy_physical_column': return `${chance} · 왼쪽 열을 오른쪽에 복사`;
    case 'place_random_temporary_wild_mark': return `${chance} · 이번 스핀 무작위 와일드 1칸`;
    case 'award_pattern_points_if_equal_corners': return `같은 심벌 네 모서리 · +${e.pointsPerStack}점`;
    case 'award_pattern_points_for_crossing_cells': return `교차 칸당 +${e.pointsPerCell}점 · 최대 ${BigInt(e.pointsPerCell) * BigInt(e.maxRewardedCells)}점`;
    case 'refund_coins_every_n_item_purchases': return `구매 ${e.purchasesPerRefund}회마다 ${e.refundCoins}코인 환급`;
    case 'grant_hand_before_run_failed': return `실패 직전 · Hand +${e.handsGranted}`;
    case 'multiply_actual_line_payout_if_physical_board_changed': return `보드 변경 시 · 라인 배당 ${percent(e.factor)}`;
    default: throw new Error('Unsupported item summary');
  }
}
