// Memory-only UI acceptance for grouped shops and ranked builds.
import { randomBytes } from 'node:crypto';
import { loadRules } from '../src/server/load-rules.js';
import { parseRules } from '../src/domain/rules.js';
import { GameStore } from '../src/server/store.js';
import { createGameServer } from '../src/server/http.js';
const current=loadRules(), raw=structuredClone({balance:current.balance,lines:current.lineDefinitions,catalog:current.catalog});
raw.balance.economy.startingCoins=100;
raw.balance.round.roundTargets.forEach(row=>{row.targetScore=row.round<4 ? '1' : '9999999999999999999999999999';});
const store=new GameStore({filename:':memory:',key:randomBytes(32),rules:parseRules(raw)});
let state=store.createRun('build-preview','sample').state;
const act=(type,extra={})=>{state=store.execute('build-preview',state.runId,{type,expectedRevision:state.revision,idempotencyKey:`sample-${state.revision}`,...extra}).state;};
for(let r=1;r<=3;r++){
  act('SPIN');
  if(state.phase==='CARD_CHOICE')act('CHOOSE_CARD',{slotId:state.cardChoice.slots[0].slotId});
  for(const offer of [...state.shop.slots])if(offer.canBuy)try{act('BUY',{slotId:offer.slotId});}catch{}
  act('CONTINUE');
}
while(state.phase==='ROUND_ACTIVE')act('SPIN');
const server=createGameServer({store,localPlayer:'build-preview'});
server.listen(3010,'127.0.0.1',()=>console.log('Build preview: http://127.0.0.1:3010'));
const close=()=>{server.close(()=>store.close());server.closeAllConnections();};
process.once('SIGINT',close);process.once('SIGTERM',close);
