// Browser acceptance only. In-memory stores, loopback binding, no .runtime access.
import { randomBytes } from 'node:crypto';
import { loadRules } from '../src/server/load-rules.js';
import { parseRules } from '../src/domain/rules.js';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';

const rules = loadRules(), servers = [], stores = [];
for (const [scenario, port, target] of [['win', 3001, '1'], ['fail', 3002, '100000000000000000000']]) {
  const raw = structuredClone({ balance: rules.balance, lines: rules.lineDefinitions, catalog: rules.catalog });
  raw.balance.round.roundTargets.forEach((row) => { row.targetScore = target; });
  raw.catalog.items = raw.catalog.items.filter((item) => ['cherry_farm', 'golden_harvest', 'joker_mask'].includes(item.id));
  const store = new GameStore({ filename: ':memory:', key: randomBytes(32), rules: parseRules(raw) });
  const server = createGameServer({ store, localPlayer: `fixture-${scenario}` });
  stores.push(store); servers.push(server);
  server.listen(port, '127.0.0.1', () => console.log(`Browser test fixture ${scenario}: http://127.0.0.1:${port}`));
}
const close = () => { for (const server of servers) { server.close(); server.closeAllConnections(); } for (const store of stores) store.close(); };
process.once('SIGINT', close); process.once('SIGTERM', close);
