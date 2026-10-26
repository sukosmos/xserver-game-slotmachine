import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rules, rawRules, randomForBoard, noLineBoard, cherryBoard, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { spinWithItems } from '../src/domain/items.js';
import { scoreWithItems } from '../src/domain/item-scoring.js';
import { createShop } from '../src/domain/shop.js';
import { GameSession, restoreSession } from '../src/server/session.js';
import { CounterRandom } from '../src/server/random.js';
import { chooseMilestone } from '../src/domain/milestone.js';
import { publicCatalog } from '../src/server/catalog.js';
import { spinPresentation } from '../src/server/presentation.js';

const candidates = ['cherry','cherry','diamond','bell','lemon','seven','diamond','bell','lemon'];
const build = (ids=[]) => ({...createRun(rules,{initialItemIds:ids}),targetScore:10n**40n});
function easyRules(){const raw=rawRules();raw.balance.round.roundTargets.forEach((r,i)=>{r.targetScore=i<3?'1':'99999999';});return parseRules(raw);}
function offer(){const config=easyRules(),rng=new CounterRandom(seed);let state=createRun(config);for(let i=1;i<=3;i++){state=applyAction(state,{type:'SPIN'},config,rng).state;if(i<3)state=applyAction(state,{type:'CONTINUE'},config,rng).state;}return {config,rng,state};}

test('v0.12 catalog, prices, lifetime, reward and R3 unlock follow JSON',()=>{
 assert.equal(rules.rulesVersion,'v0.12'); assert.equal(rules.balance.economy.baseClearReward,4);
 assert.equal(rules.itemsById.miracle_hand.slot,'permanent');assert.equal(rules.itemsById.miracle_hand.effect.triggerChanceBasisPoints,2000);
 assert.equal(rules.itemsById.temporary_wild,undefined);assert.equal(rules.itemsById.mirror_copier.price,5);assert.equal(rules.itemsById.crossroads_bonus.price,6);
 assert.equal(rules.itemsById.score_puffer.price,7);assert.equal(rules.itemsById.score_puffer.maxStacks,3);
 const rng=new CounterRandom(seed);for(let roundIndex=1;roundIndex<=3;roundIndex++)for(let n=0;n<100;n++){
 const shop=createShop({...build(),roundIndex},rules,rng).shop;
 if(roundIndex<3)assert.ok(!shop.slots.some(s=>s.itemId==='score_puffer'));
 }
 const cat=publicCatalog(rules);assert.ok(!cat.items.some(i=>i.id==='temporary_wild'));
 assert.match(cat.items.find(i=>i.id==='magnet_device').description,/남은 Hand/);
});

test('consumables use exact decreasing bounds and do not expire before triggering',()=>{
 let state=build(['magnet_device']);const bounds=[];
 for(let h=5;h>=1;h--){const boardRng=randomForBoard(candidates,rules,[0]);let draws=0;const rng={nextInt(bound){if(draws++<9)return boardRng.nextInt(bound);bounds.push(bound);return h===1?0:bound-1;}};
 const result=applyAction({...state,handsRemaining:h},{type:'SPIN'},rules,rng);if(h>1){assert.equal(result.event.triggeredItems.length,0);assert.equal(result.state.items[0].remainingCharges,1);}else{assert.equal(result.event.triggeredItems[0].itemId,'magnet_device');assert.equal(result.event.expiredItems.length,1);}state=result.state;
 }
 assert.deepEqual(bounds,[5,4,3,2,1,3]); // candidate selection is a separate uniform draw
});

test('charged item triggers once per round, resets next round and uses expanded Hand count',()=>{
 const original=build(['mirror_copier','extra_hand']);assert.equal(original.handsRemaining,6);
 const seen=[];const rng=randomForBoard(noLineBoard,rules,[0]);const spin=applyAction(original,{type:'SPIN'},rules,{nextInt(bound){seen.push(bound);return rng.nextInt(bound);}});
 assert.equal(seen.at(-1),6);assert.equal(spin.state.items[0].remainingCharges,1);assert.equal(spin.state.items[0].lastTriggeredRound,1);
 const second=spinWithItems(rules,randomForBoard(noLineBoard),spin.state);assert.equal(second.triggeredItems.length,0);assert.equal(second.itemsAfterSpin[0].remainingCharges,1);
 const next=spinWithItems(rules,randomForBoard(noLineBoard,rules,[0]),{...spin.state,roundIndex:2,handsRemaining:5});assert.equal(next.triggeredItems[0].itemId,'mirror_copier');assert.ok(next.expiredItems.some(i=>i.itemId==='mirror_copier'));
});

test('ineligible and unchanged edits preserve charges; successful priority blocks later modifiers',()=>{
 const inactive=spinWithItems(rules,randomForBoard(cherryBoard),{...build(['magnet_device']),handsRemaining:1});assert.equal(inactive.triggeredItems.length,0);assert.equal(inactive.itemsAfterSpin[0].remainingCharges,1);
 const noChange=spinWithItems(rules,randomForBoard(noLineBoard,rules,[0,55,0,75]),{...build(['broken_lever']),handsRemaining:1});assert.equal(noChange.triggeredItems.length,0);assert.equal(noChange.itemsAfterSpin[0].lastTriggeredRound,0);
 const priority=spinWithItems(rules,randomForBoard(candidates,rules,[0]),{...build(['calculated_miracle','mirror_copier']),handsRemaining:1});assert.deepEqual(priority.triggeredItems.map(i=>i.itemId),['calculated_miracle']);assert.equal(priority.itemsAfterSpin[0].itemId,'mirror_copier');assert.equal(priority.itemsAfterSpin[0].remainingCharges,2);
});

test('permanent miracle uses 20 percent each eligible Hand without charges or round lock',()=>{
 let state=build(['miracle_hand']);
 for(let h=5;h>=4;h--){const r=spinWithItems(rules,randomForBoard(candidates,rules,[1999,0]),{...state,handsRemaining:h});assert.equal(r.triggeredItems.length,1);assert.deepEqual(r.itemsAfterSpin,state.items);}
 assert.equal(spinWithItems(rules,randomForBoard(candidates,rules,[2000]),state).triggeredItems.length,0);
});

test('wild mask is a one-use consumable; card wild does not bypass its scheduled trigger',()=>{
 const state={...build(['joker_mask']),milestoneReward:{cardId:'wild'},roundWildAvailable:true};
 const miss=spinWithItems(rules,randomForBoard(noLineBoard,rules,[4]),state);assert.deepEqual(miss.wildMarks,[4]);assert.equal(miss.triggeredItems.length,0);assert.equal(miss.itemsAfterSpin[0].remainingCharges,1);
 const hit=spinWithItems(rules,randomForBoard(noLineBoard,rules,[0]),{...state,roundWildAvailable:false,handsRemaining:3});assert.deepEqual(hit.wildMarks,[4]);assert.equal(hit.expiredItems.length,1);
});

test('emergency lever rescues exact 70 percent but never changes the actual score',()=>{
 const base=scoreWithItems(noLineBoard,rules,[]).spinScore;
 for(const [total,phase,used] of [[699n,'RUN_FAILED',false],[700n,'SHOP',true],[999n,'SHOP',true],[1000n,'SHOP',false]]){
 const state={...build(['emergency_lever']),targetScore:1000n,roundScore:total-base,runTotalScore:total-base,handsRemaining:1};
 const rng=randomForBoard(noLineBoard,rules,Array(20).fill(0));const r=applyAction(state,{type:'SPIN'},rules,rng);
 assert.equal(r.state.phase,phase);assert.equal(r.state.roundScore,total);assert.equal(r.state.runTotalScore,total);assert.equal(Boolean(r.event.emergency),used);
 if(used){assert.equal(r.event.emergency.type,'EMERGENCY_ROUND_CLEARED');assert.equal(r.event.settlement.baseReward,4);assert.equal(spinPresentation(r.event,rules).emergency.label,'ROUND SAVED');}
 }
 const active=applyAction({...build(['emergency_lever']),handsRemaining:2},{type:'SPIN'},rules,randomForBoard(noLineBoard));assert.equal(active.event.emergency,null);
});

test('emergency clear preserves exact huge thresholds and reaches R3 cards/final victory',()=>{
 const target=9007199254740993000n,limit=target*7n/10n,base=scoreWithItems(noLineBoard,rules,[]).spinScore;
 for(const [roundIndex,phase] of [[3,'CARD_CHOICE'],[10,'RUN_WON']]){
 const r=applyAction({...build(['emergency_lever']),roundIndex,targetScore:target,roundScore:limit-base,handsRemaining:1},{type:'SPIN'},rules,randomForBoard(noLineBoard,rules,Array(20).fill(0)));
 assert.equal(r.state.phase,phase);assert.equal(r.state.completedRounds,roundIndex);assert.equal(r.state.roundScore,limit);
 }
});

test('puffer stacks multiplicatively with evolve and rounds total exactly once',()=>{
 const state={...build(['score_puffer','score_puffer','score_puffer']),milestoneReward:{cardId:'evolve'}};
 const r=spinWithItems(rules,randomForBoard(noLineBoard),state);assert.deepEqual(r.globalMultiplier,{num:135n,den:32n});
 assert.equal(r.spinScore,(r.baseScore+r.lineScore+r.patternScore+r.virtualScore)*135n/32n);
 const raw=rawRules();raw.balance.symbols[0].basePoint='9007199254740993';const config=parseRules(raw);
 const s={...createRun(config,{initialItemIds:['score_puffer']}),milestoneReward:{cardId:'evolve'}};
 const huge=spinWithItems(config,randomForBoard(cherryBoard,config),s);assert.equal(huge.spinScore,(huge.baseScore+huge.lineScore)*15n/8n);
});

test('permanent joker marks first and last actual Hand only, including single-Hand rounds',()=>{
 const state={...build(),milestoneReward:{cardId:'wild'}};
 for(const [hands,first,wild] of [[5,true,true],[4,false,false],[2,false,false],[1,false,true],[1,true,true]]){
 const r=spinWithItems(rules,randomForBoard(noLineBoard),{...state,handsRemaining:hands,roundWildAvailable:first});assert.equal(r.milestoneWild,wild);assert.deepEqual(r.wildMarks,wild?[4]:[]);
 }
});

test('four shuffled cards include windfall; cash is paid once on choice before shop creation',()=>{
 const {state,config}=offer();assert.equal(state.cardOffer.length,4);assert.deepEqual(state.cardOffer.map(c=>c.cardId).sort(),['evolve','prune','wild','windfall']);
 const result=chooseMilestone(state,state.cardOffer.find(c=>c.cardId==='windfall').slotId,config,new CounterRandom(seed));
 assert.equal(result.state.coins,state.coins+30);assert.equal(result.event.reward.coinsGranted,30);
 assert.throws(()=>chooseMilestone(result.state,'milestone-card-0',config,new CounterRandom(seed)),{code:'INVALID_RUN_PHASE'});
});

test('round lock and cash selection survive audit replay and idempotent retries',()=>{
 const config=easyRules(),session=new GameSession(config,{userId:'u',seed,initialItemIds:['mirror_copier']});let state=session.getState('u');let n=0;
 for(let r=1;r<=3;r++){const cmd={type:'SPIN',expectedRevision:state.revision,idempotencyKey:`s-${n++}`};const reply=session.execute('u',cmd);assert.deepEqual(session.execute('u',cmd),reply);state=reply.state;if(r<3)state=session.execute('u',{type:'CONTINUE',expectedRevision:state.revision,idempotencyKey:`c-${n++}`}).state;}
 const hidden=session.exportAudit();const recovered=restoreSession(config,hidden);assert.deepEqual(recovered.getState('u'),state);assert.equal(state.cardChoice.slots.length,4);assert.ok(!JSON.stringify(state.cardChoice).includes('cardId'));
 const command={type:'CHOOSE_CARD',slotId:state.cardChoice.slots[0].slotId,expectedRevision:state.revision,idempotencyKey:'pick'};
 const choice=recovered.execute('u',command);assert.deepEqual(recovered.execute('u',command),choice);assert.deepEqual(restoreSession(config,recovered.exportAudit()).getState('u'),choice.state);
});

test('v0.11 snapshots retain temporary wild, timed expiry, three cards and original payout',()=>{
 const old=parseRules(JSON.parse(readFileSync(new URL('./fixtures/rules-v011.json',import.meta.url),'utf8')));
 assert.ok(old.itemsById.temporary_wild);assert.equal(old.itemsById.miracle_hand.slot,'charged');assert.equal(old.balance.round.milestoneCards.cards.length,3);
 const session=new GameSession(old,{userId:'u',seed,initialItemIds:['joker_mask','temporary_wild']});session.execute('u',{type:'SPIN',expectedRevision:0,idempotencyKey:'old'});assert.deepEqual(restoreSession(old,session.exportAudit()).getState('u'),session.getState('u'));
});

test('payout stacks have no cap, weights allow five, and repeated IDs use one permanent slot',()=>{
 const many=build(Array(20).fill('golden_harvest'));
 assert.equal(many.items.length,20);assert.equal(rules.itemsById.golden_harvest.maxStacks,null);
 const score=scoreWithItems(cherryBoard,rules,many.items);assert.equal(score.baseScore,369n);assert.equal(score.lineScore,9840n);
 for(const id of ['cherry_farm','lemon_orchard','bell_foundry','gem_mine','sevens_blessing','seven_tracker']){
  assert.equal(build(Array(5).fill(id)).items.length,5);assert.throws(()=>build(Array(6).fill(id)),{code:'ITEM_CAP_REACHED'});
 }
 const raw=rawRules();delete raw.balance.round.milestoneCards;raw.catalog.items=raw.catalog.items.filter(i=>i.id==='golden_harvest');const config=parseRules(raw);
 const state={...createRun(config,{initialItemIds:Array(20).fill('golden_harvest')}),phase:'SHOP',coins:100};state.shop=createShop(state,config,new CounterRandom(seed)).shop;
 assert.equal(state.shop.slots[0].itemId,'golden_harvest');
 const bought=applyAction(state,{type:'BUY',slotId:state.shop.slots[0].slotId},config);assert.equal(bought.state.items.length,21);assert.equal(bought.state.coins,97);
});
