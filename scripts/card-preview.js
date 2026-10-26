// Isolated browser acceptance; no persisted user records or production rule changes.
import { randomBytes } from 'node:crypto';
import { loadRules } from '../src/server/load-rules.js';
import { parseRules } from '../src/domain/rules.js';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
const rules=loadRules(),servers=[];
function start(port,change){
 const raw=structuredClone({balance:rules.balance,lines:rules.lineDefinitions,catalog:rules.catalog});change(raw);
 const store=new GameStore({filename:':memory:',key:randomBytes(32),rules:parseRules(raw)});
 const server=createGameServer({store,localPlayer:`preview-${port}`});
 server.listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}`));servers.push({server,store});
}
start(3007,raw=>{raw.balance.round.roundTargets.forEach((target,i)=>{target.targetScore=i<3?'1':'99999999';});});
start(3008,raw=>{
 delete raw.balance.round.milestoneCards;
 raw.balance.round.baseHands=1;raw.balance.economy.startingCoins=50;
 raw.balance.symbols[0].weight=1000000;
 raw.balance.round.roundTargets[0].targetScore='1';raw.balance.round.roundTargets[1].targetScore='350';
 raw.catalog.items=raw.catalog.items.filter(i=>['emergency_lever','score_puffer','crossroads_bonus','mirror_copier'].includes(i.id));
});
function close(){for(const {server,store} of servers){server.close(()=>store.close());server.closeAllConnections();}}
process.once('SIGTERM',close);process.once('SIGINT',close);
