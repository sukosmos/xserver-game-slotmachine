import { requireCondition } from './errors.js';

export function assertCoins(value) {
  requireCondition(Number.isSafeInteger(value) && value >= 0, 'INVALID_COINS');
  return value;
}

/** Use exact intermediate arithmetic, then expose only bounded integer coins. */
export function safeAmount(value, code = 'COIN_OVERFLOW') {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), code);
  return Number(value);
}
