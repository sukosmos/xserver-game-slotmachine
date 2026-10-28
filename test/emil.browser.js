// Isolated real-server/browser acceptance. No access to the player's runtime database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
import { parseRules } from '../src/domain/rules.js';
import { rawRules } from './helpers.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const raw = rawRules();
raw.balance.round.roundTargets.forEach(row => { row.targetScore = '1'; });
raw.balance.economy.startingCoins = 100;
const keep = new Set([...raw.balance.shop.upgradeItemIds, 'emils_shop', 'rock_bottom']);
raw.catalog.items = raw.catalog.items.filter(item => keep.has(item.id));
const store = new GameStore({ filename: ':memory:', key: randomBytes(32), rules: parseRules(raw) });
const server = createGameServer({ store, localPlayer: 'emil-ui' });
let browser;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ reducedMotion: 'no-preference', viewport: { width: 360, height: 800 } });
  const errors = [], purchases = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/shop/destiny')) purchases.push(request.postDataJSON()); });
  await page.addInitScript(() => localStorage.setItem('nine.preferences', JSON.stringify({ fast: true, reduced: false, sound: false })));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-action="start"]').click();
  const idle = () => page.waitForFunction(() => document.querySelector('#main').getAttribute('aria-busy') === 'false');
  await idle();
  for (let round = 1; round <= 5; round++) {
    await page.locator('.lever').click(); await idle();
    if (round === 3) { await page.locator('[data-action="choose-card"]').first().click(); await idle(); }
    if (round < 5) { await page.locator('[data-action="continue"]').click(); await idle(); }
  }
  const runId = store.listRuns('emil-ui').runs[0].runId;
  const snapshot = () => store.getRun('emil-ui', runId).state;
  const before = snapshot(), offer = before.shop.slots.find(slot => slot.itemId === 'emils_shop');
  const buy = () => page.locator(`[data-action="buy"][data-value="${offer.slotId}"]`).click();
  const cards = page.locator('#details [data-action="buy-destiny"]');
  await buy();
  assert.equal(await cards.count(), 3);
  assert.equal(await page.locator('#details .revealed, #details .card-front svg').count(), 0);
  assert.equal(await page.evaluate(() => document.querySelector('#details').scrollWidth <= document.querySelector('#details').clientWidth), true);
  const positions = await cards.evaluateAll(nodes => nodes.map(node => node.dataset.value));
  assert.ok(positions.every(value => !value.includes('selectedDestinyCardId')));
  assert.deepEqual(snapshot(), before);
  await page.screenshot({ path: '/tmp/nine-emil-before.png' });
  await page.locator('#details form button').click();
  assert.equal(purchases.length, 0); assert.deepEqual(snapshot(), before);
  await buy();
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.value)), positions);
  await page.reload(); await idle(); await buy();
  assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.value)), positions);
  await cards.nth(1).click();
  await page.locator('#details .fate-card.revealed').waitFor();
  assert.equal(await page.locator('#details .fate-card.revealed').count(), 1);
  assert.equal(await page.locator('#details .fate-card.unchosen').count(), 2);
  assert.equal(await page.locator('#details .card-front svg').count(), 1);
  const rewardName = await page.locator('#details .card-result strong').textContent();
  await page.waitForFunction(() => {
    const inner = document.querySelector('#details .revealed .card-inner');
    return inner && new DOMMatrixReadOnly(getComputedStyle(inner).transform).m11 < -0.99;
  });
  await page.screenshot({ path: '/tmp/nine-emil-after.png' });
  await idle();
  const after = snapshot(), reward = after.milestoneRewards.find(card => !before.milestoneRewards.some(old => old.cardId === card.cardId));
  assert.equal(reward.name, rewardName);
  assert.equal(after.coins, before.coins - offer.price + (reward.coinsGranted ?? 0));
  assert.equal(after.milestoneRewards.length, 2);
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].selectedDestinySlotId, JSON.parse(positions[1]).selectedDestinySlotId);
  assert.ok(!('selectedDestinyCardId' in purchases[0]));
  await page.reload(); await idle(); assert.deepEqual(snapshot(), after);
  await page.locator('[data-tab="catalog"]').click();
  await page.locator('[data-action="item"][data-value="rock_bottom"]').click();
  assert.equal(await page.locator('#detail-content h2').textContent(), '도굴꾼');
  assert.match(await page.locator('#detail-content').textContent(), /×50/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, hiddenCards: 3, revealedCards: 1, cancelCharged: false, reloadStable: true,
    purchases: purchases.length, graveRobberMultiplier: 50, consoleErrors: 0 }));
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  store.close();
}
