// Isolated browser acceptance: real card logic, low R1–R3 targets, no persisted user records.
import { randomBytes } from 'node:crypto';
import { loadRules } from '../src/server/load-rules.js';
import { parseRules } from '../src/domain/rules.js';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
const rules=loadRules();
const raw=structuredClone({balance:rules.balance,lines:rules.lineDefinitions,catalog:rules.catalog});
raw.balance.round.roundTargets.forEach((target,i)=>{target.targetScore=i<3?'1':'99999999';});
const store=new GameStore({filename:':memory:',key:randomBytes(32),rules:parseRules(raw)});
const server=createGameServer({store,localPlayer:'card-preview'});
server.listen(3007,'127.0.0.1',()=>console.log('Card preview: http://127.0.0.1:3007'));
function close(){server.close(()=>store.close());server.closeAllConnections();}
process.once('SIGTERM',close);process.once('SIGINT',close);
