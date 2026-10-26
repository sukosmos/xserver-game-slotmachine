import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, applyAction, canClaim } from '../src/domain/run.js';
import { parseRules } from '../src/domain/rules.js';
import { rules, rawRules, cherryBoard, noLineBoard, randomForBoard } from './helpers.js';

const start = (config = rules) => createRun(config);
const takeSpin = (state, board = noLineBoard, config = rules) => applyAction(state, { type: 'SPIN' }, config, randomForBoard(board, config, Array(6).fill(0)));
const claim = (state, config = rules) => applyAction(state, { type: 'CLAIM' }, config, { nextInt: () => 0 });

test('new run uses JSON targets and Hand count', () => {
  const state = start();
  assert.equal(state.handsRemaining, 4);
  assert.equal(state.targetScore, 120n);
  assert.equal(state.roundScore, 0n);
  assert.equal(state.runTotalScore, 0n);
  assert.equal(state.completedRounds, 0);
  assert.equal(state.revision, 0);
});

test('HAND-01: first Hand clear permits claim with three unused Hands', () => {
  const initial = start();
  const { state } = takeSpin(initial, cherryBoard);
  assert.equal(initial.handsRemaining, 4);
  assert.equal(state.phase, 'ROUND_ACTIVE');
  assert.equal(state.handsRemaining, 3);
  assert.equal(canClaim(state), true);
  const claimed = claim(state);
  assert.equal(claimed.state.phase, 'SHOP');
  assert.equal(claimed.state.completedRounds, 1);
  assert.equal(claimed.state.handsRemaining, 3);
  assert.equal(claimed.event.type, 'ROUND_CLAIMED');
  assert.throws(() => applyAction(claimed.state, { type: 'CLAIM' }, rules), { code: 'INVALID_RUN_PHASE' });
});

test('HAND-02: last Hand below target fails immediately and keeps final score', () => {
  const raw = rawRules();
  raw.balance.round.roundTargets[0].targetScore = '129';
  const config = parseRules(raw);
  let state = start(config);
  for (let i = 0; i < 4; i++) state = takeSpin(state, noLineBoard, config).state;
  assert.equal(state.phase, 'RUN_FAILED');
  assert.equal(state.handsRemaining, 0);
  assert.equal(state.roundScore, 128n);
  assert.equal(state.runTotalScore, 128n);
  assert.equal(state.completedRounds, 0);
  assert.equal(canClaim(state), false);
  for (const type of ['SPIN', 'CLAIM', 'CONTINUE']) {
    assert.throws(() => applyAction(state, { type }, config, randomForBoard(cherryBoard)), { code: 'INVALID_RUN_PHASE' });
  }
});

test('HAND-03: extra Hands after target add score and auto-clear on the last Hand', () => {
  let state = takeSpin(start(), cherryBoard).state;
  for (let i = 0; i < 3; i++) state = takeSpin(state).state;
  assert.equal(state.phase, 'SHOP');
  assert.equal(state.handsRemaining, 0);
  assert.equal(state.roundScore, 345n);
  assert.equal(state.runTotalScore, 345n);
  assert.equal(state.completedRounds, 1);
});

test('exact target clears and target-minus-one does not permit claim', () => {
  const raw = rawRules();
  raw.balance.round.roundTargets[0].targetScore = '128';
  const config = parseRules(raw);
  let state = start(config);
  for (let i = 0; i < 4; i++) state = takeSpin(state, noLineBoard, config).state;
  assert.equal(state.phase, 'SHOP');
  const raw2 = rawRules();
  raw2.balance.round.roundTargets[0].targetScore = '33';
  const config2 = parseRules(raw2);
  const below = takeSpin(start(config2), noLineBoard, config2).state;
  assert.throws(() => applyAction(below, { type: 'CLAIM' }, config2), { code: 'TARGET_NOT_MET' });
});

test('next round resets round score and Hands, retaining cumulative score', () => {
  const won = takeSpin(start(), cherryBoard).state;
  const cleared = claim(won).state;
  const next = applyAction(cleared, { type: 'CONTINUE' }, rules).state;
  assert.equal(next.roundIndex, 2);
  assert.equal(next.roundScore, 0n);
  assert.equal(next.runTotalScore, 249n);
  assert.equal(next.handsRemaining, 4);
  assert.equal(next.targetScore, 250n);
  assert.equal(next.phase, 'ROUND_ACTIVE');
  assert.equal(next.revision, 3);
});

test('all ten rounds transition and the last claim wins without round eleven', () => {
  const raw = rawRules();
  raw.balance.symbols[0].linePayout = '1000000';
  const config = parseRules(raw);
  let state = start(config);
  for (let round = 1; round <= 10; round++) {
    assert.equal(state.roundIndex, round);
    assert.equal(state.targetScore, BigInt(raw.balance.round.roundTargets[round - 1].targetScore));
    state = takeSpin(state, cherryBoard, config).state;
    state = claim(state, config).state;
    assert.equal(state.completedRounds, round);
    if (round < 10) state = applyAction(state, { type: 'CONTINUE' }, config).state;
  }
  assert.equal(state.phase, 'RUN_WON');
  assert.equal(state.roundIndex, 10);
  assert.equal(state.runTotalScore, 80000090n);
  assert.throws(() => applyAction(state, { type: 'CONTINUE' }, config), { code: 'INVALID_RUN_PHASE' });
});

test('invalid actions fail before any RNG draw or state mutation', () => {
  const state = start();
  const before = structuredClone(state);
  const rng = { nextInt() { assert.fail('invalid action consumed RNG'); } };
  for (const action of [{ type: 'CONTINUE' }, { type: 'CLAIM' }, { type: 'SPIN', score: '100' }, { type: 'BUY' }]) {
    assert.throws(() => applyAction(state, action, rules, rng));
    assert.deepEqual(state, before);
  }
  assert.throws(() => applyAction({ ...state, handsRemaining: 0 }, { type: 'SPIN' }, rules, rng), { code: 'NO_HANDS_LEFT' });
});
