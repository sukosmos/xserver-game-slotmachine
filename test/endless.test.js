import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { rules, rawRules, noLineBoard, randomForBoard, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun, applyAction, canStartEndless } from '../src/domain/run.js';
import { GameSession, restoreSession } from '../src/server/session.js';
import { GameStore } from '../src/server/store.js';
import { CounterRandom } from '../src/server/random.js';

const oldRaw = () => JSON.parse(readFileSync(new URL('./fixtures/rules-v012.json', import.meta.url), 'utf8'));
const zeroRng = { nextInt: () => 0 };
function easyRules() {
  const raw = rawRules(); raw.balance.round.roundTargets.forEach(row => { row.targetScore = '1'; });
  return parseRules(raw);
}
function victory(config = rules, initialItemIds = ['score_puffer','mirror_copier','extra_hand']) {
  const state = { ...createRun(config, { initialItemIds }), roundIndex:10, targetScore:1n,
    milestoneReward:{cardId:'wild'}, pendingNextHandWeightBuffs:[] };
  return applyAction(state, {type:'SPIN'}, config, zeroRng);
}
function reachVictory(act, getState) {
  for(let round=1;round<=10;round++) {
    act('SPIN');
    if(getState().phase==='CARD_CHOICE') act('CHOOSE_CARD',{slotId:getState().cardChoice.slots[0].slotId});
    if(round<10) act('CONTINUE');
  }
}

test('v0.13 adds only Endless config; existing scores, items, targets and economy are unchanged', () => {
  const old=oldRaw(), current=rawRules();
  assert.equal(rules.rulesVersion,'v0.13');
  assert.deepEqual(current.balance.round.endless,{targetGrowth:{num:19,den:10},targetRounding:'ceil'});
  delete current.balance.round.endless;
  for(const part of Object.keys(current)) { delete current[part].version; delete old[part].version; }
  assert.deepEqual(current,old);
  for(const change of [r=>{r.targetGrowth.num=10;},r=>{r.targetGrowth.den=0;},r=>{r.targetRounding='floor';},r=>{r.scoreGrowth=20;}]){
    const raw=rawRules();change(raw.balance.round.endless);assert.throws(()=>parseRules(raw),{code:'INVALID_RULES'});
  }
});

test('R10 victory pays once and preserves the build until explicit Endless entry', () => {
  const won=victory();
  assert.equal(won.state.phase,'RUN_WON'); assert.equal(won.state.mode,'standard'); assert.equal(won.state.completedRounds,10);
  assert.ok(won.state.coins>3); assert.equal(won.state.items.length,3); assert.equal(won.state.shop,null);
  assert.ok(canStartEndless(won.state,rules));
  const before=structuredClone(won.state), started=applyAction(before,{type:'START_ENDLESS'},rules,zeroRng);
  assert.deepEqual(before,won.state); assert.equal(started.state.mode,'endless'); assert.equal(started.state.phase,'SHOP');
  assert.equal(started.event.type,'ENDLESS_STARTED'); assert.equal(started.event.settlement,undefined);
  for(const field of ['items','coins','milestoneReward','consecutiveWinHands','runTotalScore','roundScore','handsRemaining','pendingNextHandWeightBuffs']) assert.deepEqual(started.state[field],won.state[field]);
  assert.equal(started.state.shop.slots.length,4); assert.ok(!canStartEndless(started.state,rules));
  for(const action of ['SPIN','CONTINUE','CLAIM']) assert.throws(()=>applyAction(won.state,{type:action},rules,zeroRng),{code:'INVALID_RUN_PHASE'});
  assert.throws(()=>applyAction(started.state,{type:'START_ENDLESS'},rules,zeroRng),{code:'INVALID_RUN_PHASE'});
  assert.throws(()=>applyAction(createRun(rules),{type:'START_ENDLESS'},rules,zeroRng),{code:'INVALID_RUN_PHASE'});
});

test('Endless targets grow exactly; R11+ retain Hands, card wild, shops and clear rewards', () => {
  const won=victory();won.state.targetScore=32000n;
  let state=applyAction(won.state,{type:'START_ENDLESS'},rules,zeroRng).state;
  state=applyAction(state,{type:'CONTINUE'},rules).state;
  assert.equal(state.roundIndex,11);assert.equal(state.targetScore,60800n);assert.equal(state.roundScore,0n);
  assert.equal(state.handsRemaining,6);assert.equal(state.roundWildAvailable,true);
  const spin=applyAction(state,{type:'SPIN'},rules,zeroRng);
  assert.equal(spin.event.milestoneWild,true);assert.deepEqual(spin.event.globalMultiplier,{num:3n,den:2n});
  assert.equal(spin.event.spinScore,(spin.event.baseScore+spin.event.lineScore)*3n/2n);
  assert.equal(spin.state.roundWildAvailable,false);
  state=applyAction({...spin.state,roundScore:state.targetScore},{type:'SPIN'},rules,zeroRng).state;
  assert.equal(state.phase,'SHOP');assert.equal(state.completedRounds,11);
  state=applyAction(state,{type:'CONTINUE'},rules).state;
  assert.equal(state.targetScore,115520n);assert.equal(state.roundIndex,12);assert.equal(state.roundWildAvailable,true);
  let target=9007199254740993123456789n;
  state={...state,phase:'SHOP',roundIndex:40,targetScore:target};
  for(let i=0;i<40;i++){
    state=applyAction(state,{type:'CONTINUE'},rules).state;target=(target*19n+9n)/10n;
    assert.equal(state.targetScore,target);
    state=applyAction({...state,roundScore:target},{type:'SPIN'},rules,zeroRng).state;
    assert.equal(state.phase,'SHOP');
  }
  assert.throws(()=>applyAction({...state,roundIndex:Number.MAX_SAFE_INTEGER},{type:'CONTINUE'},rules),{code:'ROUND_EXHAUSTED'});
});

test('Endless failure and emergency rescue obey existing rules after round ten', () => {
  const initial=createRun(rules,{initialItemIds:['emergency_lever']});
  const base={...initial,mode:'endless',roundIndex:11,completedRounds:10,handsRemaining:1,targetScore:1000n};
  const score=32n;
  const rescued=applyAction({...base,roundScore:700n-score},{type:'SPIN'},rules,randomForBoard(noLineBoard,rules,Array(20).fill(0)));
  assert.equal(rescued.state.phase,'SHOP');assert.equal(rescued.event.emergency.type,'EMERGENCY_ROUND_CLEARED');
  assert.equal(rescued.event.settlement.baseReward,14);assert.equal(rescued.state.items.length,0);
  const failed=applyAction({...base,roundScore:699n-score},{type:'SPIN'},rules,randomForBoard(noLineBoard));
  assert.equal(failed.state.phase,'RUN_FAILED');assert.equal(failed.state.completedRounds,10);assert.equal(failed.state.coins,0);
  assert.deepEqual(failed.state.items,[]);assert.ok(!canStartEndless(failed.state,rules));
});

test('Endless public state, idempotency and full audit replay preserve the opt-in transition', () => {
  const config=easyRules(), session=new GameSession(config,{userId:'u',seed,initialItemIds:['extra_hand']});
  let state=session.getState('u');
  const act=(type,extra={})=>{const r=session.execute('u',{type,expectedRevision:state.revision,idempotencyKey:`act-${state.revision}`,...extra});state=r.state;return r;};
  reachVictory(act,()=>state);assert.equal(state.canStartEndless,true);
  const before=restoreSession(config,session.exportAudit());assert.deepEqual(before.getState('u'),state);
  const command={type:'START_ENDLESS',expectedRevision:state.revision,idempotencyKey:'endless'};
  const started=session.execute('u',command);assert.deepEqual(session.execute('u',command),started);
  assert.throws(()=>session.execute('u',{...command,idempotencyKey:'race'}),{code:'STALE_REVISION'});
  assert.throws(()=>session.execute('other',command),{code:'NOT_OWNER'});
  state=started.state;act('CONTINUE');act('SPIN');
  assert.deepEqual(restoreSession(config,session.exportAudit()).getState('u'),state);
  assert.deepEqual(session.execute('u',command),started);
  assert.equal(session.getState('u').roundIndex,11);
});

test('v0.12 victories still end, clear assets and replay without new mode fields', () => {
  const raw=oldRaw();raw.balance.round.roundTargets.forEach(r=>{r.targetScore='1';});const config=parseRules(raw);
  const session=new GameSession(config,{userId:'u',seed});let state=session.getState('u');
  const act=(type,extra={})=>{state=session.execute('u',{type,expectedRevision:state.revision,idempotencyKey:`old-${state.revision}`,...extra}).state;};
  reachVictory(act,()=>state);assert.equal(state.phase,'RUN_WON');assert.equal(state.coins,0);assert.deepEqual(state.items,[]);
  assert.equal(state.mode,undefined);assert.equal(state.canStartEndless,undefined);
  assert.throws(()=>act('START_ENDLESS'),{code:'INVALID_RUN_PHASE'});
  assert.deepEqual(restoreSession(config,session.exportAudit()).getState('u'),state);
});

test('disk restart keeps victory, Endless shop and progress; ranking updates only once on failure', t => {
  const dir=mkdtempSync(join(tmpdir(),'nine-endless-')),config=easyRules();
  const options={filename:join(dir,'game.sqlite'),key:randomBytes(32),rules:config};
  const connections=[];const open=()=>{const store=new GameStore(options);connections.push(store);return store;};
  t.after(()=>{connections.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});
  let store=open(),result=store.createRun('u','new'),state=result.state,id=state.runId;
  const act=(type,extra={})=>{result=store.execute('u',id,{type,expectedRevision:state.revision,idempotencyKey:`store-${state.revision}`,...extra});state=result.state;return result;};
  reachVictory(act,()=>state);const victoryView=store.getRun('u',id),rank10=store.leaderboard();
  assert.equal(rank10.entries[0].completedRounds,10);assert.ok(victoryView.endedAt!==null);
  store.close();store=open();assert.deepEqual(store.getRun('u',id),victoryView);
  const command={type:'START_ENDLESS',expectedRevision:state.revision,idempotencyKey:'start-endless'};
  result=store.execute('u',id,command);state=result.state;const second=open();
  assert.deepEqual(second.execute('u',id,command),result);assert.throws(()=>second.execute('u',id,{...command,idempotencyKey:'race'}),{code:'STALE_REVISION'});
  assert.equal(store.getRun('u',id).endedAt,null);assert.deepEqual(store.leaderboard(),rank10);
  store.close();store=open();assert.deepEqual(store.getRun('u',id).state,state);
  act('CONTINUE');const round11=store.getRun('u',id);store.close();store=open();assert.deepEqual(store.getRun('u',id),round11);
  for(let guard=0;state.phase!=='RUN_FAILED'&&guard<300;guard++) act(state.phase==='SHOP'?'CONTINUE':'SPIN');
  assert.equal(state.phase,'RUN_FAILED');assert.ok(state.completedRounds>10);
  assert.equal(store.leaderboard().entries[0].completedRounds,state.completedRounds);
  const terminal=store.getRun('u',id);store.close();store=open();assert.deepEqual(store.getRun('u',id),terminal);
  const beforeRetry=store.leaderboard();second.execute('u',id,command);assert.deepEqual(store.leaderboard(),beforeRetry);
});
