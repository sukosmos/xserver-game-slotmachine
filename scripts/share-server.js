import { openRuntime } from '../src/server/runtime.js';
import { createGameServer } from '../src/server/http.js';

const origin = process.env.NINE_SHARE_ORIGIN;
if (!origin) throw new Error('NINE_SHARE_ORIGIN must be the HTTPS origin printed by your tunnel');
// Sharing always uses its own records and loopback listener.
const store = openRuntime('.runtime/shared-play');
let server;
try { server = createGameServer({ store, guestOrigin: origin }); }
catch (error) { store.close(); throw error; }
server.on('error', (error) => { console.error(`Shared server failed: ${error.code ?? 'UNKNOWN'}`); store.close(); process.exitCode = 1; });
server.listen(3006, '127.0.0.1', () => console.log(JSON.stringify({ sharing: origin, listening: 'http://127.0.0.1:3006' })));
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => store.close());
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 10000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
