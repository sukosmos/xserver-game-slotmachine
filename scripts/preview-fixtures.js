// Browser acceptance only. In-memory stores, loopback binding, no .runtime access.
import { randomBytes } from 'node:crypto';
import { loadRules } from '../src/server/load-rules.js';
import { parseRules } from '../src/domain/rules.js';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';

const rules = loadRules(), servers = [], stores = [];
for (const [scenario, port, target] of [['win', 3001, '1'], ['fail', 3002, '100000000000000000000'], ['effects', 3003, '100000000'], ['selected', 3004, '100000000'], ['stateful', 3005, '100000000']]) {
  const raw = structuredClone({ balance: rules.balance, lines: rules.lineDefinitions, catalog: rules.catalog });
  delete raw.balance.round.milestoneCards; // Narrow catalog fixtures; cards use card-preview.js.
  raw.balance.round.roundTargets.forEach((row) => { row.targetScore = target; });
  raw.catalog.items = raw.catalog.items.filter((item) => ['cherry_farm', 'golden_harvest', 'joker_mask'].includes(item.id));
  if (scenario === 'effects') {
    raw.balance.round.roundTargets[0].targetScore = '1';
    raw.balance.symbols[0].weight = 100000;
    raw.balance.economy.startingCoins = 20;
    raw.catalog.items = structuredClone(rules.catalog.items.filter((item) => ['square_seal', 'cherry_farm', 'win_streak', 'extra_hand'].includes(item.id)));
    // Isolated acceptance fixture: expose the normally R3 weight item in the first shop.
    raw.catalog.items.find((item) => item.id === 'cherry_farm').minShopRound = 1;
  }
  if (['selected', 'stateful'].includes(scenario)) {
    raw.balance.economy.startingCoins = 100;
    raw.balance.round.roundTargets[0].targetScore = '1';
    const ids = scenario === 'selected' ? ['mirror_copier', 'temporary_wild', 'corner_collector', 'editors_proof']
      : ['seven_tracker', 'receipt_collector', 'emergency_lever', 'golden_harvest'];
    raw.catalog.items = structuredClone(rules.catalog.items.filter((item) => ids.includes(item.id)));
    if (scenario === 'selected') {
      // Acceptance only: make the two random animations observable on every eligible spin.
      for (const item of raw.catalog.items) if (item.effect.triggerChanceBasisPoints) item.effect.triggerChanceBasisPoints = 10000;
    } else {
      raw.balance.round.roundTargets[1].targetScore = '1';
      raw.balance.symbols[0].weight = 100000;
    }
  }
  const store = new GameStore({ filename: ':memory:', key: randomBytes(32), rules: parseRules(raw) });
  const server = createGameServer({ store, localPlayer: `fixture-${scenario}` });
  stores.push(store); servers.push(server);
  server.listen(port, '127.0.0.1', () => console.log(`Browser test fixture ${scenario}: http://127.0.0.1:${port}`));
}
const close = () => { for (const server of servers) { server.close(); server.closeAllConnections(); } for (const store of stores) store.close(); };
process.once('SIGINT', close); process.once('SIGTERM', close);
