import { requireCondition } from './errors.js';

/** Convert config integers without ever rounding an unsafe Number. */
export function exactInteger(value) {
  const valid = (typeof value === 'bigint' && value >= 0n)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value));
  requireCondition(valid, 'INVALID_INTEGER', 'Expected a nonnegative exact integer');
  return BigInt(value);
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rational(numerator, denominator = 1) {
  const num = exactInteger(numerator);
  const den = exactInteger(denominator);
  requireCondition(den > 0n, 'INVALID_RATIONAL', 'Denominator must be positive');
  const divisor = gcd(num, den);
  return Object.freeze({ num: num / divisor, den: den / divisor });
}

export function addRational(a, b) {
  a = rational(a.num, a.den);
  b = rational(b.num, b.den);
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function multiplyRational(a, b) {
  a = rational(a.num, a.den);
  b = rational(b.num, b.den);
  return rational(a.num * b.num, a.den * b.den);
}

export function floorMultiply(value, factor) {
  const { num, den } = rational(factor.num, factor.den);
  return exactInteger(value) * num / den;
}

export function stringifyExact(value, space) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, space);
}
