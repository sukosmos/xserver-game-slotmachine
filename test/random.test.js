import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CounterRandom, uniformInt, RNG_VERSION, generateSeed } from '../src/server/random.js';
import { seed, rules } from './helpers.js';
import { spin } from '../src/domain/slot.js';

test('v1 golden replay vector pins the first board, score and cursor', () => {
  const rng = new CounterRandom(seed);
  assert.deepEqual(spin(rules, rng), {
    board: ['lemon', 'diamond', 'lemon', 'lemon', 'bell', 'cherry', 'lemon', 'cherry', 'bell'],
    baseScore: 21n, lineScore: 60n, spinScore: 81n,
    winningLines: [{ lineId: 'col_left', symbol: 'lemon', score: 60n }],
  });
  assert.equal(rng.snapshot().counter, 9);
});

test('RNG-01: identical seed and draw sequence reproduce spins', () => {
  const first = new CounterRandom(seed);
  const second = new CounterRandom(seed);
  for (let i = 0; i < 20; i++) assert.deepEqual(spin(rules, first), spin(rules, second));
  assert.equal(first.snapshot().counter, 180);
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.notDeepEqual(spin(rules, new CounterRandom('ff'.repeat(32))), spin(rules, new CounterRandom(seed)));
});

test('versioned stream uses HMAC blocks in big-endian word order', () => {
  const rng = new CounterRandom(seed);
  for (let block = 0; block < 3; block++) {
    const expected = createHmac('sha256', Buffer.from(seed, 'hex')).update(`nine-to-ruin:rng:v1:${block}`).digest();
    for (let word = 0; word < 8; word++) assert.equal(rng.nextInt(2 ** 32), expected.readUInt32BE(word * 4));
  }
  assert.equal(rng.snapshot().algorithm, RNG_VERSION);
});

test('snapshot resumes at mid-block position, including later blocks', () => {
  const rng = new CounterRandom(seed);
  for (let i = 0; i < 13; i++) rng.nextInt(110);
  const snapshot = rng.snapshot();
  const resumed = CounterRandom.fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
  snapshot.counter = 0;
  for (let i = 0; i < 40; i++) assert.equal(rng.nextInt(110), resumed.nextInt(110));
});

test('rejection sampling discards overflow tail instead of using biased modulo', () => {
  const words = [4294967295, 4294967290, 4294967289];
  let count = 0;
  assert.equal(uniformInt(() => words[count++], 10), 9);
  assert.equal(count, 3);
  assert.equal(uniformInt(() => 4294967295, 2 ** 32), 4294967295);
  assert.equal(uniformInt(() => 123, 1), 0);
});

test('snapshot cursor includes rejected random words', () => {
  const rng = new CounterRandom(seed);
  for (let i = 0; i < 100; i++) rng.nextInt(2 ** 31 + 1);
  assert.ok(rng.snapshot().counter > 100);
  const restored = CounterRandom.fromSnapshot(rng.snapshot());
  assert.equal(rng.nextInt(110), restored.nextInt(110));
});

test('invalid bounds, seeds, words and snapshots are rejected before consuming a draw', () => {
  const rng = new CounterRandom(seed);
  for (const bound of [0, -1, 1.1, 2 ** 32 + 1, NaN, '100']) assert.throws(() => rng.nextInt(bound));
  assert.equal(rng.snapshot().counter, 0);
  for (const value of ['', 'hello', 'a'.repeat(63), 'zz'.repeat(32)]) assert.throws(() => new CounterRandom(value));
  for (const word of [-1, 2 ** 32, 0.1, undefined]) assert.throws(() => uniformInt(() => word, 10));
  assert.throws(() => CounterRandom.fromSnapshot({ ...rng.snapshot(), algorithm: 'other' }), { code: 'RNG_VERSION_MISMATCH' });
  assert.throws(() => CounterRandom.fromSnapshot({ ...rng.snapshot(), counter: -1 }));
  assert.throws(() => CounterRandom.fromSnapshot({ ...rng.snapshot(), counter: Number.MAX_SAFE_INTEGER }).nextInt(100), { code: 'RNG_EXHAUSTED' });
  assert.match(generateSeed(), /^[0-9a-f]{64}$/);
});
