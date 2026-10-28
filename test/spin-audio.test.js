import test from 'node:test';
import assert from 'node:assert/strict';
import { SpinAudio } from '../web/spin-audio.js';
import { presentSpin } from '../web/spin-animation.js';

function setup(play = () => Promise.resolve()) {
  const clips = [];
  const sound = new SpinAudio({ createAudio: (url) => {
    const clip = { url, currentTime: 0, pauses: 0, plays: [], preload: '', loop: true,
      play() { this.plays.push(this.currentTime); return play(); },
      pause() { this.pauses++; } };
    clips.push(clip); return clip;
  } });
  return { sound, clips };
}
const normal = { sound: true, fast: false, reduced: false };

test('reel sound is opt-in and suppressed by fast or reduced presentation', () => {
  for (const preferences of [{ ...normal, sound: false }, { ...normal, fast: true }, { ...normal, reduced: true }]) {
    const { sound, clips } = setup();
    sound.start(preferences);
    assert.equal(clips.length, 0);
  }
});

test('each spin starts the short clip from zero without looping or overlapping', () => {
  const { sound, clips } = setup();
  sound.prepare(normal);
  assert.equal(clips[0].preload, 'auto');
  assert.deepEqual(clips[0].plays, []);
  sound.start(normal);
  clips[0].currentTime = 0.7;
  sound.start(normal);
  assert.deepEqual(clips[0].plays, [0, 0]);
  assert.equal(clips[0].loop, false);
  assert.equal(clips[0].url, '/audio/spin-start.wav');
  sound.stop(); sound.stop();
  assert.equal(clips[0].currentTime, 0);
  assert.ok(clips[0].pauses >= 3);
});

test('stopping the reels silences audio before raw or final boards, awards and score', async () => {
  for (const changed of [false, true]) {
    const { sound, clips } = setup();
    sound.start(normal);
    const initialPauses = clips[0].pauses;
    await presentSpin({ event: { rawBoard: ['cherry'], board: [changed ? 'lemon' : 'cherry'] },
      show(stage) {
        sound.onStage(stage);
        assert.equal(clips[0].pauses > initialPauses, stage !== 'stopping');
      }, fill: async () => {}, wait: async () => {} });
  }
});

test('preference changes and failure cleanup stop playback, including a pending play', async () => {
  let finish;
  const { sound, clips } = setup(() => new Promise((resolve) => { finish = resolve; }));
  sound.start(normal);
  sound.prepare({ ...normal, fast: true });
  assert.equal(clips[0].currentTime, 0);
  finish(); await Promise.resolve();
  assert.ok(clips[0].pauses > 0);
  sound.start(normal); sound.stop(); finish(); await Promise.resolve();
  assert.equal(clips[0].currentTime, 0);
});

test('unsupported audio, synchronous failures and rejected playback never block a spin', async () => {
  const unavailable = new SpinAudio({ createAudio() { throw new Error('No audio'); } });
  assert.doesNotThrow(() => unavailable.start(normal));
  for (const play of [() => { throw new Error('Unsupported'); }, () => Promise.reject(new Error('NotAllowedError'))]) {
    const { sound } = setup(play);
    assert.doesNotThrow(() => sound.start(normal));
    await Promise.resolve();
    assert.doesNotThrow(() => sound.stop());
  }
});
