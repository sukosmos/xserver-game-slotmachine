// Memory-only browser acceptance. No real records or live balance changes.
import { randomBytes } from 'node:crypto';
import { loadRules } from '../src/server/load-rules.js';
import { parseRules } from '../src/domain/rules.js';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
const rules = loadRules();
const raw = structuredClone({balance:rules.balance,lines:rules.lineDefinitions,catalog:rules.catalog});
raw.balance.round.roundTargets.forEach(row=>{row.targetScore='1';});
raw.balance.economy.startingCoins=50;
const store=new GameStore({filename:':memory:',key:randomBytes(32),rules:parseRules(raw)});
const server=createGameServer({store,localPlayer:'endless-preview'});
server.listen(3009,'127.0.0.1',()=>console.log('Endless preview: http://127.0.0.1:3009'));
const close=()=>{server.close(()=>store.close());server.closeAllConnections();};
process.once('SIGINT',close);process.once('SIGTERM',close);
