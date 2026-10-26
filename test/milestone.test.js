import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { v011Rules as rules, rawV011Rules as rawRules, seed, scriptedRandom, randomForBoard, noLineBoard } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { weightedSymbols, symbolScores, scoreWithItems } from '../src/domain/item-scoring.js';
import { spinWithItems } from '../src/domain/items.js';
import { scoringItems, chooseMilestone } from '../src/domain/milestone.js';
import { CounterRandom } from '../src/server/random.js';
import { GameSession, restoreSession } from '../src/server/session.js';
import { upgradeView } from '../src/server/upgrades.js';

function easyRules() {
  const raw = rawRules();
  raw.balance.round.roundTargets.forEach((t, i) => { t.targetScore = i < 3 ? '1' : '9999999999999999999999999999999999'; });
  return parseRules(raw);
}
function offered(config = easyRules(), initialItemIds = []) {
  const rng = new CounterRandom(seed);
  let state = createRun(config, { initialItemIds });
  for (let i = 1; i <= 3; i++) {
    state = applyAction(state, { type: 'SPIN' }, config, rng).state;
    if (i < 3) state = applyAction(state, { type: 'CONTINUE' }, config, rng).state;
  }
  return { state, config, rng };
}
function picked(id, initialItemIds = []) {
  const { state, config, rng } = offered(easyRules(), initialItemIds);
  const slotId = state.cardOffer.find((c) => c.cardId === id).slotId;
  return { ...applyAction(state, { type: 'CHOOSE_CARD', slotId }, config, rng), config, rng };
}

test('v0.11 raises every clear by one coin and reduces each target after R1', () => {
  const old = JSON.parse(readFileSync(new URL('./fixtures/rules-v010.json', import.meta.url), 'utf8'));
  assert.equal(rules.balance.economy.baseClearReward, old.balance.economy.baseClearReward + 1);
  assert.equal(rules.balance.economy.clearRewardPerRound, 1);
  assert.deepEqual(rules.targets.map(String), ['120','220','400','750','1400','2600','4800','9000','17000','32000']);
  const { state } = offered();
  assert.equal(state.coins, 31); // 3 + (3+4) + (4+4+2) + (5+4+2)
});

test('R3 offers one of each hidden card once, blocks shop/spins and pays only on clear', () => {
  const { state, config, rng } = offered();
  assert.equal(state.phase, 'CARD_CHOICE'); assert.equal(state.shop, null);
  assert.deepEqual(state.cardOffer.map((c) => c.cardId).sort(), ['evolve','prune','wild']);
  for (const action of [{ type: 'SPIN' }, { type: 'CONTINUE' }, { type: 'REROLL' }, { type: 'BUY', slotId: 'fake' }]) {
    assert.throws(() => applyAction(state, action, config, rng), { code: 'INVALID_RUN_PHASE' });
  }
  const selection = applyAction(state, { type: 'CHOOSE_CARD', slotId: state.cardOffer[0].slotId }, config, rng);
  assert.equal(selection.state.phase, 'SHOP'); assert.equal(selection.state.coins, state.coins);
  assert.equal(selection.state.cardOffer, null); assert.equal(selection.state.shop.slots.length, 4);
  assert.throws(() => applyAction(selection.state, { type: 'CHOOSE_CARD', slotId: state.cardOffer[0].slotId }, config, rng), { code: 'INVALID_RUN_PHASE' });
});

test('delete card draws using effective weights including pending tracker and item boosts', () => {
  const { state, config } = offered(easyRules(), ['cherry_farm', 'seven_tracker']);
  state.pendingNextHandWeightBuffs = [{ sourceInstanceId: state.items.find((i) => i.itemId === 'seven_tracker').instanceId, symbol: 'seven', amount: 4, targetHandSequence: state.handSequence + 1 }];
  const slotId = state.cardOffer.find((c) => c.cardId === 'prune').slotId;
  for (const [roll, expected] of [[0,'cherry'],[39,'cherry'],[40,'lemon'],[64,'lemon'],[65,'bell'],[84,'bell'],[85,'diamond'],[99,'diamond'],[100,'seven'],[113,'seven']]) {
    const random = { nextInt(bound) { assert.equal(bound, 114); return roll; } };
    const result = chooseMilestone(state, slotId, config, random);
    assert.equal(result.state.milestoneReward.removedSymbol, expected);
  }
});

test('deleted symbol stays excluded from base draws, rerolls, boosts and tracker reservations', () => {
  const { state, config } = offered(easyRules(), ['sevens_blessing','seven_tracker','broken_lever']);
  const slotId = state.cardOffer.find((c) => c.cardId === 'prune').slotId;
  const chosen = chooseMilestone(state, slotId, config, { nextInt: (bound) => bound - 1 }).state;
  const active = { ...chosen, phase: 'ROUND_ACTIVE', roundIndex: 4, roundWildAvailable: false };
  const weighted = weightedSymbols(config, active.items, [], 'seven');
  assert.equal(weighted.length, 4); assert.equal(weighted.reduce((s, x) => s+x.weight, 0), 90);
  const rng = new CounterRandom(seed);
  for (let i=0;i<200;i++) {
    const spin = spinWithItems(config, rng, active);
    assert.ok(!spin.rawBoard.includes('seven') && !spin.board.includes('seven'));
    assert.ok(!spin.pendingNextHandWeightBuffs.some((b) => b.symbol === 'seven'));
  }
  const view = upgradeView(active, config).current;
  assert.equal(view.symbols.find((s) => s.id === 'seven').probability, '0.00%');
  assert.equal(view.symbols.find((s) => s.id === 'cherry').probability, '33.33%');
});

test('evolve grants one matching payout upgrade per symbol, adds to owned items without slots', () => {
  const { state, config } = picked('evolve', ['golden_harvest']);
  assert.equal(state.items.length, 1);
  const scoring = scoringItems(state, config, state.items);
  const profiles = symbolScores(config, scoring);
  assert.deepEqual(profiles.map((p) => String(p.point)), ['5','6','9','15','30']);
  assert.deepEqual(profiles.map((p) => String(p.linePayout)), ['150','150','270','600','2625']);
  const next = upgradeView(state, config).next;
  assert.deepEqual(next.symbols.map((s) => s.linePayout), profiles.map((p) => String(p.linePayout)));
  const spin = spinWithItems(config, randomForBoard(Array(9).fill('cherry'), config), { ...state, roundIndex: 4 });
  assert.equal(spin.baseScore, 45n); assert.equal(spin.lineScore, 1200n);
});

test('evolve respects contract base zero, exact large integers and unchanged pattern payouts', () => {
  const raw = rawRules(); raw.balance.symbols[0].basePoint = '9007199254740993'; raw.balance.symbols[0].linePayout = '9007199254740995';
  const config = parseRules(raw);
  const state = createRun(config, { initialItemIds: ['devils_contract','square_seal'] });
  state.milestoneReward = { cardId: 'evolve' };
  const result = scoreWithItems(Array(9).fill('cherry'), config, scoringItems(state, config, state.items));
  assert.equal(result.baseScore, 0n); assert.equal(result.lineScore, 9007199254740995n*12n*8n);
  assert.equal(result.patternScore, 9007199254740995n*4n);
});

test('permanent joker applies on the first Hand and recharges only for the next round', () => {
  const { state, config, rng } = picked('wild');
  const round = applyAction(state, { type: 'CONTINUE' }, config, rng).state;
  assert.equal(round.roundWildAvailable, true);
  const board = ['cherry','lemon','bell','lemon','seven','lemon','bell','diamond','cherry'];
  const first = applyAction(round, { type: 'SPIN' }, config, randomForBoard(board, config));
  assert.equal(first.event.milestoneWild, true); assert.ok(first.event.wildMarks.includes(4));
  assert.equal(first.state.roundWildAvailable, false); assert.ok(first.event.winningLines.some((l) => l.lineId==='row_middle'));
  const second = applyAction(first.state, { type: 'SPIN' }, config, randomForBoard(board, config));
  assert.equal(second.event.milestoneWild, false); assert.ok(!second.event.wildMarks.includes(4));
  const next = applyAction({ ...second.state, phase:'SHOP', shop:state.shop }, { type:'CONTINUE' }, config, rng).state;
  assert.equal(next.roundIndex, 5); assert.equal(next.roundWildAvailable, true);
});

test('permanent joker overlaps central joker and excludes temporary wild center', () => {
  const state = createRun(rules, { initialItemIds: ['joker_mask','temporary_wild'] });
  state.milestoneReward = { cardId:'wild' }; state.roundWildAvailable = true;
  const spin = spinWithItems(rules, randomForBoard(noLineBoard, rules, [0,4]), state);
  assert.deepEqual(spin.wildMarks, [4,5]); assert.equal(spin.milestoneWild, true);
});

test('emergency Hand does not recharge the permanent central wild', () => {
  const { state, config, rng } = picked('wild', ['emergency_lever']);
  const round = applyAction(state, { type:'CONTINUE' }, config, rng).state;
  const first = applyAction({ ...round, handsRemaining:1 }, { type:'SPIN' }, config, randomForBoard(noLineBoard, config));
  assert.equal(first.event.milestoneWild, true);
  assert.equal(first.event.emergency.type, 'EMERGENCY_HAND_GRANTED');
  assert.equal(first.state.handsRemaining, 1);
  assert.equal(first.state.roundWildAvailable, false);
  const extra = applyAction(first.state, { type:'SPIN' }, config, randomForBoard(noLineBoard, config));
  assert.equal(extra.event.milestoneWild, false);
  assert.deepEqual(extra.event.wildMarks, []);
  assert.equal(extra.state.phase, 'RUN_FAILED');
});

test('calculated miracle changes its best edit to account for each permanent score reward', () => {
  const state = createRun(rules, { initialItemIds:['calculated_miracle'] });
  for (const vector of [
    { cardId:'evolve', board:['lemon','diamond','lemon','lemon','bell','cherry','lemon','cherry','bell'], before:'diag_main', after:'diag_anti', delta:147n },
    { cardId:'wild', board:['cherry','lemon','cherry','diamond','cherry','lemon','bell','lemon','lemon'], before:'col_middle', after:'col_right', delta:61n },
  ]) {
    const ordinary = spinWithItems(rules, randomForBoard(vector.board, rules, [0]), state);
    const rewarded = spinWithItems(rules, randomForBoard(vector.board, rules, [0]), {
      ...state, milestoneReward:{cardId:vector.cardId}, roundWildAvailable:vector.cardId === 'wild',
    });
    assert.equal(ordinary.triggeredItems[0].lineId, vector.before);
    assert.equal(rewarded.triggeredItems[0].lineId, vector.after);
    assert.equal(rewarded.triggeredItems[0].scoreDelta, vector.delta);
  }
});

test('public card state never reveals order, selection survives replay and duplicate requests', () => {
  const config = easyRules(), session = new GameSession(config, { userId:'u', seed });
  let state = session.getState('u'), i=0;
  const execute=(type, extra={}) => session.execute('u', {type,...extra,expectedRevision:state.revision,idempotencyKey:`cmd-${i++}`});
  for(let round=1;round<=3;round++) {
    state=execute('SPIN').state;
    if(round<3) state=execute('CONTINUE').state;
  }
  assert.equal(state.phase,'CARD_CHOICE'); assert.equal(state.cardChoice.slots.length,3);
  assert.ok(state.cardChoice.slots.every((s)=>Object.keys(s).join()==='slotId'));
  assert.ok(!JSON.stringify(state).includes('cardId'));
  const audit=session.exportAudit(); const restored=restoreSession(config,audit);
  assert.deepEqual(restored.getState('u'),state);
  const command={type:'CHOOSE_CARD',slotId:state.cardChoice.slots[0].slotId,expectedRevision:state.revision,idempotencyKey:'select'};
  const selected=restored.execute('u',command);
  assert.deepEqual(restored.execute('u',command),selected);
  assert.throws(()=>restored.execute('u',{...command,idempotencyKey:'other'}),{code:'STALE_REVISION'});
  assert.deepEqual(restoreSession(config,restored.exportAudit()).getState('u'),selected.state);
});

test('old v0.10 runs keep their original coins, phases and exact event shape', () => {
  const old = parseRules(JSON.parse(readFileSync(new URL('./fixtures/rules-v010.json', import.meta.url), 'utf8')));
  const session=new GameSession(old,{userId:'u',seed});
  const before=session.getState('u'); assert.ok(!('milestoneReward' in before));
  session.execute('u',{type:'SPIN',expectedRevision:0,idempotencyKey:'old'});
  assert.deepEqual(restoreSession(old,session.exportAudit()).getState('u'),session.getState('u'));
});

test('failed R3 and a final R3 never offer a card; invalid choices consume no draws', () => {
  const config=easyRules(), rng=new CounterRandom(seed);
  const failed=applyAction({...createRun(config),roundIndex:3,handsRemaining:1,targetScore:99999999n},{type:'SPIN'},config,randomForBoard(noLineBoard,config));
  assert.equal(failed.state.phase,'RUN_FAILED'); assert.equal(failed.state.cardOffer,null);
  const raw=rawRules();raw.balance.round.maxRoundMvp=3;raw.balance.round.roundTargets=raw.balance.round.roundTargets.slice(0,3);raw.balance.round.roundTargets.forEach((r)=>{r.targetScore='1';});
  assert.equal(offered(parseRules(raw)).state.phase,'RUN_WON');
  const {state}=offered(config);const before=rng.snapshot();
  assert.throws(()=>applyAction(state,{type:'CHOOSE_CARD',slotId:'bad'},config,rng),{code:'UNKNOWN_CARD_SLOT'});
  assert.deepEqual(rng.snapshot(),before);assert.equal(state.milestoneReward,null);
});

test('milestone policies and referenced upgrade definitions are strictly validated', () => {
  for(const mutate of [
    (r)=>{r.balance.round.milestoneCards.cards.pop();},
    (r)=>{r.balance.round.milestoneCards.cards[0].effect.redistribution='equal';},
    (r)=>{r.balance.round.milestoneCards.cards[1].effect.itemIds[0]='cherry_farm';},
    (r)=>{r.balance.round.milestoneCards.cards[2].effect.cellIndex=0;},
  ]) {const raw=rawRules();mutate(raw);assert.throws(()=>parseRules(raw));}
});
