import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession, replayAudit } from '../src/server/session.js';
import { createRun, applyAction } from '../src/domain/run.js';
import { acquireItem } from '../src/domain/inventory.js';
import { legacyRules as rules, rawLegacyRules as rawRules, seed, cherryBoard, noLineBoard, randomForBoard } from './helpers.js';
import { parseRules } from '../src/domain/rules.js';

test('timed item expires once per accepted spin; duplicate requests do not consume charges or RNG', () => {
  const session = new GameSession(rules, { userId: 'owner', seed, initialItemIds: ['joker_mask', 'miracle_hand'] });
  const request = { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin-1' };
  const first = session.execute('owner', request);
  const audit = session.exportAudit();
  assert.equal(first.state.items.find((item) => item.itemId === 'joker_mask').remainingSpins, 1);
  assert.deepEqual(session.execute('owner', request), first);
  assert.deepEqual(session.exportAudit(), audit);
  assert.ok(!JSON.stringify(first).includes('randomTrace'));
  assert.ok(!JSON.stringify(first).includes(seed));
  session.execute('owner', { type: 'SPIN', expectedRevision: 1, idempotencyKey: 'spin-2' });
  assert.ok(!session.getState('owner').items.some((item) => item.itemId === 'joker_mask'));
  assert.deepEqual(replayAudit(rules, JSON.parse(JSON.stringify(session.exportAudit()))), session.getState('owner'));
});

test('invalid requests cannot inject item inventories, stacks, charges or activation rounds', () => {
  const session = new GameSession(rules, { userId: 'owner', seed });
  for (const key of ['items', 'initialItemIds', 'remainingCharges', 'activeFromRound', 'consecutiveWinHands']) {
    assert.throws(() => session.execute('owner', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'x', [key]: 100 }), { code: 'INVALID_COMMAND' });
  }
  assert.equal(session.exportAudit().actions.length, 0);
  assert.deepEqual(session.getState('owner').items, []);
});

test('claim/continue preserve timers and win streak; pending copies become active next round', () => {
  let state = createRun(rules, { initialItemIds: ['joker_mask', 'win_streak', 'golden_harvest'] });
  state = applyAction(state, { type: 'SPIN' }, rules, randomForBoard(cherryBoard)).state;
  assert.equal(state.consecutiveWinHands, 1);
  const cleared = applyAction(state, { type: 'CLAIM' }, rules, { nextInt: () => 0 }).state;
  assert.equal(cleared.items[0].remainingSpins, 1);
  const inventory = acquireItem(cleared, 'golden_harvest', rules, { activeFromRound: 2 });
  const next = applyAction({ ...cleared, ...inventory }, { type: 'CONTINUE' }, rules).state;
  assert.equal(next.consecutiveWinHands, 1);
  assert.equal(next.items[0].remainingSpins, 1);
  const result = applyAction(next, { type: 'SPIN' }, rules, randomForBoard(cherryBoard));
  assert.equal(result.event.lineScore, 1200n);
  assert.equal(result.event.spinScore, 1813n);
  assert.equal(result.state.consecutiveWinHands, 2);
  assert.ok(!result.state.items.some((item) => item.itemId === 'joker_mask'));
});

test('run failure clears inventory after resolving the final Hand; no-line resets streak', () => {
  const raw = rawRules(); raw.balance.round.roundTargets[0].targetScore = '999999';
  const config = parseRules(raw);
  let state = createRun(config, { initialItemIds: ['win_streak', 'golden_harvest'] });
  state = applyAction(state, { type: 'SPIN' }, config, randomForBoard(cherryBoard)).state;
  for (let i = 0; i < 3; i++) state = applyAction(state, { type: 'SPIN' }, config, randomForBoard(noLineBoard)).state;
  assert.equal(state.phase, 'RUN_FAILED');
  assert.equal(state.consecutiveWinHands, 0);
  assert.deepEqual(state.items, []);
});

test('every non-economic catalog item is usable from a trusted fixture and auditable', () => {
  for (const item of rules.catalog.items.filter((item) => item.category !== 'economy')) {
    const session = new GameSession(rules, { userId: 'owner', seed, initialItemIds: [item.id] });
    for (let i = 0; i < 2; i++) session.execute('owner', { type: 'SPIN', expectedRevision: i, idempotencyKey: `spin-${i}` });
    const audit = session.exportAudit();
    assert.equal(audit.initialItemIds[0], item.id);
    assert.ok(audit.actions[0].randomTrace.length >= 9);
    assert.deepEqual(replayAudit(rules, audit), session.getState('owner'), item.id);
    const corrupted = structuredClone(audit);
    corrupted.actions[0].randomTrace[0].value += 1;
    assert.throws(() => replayAudit(rules, corrupted), { code: 'REPLAY_MISMATCH' });
  }
});

test('economic items are stored without spinning economic effects; old audit formats fail explicitly', () => {
  const session = new GameSession(rules, { userId: 'owner', seed, initialItemIds: ['lucky_payday', 'piggy_bank'] });
  const response = session.execute('owner', { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin' });
  assert.equal(response.event.spinScore, '81');
  assert.deepEqual(response.event.triggeredItems, []);
  assert.equal(session.exportAudit().actions[0].rngAfter, 9);
  assert.throws(() => replayAudit(rules, { ...session.exportAudit(), format: 'slot-audit-v1' }), { code: 'INVALID_AUDIT' });
});
