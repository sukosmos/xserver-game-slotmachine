import { openRuntime } from '../src/server/runtime.js';
import { createGameServer } from '../src/server/http.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer in 0..65535');
const host = process.env.HOST ?? '127.0.0.1';
const store = openRuntime();
const server = createGameServer({ store });
server.on('error', (error) => { console.error(`Server failed: ${error.code ?? 'UNKNOWN'}`); store.close(); process.exitCode = 1; });
server.listen(port, host, () => console.log(JSON.stringify({ listening: `http://${host}:${server.address().port}`, api: '/api/game/v1' })));
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => { store.close(); });
  server.closeIdleConnections();
  const timer = setTimeout(() => { server.closeAllConnections(); }, 10000);
  timer.unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
