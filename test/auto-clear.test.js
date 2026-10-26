import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, applyAction } from '../src/domain/run.js';
import { parseRules } from '../src/domain/rules.js';
import { GameSession, replayAudit } from '../src/server/session.js';
import { GameStore } from '../src/server/store.js';
import { rules, rawRules, cherryBoard, noLineBoard, randomForBoard, seed } from './helpers.js';

const spin = (state, board = cherryBoard, config = rules) => applyAction(state, { type: 'SPIN' }, config, randomForBoard(board, config, Array(8).fill(0)));
test('v0.7: two starting coins, target clears on first spin and unused Hands pay immediately', () => {
  const initial = createRun(rules);
  assert.equal(initial.coins, 2);
  assert.equal(initial.handsRemaining, 5);
  const result = spin(initial);
  assert.equal(result.state.phase, 'SHOP'); assert.equal(result.state.revision, 1);
  assert.equal(result.state.handsRemaining, 4); assert.equal(result.event.settlement.reward, 6);
  assert.equal(result.state.coins, 8); assert.equal(result.state.completedRounds, 1);
  assert.equal(initial.coins, 2); assert.equal(initial.revision, 0);
  for (const type of ['SPIN', 'CLAIM']) assert.throws(() => applyAction(result.state, { type }, rules), { code: 'INVALID_RUN_PHASE' });
  const next = applyAction(result.state, { type: 'CONTINUE' }, rules).state;
  assert.equal(next.coins, 8); assert.equal(next.roundIndex, 2);
  assert.equal(next.handsRemaining, 5); assert.equal(next.targetScore, 240n);
});
test('auto clear exact boundary, one below target, last Hand and terminal round', () => {
  const raw = rawRules(); raw.balance.round.roundTargets[0].targetScore = '32';
  const exact = parseRules(raw);
  assert.equal(spin(createRun(exact), noLineBoard, exact).state.phase, 'SHOP');
  raw.balance.round.roundTargets[0].targetScore = '33';
  const below = parseRules(raw);
  assert.equal(spin(createRun(below), noLineBoard, below).state.phase, 'ROUND_ACTIVE');
  raw.balance.round.roundTargets[0].targetScore = '160';
  const fifth = parseRules(raw); let state = createRun(fifth), result;
  for (let i = 0; i < 5; i++) { result = spin(state, noLineBoard, fifth); state = result.state; }
  assert.equal(state.phase, 'SHOP'); assert.equal(result.event.settlement.handBonus, 0);
  raw.balance.round.roundTargets[0].targetScore = '161';
  const fail = parseRules(raw); state = createRun(fail);
  for (let i = 0; i < 5; i++) state = spin(state, noLineBoard, fail).state;
  assert.equal(state.phase, 'RUN_FAILED'); assert.equal(state.roundScore, 160n); assert.equal(state.coins, 0);
  raw.balance.round.roundTargets.forEach((t) => { t.targetScore = '1'; });
  const easy = parseRules(raw); state = createRun(easy);
  for (let i = 1; i <= 10; i++) {
    state = spin(state, cherryBoard, easy).state;
    assert.equal(state.completedRounds, i);
    if (i < 10) state = applyAction(state, { type: 'CONTINUE' }, easy).state;
  }
  assert.equal(state.phase, 'RUN_WON'); assert.equal(state.coins, 0);
});
test('automatic reward, RNG and shop replay exactly; retry never grants another reward', () => {
  const raw = rawRules(); raw.balance.round.roundTargets[0].targetScore = '1';
  const config = parseRules(raw), session = new GameSession(config, { userId: 'alice', seed });
  const command = { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin' };
  const first = session.execute('alice', command), audit = session.exportAudit();
  assert.equal(first.state.coins, 8); assert.equal(first.state.canClaim, false);
  assert.deepEqual(session.execute('alice', command), first);
  assert.deepEqual(session.exportAudit(), audit);
  assert.deepEqual(replayAudit(config, audit), first.state);
});
test('automatic settlement failures roll back spin and RNG together', () => {
  const raw = rawRules(); raw.balance.round.roundTargets[0].targetScore = '1';
  raw.balance.economy.startingCoins = Number.MAX_SAFE_INTEGER;
  const session = new GameSession(parseRules(raw), { userId: 'alice', seed });
  const before = session.exportAudit();
  assert.throws(() => session.execute('alice', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin' }), { code: 'COIN_OVERFLOW' });
  assert.deepEqual(session.exportAudit(), before);
});
test('creation retries and reads do not replenish starting coins', (t) => {
  const store = new GameStore({ filename: ':memory:', key: Buffer.alloc(32, 7), rules });
  t.after(() => store.close());
  const created = store.createRun('alice', 'new');
  assert.equal(created.state.coins, 2);
  assert.deepEqual(store.createRun('alice', 'new'), created);
  assert.equal(store.getRun('alice', created.state.runId).state.coins, 2);
  assert.equal(store.listRuns('alice').runs.length, 1);
});
