import { createRun } from '../domain/run.js';
import { upgradeView } from './upgrades.js';

const names = { cherry: '체리', lemon: '레몬', bell: '종', diamond: '다이아', seven: '세븐' };
const ratio = (f) => `${f.num}/${f.den}`;
export function describeItem(item) {
  const e = item.effect;
  const chance = `${e.triggerChanceBasisPoints / 100}%`;
  switch (e.kind) {
    case 'weight_add': return `${names[e.symbol]} 등장 가중치 +${e.amount}. 전체 가중치에 비례해 추첨합니다.`;
    case 'symbol_line_add_factor': return `${names[e.symbol]} 라인 배당에 기본 배당의 ${ratio(e.extraFactor)}을 추가합니다. 중첩은 합산됩니다.`;
    case 'random_candidate_edit': return `${chance} 확률로 완성 가능한 라인 하나를 균등 선택해 1칸을 바꿉니다.${e.selectedLineMultiplier ? ` 선택한 라인 배당 ×${ratio(e.selectedLineMultiplier)}.` : ''}`;
    case 'wild_center': return '가운데 칸을 라인 판정에서 와일드로 사용합니다. 보이는 심벌은 유지합니다.';
    case 'reroll_last_column': return `원본 보드에 당첨이 없으면 ${chance} 확률로 오른쪽 열을 다시 추첨합니다.`;
    case 'virtual_cherry_line_bonus': return `미완성 라인이 있으면 ${chance} 확률로 ${e.fixedPoints}점의 가상 배당. 실제 당첨 라인에는 포함되지 않습니다.`;
    case 'convert_random_nonseven_to_seven': return `세븐이 2개 이상이면 ${chance} 확률로 다른 심벌 한 칸을 세븐으로 바꿉니다.`;
    case 'best_candidate_edit': return `${chance} 확률로 최종 점수가 가장 많이 오르는 후보 라인을 완성합니다.`;
    case 'spin_multiplier_if_min_real_lines': return `실제 당첨 ${e.minRealWinningLines}라인 이상이면 스핀 점수 ×${ratio(e.factor)}.`;
    case 'conditional_per_line_factor': return `세븐 라인 ×${ratio(e.forSeven)}, 나머지 라인 ×${ratio(e.forOther)}.`;
    case 'zero_base_plus_per_real_line_factor': return `심벌 기본 점수는 0. 실제 당첨 라인 배당 ×${ratio(e.perRealLineFactor)}.`;
    case 'consecutive_win_multiplier': return `연속 당첨마다 ×${ratio(e.factorPerExtraHit)}, 최대 ${e.maxExponent}단계. 무당첨이면 초기화합니다.`;
    case 'clear_base_coins_add': return `클리어 기본 보상 +${e.amount}코인.`;
    case 'interest_cap_add': return `클리어 정산의 이자 상한 +${e.amount}코인.`;
    case 'one_free_reroll_per_shop': return `다음 상점부터 매 상점 ${e.amount}회 무료 새로고침.`;
    case 'shop_item_cost_subtract': return `구매 직후 이후 아이템 가격 −${e.amount}코인, 최소 ${e.minPrice}코인. 새로고침 제외.`;
    case 'chance_coins_on_clear': return `클리어 정산 시 ${chance} 확률로 +${e.coins}코인.`;
    default: throw new Error('Unsupported item description');
  }
}
export function publicCatalog(rules) {
  return {
    upgrades: upgradeView(createRun(rules), rules),
    rulesVersion: rules.rulesVersion, maxRounds: rules.balance.round.maxRoundMvp, baseHands: rules.balance.round.baseHands, targets: rules.targets.map(String),
    permanentSlots: rules.balance.shop.basePermanentItemSlots, limitedSlots: rules.balance.shop.baseLimitedItemSlots,
    startingCoins: rules.balance.economy.startingCoins,
    symbols: rules.symbols.map((s) => ({ id: s.id, name: names[s.id], basePoint: s.basePoint.toString(), linePayout: s.linePayout.toString() })),
    lines: rules.lines,
    items: rules.catalog.items.map((item) => ({ ...item, description: describeItem(item), summary: summarizeItem(item) })),
  };
}

export function summarizeItem(item) {
  const e = item.effect, chance = `${e.triggerChanceBasisPoints / 100}%`;
  const factor = (f) => f.den === 1 ? String(f.num) : ratio(f);
  switch (e.kind) {
    case 'weight_add': return `${names[e.symbol]} 가중치 +${e.amount}`;
    case 'symbol_line_add_factor': {
      const numerator = BigInt(e.extraFactor.num) * 100n, denominator = BigInt(e.extraFactor.den);
      const percent = numerator % denominator === 0n ? String(numerator / denominator) : `${numerator}/${denominator}`;
      return `${names[e.symbol]} 배당 +${percent}%`;
    }
    case 'random_candidate_edit': return `${chance} · 라인 1칸 완성${e.selectedLineMultiplier ? ` · 해당 배당 ×${factor(e.selectedLineMultiplier)}` : ''}`;
    case 'wild_center': return '중앙 와일드';
    case 'reroll_last_column': return `무당첨 시 ${chance} · 오른쪽 열 재추첨`;
    case 'virtual_cherry_line_bonus': return `미완성 라인 시 ${chance} · +${e.fixedPoints}점`;
    case 'convert_random_nonseven_to_seven': return `세븐 2개 이상 · ${chance}로 세븐 +1칸`;
    case 'best_candidate_edit': return `${chance} · 최고 득점 라인 완성`;
    case 'spin_multiplier_if_min_real_lines': return `${e.minRealWinningLines}라인 이상 · 스핀 ×${factor(e.factor)}`;
    case 'conditional_per_line_factor': return `세븐 배당 ×${factor(e.forSeven)} · 나머지 ×${factor(e.forOther)}`;
    case 'zero_base_plus_per_real_line_factor': return `기본점수 0 · 라인 배당 ×${factor(e.perRealLineFactor)}`;
    case 'consecutive_win_multiplier': return `연속 당첨 ×${factor(e.factorPerExtraHit)} · 최대 ${e.maxExponent}단계`;
    case 'clear_base_coins_add': return `클리어 보상 +${e.amount}코인`;
    case 'interest_cap_add': return `이자 상한 +${e.amount}코인`;
    case 'one_free_reroll_per_shop': return `상점당 무료 새로고침 ${e.amount}회`;
    case 'shop_item_cost_subtract': return `구매가 −${e.amount}코인 · 즉시 적용`;
    case 'chance_coins_on_clear': return `클리어 시 ${chance} · +${e.coins}코인`;
    default: throw new Error('Unsupported item summary');
  }
}
