import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, replayAudit } from '../src/server/session.js';
import { parseRules } from '../src/domain/rules.js';
import { legacyRules as rules, rawLegacyRules as rawRules, seed } from './helpers.js';

const owner = 'server-authenticated-user';
const create = (config = rules) => new GameSession(config, { userId: owner, runId: 'test-run', seed });
const command = (type, expectedRevision, idempotencyKey = `action-${expectedRevision}`) => ({ type, expectedRevision, idempotencyKey });

test('SEC-01: public state and spin responses contain exact strings and no secret RNG data', () => {
  const session = create();
  const response = session.execute(owner, command('SPIN', 0));
  assert.equal(typeof response.state.roundScore, 'string');
  assert.equal(typeof response.event.spinScore, 'string');
  assert.ok(response.event.winningLines.every((line) => typeof line.score === 'string'));
  const json = JSON.stringify(response);
  for (const secret of [seed, 'seed', 'counter', 'rngBefore', 'rngAfter', 'initialSeed']) assert.ok(!json.includes(secret));
  assert.deepEqual(session.getState(owner), response.state);
  response.state.roundScore = '999999';
  response.event.board[0] = 'fake';
  assert.notEqual(session.getState(owner).roundScore, '999999');
});

test('SEC-01: forged board/score/coins/items and invalid caller fail without state or RNG changes', () => {
  const session = create();
  const initial = session.exportAudit();
  for (const field of ['score', 'spinScore', 'board', 'coins', 'items', 'seed', 'userId']) {
    assert.throws(() => session.execute(owner, { ...command('SPIN', 0), [field]: 'forged' }), { code: 'INVALID_COMMAND' });
  }
  assert.throws(() => session.execute('someone-else', command('SPIN', 0)), { code: 'NOT_OWNER' });
  assert.throws(() => session.getState('someone-else'), { code: 'NOT_OWNER' });
  assert.deepEqual(session.exportAudit(), initial);
});

test('server totals stay exact beyond Number precision through JSON and replay', () => {
  const raw = rawRules();
  for (const symbol of raw.balance.symbols) symbol.basePoint = '9007199254740993';
  const config = parseRules(raw);
  const session = create(config);
  const response = session.execute(owner, command('SPIN', 0));
  assert.equal(response.event.baseScore, '81064793292668937');
  assert.equal(response.state.roundScore, (81064793292668937n + BigInt(response.event.lineScore)).toString());
  assert.equal(response.state.runTotalScore, response.state.roundScore);
  assert.deepEqual(replayAudit(config, JSON.parse(JSON.stringify(session.exportAudit()))), response.state);
});

test('SEC-02: duplicate spin returns original response and charges one Hand only', () => {
  const session = create();
  const request = command('SPIN', 0);
  const first = session.execute(owner, request);
  const second = session.execute(owner, { ...request });
  assert.deepEqual(first, second);
  assert.equal(session.getState(owner).handsRemaining, 3);
  assert.equal(session.exportAudit().actions.length, 1);
  assert.equal(session.exportAudit().actions[0].rngAfter, 9);
  session.execute(owner, command('SPIN', 1));
  assert.deepEqual(session.execute(owner, request), first);
  assert.equal(session.getState(owner).revision, 2);
  assert.throws(() => session.execute('intruder', request), { code: 'NOT_OWNER' });
  assert.throws(() => session.execute(owner, command('CLAIM', 0)), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('stale revision and invalid claim reject atomically, leaving key reusable', () => {
  const session = create();
  assert.throws(() => session.execute(owner, command('SPIN', 1)), { code: 'STALE_REVISION' });
  const initial = session.exportAudit();
  assert.throws(() => session.execute(owner, command('CLAIM', 0)), { code: 'TARGET_NOT_MET' });
  assert.deepEqual(session.exportAudit(), initial);
  assert.equal(session.execute(owner, command('SPIN', 0)).state.revision, 1);
  assert.throws(() => session.execute(owner, command('SPIN', 0, 'new-key')), { code: 'STALE_REVISION' });
  for (const bad of [{}, { type: 'SPIN' }, command('SPIN', -1), command('SPIN', 1, ''), command('BUY', 1)]) {
    assert.throws(() => session.execute(owner, bad));
  }
});

test('RNG-01: full server action log replays every board, score, counter and final state', () => {
  const session = create();
  for (let steps = 0; steps < 100; steps++) {
    const state = session.getState(owner);
    if (['RUN_FAILED', 'RUN_WON'].includes(state.phase)) break;
    const type = state.phase === 'SHOP' ? 'CONTINUE' : state.canClaim ? 'CLAIM' : 'SPIN';
    session.execute(owner, command(type, state.revision));
  }
  const audit = JSON.parse(JSON.stringify(session.exportAudit()));
  assert.deepEqual(replayAudit(rules, audit), session.getState(owner));
  assert.ok(audit.actions.length >= 4);
  assert.ok(['RUN_FAILED', 'RUN_WON'].includes(audit.finalState.phase));
  assert.equal(audit.actions[0].rngBefore, 0);
  assert.equal(audit.actions[0].rngAfter, 9);
  const altered = structuredClone(audit);
  altered.actions[0].response.event.spinScore = '999';
  assert.throws(() => replayAudit(rules, altered), { code: 'REPLAY_MISMATCH' });
  const wrongVersion = structuredClone(audit);
  wrongVersion.rngVersion = 'unrecognized';
  assert.throws(() => replayAudit(rules, wrongVersion), { code: 'RNG_VERSION_MISMATCH' });
  const raw = rawRules();
  raw.balance.symbols[0].weight += 1;
  assert.throws(() => replayAudit(parseRules(raw), audit), { code: 'RULES_FINGERPRINT_MISMATCH' });
});

test('claim idempotency and final-round automatic success use the same transition path', () => {
  const raw = rawRules();
  raw.balance.round.roundTargets.forEach((target) => { target.targetScore = '1'; });
  const config = parseRules(raw);
  const session = create(config);
  for (let round = 1; round <= 10; round++) {
    let state = session.getState(owner);
    if (round < 10) {
      state = session.execute(owner, command('SPIN', state.revision)).state;
      const claim = command('CLAIM', state.revision);
      const cleared = session.execute(owner, claim);
      assert.deepEqual(session.execute(owner, claim), cleared);
      state = session.execute(owner, command('CONTINUE', cleared.state.revision)).state;
      assert.equal(state.roundIndex, round + 1);
    } else {
      for (let hand = 0; hand < 4; hand++) state = session.execute(owner, command('SPIN', state.revision)).state;
      assert.equal(state.phase, 'RUN_WON');
      assert.equal(state.completedRounds, 10);
      assert.equal(state.handsRemaining, 0);
    }
  }
  assert.deepEqual(replayAudit(config, session.exportAudit()), session.getState(owner));
});
