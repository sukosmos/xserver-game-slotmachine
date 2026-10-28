import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createRun, applyAction } from '../src/domain/run.js';
import { CounterRandom } from '../src/server/random.js';
import { GameStore } from '../src/server/store.js';
import { createVault } from '../src/server/vault.js';
import { compareRecords } from '../src/domain/ranking.js';
import { parseRules } from '../src/domain/rules.js';
import { legacyRules as rules, rawLegacyRules as rawRules } from './helpers.js';
import { rules as currentRules, rawV011Rules } from './helpers.js';

function fixture(t, config = rules) {
  const dir = mkdtempSync(join(tmpdir(), 'nine-store-'));
  const options = { filename: join(dir, 'game.sqlite'), key: randomBytes(32), rules: config };
  const stores = [];
  const open = (extra = {}) => { const store = new GameStore({ ...options, ...extra }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { options, open, store: open() };
}
const cmd = (type, revision, extra = {}) => ({ type, expectedRevision: revision, idempotencyKey: `action-${revision}`, ...extra });

test('R3 hidden cards and chosen reward survive disk restart and simultaneous connections', (t) => {
  const raw = structuredClone({ balance:currentRules.balance, lines:currentRules.lineDefinitions, catalog:currentRules.catalog });
  raw.balance.round.roundTargets.forEach((row) => { row.targetScore='1'; });
  const { store, open }=fixture(t,parseRules(raw));
  let active=store, result=active.createRun('alice','cards'), id=result.state.runId;
  const act=(type,extra={}) => result=active.execute('alice',id,cmd(type,result.state.revision,extra));
  for(let round=1;round<=3;round++) { act('SPIN'); if(round<3) act('CONTINUE'); }
  const pending=structuredClone(result);
  active.close(); active=open();
  assert.deepEqual(active.getRun('alice',id).state,pending.state);
  const command=cmd('CHOOSE_CARD',result.state.revision,{slotId:result.state.cardChoice.slots[1].slotId});
  result=active.execute('alice',id,command);
  const other=open();
  assert.deepEqual(other.execute('alice',id,command),result);
  assert.throws(()=>other.execute('alice',id,{...command,idempotencyKey:'race'}),{code:'STALE_REVISION'});
  active.close(); active=open();
  assert.deepEqual(active.getRun('alice',id).state,result.state);
  assert.equal(result.state.coins,pending.state.coins+(result.state.milestoneReward.coinsGranted??0));
  act('CONTINUE'); const started=structuredClone(result.state);
  act('SPIN'); const first=structuredClone(result);
  active.close(); active=open();
  assert.deepEqual(active.getRun('alice',id).state,first.state);
  if(started.milestoneReward.cardId==='wild') assert.equal(first.event.milestoneWild,true);
  assert.equal(first.state.phase,'SHOP');
});
function losingRules() {
  const raw = rawRules(); raw.balance.round.roundTargets[0].targetScore = '9999999999999999999999999999';
  return parseRules(raw);
}

test('v0.6 stored runs still replay while new deployments use three coins and auto clear', (t) => {
  const raw = rawRules(); raw.balance.round.roundTargets[0].targetScore = '1';
  const { store, open } = fixture(t, parseRules(raw));
  const id = store.createRun('alice', 'legacy').state.runId;
  const previous = store.execute('alice', id, cmd('SPIN', 0));
  assert.equal(previous.state.canClaim, true); assert.equal(previous.state.coins, 0);
  store.close();
  const upgraded = open({ rules: currentRules });
  assert.deepEqual(upgraded.execute('alice', id, cmd('SPIN', 0)), previous);
  assert.equal(upgraded.getRun('alice', id).state.canClaim, true);
  assert.equal(upgraded.execute('alice', id, cmd('CLAIM', 1)).state.coins, 5);
  assert.equal(upgraded.createRun('alice', 'current').state.coins, 3);
});

test('disk restart restores state, RNG, idempotent responses and server-issued authentication', (t) => {
  const { store, open, options } = fixture(t);
  const token = store.issueToken('alice');
  const created = store.createRun('alice', 'create');
  const id = created.state.runId;
  const spun = store.execute('alice', id, cmd('SPIN', 0));
  store.close();
  const restarted = open();
  assert.equal(restarted.authenticate(token), 'alice');
  assert.deepEqual(restarted.createRun('alice', 'create'), created);
  assert.deepEqual(restarted.execute('alice', id, cmd('SPIN', 0)), spun);
  const view = restarted.getRun('alice', id);
  assert.deepEqual(view.state, spun.state);
  assert.deepEqual(view.lastSpin, spun.event);
  assert.equal(restarted.listRuns('alice').runs.length, 1);
  assert.equal(restarted.listRuns('bob').runs.length, 0);
  assert.throws(() => restarted.getRun('bob', id), { code: 'RUN_NOT_FOUND' });
  assert.throws(() => restarted.execute('bob', id, cmd('SPIN', 1)), { code: 'RUN_NOT_FOUND' });
  assert.ok(!readFileSync(options.filename).includes(Buffer.from(token)));
  restarted.revokeTokens('alice');
  assert.equal(restarted.authenticate(token), null);
});

test('two connections serialize stale and duplicate commands without double charging', (t) => {
  const { store, open } = fixture(t);
  const other = open();
  const created = store.createRun('alice', 'same-create');
  assert.deepEqual(other.createRun('alice', 'same-create'), created);
  const id = created.state.runId;
  const first = store.execute('alice', id, cmd('SPIN', 0));
  assert.deepEqual(other.execute('alice', id, cmd('SPIN', 0)), first);
  assert.throws(() => other.execute('alice', id, cmd('SPIN', 0, { idempotencyKey: 'other' })), { code: 'STALE_REVISION' });
  assert.equal(store.getRun('alice', id).state.handsRemaining, 3);
});

test('existing runs keep stored rules after new deployments, including overlarge exact scores', (t) => {
  const original = rawRules();
  for (const symbol of original.balance.symbols) symbol.basePoint = '9007199254740993';
  const config = parseRules(original);
  const { store, open } = fixture(t, config);
  const id = store.createRun('alice', 'old').state.runId;
  const next = rawRules();
  for (const part of [next.balance, next.lines, next.catalog]) part.version = 'new-test';
  const newRules = parseRules(next);
  const changed = open({ rules: newRules });
  const oldSpin = changed.execute('alice', id, cmd('SPIN', 0));
  assert.equal(oldSpin.event.baseScore, '81064793292668937');
  assert.equal(oldSpin.state.rulesVersion, config.rulesVersion);
  assert.equal(changed.catalog('alice', id).symbols[0].basePoint, '9007199254740993');
  assert.equal(changed.catalog('alice', id).rulesVersion, config.rulesVersion);
  assert.equal(changed.catalog('alice').rulesVersion, 'new-test');
  assert.equal(changed.getRun('alice', id).upgrades.current.symbols[0].point, '9007199254740993');
  assert.equal(changed.createRun('alice', 'old').upgrades.current.symbols[0].point, '9007199254740993');
  assert.equal(changed.createRun('alice', 'new').state.rulesVersion, 'new-test');
});

test('terminal state and best leaderboard record commit once and survive restart', (t) => {
  const { store, open } = fixture(t, losingRules());
  const id = store.createRun('alice', 'game').state.runId;
  assert.deepEqual(store.leaderboard().entries, []);
  let result;
  for (let i = 0; i < 4; i++) result = store.execute('alice', id, cmd('SPIN', i));
  assert.equal(result.state.phase, 'RUN_FAILED');
  const before = store.getRun('alice', id);
  const rank = store.leaderboard().entries[0];
  assert.equal(rank.runTotalScore, result.state.runTotalScore);
  assert.equal(rank.completedRounds, 0);
  assert.ok(!JSON.stringify(rank).includes('alice'));
  const restarted = open();
  assert.deepEqual(restarted.execute('alice', id, cmd('SPIN', 3)), result);
  assert.deepEqual(restarted.getRun('alice', id), before);
  assert.deepEqual(restarted.leaderboard().entries, [rank]);
});

test('database failure rolls back ending spin and ranking together, allowing safe retry', (t) => {
  const { store, options } = fixture(t, losingRules());
  const id = store.createRun('alice', 'game').state.runId;
  for (let i = 0; i < 3; i++) store.execute('alice', id, cmd('SPIN', i));
  const before = store.getRun('alice', id);
  const db = new DatabaseSync(options.filename);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_rank BEFORE INSERT ON leaderboard BEGIN SELECT RAISE(ABORT, 'test disk failure'); END");
  assert.throws(() => store.execute('alice', id, cmd('SPIN', 3)), { code: 'STORAGE_ERROR' });
  assert.deepEqual(store.getRun('alice', id), before);
  assert.deepEqual(store.leaderboard().entries, []);
  db.exec('DROP TRIGGER fail_rank');
  const result = store.execute('alice', id, cmd('SPIN', 3));
  assert.equal(result.state.phase, 'RUN_FAILED');
  assert.equal(store.leaderboard().entries.length, 1);
});

test('encrypted audit and incorrect key fail closed; no secret seed appears in persisted text', (t) => {
  const { store, options } = fixture(t);
  const id = store.createRun('alice', 'game').state.runId;
  const db = new DatabaseSync(options.filename);
  t.after(() => db.close());
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  assert.ok(!row.audit.includes('initialSeed'));
  assert.throws(() => new GameStore({ ...options, key: randomBytes(32) }), { code: 'STORAGE_KEY_MISMATCH' });
  const envelope = JSON.parse(row.audit); envelope.tag = Buffer.alloc(16).toString('base64url');
  db.prepare('UPDATE runs SET audit = ? WHERE id = ?').run(JSON.stringify(envelope), id);
  assert.throws(() => store.getRun('alice', id), { code: 'STORAGE_CORRUPT' });
});

test('vault authenticates ownership/context, randomizes ciphertext and rejects tampering', () => {
  const vault = createVault(randomBytes(32));
  const a = vault.seal({ seed: 'private' }, 'run-a');
  assert.notEqual(a, vault.seal({ seed: 'private' }, 'run-a'));
  assert.deepEqual(vault.open(a, 'run-a'), { seed: 'private' });
  assert.throws(() => vault.open(a, 'run-b'), { code: 'STORAGE_CORRUPT' });
});

test('ranking comparison uses round, exact score beyond Number/SQLite integer, then server time', () => {
  const a = { completedRounds: 2, runTotalScore: '9007199254740993', endedAt: 100 };
  assert.ok(compareRecords(a, { ...a, runTotalScore: '9007199254740992' }) < 0);
  assert.ok(compareRecords(a, { ...a, completedRounds: 3, runTotalScore: '1' }) > 0);
  assert.ok(compareRecords(a, { ...a, endedAt: 101 }) < 0);
  assert.equal(compareRecords(a, { ...a }), 0);
});

test('actual concurrent connections apply a duplicate once and reject a competing stale revision', async (t) => {
  const { store, options } = fixture(t);
  for (const sameKey of [true, false]) {
    const runId = store.createRun('alice', `create-${sameKey}`).state.runId;
    const barrier = new SharedArrayBuffer(4);
    let ready = 0;
    const outcomes = await Promise.all([0, 1].map((index) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./fixtures/store-worker.js', import.meta.url), { workerData: {
        filename: options.filename, key: options.key, barrier, runId,
        command: cmd('SPIN', 0, { idempotencyKey: sameKey ? 'same' : `different-${index}` }),
      } });
      worker.on('error', reject);
      worker.on('message', (message) => {
        if (message.ready) {
          if (++ready === 2) { Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0); }
        } else resolve(message);
      });
    })));
    if (sameKey) assert.deepEqual(outcomes[0], outcomes[1]);
    else {
      assert.equal(outcomes.filter((o) => o.code === 'STALE_REVISION').length, 1);
      assert.equal(outcomes.filter((o) => o.response).length, 1);
    }
    assert.equal(store.getRun('alice', runId).state.handsRemaining, 3);
  }
});

test('leaderboard SQL preserves exact ordering, one best per account and earlier ties', (t) => {
  const fixed = (base, rounds = 1) => {
    const raw = rawRules(); raw.balance.round.maxRoundMvp = rounds;
    raw.balance.round.roundTargets = Array.from({ length: rounds }, (_, i) => ({ round: i + 1, targetScore: '1' }));
    for (const symbol of raw.balance.symbols) { symbol.basePoint = base; symbol.linePayout = '0'; }
    return parseRules(raw);
  };
  const { store, open } = fixture(t, fixed('100000000000000000000000000000000000000000000000000'));
  const finish = (connection, user, key, rounds = 1) => {
    let state = connection.createRun(user, key).state;
    for (let round = 1; round <= rounds; round++) {
      state = connection.execute(user, state.runId, cmd('SPIN', state.revision)).state;
      state = connection.execute(user, state.runId, cmd('CLAIM', state.revision)).state;
      if (round < rounds) state = connection.execute(user, state.runId, cmd('CONTINUE', state.revision)).state;
    }
    return state;
  };
  const first = finish(store, 'alice', 'first');
  const high = open({ rules: fixed('100000000000000000000000000000000000000000000000001') });
  finish(high, 'bob', 'higher');
  assert.equal(store.leaderboard().entries[0].playerId, store.playerId('bob'));
  const low = open({ rules: fixed('1'), now: () => 9000000000000 });
  finish(low, 'alice', 'worse');
  assert.equal(store.leaderboard().entries.find((r) => r.playerId === store.playerId('alice')).runId, first.runId);
  finish(store, 'alice', 'tie');
  assert.equal(store.leaderboard().entries.find((r) => r.playerId === store.playerId('alice')).runId, first.runId);
  const moreRounds = open({ rules: fixed('1', 2) });
  const better = finish(moreRounds, 'alice', 'rounds', 2);
  assert.equal(store.leaderboard().entries[0].runId, better.runId);
  assert.equal(store.leaderboard().entries.length, 2);
  assert.equal(store.leaderboard(1).entries.length, 1);
});

test('selected8 receipt refunds and emergency Hands commit once across connections and disk restart', (t) => {
  const raw = rawV011Rules(); // Preserve the v0.11 extra-Hand replay regression.
  raw.balance.economy.startingCoins = 50;
  delete raw.balance.round.milestoneCards; // Isolate the selected-eight persistence fixture.
  raw.balance.round.roundTargets[0].targetScore = '1'; raw.balance.round.roundTargets[1].targetScore = '1';
  raw.balance.round.roundTargets[2].targetScore = '999999999';
  raw.balance.symbols[0].weight = 100000;
  raw.catalog.items = raw.catalog.items.filter((i) => ['receipt_collector', 'seven_tracker', 'emergency_lever', 'golden_harvest'].includes(i.id));
  const { store, open } = fixture(t, parseRules(raw));
  let active = store, result = active.createRun('alice', 'selected-eight'), id = result.state.runId;
  const act = (type, extra = {}) => { result = active.execute('alice', id, cmd(type, result.state.revision, extra)); return result; };
  const purchase = (itemId) => act('BUY', { slotId: result.state.shop.slots.find((s) => s.itemId === itemId).slotId });
  act('SPIN');
  for (const item of ['receipt_collector', 'seven_tracker', 'emergency_lever']) purchase(item);
  assert.equal(result.state.items.find((i) => i.itemId === 'receipt_collector').purchaseCounter, 0);
  act('CONTINUE'); act('SPIN');
  purchase('golden_harvest'); act('REROLL'); purchase('golden_harvest');
  const saved = structuredClone(result.state);
  active.close(); active = open();
  assert.deepEqual(active.getRun('alice', id).state, saved);
  assert.equal(saved.items.find((i) => i.itemId === 'receipt_collector').purchaseCounter, 2);
  act('REROLL');
  const buy = cmd('BUY', result.state.revision, { slotId: result.state.shop.slots.find((s) => s.itemId === 'golden_harvest').slotId });
  result = active.execute('alice', id, buy);
  assert.equal(result.event.refundCoins, 1);
  assert.equal(result.state.items.find((i) => i.itemId === 'receipt_collector').purchaseCounter, 0);
  const other = open();
  assert.deepEqual(other.execute('alice', id, buy), result);
  assert.throws(() => other.execute('alice', id, { ...buy, idempotencyKey: 'race-buy' }), { code: 'STALE_REVISION' });
  act('CONTINUE');
  for (let i = 0; i < 4; i++) act('SPIN');
  const emergencyCommand = cmd('SPIN', result.state.revision);
  result = active.execute('alice', id, emergencyCommand);
  assert.equal(result.event.emergency.type, 'EMERGENCY_HAND_GRANTED');
  assert.equal(result.state.handsRemaining, 1); assert.equal(result.state.phase, 'ROUND_ACTIVE');
  assert.deepEqual(active.leaderboard().entries, []);
  active.close(); active = open();
  assert.deepEqual(active.execute('alice', id, emergencyCommand), result);
  act('SPIN');
  assert.equal(result.state.phase, 'RUN_FAILED');
  assert.deepEqual(result.state.pendingNextHandWeightBuffs, []);
  assert.equal(active.leaderboard().entries.length, 1);
});


test('windfall pays exactly thirty coins once across connections and disk restart', (t) => {
 const raw=structuredClone({balance:currentRules.balance,lines:currentRules.lineDefinitions,catalog:currentRules.catalog});raw.balance.round.roundTargets.forEach(r=>{r.targetScore='1';});
 const config=parseRules(raw),{store,open,options}=fixture(t,config);
 let result=store.createRun('alice','windfall'),id=result.state.runId;
 for(let r=1;r<=3;r++){result=store.execute('alice',id,cmd('SPIN',result.state.revision));if(r<3)result=store.execute('alice',id,cmd('CONTINUE',result.state.revision));}
 // Only the isolated test reads its private audit to select a known reward.
 const db=new DatabaseSync(options.filename);const row=db.prepare('SELECT * FROM runs WHERE id=?').get(id);db.close();
 const audit=createVault(options.key).open(row.audit,JSON.stringify(['run-v1',row.id,row.owner_id,row.rules_hash,row.created_at]));
 const rng=new CounterRandom(audit.initialSeed);let internal=createRun(config);
 for(const {command} of audit.actions){const {expectedRevision,idempotencyKey,...action}=command;internal=applyAction(internal,action,config,rng).state;}
 const slotId=internal.cardOffer.find(c=>c.cardId==='windfall').slotId,before=result.state.coins;
 const command=cmd('CHOOSE_CARD',result.state.revision,{slotId});result=store.execute('alice',id,command);
 assert.equal(result.state.coins,before+30);assert.equal(result.event.reward.coinsGranted,30);
 const second=open();assert.deepEqual(second.execute('alice',id,command),result);assert.throws(()=>second.execute('alice',id,{...command,idempotencyKey:'second-choice'}),{code:'STALE_REVISION'});
 store.close();second.close();const restarted=open();assert.deepEqual(restarted.getRun('alice',id).state,result.state);assert.deepEqual(restarted.execute('alice',id,command),result);
});

test('v0.14 disk saves retain their original catalog while v0.15 adds expansion items', t=>{
 const old=parseRules(JSON.parse(readFileSync(new URL('./fixtures/rules-v014.json',import.meta.url),'utf8')));
 const {store,open}=fixture(t,old);const created=store.createRun('alice','old');const id=created.state.runId;
 const result=store.execute('alice',id,cmd('SPIN',0));store.close();
 const next=open({rules:currentRules});assert.deepEqual(next.getRun('alice',id).state,result.state);
 assert.deepEqual(next.execute('alice',id,cmd('SPIN',0)),result);
 assert.equal(next.catalog('alice',id).items.length,37);assert.equal(next.catalog('alice').items.length,45);
 assert.equal(next.createRun('alice','new').state.rulesVersion,'v0.15');
});

test('Emil and bag purchases survive SQLite restart, retries and rank snapshot creation', t=>{
 const raw=structuredClone({balance:currentRules.balance,lines:currentRules.lineDefinitions,catalog:currentRules.catalog});
 raw.balance.economy.startingCoins=100;raw.balance.round.roundTargets.forEach(r=>r.targetScore='1');
 const ids=new Set([...raw.balance.shop.upgradeItemIds,'survival_bag','emils_shop']);raw.catalog.items=raw.catalog.items.filter(i=>ids.has(i.id));
 const {store,open}=fixture(t,parseRules(raw));let active=store,state=active.createRun('alice','expansion').state;
 const runId=state.runId,act=(type,extra={})=>{const result=active.execute('alice',runId,cmd(type,state.revision,extra));state=result.state;return result;};
 for(let round=1;round<=5;round++){
   act('SPIN');if(state.phase==='CARD_CHOICE')act('CHOOSE_CARD',{slotId:state.cardChoice.slots[0].slotId});
   if(round===1){act('BUY',{slotId:state.shop.slots.find(o=>o.itemId==='survival_bag').slotId});assert.deepEqual(state.inventoryLimits,{permanent:6,limited:3});}
   if(round<5)act('CONTINUE');
 }
 const offer=state.shop.slots.find(o=>o.itemId==='emils_shop');const command=cmd('BUY_DESTINY',state.revision,{slotId:offer.slotId,selectedDestinyCardId:offer.destinyChoices[0].cardId});
 const bought=active.execute('alice',runId,command);state=bought.state;active.close();active=open();
 assert.deepEqual(active.getRun('alice',runId).state,state);assert.deepEqual(active.execute('alice',runId,command),bought);
 assert.equal(state.milestoneRewards.length,2);assert.deepEqual(state.inventoryLimits,{permanent:6,limited:3});
 for(let round=6;round<=10;round++){act('CONTINUE');act('SPIN');}
 const snap=active.leaderboardDetail(runId).snapshot;assert.equal(snap.build.milestoneRewards.length,2);assert.equal(snap.permanentSlots,6);
 active.close();active=open();assert.deepEqual(active.leaderboardDetail(runId).snapshot,snap);
});
