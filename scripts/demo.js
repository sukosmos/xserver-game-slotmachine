import { loadRules } from '../src/server/load-rules.js';
import { GameSession } from '../src/server/session.js';

const userId = 'local-demo-user';
const shopDemo = process.argv.includes('--shop');
const initialItemIds = process.argv.includes('--items') ? ['cherry_farm', 'golden_harvest', 'win_streak', 'joker_mask', 'miracle_hand'] : [];
// Public test seed only for a repeatable local shop walkthrough; production uses a secret random seed.
const options = shopDemo ? { seed: '1'.padStart(64, '0') } : {};
const session = new GameSession(loadRules(), { userId, initialItemIds, ...options });
console.log(JSON.stringify({ mode: 'Phase 3 local memory harness', shopDemo, state: session.getState(userId) }));
while (true) {
  const state = session.getState(userId);
  if (['RUN_WON', 'RUN_FAILED'].includes(state.phase)) break;
  let action = { type: state.phase === 'SHOP' ? 'CONTINUE' : state.canClaim ? 'CLAIM' : 'SPIN' };
  if (shopDemo && state.phase === 'SHOP') {
    const slot = state.shop.slots.find((offer) => offer.canBuy);
    if (slot) action = { type: 'BUY', slotId: slot.slotId };
    else if (state.shop.canReroll && state.shop.paidRerolls === 0) action = { type: 'REROLL' };
  }
  console.log(JSON.stringify(session.execute(userId, { ...action, expectedRevision: state.revision, idempotencyKey: `demo-${state.revision}` })));
}
