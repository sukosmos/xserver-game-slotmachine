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

test('awards highlight one at a time before multipliers; reduced motion uses a static summary', async () => {
  const awards = [{ id: 'row_top' }, { id: 'col_left' }, { id: 'diag_main' }, { id: 'square_top_left' }];
  for (const [reduced, fast] of [[false, false], [false, true], [true, false]]) {
    const stages = [], durations = [];
    await presentSpin({ event: { rawBoard: ['cherry'], board: ['cherry'] }, presentation: { awards, effects: [{ label: '×4' }] }, reduced, fast,
      show: (stage, data) => stages.push({ stage, award: data?.award?.id }), fill: async () => stages.push({ stage: 'filled' }), wait: async (ms) => durations.push(ms) });
    assert.deepEqual(stages.filter((s) => s.stage === 'award').map((s) => s.award), reduced ? [] : awards.map((a) => a.id));
    assert.ok(stages.findIndex((s) => s.stage === (reduced ? 'awards' : 'award')) < stages.findIndex((s) => s.stage === 'effects'));
    if (!reduced) assert.equal(durations.filter((ms) => ms === (fast ? 85 : 140)).length, 4);
  }
});

test('emergency Hand is announced after final score before enabling another spin', async () => {
  const stages = [];
  await presentSpin({ event: { rawBoard: ['cherry'], board: ['cherry'], emergency: { handsGranted: 1 } },
    presentation: { emergency: { handsGranted: 1 } }, show: (stage) => stages.push(stage),
    fill: async () => stages.push('fill'), wait: async () => {} });
  assert.ok(stages.indexOf('emergency') > stages.indexOf('fill'));
  assert.ok(!stages.includes('clear'));
});
