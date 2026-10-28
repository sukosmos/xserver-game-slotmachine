import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { GameError, requireCondition } from '../domain/errors.js';
import { serveStatic } from './static.js';

const base = '/api/game/v1';
const routes = new Map([
  ['endless/start', 'START_ENDLESS'],
  ['cards/choice', 'CHOOSE_CARD'], ['shop/destiny', 'BUY_DESTINY'],
  ['spins', 'SPIN'], ['claim', 'CLAIM'], ['shop/purchases', 'BUY'],
  ['shop/rerolls', 'REROLL'], ['shop/discards', 'DISCARD'], ['shop/continue', 'CONTINUE'],
]);
const badRequest = new Set(['INVALID_JSON', 'INVALID_COMMAND', 'INVALID_LIMIT', 'INVALID_QUERY', 'INVALID_CONTENT_TYPE']);
const conflicts = new Set(['STALE_REVISION', 'IDEMPOTENCY_CONFLICT', 'INVALID_RUN_PHASE', 'NO_HANDS_LEFT', 'TARGET_NOT_MET',
  'INSUFFICIENT_COINS', 'ITEM_CAP_REACHED', 'INVENTORY_FULL', 'SOLD_OUT', 'EMPTY_SHOP_SLOT', 'UNKNOWN_SHOP_SLOT', 'UNKNOWN_ITEM_INSTANCE',
  'COIN_OVERFLOW', 'SHOP_COUNTER_EXHAUSTED', 'ITEM_ORDER_EXHAUSTED', 'REVISION_EXHAUSTED', 'UNKNOWN_CARD_SLOT', 'ITEM_ALREADY_PURCHASED', 'ITEM_NOT_AVAILABLE', 'NO_DESTINY_CHOICES', 'DESTINY_SELECTION_REQUIRED', 'INVALID_DESTINY_CARD', 'ITEM_NOT_DISCARDABLE']);

function readBody(req, maximum = 4096) {
  requireCondition(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 'INVALID_CONTENT_TYPE');
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort); req.off('error', onAbort);
    };
    const fail = (code) => { cleanup(); req.resume(); reject(new GameError(code)); };
    const onAbort = () => fail('REQUEST_ABORTED');
    const onData = (chunk) => {
      length += chunk.length;
      if (length > maximum) fail('BODY_TOO_LARGE'); else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON');
        resolve(value);
      } catch { reject(new GameError('INVALID_JSON')); }
    };
    const timer = setTimeout(() => fail('REQUEST_TIMEOUT'), 10000);
    req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', onAbort);
  });
}

function listLimit(url) {
  const keys = [...url.searchParams.keys()];
  requireCondition(keys.length === 0 || (keys.length === 1 && keys[0] === 'limit'), 'INVALID_QUERY');
  const raw = url.searchParams.get('limit') ?? '20';
  requireCondition(/^[1-9]\d{0,2}$/.test(raw) && Number(raw) <= 100, 'INVALID_LIMIT');
  return Number(raw);
}

/** authenticate is replaceable by an existing service's token verifier. Never read owner IDs from request data. */
export function createGameServer({ store, authenticate = (token) => store.authenticate(token), localPlayer = null, guestOrigin = null, rateLimit = 120, windowMs = 60000, now = Date.now }) {
  requireCondition(Number.isSafeInteger(rateLimit) && rateLimit > 0 && Number.isSafeInteger(windowMs) && windowMs > 0, 'INVALID_RATE_LIMIT');
  let guestHost = null;
  if (guestOrigin !== null) {
    const parsed = new URL(guestOrigin);
    requireCondition(!localPlayer && parsed.protocol === 'https:' && parsed.origin === guestOrigin && !parsed.username && !parsed.password, 'INVALID_GUEST_ORIGIN');
    guestHost = parsed.host;
  }
  const buckets = new Map();
  function throttle(key, maximum) {
    const time = now();
    if (buckets.size >= 10000) for (const [id, bucket] of buckets) if (bucket.until <= time) buckets.delete(id);
    const old = buckets.get(key);
    if (!old || old.until <= time) {
      requireCondition(buckets.size < 10000 || buckets.has(key), 'RATE_LIMITED');
      buckets.set(key, { count: 1, until: time + windowMs });
    } else { requireCondition(old.count < maximum, 'RATE_LIMITED'); old.count++; }
  }
  const server = createServer(async (req, res) => {
    // An aborted IncomingMessage can emit an error after the body reader has detached.
    req.on('error', () => {});
    const send = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, 'http://local');
      if (url.search === '' && serveStatic(req, res, url.pathname)) return;
      if (req.method === 'GET' && url.pathname === '/health') { send(200, { status: 'ok' }); return; }
      throttle(`ip:${req.socket.remoteAddress}`, rateLimit * 4);
      const host = req.headers.host ?? '';
      const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (guestOrigin) requireCondition(loopback && host === guestHost, 'UNTRUSTED_ORIGIN');
      const guestEnabled = Boolean(guestOrigin && loopback && host === guestHost);
      const localEnabled = Boolean(localPlayer && localHost && loopback);
      const sameOrigin = guestEnabled ? req.headers.origin === guestOrigin : req.headers.origin === `http://${host}` || req.headers.origin === `https://${host}`;
      const cookie = /(?:^|;\s*)nine_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
      const guestCookie = guestEnabled ? /(?:^|;\s*)__Secure-nine_guest=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] : null;
      const guestOwner = guestCookie ? store.authenticate(guestCookie) : null;
      const validGuest = /^guest-[0-9a-f-]{36}$/.test(guestOwner ?? '');
      if (req.method === 'GET' && url.pathname === `${base}/bootstrap` && url.search === '') { send(200, { localPlay: localEnabled, ...(guestEnabled ? { guestPlay: true } : {}) }); return; }
      if (req.method === 'POST' && url.pathname === `${base}/guest-session` && url.search === '') {
        requireCondition(guestEnabled, 'NOT_FOUND');
        requireCondition(sameOrigin, 'UNTRUSTED_ORIGIN');
        const body = await readBody(req);
        requireCondition(Object.keys(body).length === 0, 'INVALID_COMMAND');
        if (!validGuest) throttle('guest-creation', 32);
        const owner = validGuest ? guestOwner : `guest-${randomUUID()}`;
        const token = validGuest ? guestCookie : store.issueToken(owner);
        res.setHeader('Set-Cookie', `__Secure-nine_guest=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/game/v1; Max-Age=604800`);
        send(200, { playerId: store.playerId(owner) }); return;
      }
      if (req.method === 'POST' && url.pathname === `${base}/local-session` && url.search === '') {
        requireCondition(localEnabled, 'NOT_FOUND');
        requireCondition(sameOrigin, 'UNTRUSTED_ORIGIN');
        const body = await readBody(req);
        requireCondition(Object.keys(body).length === 0, 'INVALID_COMMAND');
        const token = cookie && store.authenticate(cookie) === localPlayer ? cookie : store.issueToken(localPlayer);
        res.setHeader('Set-Cookie', `nine_session=${token}; HttpOnly; SameSite=Strict; Path=/api/game/v1; Max-Age=604800`);
        send(200, { playerId: store.playerId(localPlayer) }); return;
      }
      const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '');
      const localCookie = localEnabled ? cookie : null;
      if (!match && (localCookie || validGuest) && req.method !== 'GET') requireCondition(sameOrigin, 'UNTRUSTED_ORIGIN');
      const userId = match ? await authenticate(match[1]) : localCookie ? store.authenticate(localCookie) : validGuest ? guestOwner : null;
      requireCondition(typeof userId === 'string' && userId.length > 0, 'UNAUTHENTICATED');
      throttle(`user:${userId}`, rateLimit);
      if (req.method === 'GET' && url.pathname === `${base}/runs`) { send(200, store.listRuns(userId, listLimit(url))); return; }
      if (req.method === 'GET' && url.pathname === `${base}/leaderboard`) { send(200, store.leaderboard(listLimit(url))); return; }
      requireCondition(url.search === '', 'INVALID_QUERY');
      const rankDetail = url.pathname.match(/^\/api\/game\/v1\/leaderboard\/([A-Za-z0-9_-]{1,128})$/);
      if (req.method === 'GET' && rankDetail) { send(200, store.leaderboardDetail(rankDetail[1])); return; }
      if (req.method === 'GET' && url.pathname === `${base}/me`) { send(200, { playerId: store.playerId(userId) }); return; }
      if (req.method === 'GET' && url.pathname === `${base}/catalog`) { send(200, store.catalog(userId)); return; }
      if (req.method === 'POST' && url.pathname === `${base}/runs`) {
        const body = await readBody(req);
        requireCondition(Object.keys(body).length === 0, 'INVALID_COMMAND');
        send(201, store.createRun(userId, req.headers['idempotency-key'])); return;
      }
      const resource = /^\/api\/game\/v1\/runs\/([0-9a-f-]{36})(?:\/(.+))?$/.exec(url.pathname);
      requireCondition(resource !== null, 'NOT_FOUND');
      const [, runId, suffix] = resource;
      if (req.method === 'GET' && !suffix) { send(200, store.getRun(userId, runId)); return; }
      if (req.method === 'GET' && suffix === 'catalog') { send(200, store.catalog(userId, runId)); return; }
      requireCondition(req.method === 'POST' && routes.has(suffix), 'NOT_FOUND');
      const body = await readBody(req);
      const type = routes.get(suffix);
      const allowed = ['expectedRevision', ...(['BUY', 'CHOOSE_CARD', 'BUY_DESTINY'].includes(type) ? ['slotId', ...(type === 'BUY_DESTINY' ? [Object.hasOwn(body, 'selectedDestinySlotId') ? 'selectedDestinySlotId' : 'selectedDestinyCardId'] : [])] : type === 'DISCARD' ? ['instanceId'] : [])];
      requireCondition(Object.keys(body).length === allowed.length && allowed.every((field) => Object.hasOwn(body, field)), 'INVALID_COMMAND');
      send(200, store.execute(userId, runId, { ...body, type, idempotencyKey: req.headers['idempotency-key'] }));
    } catch (error) {
      const code = error instanceof GameError ? error.code : 'INTERNAL_ERROR';
      let status = badRequest.has(code) ? 400 : conflicts.has(code) ? 409 : 500;
      if (code === 'UNAUTHENTICATED') { status = 401; res.setHeader('WWW-Authenticate', 'Bearer'); }
      if (code === 'UNTRUSTED_ORIGIN') status = 403;
      if (['RUN_NOT_FOUND', 'RANK_NOT_FOUND', 'NOT_FOUND'].includes(code)) status = 404;
      if (code === 'RATE_LIMITED') { status = 429; res.setHeader('Retry-After', Math.ceil(windowMs / 1000)); }
      if (code === 'BODY_TOO_LARGE') status = 413;
      if (['REQUEST_TIMEOUT', 'REQUEST_ABORTED'].includes(code)) status = 408;
      if (['STORAGE_BUSY', 'STORAGE_ERROR', 'STORAGE_CORRUPT', 'STORAGE_KEY_MISMATCH'].includes(code)) status = 503;
      if (!req.complete) res.setHeader('Connection', 'close');
      // Do not expose error messages, SQL, paths, audit data, seeds, or tokens.
      send(status, { error: { code: status >= 500 ? (status === 503 ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR') : code } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
