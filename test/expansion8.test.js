import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rules, rawRules, rawLegacyRockRules, randomForBoard, noLineBoard, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createInventory, acquireItem, discardItem, inventoryUsage, inventoryLimits } from '../src/domain/inventory.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { scoreWithItems } from '../src/domain/item-scoring.js';
import { spinWithItems, candidateLines } from '../src/domain/items.js';
import { buyItem, createShop, getShopView } from '../src/domain/shop.js';
import { calculateClearReward } from '../src/domain/economy.js';
import { procChance } from '../src/domain/expansion8.js';
import { GameSession, restoreSession } from '../src/server/session.js';
import { CounterRandom } from '../src/server/random.js';
import { milestoneRewards, removedSymbol } from '../src/domain/milestone.js';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const inventory = (...ids) => ids.reduce((s,id)=>acquireItem(s,id,rules,{activeFromRound:1}),createInventory());
const shop = (id, ids=[], overrides={}) => ({...createRun(rules,{initialItemIds:ids}),phase:'SHOP',roundIndex:5,coins:100,shop:{slots:[{slotId:'offer',itemId:id,soldOut:false}],paidRerolls:0,freeRerollsUsed:0,offerSequence:0},...overrides});
const spin = (ids, board=noLineBoard, extra=[], state={}) => spinWithItems(rules,randomForBoard(board,rules,extra),{...createRun(rules,{initialItemIds:ids}),...state});

test('v0.15 appends exactly eight items and preserves all 37 existing definitions',()=>{
 const prior=fixture('rules-v014');const source=fixture('expansion8-catalog');
 assert.equal(rules.catalog.items.length,45);
 assert.deepEqual(rules.catalog.items.slice(0,37),prior.catalog.items);
 for(const i of source.items){const actual=rules.itemsById[i.id];assert.equal(actual.price,i.id==='hootie_fruitie'?10:i.price);assert.equal(actual.rarity,i.id==='hootie_fruitie'?'legendary':i.rarity);if(i.id==='rock_bottom'){assert.equal(actual.effect.kind,'bonus_once_if_physical_symbol_present');assert.equal(actual.effect.bonusMultiplier,100);assert.equal(actual.effect.maxAwardsPerSpin,1);}else assert.deepEqual(actual.effect,i.id==='help_hand'?{...i.effect,protectCompletedLines:true}:i.effect);}
 const svg=readFileSync(new URL('../web/icons.svg',import.meta.url),'utf8');
 for(const i of source.items) assert.equal([...svg.matchAll(new RegExp(`id="${i.id}"`,'g'))].length,1);
});
test('v0.14 recorded before integration replays byte-for-byte',()=>{
 const audit=fixture('audit-v014');const old=parseRules(fixture('rules-v014'));
 assert.deepEqual(restoreSession(old,audit).exportAudit(),audit);
 assert.equal(Object.hasOwn(restoreSession(old,audit).getState(audit.userId),'doublesArmedForNextHand'),false);
});
test('expansion schemas reject unsupported policies and disabled acquisition',()=>{
 for(const [key,value] of [['bonusMultiplier',-1],['board','rawBoard']]){
  const raw=rawRules();raw.catalog.items.find(i=>i.id==='rock_bottom').effect[key]=value;
  assert.throws(()=>parseRules(raw),{code:'INVALID_RULES'});
 }
 const occupied=rawRules();occupied.catalog.items.find(i=>i.id==='survival_bag').effect.occupiesSlots=1;
 assert.throws(()=>parseRules(occupied),{code:'INVALID_RULES'});
 const raw=rawRules();raw.balance.itemRules.expansion8Items=false;
 assert.throws(()=>acquireItem(createInventory(),'rock_bottom',parseRules(raw),{activeFromRound:1}),{code:'ITEM_DISABLED'});
});
test('bag buys into full inventory, immediately expands capacity, occupies no slot and cannot be discarded',()=>{
 const before=shop('survival_bag',['piggy_bank','compound_magic','vip_pass','haggler','scammers_card','broken_lever']);
 const after=buyItem(before,'offer',rules).state;
 assert.deepEqual(inventoryLimits(after.items,rules),{permanent:6,limited:3});
 assert.deepEqual(inventoryUsage(after.items,rules),{permanent:4,limited:2,upgrade:0});
 assert.throws(()=>discardItem(after,after.items.at(-1).instanceId,rules),{code:'ITEM_NOT_DISCARDABLE'});
 const duplicate={...after,shop:before.shop};assert.throws(()=>buyItem(duplicate,'offer',rules),{code:'ITEM_ALREADY_PURCHASED'});
});
test('legacy rock bottom uses raw diamond points, survives contract, receives global multiplier and exact arithmetic',()=>{
 const rules=parseRules(rawLegacyRockRules());
 const base=scoreWithItems(noLineBoard,rules,inventory('rock_bottom').items);
 assert.equal(base.specialFlatBonus,1000n);
 const contract=scoreWithItems(noLineBoard,rules,inventory('rock_bottom','devils_contract','score_puffer').items);
 assert.equal(contract.baseScore,0n);assert.equal(contract.spinScore,1500n);
 const raw=rawLegacyRockRules();raw.balance.symbols.find(s=>s.id==='diamond').basePoint='9007199254740993';
 const r=parseRules(raw);const out=scoreWithItems(noLineBoard,r,inventory('rock_bottom').items);
 assert.equal(out.specialFlatBonus,9007199254740993n*200n);
});
test('hootie applies after same-symbol upgrades and uses physical base symbols with wild lines',()=>{
 const board=['cherry','cherry','cherry','lemon','lemon','lemon','bell','diamond','seven'];
 const out=scoreWithItems(board,rules,inventory('hootie_fruitie').items);
 assert.equal(out.baseScore,45n);assert.equal(out.lineScore,270n);assert.equal(out.spinScore,315n);
 const boosted=scoreWithItems(board,rules,inventory('hootie_fruitie','golden_harvest').items);
 assert.equal(boosted.baseScore,63n);assert.equal(boosted.winningLines[0].score,270n);
 const wild=scoreWithItems(['cherry','diamond','cherry',...noLineBoard.slice(3)],rules,inventory('hootie_fruitie').items,{wildMarks:[1]});
 assert.equal(wild.winningLines[0].score,90n);
});
test('help hand edits one uniform candidate before other modifiers and persists for every hand of its round',()=>{
 const board=['cherry','cherry','diamond','bell','lemon','seven','diamond','bell','lemon'];
 const candidates=candidateLines(board,rules);
 for(let i=0;i<candidates.length;i++){
  const out=spin(['help_hand','miracle_hand'],board,[i]);
  assert.equal(out.triggeredItems[0].itemId,'help_hand');assert.equal(out.triggeredItems[0].lineId,candidates[i].lineId);
  assert.equal(out.randomTrace.length,10);assert.equal(out.itemsAfterSpin.length,2);
 }
 const none=spin(['help_hand'],Array(9).fill('cherry'));assert.equal(none.randomTrace.length,9);
 const r=new CounterRandom(seed);const result=applyAction(createRun(rules,{initialItemIds:['help_hand']}),{type:'SPIN'},rules,{nextInt:()=>0});
 assert.equal(result.state.phase,'SHOP');assert.equal(result.state.items.length,0);assert.ok(result.event.expiredItems.some(i=>i.itemId==='help_hand'));
});
test('kaiji adjusts proc boundaries and clamps while preserving non-item RNG',()=>{
 assert.equal(procChance(800,true),1200);assert.equal(procChance(1000,true,true),2000);assert.equal(procChance(9000,true),10000);
 const board=['cherry','cherry','diamond','bell','lemon','seven','diamond','bell','lemon'];
 assert.ok(spin(['kaijis_dice','miracle_hand'],board,[2999,0]).triggeredItems.length);
 assert.equal(spin(['kaijis_dice','miracle_hand'],board,[3000]).triggeredItems.length,0);
 const out=spin(['kaijis_dice','scammers_card'],noLineBoard,[2999]);
 assert.equal(out.virtualScore,BigInt(rules.itemsById.scammers_card.effect.fixedPoints));assert.equal(out.randomTrace.at(-1).effectiveBp,3000);
 assert.equal(spin(['kaijis_dice']).randomTrace.length,9);
});
test('midas pays only at settlement, caps at three, uses pre-settlement interest and kaiji boosts payday',()=>{
 const state={...createRun(rules,{initialItemIds:['midas_hand','kaijis_dice','lucky_payday']}),midasDiamondCountThisRound:6,coins:4,handsRemaining:0};
 const result=calculateClearReward(state,rules,{nextInt:()=>3749});
 assert.equal(result.settlement.midasCoins,3);assert.equal(result.settlement.interest,0);
 assert.ok(result.settlement.triggeredItems.find(i=>i.itemId==='lucky_payday'));
 const out=spin(['midas_hand']);assert.equal(out.midasDiamondCountThisRound,2);
 const fail=applyAction({...createRun(rules,{initialItemIds:['midas_hand']}),handsRemaining:1,targetScore:999999n},{type:'SPIN'},rules,randomForBoard(noLineBoard));
 assert.equal(fail.state.coins,0);assert.equal(fail.event.settlement,null);assert.equal(fail.state.midasDiamondCountThisRound,0);
});
test('doubles arms only after activation, never compounds, and persists across rounds',()=>{
 const first=spin(['doubles']);assert.equal(first.doublesApplied,false);assert.equal(first.doublesArmedForNextHand,true);
 const second=spin(['doubles'],noLineBoard,[],{doublesArmedForNextHand:true});assert.equal(second.spinScore,first.spinScore*2n);
 const hit=spin(['doubles'],Array(9).fill('cherry'),[],{doublesArmedForNextHand:true});assert.equal(hit.doublesArmedForNextHand,false);assert.equal(hit.spinScore,498n);
 const started=applyAction(shop('rock_bottom',['doubles'],{doublesArmedForNextHand:true,midasDiamondCountThisRound:5}),{type:'CONTINUE'},rules).state;
 assert.equal(started.doublesArmedForNextHand,true);assert.equal(started.midasDiamondCountThisRound,0);
 const discarded=applyAction(shop('rock_bottom',['doubles'],{doublesArmedForNextHand:true}),{type:'DISCARD',instanceId:'item-1'},rules).state;assert.equal(discarded.doublesArmedForNextHand,false);
});
test('Emil offers real unclaimed cards and atomically grants an additional reward without an item slot',()=>{
 const before=shop('emils_shop',[],{milestoneReward:{cardId:rules.balance.round.milestoneCards.cards[0].id}});
 const choices=getShopView(before,rules).slots[0].destinyChoices;
 assert.equal(choices.length,3);assert.ok(choices.every(c=>c.cardId!==before.milestoneReward.cardId));
 const cash=rules.balance.round.milestoneCards.cards.find(c=>c.effect.kind==='grant_coins');
 const out=buyItem(before,'offer',rules,{selectedDestinyCardId:cash.id,rng:new CounterRandom(seed)});
 assert.equal(out.state.coins,120);assert.equal(out.state.items.length,0);assert.equal(milestoneRewards(out.state).length,2);
 assert.throws(()=>buyItem(before,'offer',rules,{selectedDestinyCardId:'fake'}),{code:'INVALID_DESTINY_CARD'});
 assert.throws(()=>buyItem(before,'offer',rules),{code:'DESTINY_SELECTION_REQUIRED'});
 assert.equal(before.coins,100);assert.equal(before.shop.slots[0].soldOut,false);
 const early=shop('emils_shop',[],{roundIndex:4});assert.throws(()=>buyItem(early,'offer',rules,{selectedDestinyCardId:cash.id}),{code:'ITEM_NOT_AVAILABLE'});
});
test('unique purchases stay excluded after discard and Emil is hidden with no eligible cards',()=>{
 let state=buyItem(shop('rock_bottom'),'offer',rules).state;
 state=applyAction(state,{type:'DISCARD',instanceId:state.items[0].instanceId},rules).state;
 state.shop=shop('rock_bottom').shop;assert.throws(()=>buyItem(state,'offer',rules),{code:'ITEM_ALREADY_PURCHASED'});
 const all=rules.balance.round.milestoneCards.cards.map(c=>({cardId:c.id}));
 const s=shop('emils_shop',[],{milestoneReward:all[0],additionalMilestoneRewards:all.slice(1)});
 for(let i=0;i<100;i++)assert.ok(createShop(s,rules,new CounterRandom(i.toString(16).padStart(64,'0'))).shop.slots.every(o=>o.itemId!=='emils_shop'));
});
test('new expansion state and RNG replay exactly; duplicate requests do not advance effects',()=>{
 const session=new GameSession(rules,{userId:'test',seed,initialItemIds:['survival_bag','rock_bottom','help_hand','kaijis_dice','midas_hand','doubles','hootie_fruitie']});
 const cmd={type:'SPIN',expectedRevision:0,idempotencyKey:'spin'};
 const result=session.execute('test',cmd);assert.deepEqual(session.execute('test',cmd),result);
 assert.deepEqual(restoreSession(rules,session.exportAudit()).exportAudit(),session.exportAudit());
 assert.throws(()=>session.execute('test',{type:'SPIN',expectedRevision:1,idempotencyKey:'bad',doublesArmedForNextHand:true}),{code:'INVALID_COMMAND'});
});

test('help hand candidate draw precedes wild RNG; inactive helper does not edit',()=>{
 const board=['cherry','cherry','diamond','bell','lemon','seven','diamond','bell','lemon'];
 const out=spin(['help_hand','joker_mask'],board,[0,0]);
 assert.equal(out.randomTrace[9].purpose,'candidate_selection');assert.equal(out.randomTrace[10].purpose,'wild_trigger');
 const pending=inventory('help_hand');pending.items[0].activeFromRound=2;
 assert.equal(spinWithItems(rules,randomForBoard(board),{...createRun(rules),...pending}).physicalChanged,false);
});
test('help hand repeats in the same round and expires on failure without carrying forward',()=>{
 const board=['cherry','cherry','diamond','bell','lemon','seven','diamond','bell','lemon'];
 let s={...createRun(rules,{initialItemIds:['help_hand']}),targetScore:99999999n,handsRemaining:2};
 const first=applyAction(s,{type:'SPIN'},rules,randomForBoard(board,rules,[0]));
 assert.equal(first.state.items[0].itemId,'help_hand');
 const second=applyAction(first.state,{type:'SPIN'},rules,randomForBoard(board,rules,[1]));
 assert.equal(second.event.triggeredItems[0].itemId,'help_hand');assert.equal(second.state.phase,'RUN_FAILED');
 assert.ok(second.event.expiredItems.some(i=>i.itemId==='help_hand'));
});
test('actual zero-line bonuses arm doubles; physical diamonds count after edits and independently of wild resolution',()=>{
 const out=spin(['rock_bottom','doubles']);assert.equal(out.winningLines.length,0);assert.equal(out.doublesArmedForNextHand,true);
 const board=['cherry','cherry','diamond','bell','lemon','seven','diamond','bell','lemon'];
 const edited=spin(['help_hand','midas_hand','rock_bottom'],board,[0]);
 assert.equal(edited.midasDiamondCountThisRound,1);assert.equal(edited.specialFlatBonus,500n);
 const wild=spin(['midas_hand','rock_bottom','joker_mask'],noLineBoard,[0]);
 assert.equal(wild.midasDiamondCountThisRound,2);assert.equal(wild.specialFlatBonus,500n);
});
test('doubles multiplies after the single global floor and ignores pre-activation misses',()=>{
 const raw=rawRules();raw.catalog.items.find(i=>i.id==='score_puffer').effect.factor={num:3,den:2};const r=parseRules(raw);
 const items=inventory('score_puffer','doubles').items;
 const score=scoreWithItems(Array(9).fill('cherry'),r,items,{doublesArmed:true});
 assert.equal(score.spinScore,(249n*3n/2n)*2n);
 const pending=inventory('doubles');pending.items[0].activeFromRound=2;
 assert.equal(spinWithItems(rules,randomForBoard(noLineBoard),{...createRun(rules),...pending}).doublesArmedForNextHand,false);
});
test('remaining-hand proc boost uses floor basis points, preserves one-per-round and last-hand guarantee',()=>{
 const out=spin(['kaijis_dice','scammers_card'],noLineBoard,[4998],{handsRemaining:3});
 assert.equal(out.randomTrace.at(-1).baseBp,3333);assert.equal(out.randomTrace.at(-1).effectiveBp,4999);
 assert.equal(out.itemsAfterSpin.length,1);
 const miss=spin(['kaijis_dice','scammers_card'],noLineBoard,[4999],{handsRemaining:3});assert.equal(miss.virtualScore,0n);
 const last=spin(['kaijis_dice','scammers_card'],noLineBoard,[0],{handsRemaining:1});assert.equal(last.randomTrace.at(-1).bound,1);
 const inv=inventory('broken_lever','kaijis_dice');inv.items[0].lastTriggeredRound=1;
 assert.equal(spinWithItems(rules,randomForBoard(noLineBoard),{...createRun(rules),...inv}).triggeredItems.length,0);
});
test('Midas accumulates across actual spins, pays once and resets on clear/continue',()=>{
 const state={...createRun(rules,{initialItemIds:['midas_hand']}),targetScore:60n};
 const first=applyAction(state,{type:'SPIN'},rules,randomForBoard(noLineBoard));
 assert.equal(first.state.midasDiamondCountThisRound,2);assert.equal(first.state.coins,3);
 const rng=new CounterRandom(seed), values=randomForBoard(noLineBoard);
 const second=applyAction(first.state,{type:'SPIN'},rules,{nextInt:bound=>values.draws<9?values.nextInt(bound):rng.nextInt(bound)});
 assert.equal(second.event.settlement.midasCoins,2);assert.equal(second.state.midasDiamondCountThisRound,0);
 assert.equal(applyAction(second.state,{type:'CONTINUE'},rules).state.midasDiamondCountThisRound,0);
});
test('Emil can add each existing card while preserving the first; removal, upgrades and wild work together',()=>{
 const cards=rules.balance.round.milestoneCards.cards;
 const cash=cards.find(c=>c.effect.kind==='grant_coins');
 for(const card of cards.filter(c=>c!==cash)){
   const before=shop('emils_shop',[],{milestoneReward:{cardId:cash.id}});
   const result=buyItem(before,'offer',rules,{selectedDestinyCardId:card.id,rng:new CounterRandom(seed)});
   assert.equal(result.state.milestoneReward.cardId,cash.id);assert.equal(result.state.additionalMilestoneRewards[0].cardId,card.id);
   const next=applyAction(result.state,{type:'CONTINUE'},rules).state;
   const out=spinWithItems(rules,new CounterRandom(seed),next);
   if(card.effect.kind==='remove_weighted_symbol') assert.ok(out.board.every(s=>s!==removedSymbol(next)));
   if(card.effect.kind==='grant_symbol_upgrades') assert.deepEqual(out.milestoneSpinFactor,{num:5,den:4});
   if(card.effect.kind.includes('wild')) assert.equal(out.milestoneWild,true);
 }
 const upgrade=cards.find(c=>c.effect.kind==='grant_symbol_upgrades'), wild=cards.find(c=>c.effect.kind.includes('wild'));
 const s=applyAction(buyItem(shop('emils_shop',[],{milestoneReward:{cardId:upgrade.id}}),'offer',rules,{selectedDestinyCardId:wild.id}).state,{type:'CONTINUE'},rules).state;
 const out=spinWithItems(rules,new CounterRandom(seed),s);assert.equal(out.milestoneWild,true);assert.deepEqual(out.milestoneSpinFactor,{num:5,den:4});
});
test('Emil selection failure and money overflow leave inventory, receipt and shop untouched',()=>{
 const before=shop('emils_shop',['receipt_collector']);before.items[0].purchaseCounter=2;
 const snapshot=structuredClone(before), cash=rules.balance.round.milestoneCards.cards.find(c=>c.effect.kind==='grant_coins');
 assert.throws(()=>buyItem(before,'offer',rules,{selectedDestinyCardId:'fake'}),{code:'INVALID_DESTINY_CARD'});assert.deepEqual(before,snapshot);
 const out=buyItem(before,'offer',rules,{selectedDestinyCardId:cash.id});assert.equal(out.event.refundCoins,1);assert.equal(out.state.coins,121);assert.equal(out.state.items[0].purchaseCounter,0);
 assert.throws(()=>buyItem({...before,coins:9},'offer',rules,{selectedDestinyCardId:cash.id}),{code:'INSUFFICIENT_COINS'});
 const overflow={...before,coins:Number.MAX_SAFE_INTEGER};const copy=structuredClone(overflow);
 assert.throws(()=>buyItem(overflow,'offer',rules,{selectedDestinyCardId:cash.id}),{code:'COIN_OVERFLOW'});assert.deepEqual(overflow,copy);
});
