import { GameClient } from './client.js';
import { compactScore, exactScore, progress, escapeHtml as esc } from './format.js';
import { delay, presentSpin, interpolateScore } from './spin-animation.js';

const $ = (selector) => document.querySelector(selector);
const client = new GameClient();
let catalog, run = null, lastSpin = null, lastEvent = null, busy = true, tab = 'play', ranks = [], recent = [], shownBoard = null;
let playerId, audioContext, upgrades = null, upgradeMode = null;
let motion = null, presentation = null, cardReveal = null;
const celebratedRuns = new Set();
const rarity = { common: '일반', rare: '희귀', epic: '영웅', legendary: '전설' };
const reasons = { INSUFFICIENT_COINS: '코인 부족', INVENTORY_FULL: '아이템 칸 부족', ITEM_CAP_REACHED: '최대 중첩', SOLD_OUT: '품절', EMPTY_SHOP_SLOT: '상품 없음' };
const errors = { CONNECTION_LOST: '연결이 끊겼어요. 결과 확인을 눌러 안전하게 이어가세요.', PENDING_ACTION: '이전 선택의 결과를 먼저 확인해주세요.',
  STALE_REVISION: '다른 화면에서 진행된 최신 상태를 불러왔어요.', INSUFFICIENT_COINS: '코인이 부족해요.', INVENTORY_FULL: '아이템을 하나 비우고 다시 구매해주세요.',
  RATE_LIMITED: '잠시 쉬어갈까요? 조금 뒤에 다시 시도해주세요.', UNAUTHENTICATED: '다시 연결하려면 플레이 키를 확인해주세요.',
  STORAGE_UNAVAILABLE: '저장소 연결을 확인하고 있어요. 잠시 뒤 결과를 다시 확인해주세요.' };
const preferences = { sound: false, fast: false, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
try { Object.assign(preferences, JSON.parse(localStorage.getItem('nine.preferences') ?? '{}')); } catch {}
for (const name of ['sound', 'fast', 'reduced']) $(`#${name}`).checked = Boolean(preferences[name]);
document.documentElement.classList.toggle('reduced', preferences.reduced);
const icon = (name, className = '') => `<svg class="icon ${className}" aria-hidden="true"><use href="/icons.svg#${esc(name)}"></use></svg>`;
const number = (value, className = '') => `<button class="score-number ${className}" data-action="score" data-value="${esc(value)}" title="${exactScore(value)}" aria-label="${exactScore(value)}점, 전체 숫자 보기">${compactScore(value)}</button>`;
const itemOf = (id) => catalog?.items.find((item) => item.id === id);
const stackLabel = (item) => item.maxStacks === null ? '중첩 무제한' : `최대 ${item.maxStacks}개`;
const itemIcon = (item) => ({ seven_tracker: 'seven', mirror_copier: 'mirror', temporary_wild: 'spark', corner_collector: 'corners', crossroads_bonus: 'crossing', receipt_collector: 'receipt', emergency_lever: 'hand', editors_proof: 'edit' })[item.id] ?? item.effect.symbol ?? (item.effect.kind === 'square_match_bonus' ? 'square' : item.category === 'resource' ? 'hand' : item.category === 'economy' ? 'coin' : item.category === 'board' ? 'spark' : 'crown');
const ended = () => run && ['RUN_WON', 'RUN_FAILED'].includes(run.phase);
const blocked = () => busy || Boolean(client.pending());
const button = (label, action, { disabled = false, className = 'secondary', value = '' } = {}) => `<button class="${className}" data-action="${action}" data-value="${esc(value)}" ${disabled ? 'disabled' : ''}>${label}</button>`;

function notice(text = '', error = false, quiet = false) {
  $('#notice').textContent = text;
  $('#notice').className = text ? quiet ? 'sr-only' : `notice ${error ? 'error' : ''}` : '';
}
function lifetime(item, instance) {
  const pending = instance && !isActive(instance) ? `R${instance.activeFromRound}부터 · ` : '';
  if (item.slot === 'charged') return `${pending}발동 ${instance?.remainingCharges ?? item.initialCharges}회`;
  if (item.slot === 'timed') return `${pending}${instance?.remainingSpins ?? item.durationSpins} Hand`;
  return `${pending}${item.inventoryGroup === 'upgrade' ? '강화' : '영구'}`;
}
function render() {
  document.querySelectorAll('[data-tab]').forEach((el) => { el.disabled = busy; el.classList.toggle('nav-active', el.dataset.tab === tab); el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'); });
  $('[data-action="settings"]').disabled = busy;
  if (!catalog) return;
  const active = document.activeElement?.dataset;
  $('#main').innerHTML = tab === 'catalog' ? renderCatalog() : tab === 'ranking' ? renderRanks() : renderPlay();
  $('#main').setAttribute('aria-busy', String(busy));
  const gauge = $('#goal-fill'); if (gauge) gauge.style.width = `${run ? progress(motion?.score ?? run.roundScore, run.targetScore) : 0}%`;
  if (active?.action) [...document.querySelectorAll('[data-action]')].find((el) => el.dataset.action === active.action && el.dataset.value === active.value && !el.disabled)?.focus({ preventScroll: true });
  const victory = $('#victory');
  if (!run?.canStartEndless && victory.open) victory.close();
  if (tab === 'play' && run?.canStartEndless && !blocked() && !celebratedRuns.has(run.runId) && !document.querySelector('dialog[open]')) {
    $('#victory-message').textContent = `${catalog.maxRounds} 라운드를 깨셨네요!`;
    celebratedRuns.add(run.runId); victory.showModal();
  }
}
function renderPlay() {
  const phase = run?.phase;
  const status = !run ? '준비' : phase === 'SHOP' ? '정산 완료' : phase === 'RUN_WON' ? '전체 클리어' : phase === 'RUN_FAILED' ? '종료' : '';
  return `<section class="run-toolbar"><div class="run-title"><h1>라운드 ${run?.roundIndex ?? 1}<small>${run?.mode === 'endless' ? ' · ENDLESS' : ` / ${catalog.maxRounds}`}</small></h1>${status ? `<span class="phase-badge">${status}</span>` : ''}</div><div class="run-meta"><span>누적 ${number(run?.runTotalScore ?? '0')}</span><span class="coin-balance">${icon('coin')} ${run?.coins ?? catalog.startingCoins}</span></div><div class="run-tools">${run || recent.length ? button('지난 런', 'history', { disabled: busy, className: 'text-button' }) : ''}${button('새 런', 'new', { disabled: blocked(), className: 'text-button' })}</div></section>
  ${client.pending() ? `<div class="recovery"><span>처리 결과 확인 필요</span>${button('결과 확인', 'retry', { disabled: busy, className: 'primary' })}</div>` : ''}
  <div class="play-layout"><div class="game-column">${!motion && (phase === 'CARD_CHOICE' || cardReveal) ? renderCardScene() : phase === 'SHOP' && !motion ? renderShopScene() : renderMachine()}${phase === 'CARD_CHOICE' || cardReveal ? '' : renderBreakdown()}</div><aside class="build-column">${renderBlessing()}${renderUpgrades()}${renderInventory()}</aside></div>`;
}
function renderCardScene() {
  const slots = cardReveal?.slots ?? run.cardChoice.slots;
  const reward = cardReveal?.reward;
  return `<section class="machine card-scene" id="scene" tabindex="-1" aria-label="카드 선택"><div class="section-title"><h2>운명의 선택</h2><small>R${run.roundIndex} 보상</small></div><p class="card-prompt">${reward ? '당신의 카드' : '한 장을 고르세요'}</p><div class="fate-cards ${slots.length === 4 ? 'four-cards' : ''}">${slots.map((slot, i) => {
    const selected = cardReveal?.slotId === slot.slotId;
    return `<button class="fate-card ${selected ? 'revealed' : reward ? 'unchosen' : ''}" data-action="choose-card" data-value="${esc(slot.slotId)}" aria-label="${i + 1}번째 카드${selected ? ` · ${esc(reward.name)}` : ' 선택'}" ${blocked() || reward ? 'disabled' : ''}><span class="card-inner"><span class="card-back" aria-hidden="true"><span class="card-emblem">9</span><span class="card-stars">✦</span></span><span class="card-front" aria-hidden="true">${selected ? icon(reward.removedSymbol ?? (reward.cardId === 'wild' ? 'spark' : reward.cardId === 'windfall' ? 'coin' : 'crown')) : ''}</span></span></button>`;
  }).join('')}</div><div class="card-result" role="status">${reward ? `<strong>${esc(reward.name)}</strong><p>${esc(reward.summary)}</p>` : '<small>한 장의 보상을 받습니다</small>'}</div></section>`;
}
function renderBlessing() {
  const reward = run?.milestoneReward;
  if (!reward) return '';
  const wild = reward.cardId === 'wild';
  return `<section class="blessing" aria-label="카드 보상">${icon(reward.removedSymbol ?? (wild ? 'spark' : reward.cardId === 'windfall' ? 'coin' : 'crown'))}<div><strong>${esc(reward.name)}</strong><p>${esc(reward.summary)}</p></div>${wild && run.phase === 'ROUND_ACTIVE' ? `<small>${reward.includesLastHand ? run.roundWildAvailable ? '첫·마지막 대기' : run.handsRemaining === 1 ? '마지막 준비' : '마지막 대기' : run.roundWildAvailable ? '이번 라운드 대기' : '이번 라운드 사용'}</small>` : `<small>${reward.coinsGranted ? '지급 완료' : '영구'}</small>`}</section>`;
}
function renderMachine() {
  const score = motion?.score ?? run?.roundScore ?? '0', hands = motion?.hands ?? run?.handsRemaining ?? catalog.baseHands;
  const totalHands = run?.roundHands ?? catalog.baseHands, rolling = ['rolling', 'stopping'].includes(motion?.stage);
  const award = motion?.award;
  return `<section class="machine motion-${motion?.stage ?? 'idle'}" id="scene" tabindex="-1" aria-label="슬롯"><div class="score-row"><div><span class="muted">점수</span><div class="score" id="round-score">${number(score)}</div></div><div class="target"><span>목표</span>${number(run?.targetScore ?? catalog.targets[0])}</div></div><div class="goal-track" role="progressbar" aria-label="목표 달성" aria-valuenow="${run ? progress(score, run.targetScore) : 0}" aria-valuemin="0" aria-valuemax="100"><div id="goal-fill"></div></div><div class="hand-row"><span>Hand</span><div class="hand-dots" aria-label="${hands} Hand 남음">${Array.from({ length: totalHands }, (_, i) => `<i class="${i < hands ? 'available' : ''}"></i>`).join('')}<strong>${hands}<span>/${totalHands}</span></strong></div></div>
  <div class="machine-interior">${renderBoard()}<button class="lever" data-action="spin" aria-label="손잡이 당기기" title="손잡이 당기기 · Space" ${blocked() || !run || ended() ? 'disabled' : ''}><span class="lever-socket"></span><span class="lever-arm"><span class="lever-knob"></span></span><span class="lever-label">${rolling ? '회전 중' : 'PULL'}</span></button></div>
  <div class="spin-caption">${rolling ? '<span>회전 중</span>' : award ? `<span>${esc(award.label)}</span><strong>+${compactScore(award.score)}<small>점</small></strong>` : lastSpin ? `<span>${awardSummary(lastSpin)}</span><strong>+${compactScore(lastSpin.spinScore)}<small>점</small></strong>` : '<span>3×3 · 8라인</span>'}</div>
  <div class="effect-cues" aria-live="polite">${(motion?.effects ?? []).map((effect) => `<div class="effect-cue"><span>${esc(effect.name)}</span><strong>${esc(effect.label)}</strong></div>`).join('')}${motion?.stage === 'score' && presentation?.expired.length ? `<small class="expiry-cue">${esc(presentation.expired.map((item) => item.name).join(', '))} · 사용 완료</small>` : ''}</div>
  ${!run || ended() ? `<div class="action-row">${run?.canStartEndless ? button('Endless Mode 시작 →', 'start-endless', { disabled: blocked(), className: 'primary spin-button' }) : button(run ? '다시 시작' : '시작', 'start', { disabled: blocked(), className: 'primary spin-button' })}</div>` : ''}${ended() ? `<p class="machine-note">${run.completedRounds}라운드 완료 · 기록 저장됨</p>` : ''}
  ${motion?.stage === 'clear' ? `<div class="round-clear" role="status"><span class="clear-mark">✓</span><strong>ROUND CLEAR</strong><span>라운드 ${run.roundIndex}</span><b>${icon('coin')} +${motion.reward}</b></div>` : ''}${motion?.stage === 'emergency' ? `<div class="round-clear emergency-clear" role="status"><span>비상 레버</span><strong>${motion.roundCleared ? 'ROUND SAVED' : `EXTRA HAND +${motion.handsGranted}`}</strong></div>` : ''}</section>`;
}
function awardSummary(spin) {
  return `${spin.winningLines.length}라인${spin.winningPatterns?.length ? ` · 패턴 ${spin.winningPatterns.length}` : ''}`;
}
function renderShopScene() {
  return `<section class="machine shop-scene" id="scene" tabindex="-1" aria-label="상점">${renderShop()}${upgrades?.next?.hands > catalog.baseHands ? `<p class="next-hands">다음 라운드 ${upgrades.next.hands} Hand</p>` : ''}<div class="action-row">${button(run.mode === 'endless' && run.roundIndex === catalog.maxRounds ? `${run.roundIndex + 1}라운드 시작` : '다음 라운드', 'continue', { disabled: blocked(), className: 'primary spin-button' })}</div></section>`;
}
function statChange(base, value, percent = false) {
  const trimPercent = (text) => text.replace(/\.00%$/, '%').replace(/(\.\d)0%$/, '$1%');
  const before = percent ? trimPercent(base) : compactScore(base), after = percent ? trimPercent(value) : compactScore(value);
  return base === value ? `<span>${after}</span>` : `<span class="stat-change" aria-label="${esc(base)}에서 ${esc(value)}"><del>${before}</del><span aria-hidden="true">→</span><strong>${after}</strong></span>`;
}
function selectedBuild() {
  const view = upgrades ?? catalog.upgrades;
  return (upgradeMode ?? (view.next ? 'next' : 'current')) === 'next' && view.next ? view.next : view.current;
}
function renderUpgrades() {
  const view = upgrades ?? catalog.upgrades, selected = selectedBuild();
  const future = selected === view.next;
  return `<section class="upgrades" aria-label="심벌 강화"><div class="section-title"><h2>심벌 강화</h2>${view.next ? `<div class="upgrade-tabs" role="group" aria-label="적용 라운드"><button data-action="upgrade-mode" data-value="current" aria-pressed="${!future}">현재</button><button data-action="upgrade-mode" data-value="next" aria-pressed="${future}">다음 R${view.next.roundIndex}</button></div>` : `<small>${ended() && !run.canStartEndless ? run.milestoneReward ? '카드 적용' : '기본값' : '현재 적용'}</small>`}</div><table class="symbol-table"><caption>기본 → 적용${future ? ` · R${selected.roundIndex} 미리보기` : ''}</caption><thead><tr><th scope="col">심벌</th><th scope="col">1칸 점수</th><th scope="col">3개 배당</th><th scope="col">추첨 확률</th></tr></thead><tbody>${selected.symbols.map((row) => `<tr data-symbol="${row.id}"><th scope="row"><button data-action="symbol" data-value="${row.id}" aria-label="${esc(catalog.symbols.find((symbol) => symbol.id === row.id).name)} 강화 상세">${icon(row.id)}<span>${esc(catalog.symbols.find((symbol) => symbol.id === row.id).name)}</span></button></th><td>${statChange(row.basePoint, row.point)}</td><td>${statChange(row.baseLinePayout, row.linePayout)}</td><td>${statChange(row.baseProbability, row.probability, true)}</td></tr>`).join('')}</tbody></table>${selected.effects.length ? `<div class="other-effects"><h3>기타 효과</h3>${selected.effects.map((effect) => `<button class="effect-row" data-action="item" data-value="${effect.itemId}"><span>${esc(itemOf(effect.itemId).nameKo)}${effect.stacks > 1 ? ` ×${effect.stacks}` : ''}</span><small>${esc(itemOf(effect.itemId).summary)}</small></button>`).join('')}</div>` : ''}</section>`;
}
function renderBreakdown() {
  if (!lastSpin) return '';
  const triggered = presentation?.effects.map((effect) => `${effect.name} ${effect.label}`) ?? lastSpin.triggeredItems.map((t) => itemOf(t.itemId)?.nameKo).filter(Boolean);
  const expired = lastSpin.expiredItems.map((t) => itemOf(t.itemId)?.nameKo).filter(Boolean);
  return `<details class="breakdown"><summary>점수 내역 <span>+${compactScore(lastSpin.spinScore)} ⌄</span></summary><dl><div><dt>심벌 점수</dt><dd>${exactScore(lastSpin.baseScore)}</dd></div><div><dt>라인 배당</dt><dd>${exactScore(lastSpin.lineScore)}</dd></div>${BigInt(lastSpin.patternScore ?? '0') > 0n ? `<div><dt>패턴 배당</dt><dd>${exactScore(lastSpin.patternScore)}</dd></div>` : ''}${lastSpin.virtualScore !== '0' ? `<div><dt>가상 배당</dt><dd>${exactScore(lastSpin.virtualScore)}</dd></div>` : ''}<div><dt>전체 배수</dt><dd>${esc(presentation?.multiplier ?? '—')}</dd></div><div><dt>최종 점수</dt><dd>${exactScore(lastSpin.spinScore)}</dd></div></dl>${triggered.length ? `<p>발동: ${esc(triggered.join(', '))}</p>` : ''}${expired.length ? `<p>만료: ${esc(expired.join(', '))}</p>` : ''}${button('보드 전후', 'before-after', { className: 'text-button' })}</details>`;
}
function isActive(instance) {
  return instance.activeFromRound <= run.roundIndex || itemOf(instance.itemId).effect.kind === 'shop_item_cost_subtract';
}
function instanceStatus(item, instance) {
  if (item.effect.triggerPolicy && instance.lastTriggeredRound === run?.roundIndex && run.phase === 'ROUND_ACTIVE') return '이번 라운드 사용';
  if (instance.purchaseCounter !== undefined) return `구매 ${instance.purchaseCounter}/${item.effect.purchasesPerRefund}`;
  const pending = run?.pendingNextHandWeightBuffs?.find((buff) => buff.sourceInstanceId === instance.instanceId);
  return pending ? `다음 스핀 세븐 +${pending.amount}` : '';
}
function renderInventory() {
  const inventory = run?.items ?? [], ids = [...new Set(inventory.map(item => item.itemId))];
  const groupOf = item => item.inventoryGroup ?? (item.slot === 'permanent' ? 'permanent' : 'limited');
  const groups = [['permanent','영구',catalog.permanentSlots],['limited','제한',catalog.limitedSlots], ...(catalog.upgradeItemIds ? [['upgrade','강화',null]] : [])];
  return `<section class="inventory"><div class="section-title"><h2>아이템</h2></div>${groups.map(([group,label,limit]) => {
    const selected = ids.filter(id => groupOf(itemOf(id)) === group);
    const count = group === 'limited' ? inventory.filter(i => groupOf(itemOf(i.itemId)) === group).length : selected.length;
    return `<div class="inventory-group"><h3>${label}<small>${limit === null ? `${count}종 · 무제한` : `${count}/${limit}`}</small></h3>${selected.length ? `<div class="inventory-grid">${selected.map(id => {
      const item=itemOf(id), instances=inventory.filter(i=>i.itemId===id), active=instances.filter(isActive).length;
      const status=item.slot!=='permanent' ? `${lifetime(item,instances[0])}${instanceStatus(item,instances[0]) ? ` · ${instanceStatus(item,instances[0])}` : ''}` : active===0 ? '다음 라운드' : instanceStatus(item,instances[0]) || (active===instances.length ? '적용 중' : `적용 ${active} · 다음 ${instances.length-active}`);
      return `<button class="inventory-item ${item.rarity}" data-action="owned" data-value="${id}">${icon(itemIcon(item))}<span><strong>${esc(item.nameKo)}${instances.length>1 ? ` ×${instances.length}` : ''}</strong><small>${status}</small></span></button>`;
    }).join('')}</div>` : '<p class="empty-label">없음</p>'}</div>`;
  }).join('')}</section>`;
}
function renderOffers(shop) {
  const groups = catalog.offerGroups ? [['upgrade','강화',catalog.offerGroups.upgrade],['item','아이템',catalog.offerGroups.item]] : [[null,null,null]];
  return groups.map(([group,title,count]) => `<div class="shop-group">${title ? `<h3>${title}<small>${count}칸</small></h3>` : ''}<div class="shop-offers">${shop.slots.filter(o=>!group || o.group===group).map(offer=>{
    if(!offer.itemId) return `<div class="sold-out">${offer.soldOut ? '품절' : '상품 없음'}</div>`;
    const item=itemOf(offer.itemId);
    return `<article class="shop-card ${item.rarity}"><div class="item-top">${icon(itemIcon(item))}<div><button class="item-name" data-action="item" data-value="${item.id}">${esc(item.nameKo)}</button><span class="rarity">${rarity[item.rarity]} · ${lifetime(item)}</span></div>${button(`${offer.price} 코인${offer.canBuy ? '<small>구매</small>' : `<small>${reasons[offer.blockedReason] ?? '구매 불가'}</small>`}`, 'buy', {disabled:blocked() || !offer.canBuy,className:'buy-button',value:offer.slotId})}</div><p>${esc(item.summary)}</p></article>`;
  }).join('')}</div></div>`).join('');
}
function renderShop() {
  const shop = run?.shop, settlement = lastEvent?.settlement;
  return `<section class="shop"><div class="section-title"><h2>상점</h2>${shop ? `<small>${run.coins}코인</small>` : ''}</div>${settlement ? `<details class="settlement"><summary>정산 +${settlement.reward}코인</summary><dl><div><dt>기본</dt><dd>+${settlement.baseReward + settlement.itemBaseBonus}</dd></div><div><dt>남은 Hand</dt><dd>+${settlement.handBonus}</dd></div><div><dt>이자</dt><dd>+${settlement.interest}</dd></div>${settlement.bonusCoins ? `<div><dt>추가 보상</dt><dd>+${settlement.bonusCoins}</dd></div>` : ''}</dl></details>` : ''}${shop ? `${renderOffers(shop)}${button(`↻ 새로고침 <span>${shop.rerollPrice === 0 ? '무료' : `${shop.rerollPrice ?? '—'} 코인`}</span>`, 'reroll', { disabled: blocked() || !shop.canReroll, className: 'reroll-button' })}` : `<p class="empty-label">${ended() ? '종료' : '라운드 클리어 후 열림'}</p>`}</section>`;
}
function renderCatalog() {
  return `<section class="page-intro"><h1>아이템 <small>${catalog.items.length}</small></h1></section><div class="catalog-grid">${catalog.items.map((item) => `<article class="shop-card ${item.rarity}"><div class="item-top">${icon(itemIcon(item))}<span class="rarity">${rarity[item.rarity]} · ${lifetime(item)}</span></div><button class="item-name" data-action="item" data-value="${item.id}">${esc(item.nameKo)}</button><p>${esc(item.summary)}</p><div class="catalog-bottom"><span>${item.price} 코인</span><span>${stackLabel(item)}</span></div></article>`).join('')}</div>`;
}
function renderRanks() {
  return `<section class="page-intro"><h1>랭킹</h1>${button('새로고침','ranking',{disabled:busy})}</section><section class="rank-panel"><div class="rank-head"><span>순위 / 플레이어</span><span>완료 라운드</span><span>누적 점수</span></div>${ranks.length ? ranks.map(entry=>`<button class="rank-row ${entry.playerId===playerId ? 'my-rank' : ''}" data-action="rank-detail" data-value="${esc(entry.runId)}" aria-label="${entry.rank}위 · ${entry.completedRounds}라운드 완료 · 빌드 보기"><div><b>${String(entry.rank).padStart(2,'0')}</b><span>${entry.playerId===playerId ? '내 기록' : `PLAYER ${entry.playerId.slice(0,6).toUpperCase()}`}<small>${esc(new Date(entry.endedAt).toLocaleString('ko-KR'))} · ${esc(entry.rulesVersion)}</small></span></div><strong>${entry.completedRounds}</strong><span class="rank-score" title="${exactScore(entry.runTotalScore)}">${compactScore(entry.runTotalScore)}<small>빌드 보기 ↗</small></span></button>`).join('') : '<p class="empty-label rank-empty">기록 없음</p>'}</section>`;
}
let rankRequest = 0;
function details(content, wide = false) { rankRequest += 1; $('#details').classList.toggle('rank-details',wide); $('#detail-content').innerHTML=content; if(!$('#details').open) $('#details').showModal(); }
async function showRank(id) {
  details('<h2>기록 상세</h2><p role="status">불러오는 중…</p>',true);
  const request=rankRequest;
  try {
    const {snapshot:s,playerId:owner}=await client.get(`/leaderboard/${encodeURIComponent(id)}`);
    if(request!==rankRequest || !$('#details').open) return;
    const groups=[['permanent','영구',s.permanentSlots],['limited','제한',s.limitedSlots],...(s.hasUpgradeGroup ? [['upgrade','강화',null]] : [])];
    const score=value=>`<span title="${exactScore(value)}">${compactScore(value)}</span>`;
    details(`<h2>${owner===playerId ? '내 기록' : `PLAYER ${esc(owner.slice(0,6).toUpperCase())}`}</h2><p class="rank-subtitle">R${s.roundIndex} · ${s.mode==='endless' ? 'ENDLESS · ' : ''}${s.outcome==='RUN_WON' ? '클리어' : '종료'} · ${esc(s.rulesVersion)}</p><div class="rank-summary"><div><small>완료 라운드</small><strong>${s.completedRounds}</strong></div><div><small>누적 점수</small><strong>${score(s.runTotalScore)}</strong></div><div><small>라운드 점수 / 목표</small><strong>${score(s.roundScore)} / ${score(s.targetScore)}</strong></div></div><p class="muted">마지막 스핀 기준 · 소모된 아이템 포함</p><div class="rank-build-layout"><section><h3>슬롯 스탯</h3><table class="symbol-table"><caption>기본 → 적용</caption><thead><tr><th>심벌</th><th>1칸 점수</th><th>3개 배당</th><th>추첨 확률</th></tr></thead><tbody>${s.build.symbols.map(row=>`<tr><th scope="row">${icon(row.id)}<span class="sr-only">${esc(catalog.symbols.find(symbol=>symbol.id===row.id)?.name ?? row.id)}</span></th><td title="${exactScore(row.point)}">${statChange(row.basePoint,row.point)}</td><td title="${exactScore(row.linePayout)}">${statChange(row.baseLinePayout,row.linePayout)}</td><td title="가중치 ${row.weight} / ${s.build.totalWeight}">${statChange(row.baseProbability,row.probability,true)}<small class="rank-weight">가중치 ${row.weight}</small></td></tr>`).join('')}</tbody></table><dl><div><dt>라운드 Hand</dt><dd>${s.build.hands}</dd></div><div><dt>연속 당첨</dt><dd>${s.consecutiveWinHands}</dd></div></dl>${s.build.milestoneReward ? `<div class="rank-blessing"><strong>${esc(s.build.milestoneReward.name)}</strong><p>${esc(s.build.milestoneReward.summary)}</p></div>` : ''}${groups.map(([group,label,limit])=>{
      const items=s.items.filter(i=>i.group===group), count=group==='limited' ? items.reduce((sum,i)=>sum+i.stacks,0) : items.length;
      return `<div class="rank-item-group"><h3>${label}<small>${limit===null ? `${count}종 · 무제한` : `${count}/${limit}`}</small></h3>${items.length ? items.map(i=>`<details class="rank-item"><summary><span>${esc(i.name)}${i.stacks>1 ? ` ×${i.stacks}` : ''}</span><small>${i.instances.some(x=>x.consumed) ? '마지막 스핀 소모' : i.instances.some(x=>x.triggered) ? '발동' : ''}</small></summary><p>${esc(i.description)}</p>${i.instances.map(x=>`<small>${x.remainingCharges!==undefined ? `발동 ${x.remainingCharges}회 남음` : x.remainingSpins!==undefined ? `${x.remainingSpins} Hand 남음` : x.active ? '적용 중' : '활성 전'}${x.consumed ? ' → 소모' : ''}</small>`).join('')}</details>`).join('') : '<p class="empty-label">없음</p>'}</div>`;
    }).join('')}</section><section class="rank-last-spin"><h3>마지막 스핀</h3><div class="mini-grid" role="img" aria-label="${esc(s.lastSpin.board.map(id=>catalog.symbols.find(symbol=>symbol.id===id)?.name ?? id).join(', '))}">${s.lastSpin.board.map((symbol,i)=>`<div>${icon(symbol)}${s.lastSpin.wildMarks.includes(i) ? '<span class="wild-label">WILD</span>' : ''}</div>`).join('')}</div><dl><div><dt>심벌 점수</dt><dd>${score(s.lastSpin.baseScore)}</dd></div><div><dt>라인 배당 · ${s.lastSpin.winningLines}라인</dt><dd>${score(s.lastSpin.lineScore)}</dd></div><div><dt>패턴 / 가상 배당</dt><dd>${score(s.lastSpin.patternScore)} / ${score(s.lastSpin.virtualScore)}</dd></div><div><dt>적용 배수</dt><dd>${esc(s.lastSpin.multiplier)}</dd></div><div><dt>스핀 점수</dt><dd>${score(s.lastSpin.spinScore)}</dd></div></dl></section></div>`,true);
  } catch { if(request===rankRequest && $('#details').open) details('<h2>기록 상세</h2><p>기록을 불러오지 못했어요. 랭킹을 새로고침해 주세요.</p>'); }
}
function showItem(id, owned = false) {
  const item = itemOf(id); if (!item) return;
  const instances = owned ? run.items.filter((instance) => instance.itemId === id) : [];
  details(`<div class="detail-icon ${item.rarity}">${icon(itemIcon(item))}</div><h2>${esc(item.nameKo)}</h2><p>${esc(item.description)}</p><p class="muted">${rarity[item.rarity]} · ${stackLabel(item)} · ${lifetime(item)}${item.minShopRound ? ` · R${item.minShopRound} 상점부터` : ''}</p>${instances.map((instance) => `<div class="owned-instance"><span>${lifetime(item, instance)}${instanceStatus(item, instance) ? ` · ${instanceStatus(item, instance)}` : ''}</span>${run.phase === 'SHOP' ? button('폐기', 'discard', { value: instance.instanceId, disabled: blocked(), className: 'danger-button' }) : ''}</div>`).join('')}`);
}
function showSymbol(id) {
  const row = selectedBuild().symbols.find((symbol) => symbol.id === id);
  details(`<h2>${icon(id)} ${esc(catalog.symbols.find((symbol) => symbol.id === id).name)}</h2><dl><div><dt>1칸 점수</dt><dd>${exactScore(row.basePoint)} → ${exactScore(row.point)}</dd></div><div><dt>3개 배당</dt><dd>${exactScore(row.baseLinePayout)} → ${exactScore(row.linePayout)}</dd></div><div><dt>추첨 확률</dt><dd>${row.baseProbability} → ${row.probability}</dd></div></dl><p>가중치 ${row.weight} / 전체 ${selectedBuild().totalWeight}. 보드 조작 전 추첨 기준.</p>${run?.milestoneReward ? `<p class="muted">카드: ${esc(run.milestoneReward.summary)}</p>` : ''}${row.sources.length ? `<ul class="source-list">${row.sources.map((source) => `<li>${esc(itemOf(source.itemId).nameKo)} ×${source.stacks}</li>`).join('')}</ul>` : ''}`);
}
function renderBoard() {
  const board = motion?.board ?? shownBoard ?? lastSpin?.board;
  const rolling = ['rolling', 'stopping'].includes(motion?.stage);
  const raw = rolling || motion?.stage === 'raw';
  const removed = run?.milestoneReward?.removedSymbol;
  const preview = ['cherry', 'bell', 'lemon', 'diamond', 'seven', 'cherry', 'lemon', 'diamond', 'bell']
    .map((id) => id === removed ? catalog.symbols.find((symbol) => symbol.id !== removed).id : id);
  const spotlight = motion?.stage === 'award';
  const awards = board && !shownBoard && !raw && motion?.stage !== 'reveal'
    ? spotlight ? [motion.award] : presentation?.awards ?? [] : [];
  const cells = new Set(awards.flatMap((award) => award.indices));
  const outlines = awards.map((award) => {
    if (['corners', 'crossing'].includes(award.kind)) return award.indices.map((i) => `<circle class="pattern-point" data-award-id="${esc(award.id)}" cx="${(i % 3) * 100 + 50}" cy="${Math.floor(i / 3) * 100 + 50}" r="38"/>`).join('');
    const points = award.indices.map((i) => `${(i % 3) * 100 + 50},${Math.floor(i / 3) * 100 + 50}`).join(' ');
    const tag = award.kind === 'square' ? 'polygon' : 'polyline';
    return `<${tag} class="${award.kind === 'square' ? 'square-outline' : ''}" data-award-id="${esc(award.id)}" points="${points}"/>`;
  }).join('');
  const wild = lastSpin && !shownBoard && !raw ? lastSpin.wildMarks ? lastSpin.wildMarks : lastSpin.milestoneWild || lastSpin.activeEffects.some((effect) => effect.kind === 'wild_center') ? [4] : [] : [];
  const changed = lastSpin && !shownBoard && !raw ? lastSpin.board.map((id, i) => id !== lastSpin.rawBoard[i] ? i : -1) : [];
  return `<div class="reel-frame ${spotlight ? `spotlight ${motion.award.kind}` : ''} ${rolling ? motion.stage : ''} ${!board ? 'preview' : ''}"><div class="reel-grid" role="img" aria-label="${board ? board.map((id) => catalog.symbols.find((s) => s.id === id)?.name).join(', ') : '첫 스핀을 기다리는 예시 슬롯'}">${(board ?? preview).map((id, i) => `<div class="reel-cell ${cells.has(i) ? 'winning' : ''} ${changed.includes(i) ? 'changed' : ''}">${icon(id)}${wild.includes(i) ? '<span class="wild-label">WILD</span>' : ''}${changed.includes(i) ? '<span class="change-dot" title="아이템으로 바뀐 칸"></span>' : ''}</div>`).join('')}</div>${rolling && !preferences.reduced ? `<div class="reel-motion" aria-hidden="true">${[0, 1, 2].map((col) => `<div class="reel-column"><div class="reel-strip">${[0, 1, 2, 0, 1, 2].map((row) => `<div class="reel-cell">${icon(preview[row * 3 + col])}</div>`).join('')}</div></div>`).join('')}</div>` : ''}<svg class="paylines" viewBox="0 0 300 300" aria-hidden="true">${outlines}</svg>${!board ? '<span class="preview-label">첫 스핀 전</span>' : ''}</div>`;
}
async function loadRun(id) {
  const [snapshot, pinned] = await Promise.all([client.get(`/runs/${id}`), client.get(`/runs/${id}/catalog`)]);
  catalog = pinned; run = snapshot.state; upgrades = snapshot.upgrades; upgradeMode = null; lastEvent = snapshot.lastEvent; presentation = snapshot.presentation;
  lastSpin = snapshot.lastEvent?.type === 'ROUND_STARTED' ? null : snapshot.lastSpin;
  sessionStorage.setItem(`nine.run.${playerId}`, id);
  await collectLegacyRun();
}
// Saved v0.6 runs retain their replay policy; finish their pending claim without a UI button.
async function collectLegacyRun() {
  if (!run?.canClaim || client.pending()) return;
  const result = await client.mutate(`/runs/${run.runId}/claim`, { expectedRevision: run.revision });
  run = result.state; upgrades = result.upgrades; lastEvent = result.event; upgradeMode = null;
}
async function init() {
  busy = true;
  try {
    const bootstrap = await client.get('/bootstrap');
    if (bootstrap.localPlay && !client.token) await client.request('/local-session', {});
    if (bootstrap.guestPlay && !client.token) await client.request('/guest-session', {});
    const me = await client.get('/me');
    if (playerId !== me.playerId) { run = null; upgrades = null; lastSpin = null; lastEvent = null; recent = []; }
    playerId = me.playerId; client.setOwner(playerId);
    catalog = await client.get('/catalog');
    if (client.pending()) {
      try {
        const result = await client.retry();
        if (result.state) sessionStorage.setItem(`nine.run.${playerId}`, result.state.runId);
      } catch (error) { if (client.pending() || error.status !== 409) throw error; }
    }
    recent = (await client.get('/runs')).runs;
    const saved = sessionStorage.getItem(`nine.run.${playerId}`);
    const id = saved ?? recent.find((r) => !['RUN_FAILED', 'RUN_WON'].includes(r.phase))?.runId ?? recent[0]?.runId;
    if (id) {
      try { await loadRun(id); } catch (error) { if (error.code !== 'RUN_NOT_FOUND') throw error; sessionStorage.removeItem(`nine.run.${playerId}`); run = null; upgrades = null; }
    }
    $('#login').close(); $('#connection').textContent = bootstrap.localPlay ? '● 로컬 플레이' : bootstrap.guestPlay ? '● 게스트 플레이' : '● 연결됨'; notice();
  } catch (error) {
    notice(errors[error.code] ?? '연결을 확인해주세요.', true);
    if (error.status === 401) { $('#login-error').textContent = client.token ? '플레이 키를 확인해주세요.' : ''; if (!$('#login').open) $('#login').showModal(); }
    else if (!catalog) $('#main').innerHTML = `<div class="boot"><h1>연결 실패</h1><p>서버 실행 상태를 확인하세요.</p>${button('다시 연결', 'connect', { className: 'primary' })}</div>`;
  } finally { busy = false; render(); }
}
function playSound() {
  if (!preferences.sound) return;
  try { audioContext ??= new AudioContext(); void audioContext.resume(); } catch {}
}
function beep(won) {
  if (!preferences.sound || !audioContext) return;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = won ? 660 : 330;
  gain.gain.setValueAtTime(0.04, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.18);
  oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + 0.18);
}
function animateScore(from, to, duration) {
  const started = performance.now();
  return new Promise((resolve) => {
    const tick = (now) => {
      const ratio = duration ? Math.min(1, (now - started) / duration) : 1;
      const value = interpolateScore(from, to, Math.round((1 - (1 - ratio) ** 3) * 1000));
      motion.score = value;
      const score = $('#round-score .score-number'), gauge = $('#goal-fill'), track = $('.goal-track');
      if (score) { score.textContent = compactScore(value); score.dataset.value = value; score.title = exactScore(value); score.setAttribute('aria-label', `${exactScore(value)}점, 전체 숫자 보기`); }
      if (gauge) gauge.style.width = `${progress(value, run.targetScore)}%`;
      track?.setAttribute('aria-valuenow', String(progress(value, run.targetScore)));
      if (ratio < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
}
async function action(suffix, extra = {}, isNew = false) {
  if (blocked()) return;
  const previousPhase = run?.phase, previousSpin = lastSpin, previousPresentation = presentation;
  const choiceSlots = run?.cardChoice?.slots;
  let committed = null, applied = false;
  const spinning = suffix === 'spins';
  busy = true;
  if (spinning) motion = { stage: 'rolling', score: run.roundScore, hands: run.handsRemaining, board: lastSpin?.board };
  notice(); playSound(); render();
  try {
    const [result] = await Promise.all([
      client.mutate(isNew ? '/runs' : `/runs/${run.runId}/${suffix}`, isNew ? {} : { expectedRevision: run.revision, ...extra }),
      spinning ? delay(preferences.reduced ? 0 : preferences.fast ? 220 : 500) : Promise.resolve(),
    ]);
    committed = result;
    if (result.event?.type === 'SPIN_RESOLVED') {
      lastSpin = result.event; presentation = result.presentation;
      motion.hands = result.state.handsRemaining;
      await presentSpin({ event: lastSpin, presentation, fast: preferences.fast, reduced: preferences.reduced,
        show(stage, data) {
          Object.assign(motion, { stage, effects: [], award: null }, data); render();
          if (stage === 'effects') { beep(true); notice(data.effects.map((effect) => `${effect.name} ${effect.label}`).join(' · '), false, true); }
          if (stage === 'clear') notice(`라운드 ${run.roundIndex} 클리어 · +${data.reward}코인`, false, true);
          if (stage === 'emergency') notice(data.roundCleared ? '비상 레버 사용 · 라운드 통과' : `비상 레버 · Hand +${data.handsGranted}`, false, true);
        },
        fill: (duration) => animateScore(run.roundScore, result.state.roundScore, duration),
      });
      beep(lastSpin.winningLines.length > 0 || lastSpin.winningPatterns?.length > 0);
      if (!lastSpin.settlement) notice(`${awardSummary(lastSpin)} · +${exactScore(lastSpin.spinScore)}점`, false, true);
    }
    run = result.state; upgrades = result.upgrades; upgradeMode = null; lastEvent = result.event ?? null;
    applied = true;
    sessionStorage.setItem(`nine.run.${playerId}`, run.runId);
    motion = null;
    if (isNew) { catalog = await client.get(`/runs/${run.runId}/catalog`); lastSpin = null; presentation = null; }
    if (result.event?.type === 'ROUND_STARTED') { lastSpin = null; presentation = null; }
    if (lastEvent?.type === 'CARD_SELECTED') {
      cardReveal = { ...lastEvent, slots:choiceSlots }; render();
      notice(`${lastEvent.reward.name} · ${lastEvent.reward.summary}`, false, true);
      await delay(preferences.fast ? 1000 : 1800); cardReveal = null;
    }
    if (lastEvent?.type === 'ITEM_PURCHASED') notice(`${itemOf(lastEvent.itemId)?.nameKo} 구매 · ${lastEvent.refundCoins ? `+${lastEvent.refundCoins}코인 환급` : itemOf(lastEvent.itemId)?.effect.kind === 'shop_item_cost_subtract' ? '즉시 적용' : '다음 라운드 반영'}`, false, !lastEvent.refundCoins);
    await collectLegacyRun();
    if (spinning && !result.event.settlement && lastEvent?.type === 'ROUND_CLAIMED') {
      motion = { stage: 'clear', score: run.roundScore, hands: run.handsRemaining, reward: lastEvent.settlement.reward, board: lastSpin.board };
      render(); await delay(preferences.fast ? 650 : 1050); motion = null;
    }
    if (ended()) ranks = (await client.get('/leaderboard')).entries;
  } catch (error) {
    if (committed && !applied) {
      run = committed.state; upgrades = committed.upgrades; lastEvent = committed.event ?? null;
      if (spinning) { lastSpin = committed.event; presentation = committed.presentation; }
    } else if (!committed && motion) { lastSpin = previousSpin; presentation = previousPresentation; }
    notice(errors[error.code] ?? reasons[error.code] ?? '선택을 처리하지 못했어요. 상태를 확인하고 다시 시도해주세요.', true);
    if (error.status === 401 && !$('#login').open) $('#login').showModal();
    if (error.status === 409 && !client.pending() && run) { try { await loadRun(run.runId); } catch {} }
  } finally {
    busy = false; shownBoard = null; motion = null; cardReveal = null; render();
    if (run?.phase !== previousPhase && !document.querySelector('dialog[open]')) $('#scene')?.focus({ preventScroll: true });
  }
}

async function retry() {
  if (busy) return;
  busy = true; render();
  try { const result = await client.retry(); await loadRun(result.state.runId); notice('결과 확인 완료'); }
  catch (error) {
    notice(errors[error.code] ?? '결과를 확인하지 못했어요. 잠시 뒤 다시 시도해주세요.', true);
    if (error.status === 409 && !client.pending() && run) { try { await loadRun(run.runId); } catch {} }
    if (error.status === 401 && !$('#login').open) $('#login').showModal();
  }
  finally { busy = false; render(); }
}
async function changeTab(next) {
  if (busy) return;
  tab = next; render();
  if (tab === 'ranking') {
    try { ranks = (await client.get('/leaderboard')).entries; render(); } catch (error) { notice(errors[error.code] ?? '랭킹을 불러오지 못했어요.', true); }
  }
}
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button'); if (!target || target.disabled || busy) return;
  if (target.dataset.tab) { await changeTab(target.dataset.tab); return; }
  const { action: name, value } = target.dataset;
  if (name === 'score') details(`<h2>전체 점수</h2><p class="exact-score">${exactScore(value)}점</p>`);
  if (name === 'spin') await action('spins');
  if (name === 'start-endless') { $('#victory').close(); await action('endless/start'); }
  if (name === 'choose-card') await action('cards/choice', { slotId:value });
  if (name === 'continue') await action('shop/continue');
  if (name === 'buy') await action('shop/purchases', { slotId: value });
  if (name === 'reroll') await action('shop/rerolls');
  if (name === 'start') { $('#details').close(); await action('', {}, true); }
  if (name === 'new') {
    if (run && !ended()) details(`<h2>새 런 시작</h2><p>현재 런은 지난 런에 저장됩니다.</p>${button('시작', 'start', { className: 'primary', disabled: blocked() })}`);
    else await action('', {}, true);
  }
  if (name === 'item') showItem(value);
  if (name === 'owned') showItem(value, true);
  if (name === 'symbol') showSymbol(value);
  if (name === 'upgrade-mode') { upgradeMode = value; render(); }
  if (name === 'instance') { const instance = run?.items.find((i) => i.instanceId === value); if (instance) showItem(instance.itemId, true); }
  if (name === 'discard') details(`<h2>아이템 폐기</h2><p>1개 삭제 · 환불 없음</p>${button('폐기', 'confirm-discard', { value, className: 'danger-button', disabled: blocked() })}`);
  if (name === 'confirm-discard') { $('#details').close(); await action('shop/discards', { instanceId: value }); }
  if (name === 'settings') $('#settings').showModal();
  if (name === 'connect') await init();
  if (name === 'retry') await retry();
  if (name === 'ranking') await changeTab('ranking');
  if (name === 'rank-detail') await showRank(value);
  if (name === 'play') await changeTab('play');
  if (name === 'before-after' && lastSpin) details(`<h2>보드 전후</h2><div class="board-comparison">${[lastSpin.rawBoard, lastSpin.board].map((board, i) => `<div><h3>${i ? '아이템 적용 후' : '처음 추첨'}</h3><div class="mini-grid">${board.map((id) => icon(id)).join('')}</div></div>`).join('')}</div>`);
  if (name === 'history') {
    try {
      recent = (await client.get('/runs')).runs;
      details(`<h2>지난 런</h2><div class="history-list">${recent.map((r) => button(`<span>${['RUN_WON', 'RUN_FAILED'].includes(r.phase) ? '종료' : '진행 중'} · R${r.roundIndex}</span><strong>${compactScore(r.runTotalScore)}점</strong>`, 'resume', { value: r.runId })).join('')}</div>`);
    } catch { notice('지난 도전을 불러오지 못했어요.', true); }
  }
  if (name === 'resume' && !blocked()) { busy = true; $('#details').close(); try { await loadRun(value); tab = 'play'; notice(); } catch { notice('도전을 불러오지 못했어요.', true); } finally { busy = false; render(); } }
});
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); client.setToken($('#play-key').value.trim()); $('#play-key').value = ''; await init(); });
for (const name of ['sound', 'fast', 'reduced']) $(`#${name}`).addEventListener('change', (event) => {
  preferences[name] = event.target.checked; localStorage.setItem('nine.preferences', JSON.stringify(preferences));
  document.documentElement.classList.toggle('reduced', preferences.reduced); if (name === 'sound') playSound();
});
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !event.repeat && !event.target.closest('button,input,textarea,select,dialog') && !document.querySelector('dialog[open]') && tab === 'play' && run?.phase === 'ROUND_ACTIVE' && !blocked()) { event.preventDefault(); void action('spins'); }
});
void init();
