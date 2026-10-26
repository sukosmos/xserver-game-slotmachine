import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('server CLI restarts with the same account, committed state and duplicate responses', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nine-server-process-'));
  const env = { ...process.env, NINE_DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1' };
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const provisioned = spawnSync(process.execPath, [new URL('../scripts/account.js', import.meta.url).pathname, 'create', 'alice'], { env, encoding: 'utf8' });
  assert.equal(provisioned.status, 0, provisioned.stderr);
  const { token } = JSON.parse(provisioned.stdout);
  const start = async () => {
    const child = spawn(process.execPath, [new URL('../scripts/server.js', import.meta.url).pathname], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const address = await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited before listening: ${code}`)));
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const line = output.split('\n').find((entry) => entry.startsWith('{'));
        if (line) { try { resolve(JSON.parse(line).listening); } catch { /* Await complete line. */ } }
      });
    });
    return { child, address };
  };
  const call = async (address, path, body, key) => {
    const response = await fetch(`${address}/api/game/v1${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok);
    return response.json();
  };
  const first = await start();
  const created = await call(first.address, '/runs', {}, 'game');
  const id = created.state.runId;
  const spun = await call(first.address, `/runs/${id}/spins`, { expectedRevision: 0 }, 'spin');
  const exited = once(first.child, 'exit'); first.child.kill('SIGTERM'); await exited;
  const second = await start();
  assert.deepEqual((await call(second.address, `/runs/${id}`)).state, spun.state);
  assert.deepEqual(await call(second.address, `/runs/${id}/spins`, { expectedRevision: 0 }, 'spin'), spun);
  assert.deepEqual(await call(second.address, '/runs', {}, 'game'), created);
});
