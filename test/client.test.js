import test from 'node:test';
import assert from 'node:assert/strict';
import { GameClient } from '../web/client.js';
import { exactScore, compactScore, progress, escapeHtml } from '../web/format.js';

const storage = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
};
const response = (status, data) => ({ ok: status < 400, status, json: async () => data });

test('a lost response survives reload and retries the identical command and key', async () => {
  const saved = storage(), requests = [];
  const fetcher = async (path, options) => {
    requests.push({ path, body: options.body, key: options.headers['Idempotency-Key'] });
    if (requests.length === 1) throw new Error('Connection lost after server committed');
    return response(200, { state: { revision: 1, runTotalScore: '99999999999999999999' } });
  };
  const first = new GameClient({ fetcher, storage: saved }); first.setOwner('alice');
  await assert.rejects(first.mutate('/runs/id/spins', { expectedRevision: 0 }, 'spin-1'), { code: 'CONNECTION_LOST' });
  await assert.rejects(first.mutate('/runs/id/spins', { expectedRevision: 0 }, 'spin-2'), { code: 'PENDING_ACTION' });
  const reloaded = new GameClient({ fetcher, storage: saved }); reloaded.setOwner('alice');
  assert.equal((await reloaded.retry()).state.runTotalScore, '99999999999999999999');
  assert.deepEqual(requests[0], requests[1]); assert.equal(reloaded.pending(), null);
});

test('definitive rejections clear pending commands; auth, rate and server failures retain them', async () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
    const client = new GameClient({ storage: storage(), fetcher: async () => response(status, { error: { code: 'REJECTED' } }) });
    client.setOwner('alice');
    await assert.rejects(client.mutate('/runs', {}, 'create'), { status });
    assert.equal(Boolean(client.pending()), [401, 429, 500, 503].includes(status), String(status));
  }
});

test('switching player cannot replay another player command; corrupt saved data recovers', async () => {
  const saved = storage(), client = new GameClient({ storage: saved, fetcher: async () => { throw new Error(); } });
  client.setOwner('alice'); await assert.rejects(client.mutate('/runs', {}, 'create'));
  client.setOwner('bob'); assert.equal(client.pending(), null);
  await assert.rejects(client.retry(), { code: 'INVALID_PENDING_ACTION' });
  saved.setItem('nine.pending', '{broken'); assert.equal(client.pending(), null);
});

test('very large scores stay exact and progress clamps without Number conversion of scores', () => {
  assert.equal(exactScore('90071992547409931234567890'), '90,071,992,547,409,931,234,567,890');
  assert.equal(compactScore('90071992547409931234567890'), '90,071,992,547,409.9조');
  assert.equal(compactScore('10999'), '1만'); assert.equal(compactScore('11000'), '1.1만');
  assert.equal(progress('100000000000000000000', '300000000000000000000'), 33.3);
  assert.equal(progress('999999999999999999999', '1'), 100);
  assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
});
