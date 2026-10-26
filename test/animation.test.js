import test from 'node:test';
import assert from 'node:assert/strict';
import { presentSpin, interpolateScore } from '../web/spin-animation.js';

test('presentation reveals effects and fills score before clear; completion permits shop transition', async () => {
  for (const reduced of [false, true]) {
    const calls = [], event = { board: ['lemon'], rawBoard: ['cherry'], settlement: { reward: 8 } };
    const original = structuredClone(event);
    await presentSpin({ event, presentation: { effects: [{ label: '×1.5' }] }, reduced,
      show: (stage) => calls.push(stage), wait: async () => {}, fill: async () => calls.push('fill') });
    calls.push('shop');
    assert.ok(calls.indexOf('effects') < calls.indexOf('fill'));
    assert.ok(calls.indexOf('fill') < calls.indexOf('clear'));
    assert.ok(calls.indexOf('clear') < calls.indexOf('shop'));
    assert.deepEqual(event, original);
  }
});
test('failure shows final score without clear and huge score interpolation remains exact', async () => {
  const stages = [];
  await presentSpin({ event: { rawBoard: ['cherry'], board: ['cherry'], settlement: null },
    show: (stage) => stages.push(stage), wait: async () => {}, fill: async () => {} });
  assert.ok(!stages.includes('clear'));
  const from = '1000000000000000000000000000001', to = '2000000000000000000000000000007';
  assert.equal(interpolateScore(from, to, 0), from);
  assert.equal(interpolateScore(from, to, 1000), to);
  assert.equal(interpolateScore(from, to, 500), '1500000000000000000000000000004');
});
