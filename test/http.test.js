import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
import { parseRules } from '../src/domain/rules.js';
import { rawRules } from './helpers.js';

async function setup(t, serverOptions = {}, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nine-http-'));
  const raw = rawRules(); mutate(raw);
  const store = new GameStore({ filename: join(dir, 'game.sqlite'), key: randomBytes(32), rules: parseRules(raw) });
  const token = store.issueToken('alice'), otherToken = store.issueToken('bob');
  const server = createGameServer({ store, ...serverOptions });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { body, key, auth = token, method = body === undefined ? 'GET' : 'POST', rawBody, headers = {} } = {}) {
    const response = await fetch(`${url}/api/game/v1${path}`, {
      method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}), ...headers }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  return { store, token, otherToken, server, call };
}

test('HTTP authentication, ownership, state recovery and create/spin idempotency', async (t) => {
  const { call, otherToken, store, token } = await setup(t);
  assert.equal((await call('/runs', { auth: null })).status, 401);
  assert.equal((await call('/runs', { auth: 'forged' })).status, 401);
  assert.equal((await call('/runs', { body: {}, key: 'create' })).status, 201);
  const created = await call('/runs', { body: {}, key: 'create' });
  const id = created.data.state.runId;
  assert.equal((await call('/runs')).data.runs.length, 1);
  assert.equal((await call(`/runs/${id}`, { auth: otherToken })).status, 404);
  assert.equal((await call(`/runs/${id}/spins`, { auth: otherToken, body: { expectedRevision: 0 }, key: 'spin' })).status, 404);
  const spin = await call(`/runs/${id}/spins`, { body: { expectedRevision: 0 }, key: 'spin' });
  assert.equal(spin.status, 200);
  assert.equal(spin.data.state.handsRemaining, 3);
  assert.equal(typeof spin.data.state.runTotalScore, 'string');
  assert.deepEqual((await call(`/runs/${id}/spins`, { body: { expectedRevision: 0 }, key: 'spin' })).data, spin.data);
  assert.equal((await call(`/runs/${id}/spins`, { body: { expectedRevision: 0 }, key: 'stale' })).status, 409);
  const view = await call(`/runs/${id}`);
  assert.deepEqual(view.data.lastSpin, spin.data.event);
  assert.equal(view.headers.get('cache-control'), 'no-store');
  for (const secret of [token, 'initialSeed', 'randomTrace', 'rngBefore', 'owner_id', 'alice']) assert.ok(!JSON.stringify(view.data).includes(secret));
  store.revokeTokens('alice');
  assert.equal((await call(`/runs/${id}`)).status, 401);
});

test('HTTP rejects injected scores, seeds, prices, extra fields, malformed/large JSON and invalid queries', async (t) => {
  const { call } = await setup(t);
  for (const field of ['userId', 'seed', 'initialItemIds', 'score', 'coins']) {
    assert.equal((await call('/runs', { body: { [field]: 'forged' }, key: 'create' })).status, 400);
  }
  assert.equal((await call('/runs', { body: {} })).status, 400);
  assert.equal((await call('/runs', { method: 'POST', rawBody: '{' })).status, 400);
  assert.equal((await call('/runs', { body: [], key: 'create' })).status, 400);
  assert.equal((await call('/runs', { method: 'POST', rawBody: 'x'.repeat(5000), key: 'create' })).status, 413);
  assert.equal((await call('/runs', { body: {}, key: 'create', headers: { 'Content-Type': 'text/plain' } })).status, 400);
  const id = (await call('/runs', { body: {}, key: 'valid' })).data.state.runId;
  for (const field of ['score', 'coins', 'seed', 'board', 'type', 'userId', 'idempotencyKey']) {
    assert.equal((await call(`/runs/${id}/spins`, { body: { expectedRevision: 0, [field]: 'forged' }, key: 'spin' })).status, 400);
  }
  assert.equal((await call(`/runs/${id}/shop/purchases`, { body: { expectedRevision: 0, slotId: 'fake', price: 0 }, key: 'buy' })).status, 400);
  for (const query of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?userId=bob', '?limit=1e2']) {
    assert.equal((await call(`/runs${query}`)).status, 400);
  }
  assert.equal((await call(`/runs/${id}`)).data.state.revision, 0);
  assert.equal((await call('/leaderboard', { body: { score: '99999' }, key: 'rank' })).status, 404);
});

test('HTTP shop actions and server-only terminal ranking work through all REST routes', async (t) => {
  const { call } = await setup(t, {}, (raw) => {
    raw.balance.round.roundTargets.forEach((target) => { target.targetScore = '1'; });
    raw.balance.economy.startingCoins = 50;
    raw.catalog.items = raw.catalog.items.filter((item) => ['cherry_farm', 'lemon_orchard', 'golden_harvest'].includes(item.id));
  });
  let state = (await call('/runs', { body: {}, key: 'create' })).data.state;
  const id = state.runId;
  async function act(suffix, extra = {}) {
    const result = await call(`/runs/${id}/${suffix}`, { body: { expectedRevision: state.revision, ...extra }, key: `act-${state.revision}` });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    state = result.data.state;
    return result.data;
  }
  await act('spins'); await act('claim');
  const bought = await act('shop/purchases', { slotId: state.shop.slots[0].slotId });
  assert.ok(bought.event.price > 0);
  await act('shop/rerolls');
  await act('shop/discards', { instanceId: state.items[0].instanceId });
  await act('shop/continue');
  for (let round = 2; round <= 10; round++) {
    await act('spins'); await act('claim');
    if (round < 10) await act('shop/continue');
  }
  assert.equal(state.phase, 'RUN_WON');
  const rank = (await call('/leaderboard')).data.entries[0];
  assert.equal(rank.completedRounds, 10);
  assert.equal(rank.runTotalScore, state.runTotalScore);
  assert.equal(rank.playerId, (await call('/me')).data.playerId);
});

test('rate limits reject extra requests and recover after the window', async (t) => {
  let time = 1000;
  const { call } = await setup(t, { rateLimit: 1, windowMs: 1000, now: () => time });
  assert.equal((await call('/me')).status, 200);
  const blocked = await call('/me');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '1');
  time += 1000;
  assert.equal((await call('/me')).status, 200);
});
