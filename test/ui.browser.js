// Optional browser acceptance: PLAYWRIGHT_MODULE may point to an installed Playwright ESM module.
// Runs against an isolated in-memory game; never touches the player's saved runs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
import { parseRules } from '../src/domain/rules.js';
import { rawRules } from './helpers.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const raw = rawRules();
raw.balance.round.roundTargets.forEach(row => { row.targetScore = '1000000000000'; });
const store = new GameStore({ filename: ':memory:', key: randomBytes(32), rules: parseRules(raw) });
const server = createGameServer({ store, localPlayer: 'ui-test' });
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ reducedMotion: 'no-preference', viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.testClips = []; window.testAudioEvents = []; window.testBeeps = []; window.testGains = [];
    const setValueAtTime = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (value, time) {
      window.testGains.push(value); return setValueAtTime.call(this, value, time);
    };
    const createOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const oscillator = createOscillator.call(this), start = oscillator.start.bind(oscillator);
      oscillator.start = (...args) => {
        window.testBeeps.push({ frequency: oscillator.frequency.value, stage: document.querySelector('#scene')?.className,
          award: document.querySelector('.paylines [data-award-id]')?.dataset.awardId });
        return start(...args);
      };
      return oscillator;
    };
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(url) {
        super(url); window.testClips.push(this);
        for (const type of ['playing', 'ended', 'pause', 'error']) this.addEventListener(type, () => {
          window.testAudioEvents.push({ type, time: this.currentTime, stage: document.querySelector('#scene')?.className });
        });
      }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-action="start"]').click();
  await page.locator('.lever:not(:disabled)').waitFor();
  // Deterministic presentation fixture: three lines, one pattern and one item cue.
  // Server/domain behavior is covered separately; this isolates highlight/audio synchronization.
  const lineIds = ['row_top', 'row_middle', 'row_bottom'];
  const showThreeLines = async route => {
    const response = await route.fetch(), result = await response.json();
    result.presentation.awards = lineIds.map((id, row) => ({ kind: 'line', id, label: `가로 ${row + 1}`,
      indices: [row * 3, row * 3 + 1, row * 3 + 2], symbol: 'cherry', score: '30' }));
    result.presentation.awards.push({ kind: 'square', id: 'square_top_left', label: '2×2', indices: [0, 1, 3, 4], symbol: 'cherry', score: '30' });
    result.presentation.effects = [{ name: '효과 표시 검증', label: '×1' }];
    await route.fulfill({ response, json: result });
  };
  await page.route('**/spins', showThreeLines);

  // Structural insertions must not replace keyed siblings or unchanged SVGs.
  const patchResult = await page.evaluate(async () => {
    const { renderInto } = await import('/render.js');
    const root = document.createElement('div'); document.body.append(root);
    const body = '<section data-render-key="stable"><svg><use href="/icons.svg#cherry"></use></svg><details><summary>More</summary><p>Details</p></details><button>Before</button></section>';
    renderInto(root, body);
    const section = root.firstChild, icon = root.querySelector('svg'), use = root.querySelector('use');
    root.querySelector('details').open = true;
    let hrefWrites = 0;
    const observer = new MutationObserver(records => { hrefWrites += records.length; });
    observer.observe(use, { attributes: true });
    renderInto(root, '<div data-render-key="notice">Notice</div>' + body.replace('Before', 'After'));
    await Promise.resolve();
    const result = { same: section === root.lastChild && icon === root.querySelector('svg'), hrefWrites,
      open: root.querySelector('details').open, text: root.querySelector('button').textContent };
    renderInto(root, body);
    result.removedNotice = root.childElementCount === 1 && root.firstChild === section;
    observer.disconnect(); root.remove(); return result;
  });
  assert.deepEqual(patchResult, { same: true, hrefWrites: 0, open: true, text: 'After', removedNotice: true });

  async function settings({ sound = true, fast = false, reduced = false }) {
    await page.locator('[data-action="settings"]').click();
    await page.locator('#sound').setChecked(sound);
    await page.locator('#fast').setChecked(fast);
    await page.locator('#reduced').setChecked(reduced);
    await page.getByRole('button', { name: '설정 닫기' }).click();
  }
  async function observeSpin() {
    await page.evaluate(() => {
      window.testBeeps = [];
      window.testGains = [];
      window.stableIcons = [...document.querySelectorAll('.run-toolbar svg, .symbol-table svg')];
      window.reelGrid = document.querySelector('.reel-grid');
      window.leverNode = document.querySelector('.lever-arm');
      window.stageObservations = [];
      window.spinObserver = new MutationObserver(() => {
        window.stageObservations.push({ stage: document.querySelector('#scene')?.className,
          stable: window.stableIcons.every(node => node.isConnected),
          grid: window.reelGrid === document.querySelector('.reel-grid'),
          lever: window.leverNode === document.querySelector('.lever-arm') });
      });
      window.spinObserver.observe(document.querySelector('#main'), { subtree: true, childList: true, attributes: true });
    });
    await page.locator('.lever').click();
    await page.waitForFunction(() => document.querySelector('#main').getAttribute('aria-busy') === 'false');
    return page.evaluate(() => { window.spinObserver.disconnect(); return window.stageObservations; });
  }

  await settings({});
  await page.waitForFunction(() => window.testClips[0]?.readyState === 4);
  const duration = await page.evaluate(() => window.testClips[0].duration);
  assert.equal(duration, 1.06);
  const observations = await observeSpin();
  assert.ok(observations.some(row => row.stage.includes('motion-stopping')));
  assert.ok(observations.every(row => row.stable && row.grid && row.lever), JSON.stringify(observations));
  const audioEvents = await page.evaluate(() => window.testAudioEvents);
  assert.ok(audioEvents.some(event => event.type === 'playing' && event.stage.includes('motion-rolling')));
  assert.ok(audioEvents.some(event => event.type === 'ended' || event.type === 'pause'));
  assert.equal(await page.evaluate(() => window.testClips[0].paused), true);
  const lineBeeps = await page.evaluate(() => window.testBeeps);
  assert.deepEqual(lineBeeps.map(beep => beep.award), lineIds);
  assert.ok(lineBeeps.every(beep => beep.frequency === 660 && beep.stage.includes('motion-award')));
  assert.deepEqual(await page.evaluate(() => window.testGains), [0.12, 0.12, 0.12]);
  assert.equal(await page.evaluate(() => window.testClips[0].volume), 0.3);
  const firstPlays = audioEvents.filter(event => event.type === 'playing').length;
  for (const preferences of [{ fast: true }, { reduced: true }, { sound: false }]) {
    await settings(preferences);
    const stages = await observeSpin();
    assert.ok(stages.every(row => row.stable && row.grid && row.lever));
    assert.equal(await page.evaluate(() => window.testAudioEvents.filter(event => event.type === 'playing').length), firstPlays);
    assert.deepEqual(await page.evaluate(() => window.testBeeps.map(beep => beep.award)), preferences.fast ? lineIds : []);
  }

  await settings({});
  await page.unroute('**/spins', showThreeLines);
  await page.route('**/spins', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_REJECTED' } }) }));
  await observeSpin();
  assert.equal(await page.evaluate(() => window.testClips[0].paused), true);
  await page.unroute('**/spins');
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('[data-tab="catalog"]').click();
  await page.locator('[data-action="item"][data-value="hootie_fruitie"]').click();
  assert.ok((await page.locator('#detail-content').textContent()).includes('R6 상점부터'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, audioDuration: duration, observedUpdates: observations.length,
    stableIcons: true, normalSound: true, mutedModes: 3, lineBeeps: lineBeeps.length, reducedBeeps: 0,
    errorCleanup: true, mobileOverflow: false }));
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  store.close();
}
