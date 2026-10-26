import { parentPort, workerData } from 'node:worker_threads';
import { GameStore } from '../../src/server/store.js';
import { loadRules } from '../../src/server/load-rules.js';

const store = new GameStore({ filename: workerData.filename, key: Buffer.from(workerData.key), rules: loadRules() });
const barrier = new Int32Array(workerData.barrier);
parentPort.postMessage({ ready: true });
Atomics.wait(barrier, 0, 0, 10000);
try { parentPort.postMessage({ response: store.execute('alice', workerData.runId, workerData.command) }); }
catch (error) { parentPort.postMessage({ code: error.code }); }
finally { store.close(); parentPort.close(); }
