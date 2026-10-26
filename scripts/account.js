import { openRuntime } from '../src/server/runtime.js';

const [operation, userId, ...extra] = process.argv.slice(2);
if (!['create', 'revoke'].includes(operation) || !/^[A-Za-z0-9_-]{1,128}$/.test(userId ?? '') || extra.length) {
  console.error('Usage: npm run account:create -- player-one | npm run account:revoke -- player-one');
  process.exitCode = 1;
} else {
  const store = openRuntime();
  try {
    if (operation === 'create') console.log(JSON.stringify({ userId, token: store.issueToken(userId) }));
    else console.log(JSON.stringify({ userId, revoked: store.revokeTokens(userId) }));
  } finally { store.close(); }
}
