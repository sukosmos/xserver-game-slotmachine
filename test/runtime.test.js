import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openRuntime } from '../src/server/runtime.js';

test('runtime creates private files, keeps its key on reopen and rejects missing keys', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nine-runtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openRuntime(dir);
  const token = store.issueToken('alice');
  const initial = store.createRun('alice', 'first');
  store.close();
  const key = readFileSync(join(dir, 'master.key'));
  assert.equal(key.length, 32);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const name of ['master.key', 'game.sqlite']) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
  const reopened = openRuntime(dir);
  assert.deepEqual(reopened.createRun('alice', 'first'), initial);
  assert.equal(reopened.authenticate(token), 'alice'); reopened.close();
  assert.deepEqual(readFileSync(join(dir, 'master.key')), key);
  unlinkSync(join(dir, 'master.key'));
  assert.throws(() => openRuntime(dir), { code: 'STORAGE_KEY_MISSING' });
});

test('committed actions and issued tokens survive an abrupt process exit and CLI revocation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nine-process-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtimeUrl = new URL('../src/server/runtime.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openRuntime } from ${JSON.stringify(runtimeUrl)};
    const store = openRuntime();
    const token = store.issueToken('alice');
    const run = store.createRun('alice', 'game');
    const response = store.execute('alice', run.state.runId, { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin' });
    process.stdout.write(JSON.stringify({ token, response }), () => process.exit(0));
  `], { env: { ...process.env, NINE_DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const { token, response } = JSON.parse(child.stdout);
  const store = openRuntime(dir);
  try {
    assert.equal(store.authenticate(token), 'alice');
    assert.deepEqual(store.execute('alice', response.state.runId, { type: 'SPIN', expectedRevision: 0, idempotencyKey: 'spin' }), response);
    const revoked = spawnSync(process.execPath, [new URL('../scripts/account.js', import.meta.url).pathname, 'revoke', 'alice'], {
      env: { ...process.env, NINE_DATA_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.equal(store.authenticate(token), null);
  } finally { store.close(); }
});
