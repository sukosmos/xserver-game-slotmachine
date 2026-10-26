import test from 'node:test';
import assert from 'node:assert/strict';
import { drawBoard, evaluateLines, scoreBoard, spin, createWeightedTable } from '../src/domain/slot.js';
import { parseRules } from '../src/domain/rules.js';
import { rational, addRational, multiplyRational, floorMultiply, exactInteger, stringifyExact } from '../src/domain/exact.js';
import { rules, rawRules, cherryBoard, sevenBoard, noLineBoard, scriptedRandom, randomForBoard } from './helpers.js';

test('SLOT-01: nine cherries pay every overlapping line (249)', () => {
  const result = scoreBoard(cherryBoard, rules);
  assert.equal(result.baseScore, 9n);
  assert.equal(result.lineScore, 240n);
  assert.equal(result.spinScore, 249n);
  assert.equal(result.winningLines.length, 8);
  assert.ok(result.winningLines.every((line) => line.symbol === 'cherry' && line.score === 30n));
});

test('SLOT-02: no lines still pay all nine symbols', () => {
  assert.deepEqual(scoreBoard(noLineBoard, rules), {
    baseScore: 32n, lineScore: 0n, spinScore: 32n, winningLines: [],
  });
});

test('SLOT-05: nine sevens pay 12090', () => {
  const result = scoreBoard(sevenBoard, rules);
  assert.equal(result.spinScore, 12090n);
  assert.equal(result.baseScore, 90n);
  assert.equal(result.winningLines.length, 8);
});

for (const line of rules.lines) {
  test(`LINE-01: isolated ${line.id} pays exactly once`, () => {
    const board = [...noLineBoard];
    for (const index of line.indices) board[index] = 'seven';
    const result = evaluateLines(board, rules);
    assert.deepEqual(result.map((hit) => hit.lineId), [line.id]);
    assert.equal(result[0].symbol, 'seven');
  });
}

test('LINE-02: crossing lines both pay, shared cell contributes base once', () => {
  const board = ['cherry', 'cherry', 'cherry', 'cherry', 'lemon', 'bell', 'cherry', 'diamond', 'seven'];
  const result = scoreBoard(board, rules);
  assert.deepEqual(result.winningLines.map((line) => line.lineId), ['row_top', 'col_left']);
  assert.equal(result.lineScore, 60n);
  assert.equal(result.baseScore, 25n);
  assert.equal(result.spinScore, 85n);
});

test('weights use their actual sum and every half-open interval boundary', () => {
  const raw = rawRules();
  raw.balance.symbols[0].weight = 40;
  const changed = parseRules(raw);
  const rng = scriptedRandom([0, 39, 40, 64, 65, 84, 85, 99, 100]);
  assert.equal(createWeightedTable(changed.symbols).totalWeight, 110);
  assert.deepEqual(drawBoard(changed, rng), ['cherry', 'cherry', 'lemon', 'lemon', 'bell', 'bell', 'diamond', 'diamond', 'seven']);
  assert.equal(rng.draws, 9);
  assert.equal(drawBoard(changed, scriptedRandom(Array(9).fill(109)))[8], 'seven');
});

test('spin consumes exactly nine draws in row-major order and does not mutate inputs', () => {
  const board = Object.freeze([...noLineBoard]);
  const rng = randomForBoard(board);
  assert.deepEqual(spin(rules, rng), { board: [...board], ...scoreBoard(board, rules) });
  assert.equal(rng.draws, 9);
});

test('reject malformed boards, nonpositive/unsafe weights, and broken random sources', () => {
  for (const board of [[], Array(8).fill('cherry'), Array(10).fill('cherry'), [...cherryBoard.slice(1), 'bogus'], Array(9)]) {
    assert.throws(() => scoreBoard(board, rules));
  }
  for (const weight of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, NaN]) {
    assert.throws(() => createWeightedTable([{ id: 'cherry', weight }]));
  }
  assert.throws(() => createWeightedTable([]));
  assert.throws(() => createWeightedTable([{ id: 'cherry', weight: 1 }, { id: 'cherry', weight: 1 }]));
  for (const value of [-1, 100, 0.5, NaN, '1']) {
    assert.throws(() => drawBoard(rules, { nextInt: () => value }));
  }
});

test('score remains exact above Number.MAX_SAFE_INTEGER and serializes as decimal text', () => {
  const raw = rawRules();
  raw.balance.symbols[0].basePoint = '9007199254740993';
  raw.balance.symbols[0].linePayout = '9007199254740995';
  const result = scoreBoard(cherryBoard, parseRules(raw));
  assert.equal(result.spinScore, 153122387330596897n);
  assert.equal(JSON.parse(stringifyExact(result)).spinScore, '153122387330596897');
});

test('rational operations retain fractions until the documented floor boundary', () => {
  const factor = addRational(rational(1), multiplyRational(rational(3, 4), rational(2)));
  assert.deepEqual(factor, rational(5, 2));
  assert.equal(floorMultiply(31n, factor), 77n);
  // Applying a half and then a triple is floored once, not between factors.
  assert.equal(floorMultiply(31n, multiplyRational(rational(1, 2), rational(3))), 46n);
  assert.equal(floorMultiply(9007199254740993n, rational(3, 2)), 13510798882111489n);
  assert.deepEqual(rational(0, 5), { num: 0n, den: 1n });
  for (const value of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, '01', '1e9', '', true]) {
    assert.throws(() => exactInteger(value));
  }
  assert.throws(() => rational(1, 0));
  assert.throws(() => rational(-1, 2));
});
