import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rules, rawRules, seed } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';
import { createRun } from '../src/domain/run.js';
import { acquireItem, discardItem, inventoryUsage, inventoryGroup } from '../src/domain/inventory.js';
import { createShop, buyItem, getShopView, rerollShop } from '../src/domain/shop.js';
import { CounterRandom } from '../src/server/random.js';
import { GameSession, restoreSession } from '../src/server/session.js';
import { GameStore } from '../src/server/store.js';
import { createRankSnapshot } from '../src/server/rank-snapshot.js';

const upgrades=rules.balance.shop.upgradeItemIds;
const permanent=['piggy_bank','compound_magic','vip_pass','haggler'];
const zero={nextInt:()=>0};
const add=(state,id)=>acquireItem(state,id,rules,{activeFromRound:1});
function rawEasy(){const raw=rawRules();raw.balance.economy.startingCoins=100;raw.balance.round.roundTargets.forEach(r=>{r.targetScore='1';});return raw;}
function fixture(t,config){const dir=mkdtempSync(join(tmpdir(),'nine-build-'));const options={filename:join(dir,'game.sqlite'),key:randomBytes(32),rules:config};const stores=[];const open=()=>{const s=new GameStore(options);stores.push(s);return s;};t.after(()=>{stores.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});return {open,options,store:open()};}
function driver(store,user='u'){let state=store.createRun(user,'create').state;return {get state(){return state;},act(type,extra={}){const result=store.execute(user,state.runId,{type,expectedRevision:state.revision,idempotencyKey:`act-${state.revision}`,...extra});state=result.state;return result;}};}

test('v0.14 isolates ten upgrades without changing score/economy/item definitions',()=>{
 const old=JSON.parse(readFileSync(new URL('./fixtures/rules-v013-tuned.json',import.meta.url),'utf8')), current=rawRules();
 assert.equal(current.balance.shop.slots,5);assert.equal(current.balance.shop.basePermanentItemSlots,4);assert.equal(upgrades.length,10);
 for(const k of ['upgradeItemIds','offerGroups'])delete current.balance.shop[k];current.balance.shop.slots=4;current.balance.shop.basePermanentItemSlots=8;
 for(const part of Object.keys(current)){delete current[part].version;delete old[part].version;}assert.deepEqual(current,old);
 for(const mutate of [r=>r.balance.shop.upgradeItemIds.push('piggy_bank'),r=>r.balance.shop.upgradeItemIds[0]='missing',r=>r.balance.shop.offerGroups.item=4,r=>delete r.balance.shop.offerGroups]){const r=rawRules();mutate(r);assert.throws(()=>parseRules(r),{code:'INVALID_RULES'});}
});

test('four permanent plus two limited stay full while all ten upgrades fit and stack',()=>{
 let state=createRun(rules,{initialItemIds:[...permanent,'broken_lever','emergency_lever']});
 for(const id of upgrades)state={...state,...add(state,id)};
 assert.deepEqual(inventoryUsage(state.items,rules),{permanent:4,limited:2,upgrade:10});
 assert.equal(inventoryGroup(rules.catalog.items.find(i=>i.id==='seven_tracker'),rules),'permanent');
 for(let i=0;i<20;i++)state={...state,...add(state,'golden_harvest')};
 for(let i=0;i<4;i++)state={...state,...add(state,'cherry_farm')};
 assert.throws(()=>add(state,'cherry_farm'),{code:'ITEM_CAP_REACHED'});
 assert.throws(()=>add(state,'extra_hand'),{code:'INVENTORY_FULL'});
 assert.throws(()=>add(state,'mirror_copier'),{code:'INVENTORY_FULL'});
 const item=state.items.find(i=>i.itemId==='golden_harvest');state={...state,...discardItem(state,item.instanceId,rules)};
 assert.equal(inventoryUsage(state.items,rules).permanent,4);
 state={...state,phase:'SHOP',roundIndex:3,coins:100};state.shop=createShop(state,rules,zero).shop;
 const offer=getShopView(state,rules).slots.find(s=>s.group==='upgrade');assert.ok(offer.canBuy);assert.ok(buyItem(state,offer.slotId,rules).state.items.length>state.items.length);
});

test('shops and rerolls keep separate 2+3 pools, unlocks, caps and deterministic RNG',()=>{
 for(const roundIndex of [1,2,3,10,100]){
  const state={...createRun(rules),phase:'SHOP',coins:100,roundIndex};
  const a=createShop(state,rules,new CounterRandom(seed)),b=createShop(state,rules,new CounterRandom(seed));assert.deepEqual(a,b);
  assert.deepEqual(a.shop.slots.map(s=>s.group),['upgrade','upgrade','item','item','item']);
  for(const s of a.shop.slots){assert.equal(upgrades.includes(s.itemId),s.group==='upgrade');if(roundIndex<3)assert.notEqual(rules.itemsById[s.itemId].effect.kind,'weight_add');}
  assert.equal(new Set(a.shop.slots.map(s=>s.itemId)).size,5);
  const again=rerollShop({...state,shop:a.shop},rules,new CounterRandom(seed));assert.deepEqual(again.state.shop.slots.map(s=>s.group),a.shop.slots.map(s=>s.group));
 }
 const raw=rawRules();raw.catalog.items.filter(i=>upgrades.includes(i.id)).forEach(i=>{i.minShopRound=99;});const cfg=parseRules(raw);
 const empty=createShop(createRun(cfg),cfg,zero);assert.deepEqual(empty.shop.slots.slice(0,2).map(s=>s.itemId),[null,null]);assert.ok(empty.shop.slots.slice(2).every(s=>s.itemId));assert.equal(empty.randomTrace.length,6);
});

test('rank snapshot captures the last spin build before terminal reset and charge consumption',()=>{
 const raw=rawRules();raw.balance.round.baseHands=1;raw.balance.round.roundTargets[0].targetScore='9999999999999999999999999';const cfg=parseRules(raw);
 const session=new GameSession(cfg,{userId:'private_owner',seed,initialItemIds:['golden_harvest','joker_mask','score_puffer']});
 const response=session.execute('private_owner',{type:'SPIN',expectedRevision:0,idempotencyKey:'final'});assert.equal(response.state.phase,'RUN_FAILED');assert.equal(response.state.items.length,0);
 const audit=session.exportAudit();const snap=createRankSnapshot(audit,cfg,response.state);
 assert.equal(snap.build.symbols[0].point,'3');assert.equal(snap.build.symbols[0].linePayout,'90');assert.equal(snap.items.length,3);
 const joker=snap.items.find(i=>i.itemId==='joker_mask');assert.equal(joker.instances[0].remainingCharges,1);assert.equal(joker.instances[0].consumed,true);
 assert.equal(snap.lastSpin.spinScore,response.event.spinScore);assert.deepEqual(snap.lastSpin.globalMultiplier,response.event.globalMultiplier);
 assert.ok(!/private_owner|initialSeed|rngBefore|randomTrace|idempotencyKey/.test(JSON.stringify(snap)));
 assert.deepEqual(restoreSession(cfg,audit).getState('private_owner'),response.state);
});

test('rank detail persists through restart and duplicate; old databases backfill from verified audit',t=>{
 const raw=rawEasy();raw.balance.round.roundTargets[1].targetScore='999999999999999999999999999';const {store,open,options}=fixture(t,parseRules(raw));const d=driver(store);
 assert.throws(()=>store.leaderboardDetail(d.state.runId),{code:'RANK_NOT_FOUND'});d.act('SPIN');const id=d.state.shop.slots[0].itemId;d.act('BUY',{slotId:d.state.shop.slots[0].slotId});d.act('CONTINUE');
 while(d.state.phase==='ROUND_ACTIVE')d.act('SPIN');const detail=store.leaderboardDetail(d.state.runId);assert.equal(detail.snapshot.items[0].itemId,id);assert.equal(detail.snapshot.roundIndex,2);assert.equal(detail.snapshot.completedRounds,1);
 const second=open();assert.deepEqual(second.leaderboardDetail(d.state.runId),detail);const last=d.state.revision-1;store.execute('u',d.state.runId,{type:'SPIN',expectedRevision:last,idempotencyKey:`act-${last}`});assert.deepEqual(store.leaderboardDetail(d.state.runId),detail);
 store.close();second.close();const db=new DatabaseSync(options.filename);db.exec('ALTER TABLE leaderboard DROP COLUMN snapshot; PRAGMA user_version=1;');db.close();const migrated=open();assert.deepEqual(migrated.leaderboardDetail(d.state.runId),detail);
 const inspect=new DatabaseSync(options.filename);assert.equal(inspect.prepare('PRAGMA user_version').get().user_version,2);assert.ok(inspect.prepare('SELECT snapshot FROM leaderboard').get().snapshot);inspect.close();
});

test('R10 snapshot remains fixed during Endless then changes with a better terminal record',t=>{
 const {store,open,options}=fixture(t,parseRules(rawEasy()));const d=driver(store);
 for(let round=1;round<=10;round++){d.act('SPIN');if(round===1)d.act('BUY',{slotId:d.state.shop.slots[0].slotId});if(d.state.phase==='CARD_CHOICE')d.act('CHOOSE_CARD',{slotId:d.state.cardChoice.slots[0].slotId});if(round<10)d.act('CONTINUE');}
 const before=store.leaderboardDetail(d.state.runId);d.act('START_ENDLESS');d.act('BUY',{slotId:d.state.shop.slots[0].slotId});d.act('CONTINUE');assert.deepEqual(store.leaderboardDetail(d.state.runId),before);assert.deepEqual(open().leaderboardDetail(d.state.runId),before);
 // A migrated R10 record must use its terminal revision, never the current Endless inventory.
 const db=new DatabaseSync(options.filename);db.exec('UPDATE leaderboard SET snapshot=NULL');db.close();assert.deepEqual(store.leaderboardDetail(d.state.runId),before);
 for(let i=0;i<1000 && !['RUN_FAILED','RUN_WON'].includes(d.state.phase);i++){if(d.state.phase==='SHOP')d.act('CONTINUE');else d.act('SPIN');}
 assert.equal(d.state.phase,'RUN_FAILED');const after=store.leaderboardDetail(d.state.runId);assert.ok(after.snapshot.completedRounds>10);assert.equal(after.snapshot.runTotalScore,d.state.runTotalScore);assert.notDeepEqual(after,before);
});
