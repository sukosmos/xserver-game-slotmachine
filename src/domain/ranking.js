import { exactInteger } from './exact.js';

/** Negative means a ranks before b; never convert a score difference to Number. */
export function compareRecords(a, b) {
  if (a.completedRounds !== b.completedRounds) return a.completedRounds > b.completedRounds ? -1 : 1;
  const left = exactInteger(a.runTotalScore), right = exactInteger(b.runTotalScore);
  if (left !== right) return left > right ? -1 : 1;
  if (a.endedAt !== b.endedAt) return a.endedAt < b.endedAt ? -1 : 1;
  return 0;
}
