import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
import { parseRules } from '../src/domain/rules.js';
import { rawLegacyRules as rawRules } from './helpers.js';
import { rawRules as currentRawRules } from './helpers.js';

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
  return { store, token, otherToken, server, call, url };
}

async function sharedCall(url, path, { body, cookie, origin = 'https://nine.example', host = 'nine.example', key } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/api/game/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Host: host, ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    }, (res) => {
      let output = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { output += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(output) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('shared guests have separate ownership, secure cookies and resumable idempotent games', async (t) => {
  const { url } = await setup(t, { guestOrigin: 'https://nine.example' });
  assert.equal((await sharedCall(url, '/bootstrap')).data.guestPlay, true);
  const a = await sharedCall(url, '/guest-session', { body: {} });
  const b = await sharedCall(url, '/guest-session', { body: {} });
  assert.equal(a.status, 200); assert.notEqual(a.data.playerId, b.data.playerId);
  const header = a.headers['set-cookie'][0];
  assert.match(header, /^__Secure-nine_guest=/); assert.match(header, /HttpOnly; Secure; SameSite=Strict; Path=\/api\/game\/v1/);
  const cookie = header.split(';')[0], otherCookie = b.headers['set-cookie'][0].split(';')[0];
  const again = await sharedCall(url, '/guest-session', { body: {}, cookie });
  assert.equal(again.headers['set-cookie'][0], header); assert.deepEqual(again.data, a.data);
  const created = await sharedCall(url, '/runs', { body: {}, cookie, key: 'shared-create' });
  assert.equal(created.status, 201);
  const id = created.data.state.runId;
  assert.equal((await sharedCall(url, `/runs/${id}`, { cookie: otherCookie })).status, 404);
  assert.equal((await sharedCall(url, `/runs/${id}/spins`, { body: { expectedRevision: 0 }, cookie: otherCookie, key: 'other' })).status, 404);
  const spin = await sharedCall(url, `/runs/${id}/spins`, { body: { expectedRevision: 0 }, cookie, key: 'shared-spin' });
  assert.equal(spin.status, 200);
  assert.deepEqual((await sharedCall(url, `/runs/${id}/spins`, { body: { expectedRevision: 0 }, cookie, key: 'shared-spin' })).data, spin.data);
  assert.deepEqual((await sharedCall(url, `/runs/${id}`, { cookie })).data.state, spin.data.state);
});

test('shared sessions reject foreign hosts, origins, local credentials and chosen identities', async (t) => {
  const { url, token } = await setup(t, { guestOrigin: 'https://nine.example' });
  for (const origin of [null, 'http://nine.example', 'https://evil.example']) {
    assert.equal((await sharedCall(url, '/guest-session', { body: {}, origin })).status, 403);
  }
  assert.equal((await sharedCall(url, '/bootstrap', { host: 'evil.example' })).status, 403);
  assert.equal((await sharedCall(url, '/guest-session', { body: { userId: 'alice' } })).status, 400);
  assert.equal((await sharedCall(url, '/local-session', { body: {} })).status, 404);
  assert.equal((await sharedCall(url, '/me', { cookie: `nine_session=${token}` })).status, 401);
  assert.equal((await sharedCall(url, '/me', { cookie: `__Secure-nine_guest=${token}` })).status, 401);
  const connected = await sharedCall(url, '/guest-session', { body: {} });
  const cookie = connected.headers['set-cookie'][0].split(';')[0];
  assert.equal((await sharedCall(url, '/runs', { body: {}, cookie, key: 'csrf', origin: null })).status, 403);
  assert.equal((await sharedCall(url, '/runs', { body: {}, cookie, key: 'csrf', origin: 'https://evil.example' })).status, 403);
  assert.equal((await sharedCall(url, '/me', { cookie, host: 'evil.example' })).status, 403);
});

test('guest creation is capped without preventing established guest reconnection', async (t) => {
  const { url } = await setup(t, { guestOrigin: 'https://nine.example' });
  let cookie;
  for (let i = 0; i < 32; i++) {
    const session = await sharedCall(url, '/guest-session', { body: {} });
    assert.equal(session.status, 200); cookie ??= session.headers['set-cookie'][0].split(';')[0];
  }
  assert.equal((await sharedCall(url, '/guest-session', { body: {} })).status, 429);
  assert.equal((await sharedCall(url, '/guest-session', { body: {}, cookie })).status, 200);
});

test('guest mode is opt-in and only accepts a clean HTTPS origin separate from local play', async (t) => {
  const { call, store } = await setup(t);
  assert.equal((await call('/guest-session', { auth: null, body: {} })).status, 404);
  for (const guestOrigin of ['http://nine.example', 'https://nine.example/path', 'https://nine.example/', 'https://a:b@nine.example', 'bad']) {
    assert.throws(() => createGameServer({ store, guestOrigin }));
  }
  assert.throws(() => createGameServer({ store, guestOrigin: 'https://nine.example', localPlayer: 'local-player' }));
});

test('current HTTP rules grant three coins, auto settle, and activate purchased Hands next round', async (t) => {
  const { call } = await setup(t, {}, (raw) => {
    Object.assign(raw, currentRawRules());
    delete raw.balance.round.milestoneCards; // Isolated shop pool; cards have separate HTTP coverage.
    raw.balance.round.roundTargets[0].targetScore = '1';
    raw.catalog.items = raw.catalog.items.filter((item) => ['cherry_farm', 'golden_harvest', 'extra_hand', 'square_seal', 'win_streak'].includes(item.id));
  });
  const created = (await call('/runs', { body: {}, key: 'auto-create' })).data;
  assert.equal(created.state.coins, 3);
  const id = created.state.runId;
  const first = await call(`/runs/${id}/spins`, { body: { expectedRevision: 0 }, key: 'auto-spin' });
  assert.equal(first.status, 200); assert.equal(first.data.state.phase, 'SHOP');
  assert.equal(first.data.state.coins, 11); assert.equal(first.data.event.settlement.handBonus, 4);
  assert.equal(first.data.presentation.multiplier, '×1');
  assert.equal(first.data.event.patternScore, '0');
  assert.deepEqual(first.data.event.winningPatterns, []);
  assert.ok(first.data.presentation.awards.every((award) => award.kind === 'line' && typeof award.score === 'string' && award.indices.length === 3));
  assert.equal(first.data.state.shop.slots.length, 4);
  assert.equal(new Set(first.data.state.shop.slots.map((slot) => slot.itemId)).size, 4);
  assert.deepEqual((await call(`/runs/${id}`)).data.presentation, first.data.presentation);
  assert.equal(first.data.state.revision, 1); assert.equal(first.data.state.canClaim, false);
  assert.deepEqual((await call(`/runs/${id}/spins`, { body: { expectedRevision: 0 }, key: 'auto-spin' })).data, first.data);
  for (const route of ['spins', 'claim']) {
    assert.equal((await call(`/runs/${id}/${route}`, { body: { expectedRevision: 1 }, key: `invalid-${route}` })).status, 409);
  }
  assert.ok(!first.data.state.shop.slots.some((slot) => slot.itemId === 'cherry_farm'));
  const hand = first.data.state.shop.slots.find((slot) => slot.itemId === 'extra_hand');
  const bought = (await call(`/runs/${id}/shop/purchases`, { body: { expectedRevision: 1, slotId: hand.slotId }, key: 'buy' })).data;
  assert.equal(bought.state.coins, 6); assert.equal(bought.upgrades.next.hands, 6);
  const rerolled = (await call(`/runs/${id}/shop/rerolls`, { body: { expectedRevision: 2 }, key: 'reroll' })).data;
  assert.equal(rerolled.state.coins, 5);
  const next = (await call(`/runs/${id}/shop/continue`, { body: { expectedRevision: 3 }, key: 'next' })).data;
  assert.equal(next.state.coins, 5); assert.equal(next.state.roundIndex, 2); assert.equal(next.state.handsRemaining, 6);
  assert.equal(next.state.roundHands, 6); assert.equal(next.upgrades.current.hands, 6);
  assert.deepEqual((await call('/runs', { body: {}, key: 'auto-create' })).data, created);
});

test('card choice HTTP hides the order, validates ownership and commits exactly one choice', async (t) => {
  const { call, otherToken } = await setup(t, {}, (raw) => {
    Object.assign(raw, currentRawRules());
    raw.balance.round.roundTargets.forEach((row) => { row.targetScore = '1'; });
  });
  let current = (await call('/runs', { body:{}, key:'card-run' })).data;
  const id = current.state.runId;
  for (let round=1;round<=3;round++) {
    current = (await call(`/runs/${id}/spins`, { body:{expectedRevision:current.state.revision}, key:`spin-${round}` })).data;
    if(round<3) current=(await call(`/runs/${id}/shop/continue`,{body:{expectedRevision:current.state.revision},key:`continue-${round}`})).data;
  }
  assert.equal(current.state.phase,'CARD_CHOICE'); assert.equal(current.state.shop,null);
  for(const privateField of ['cardOffer','cardId','milestone_shuffle','rngBefore']) assert.ok(!JSON.stringify(current).includes(privateField));
  const body={expectedRevision:current.state.revision,slotId:current.state.cardChoice.slots[0].slotId};
  assert.equal((await call(`/runs/${id}/cards/choice`,{body,key:'not-owner',auth:otherToken})).status,404);
  assert.equal((await call(`/runs/${id}/cards/choice`,{body:{...body,cardId:'evolve'},key:'inject'})).status,400);
  assert.equal((await call(`/runs/${id}/cards/choice`,{body:{...body,slotId:'evolve'},key:'unknown'})).status,409);
  const chosen=await call(`/runs/${id}/cards/choice`,{body,key:'chosen'});
  assert.equal(chosen.status,200); assert.equal(chosen.data.state.phase,'SHOP');
  assert.equal(chosen.data.state.coins,current.state.coins+(chosen.data.state.milestoneReward.coinsGranted??0));
  assert.deepEqual((await call(`/runs/${id}/cards/choice`,{body,key:'chosen'})).data,chosen.data);
  assert.equal((await call(`/runs/${id}/cards/choice`,{body,key:'race'})).status,409);
});

test('static allowlist serves the game with CSP and never serves source or private files', async (t) => {
  const { url, call, token } = await setup(t);
  for (const path of ['/', '/app.js', '/client.js', '/format.js', '/spin-animation.js', '/styles.css', '/icons.svg']) {
    const result = await fetch(url + path);
    assert.equal(result.status, 200); assert.match(result.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok((await result.text()).length > 100);
  }
  for (const path of ['/.runtime/master.key', '/src/server/store.js', '/package.json', '/data/balance.json']) {
    assert.notEqual((await fetch(url + path)).status, 200);
  }
  assert.equal((await call('/bootstrap', { auth: null })).data.localPlay, false);
  assert.equal((await call('/me', { auth: null, headers: { Cookie: `nine_session=${token}` } })).status, 401);
  assert.equal((await call('/local-session', { auth: null, body: {}, headers: { Origin: url } })).status, 404);
});

test('local play cookie is opt-in, loopback-only, HttpOnly and protected against cross-origin mutations', async (t) => {
  const { call, url } = await setup(t, { localPlayer: 'local-player' });
  assert.equal((await call('/bootstrap', { auth: null })).data.localPlay, true);
  const forgedHost = await new Promise((resolve, reject) => {
    const req = request(url + '/api/game/v1/bootstrap', { headers: { Host: 'evil.example' } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (part) => { body += part; }); res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedHost.localPlay, false);
  assert.equal((await call('/local-session', { auth: null, body: {} })).status, 403);
  assert.equal((await call('/local-session', { auth: null, body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/local-session', { auth: null, body: { userId: 'alice' }, headers: { Origin: url } })).status, 400);
  const session = await call('/local-session', { auth: null, body: {}, headers: { Origin: url } });
  assert.equal(session.status, 200);
  const setCookie = session.headers.get('set-cookie'); assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const Cookie = setCookie.split(';')[0];
  assert.equal((await call('/me', { auth: null, headers: { Cookie } })).data.playerId, session.data.playerId);
  assert.equal((await call('/runs', { auth: null, body: {}, key: 'csrf', headers: { Cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/runs', { auth: null, body: {}, key: 'csrf', headers: { Cookie } })).status, 403);
  const created = await call('/runs', { auth: null, body: {}, key: 'local', headers: { Cookie, Origin: url } });
  assert.equal(created.status, 201);
  const reused = await call('/local-session', { auth: null, body: {}, headers: { Cookie, Origin: url } });
  assert.equal(reused.headers.get('set-cookie'), setCookie);
});

test('catalog is JSON-derived and run catalogs enforce ownership', async (t) => {
  const { call, otherToken } = await setup(t);
  const catalog = (await call('/catalog')).data;
  assert.equal(catalog.items.length, 27); assert.equal(catalog.lines.length, 8);
  assert.ok(catalog.items.every((item) => item.description.length > 10));
  assert.ok(catalog.targets.every((target) => typeof target === 'string'));
  assert.ok(!JSON.stringify(catalog).includes('initialSeed'));
  const id = (await call('/runs', { body: {}, key: 'catalog' })).data.state.runId;
  assert.deepEqual((await call(`/runs/${id}/catalog`)).data, catalog);
  assert.equal((await call(`/runs/${id}/catalog`, { auth: otherToken })).status, 404);
});

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

test('upgrade responses track purchase preview, activation, discard and original idempotent state', async (t) => {
  const { call } = await setup(t, {}, (raw) => {
    raw.balance.round.roundTargets.forEach((target) => { target.targetScore = '1'; });
    raw.balance.economy.startingCoins = 50;
    raw.catalog.items = raw.catalog.items.filter((item) => item.id === 'golden_harvest');
  });
  let result = (await call('/runs', { body: {}, key: 'upgrade-create' })).data;
  const id = result.state.runId;
  const act = async (suffix, extra = {}) => {
    const res = await call(`/runs/${id}/${suffix}`, { body: { expectedRevision: result.state.revision, ...extra }, key: `upgrade-${result.state.revision}` });
    assert.equal(res.status, 200); result = res.data;
    assert.equal(result.upgrades.revision, result.state.revision);
  };
  await act('spins'); await act('claim');
  await act('shop/purchases', { slotId: result.state.shop.slots[0].slotId });
  const purchase = structuredClone(result);
  assert.equal(result.upgrades.current.symbols[0].linePayout, '30');
  assert.equal(result.upgrades.next.symbols[0].linePayout, '90');
  assert.deepEqual((await call(`/runs/${id}`)).data.upgrades, result.upgrades);
  await act('shop/continue');
  assert.equal(result.upgrades.current.symbols[0].linePayout, '90');
  assert.equal(result.upgrades.next, null);
  await act('spins'); await act('claim');
  await act('shop/discards', { instanceId: result.state.items[0].instanceId });
  assert.equal(result.upgrades.current.symbols[0].linePayout, '30');
  assert.equal(result.upgrades.next.symbols[0].linePayout, '30');
  const repeated = await call(`/runs/${id}/shop/purchases`, { body: { expectedRevision: 2, slotId: 'round-1-offer-0-slot-0' }, key: 'upgrade-2' });
  assert.deepEqual(repeated.data, purchase);
  const creation = (await call('/runs', { body: {}, key: 'upgrade-create' })).data;
  assert.equal(creation.upgrades.revision, 0); assert.equal(creation.upgrades.current.symbols[0].linePayout, '30');
});

test('Endless HTTP requires a won run and preserves opt-in, assets and idempotency across rounds', async t => {
  const {call}=await setup(t,{},raw=>{
    Object.assign(raw,currentRawRules());raw.balance.round.roundTargets.forEach(row=>{row.targetScore='1';});
  });
  let result=await call('/runs',{body:{},key:'endless-create'}),state=result.data.state;
  const root=`/runs/${state.runId}`;
  const act=async(suffix,extra={})=>{result=await call(`${root}/${suffix}`,{body:{expectedRevision:state.revision,...extra},key:`endless-act-${state.revision}`});assert.equal(result.status,200);state=result.data.state;return result;};
  assert.equal((await call(`${root}/endless/start`,{body:{expectedRevision:0},key:'too-early'})).status,409);
  for(let r=1;r<=10;r++){
    await act('spins');
    if(state.phase==='CARD_CHOICE')await act('cards/choice',{slotId:state.cardChoice.slots[0].slotId});
    if(r<10)await act('shop/continue');
  }
  assert.equal(state.canStartEndless,true);assert.equal(state.mode,'standard');const coins=state.coins;
  assert.equal((await call(`${root}/endless/start`,{body:{expectedRevision:state.revision,mode:'endless'},key:'forged'})).status,400);
  assert.equal((await call(`${root}/endless/start`,{body:{expectedRevision:state.revision,targetScore:'1'},key:'forged-target'})).status,400);
  const payload={body:{expectedRevision:state.revision},key:'endless-once'};
  const entered=await call(`${root}/endless/start`,payload);assert.equal(entered.status,200);state=entered.data.state;
  assert.equal(state.phase,'SHOP');assert.equal(state.mode,'endless');assert.equal(state.coins,coins);assert.equal(state.canStartEndless,false);
  assert.deepEqual((await call(`${root}/endless/start`,payload)).data,entered.data);
  assert.equal((await call(`${root}/endless/start`,{...payload,key:'racing'})).status,409);
  await act('shop/continue');assert.equal(state.roundIndex,11);assert.equal(state.targetScore,'2');assert.equal(state.handsRemaining,5);
  await act('spins');assert.equal(state.phase,'SHOP');assert.equal(state.completedRounds,11);
  assert.deepEqual((await call(`${root}/endless/start`,payload)).data,entered.data);
  assert.deepEqual((await call(root)).data.state,state);
  assert.equal((await call('/leaderboard')).data.entries[0].completedRounds,10);
});
