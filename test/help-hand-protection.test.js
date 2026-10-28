import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, rawRules, randomForBoard, seed } from './helpers.js';
import { candidateLines, spinWithItems } from '../src/domain/items.js';
import { evaluateLines } from '../src/domain/slot.js';
import { createRun } from '../src/domain/run.js';
import { parseRules } from '../src/domain/rules.js';
import { GameSession, restoreSession } from '../src/server/session.js';
import { publicCatalog } from '../src/server/catalog.js';

const mixed = ['lemon', 'lemon', 'cherry', 'cherry', 'cherry', 'cherry', 'cherry', 'cherry', 'cherry'];
const blocked = ['lemon', 'lemon', 'lemon', 'cherry', 'cherry', 'cherry', 'cherry', 'cherry', 'cherry'];
const spin = (board, draws, config = rules, ids = ['help_hand']) => spinWithItems(config,
  randomForBoard(board, config, draws), createRun(config, { initialItemIds: ids }));
function oldRules() {
  const raw = rawRules();
  delete raw.catalog.items.find(i => i.id === 'help_hand').effect.protectCompletedLines;
  return parseRules(raw);
}

test('help hand protects completed cells while keeping intersecting safe candidates uniformly selectable', () => {
  const expected = [
    { lineId: 'col_left', changeIndex: 0, newSymbol: 'cherry' },
    { lineId: 'col_middle', changeIndex: 1, newSymbol: 'cherry' },
    { lineId: 'diag_main', changeIndex: 0, newSymbol: 'cherry' },
  ];
  assert.deepEqual(candidateLines(mixed, rules, { protectCompletedLines: true }), expected);
  for (let i = 0; i < expected.length; i++) {
    const result = spin(mixed, [i], rules, ['help_hand', 'miracle_hand']);
    assert.equal(result.triggeredItems.length, 1);
    assert.equal(result.triggeredItems[0].itemId, 'help_hand');
    assert.equal(result.triggeredItems[0].lineId, expected[i].lineId);
    assert.equal(result.triggeredItems[0].changeIndex, expected[i].changeIndex);
    assert.equal(result.randomTrace.length, 10);
    assert.equal(result.randomTrace[9].bound, expected.length);
    assert.deepEqual(result.board.slice(2), mixed.slice(2));
  }
});

test('no safe candidate skips help hand without consuming RNG or the later modifier opportunity', () => {
  const result = spin(blocked, []);
  assert.deepEqual(result.board, blocked);
  assert.deepEqual(result.triggeredItems, []);
  assert.equal(result.randomTrace.length, 9);
  assert.equal(result.itemsAfterSpin.length, 1);
  const later = spin(blocked, [0, 0], rules, ['help_hand', 'miracle_hand']);
  assert.deepEqual(later.triggeredItems.map(i => i.itemId), ['miracle_hand']);
  assert.equal(later.randomTrace[9].purpose, 'board_trigger');
});

test('all 512 two-symbol boards preserve every completed row, column and diagonal for every safe draw', () => {
  const covered = new Set();
  for (let mask = 0; mask < 512; mask++) {
    const board = Array.from({ length: 9 }, (_, i) => mask & (1 << i) ? 'lemon' : 'cherry');
    // Independent oracle: exact physical triples, without candidateLines/evaluateLines.
    const complete = rules.lines.filter(line => line.indices.every(i => board[i] === board[line.indices[0]]));
    const protectedCells = new Set(complete.flatMap(line => line.indices));
    complete.forEach(line => covered.add(line.id));
    const expected = rules.lines.flatMap(line => {
      for (const changeIndex of line.indices) {
        const others = line.indices.filter(i => i !== changeIndex);
        if (!protectedCells.has(changeIndex) && board[others[0]] === board[others[1]] && board[changeIndex] !== board[others[0]]) {
          return [{ lineId: line.id, changeIndex, newSymbol: board[others[0]] }];
        }
      }
      return [];
    });
    assert.deepEqual(candidateLines(board, rules, { protectCompletedLines: true }), expected);
    for (let index = 0; index < Math.max(1, expected.length); index++) {
      const out = spin(board, expected.length ? [index] : []);
      for (const cell of protectedCells) assert.equal(out.board[cell], board[cell]);
      for (const line of complete) assert.ok(evaluateLines(out.board, rules).some(l => l.lineId === line.id));
      assert.equal(out.randomTrace.length, expected.length ? 10 : 9);
      if (expected.length) assert.equal(out.triggeredItems[0].lineId, expected[index].lineId);
    }
  }
  assert.equal(covered.size, 8);
});

test('legacy help-hand rules preserve the original destructive candidate and RNG order', () => {
  const config = oldRules(), out = spin(mixed, [0], config);
  assert.equal(candidateLines(mixed, config).length, 4);
  assert.equal(out.randomTrace[9].bound, 4);
  assert.equal(out.triggeredItems[0].lineId, 'row_top');
  assert.equal(out.triggeredItems[0].changeIndex, 2);
  assert.equal(out.board[2], 'lemon');
  assert.deepEqual(out.board.slice(3), mixed.slice(3));
});

test('protection policy is optional for old saves, strictly true when present, and described by catalog', () => {
  assert.doesNotThrow(oldRules);
  for (const value of [false, 'true', 1, null]) {
    const raw = rawRules(); raw.catalog.items.find(i => i.id === 'help_hand').effect.protectCompletedLines = value;
    assert.throws(() => parseRules(raw), { code: 'INVALID_RULES' });
  }
  assert.match(publicCatalog(rules).items.find(i => i.id === 'help_hand').description, /완성된 라인/);
  assert.doesNotMatch(publicCatalog(oldRules()).items.find(i => i.id === 'help_hand').description, /완성된 라인/);
});

test('new and legacy help-hand runs replay exactly and retries consume no extra randomness', () => {
  for (const config of [rules, oldRules()]) {
    const session = new GameSession(config, { userId: 'test', seed, initialItemIds: ['help_hand'] });
    const command = { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'protected-spin' };
    const result = session.execute('test', command);
    assert.deepEqual(session.execute('test', command), result);
    assert.deepEqual(restoreSession(config, session.exportAudit()).exportAudit(), session.exportAudit());
  }
});
