import { requireCondition } from './errors.js';
import { MAX_RANDOM_BOUND } from './rules.js';

/** Audit-only trace: callers must keep the returned values out of public events. */
export function drawInt(rng, bound, trace, metadata) {
  requireCondition(Number.isSafeInteger(bound) && bound > 0 && bound <= MAX_RANDOM_BOUND, 'INVALID_RANDOM_BOUND');
  requireCondition(rng !== null && typeof rng?.nextInt === 'function', 'INVALID_RANDOM_SOURCE');
  const value = rng.nextInt(bound);
  requireCondition(Number.isSafeInteger(value) && value >= 0 && value < bound, 'INVALID_RANDOM_VALUE');
  trace.push({ ...metadata, bound, value });
  return value;
}
