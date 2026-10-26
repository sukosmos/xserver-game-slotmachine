import { createHmac, randomBytes } from 'node:crypto';
import { requireCondition } from '../domain/errors.js';
import { MAX_RANDOM_BOUND } from '../domain/rules.js';

export const RNG_VERSION = 'hmac-sha256-counter-v1';

export function generateSeed() { return randomBytes(32).toString('hex'); }

/** Unbiased integer sampling; discarded words count toward the stream cursor. */
export function uniformInt(nextUint32, bound) {
  requireCondition(Number.isSafeInteger(bound) && bound > 0 && bound <= MAX_RANDOM_BOUND, 'INVALID_RANDOM_BOUND');
  const limit = MAX_RANDOM_BOUND - MAX_RANDOM_BOUND % bound;
  let word;
  do {
    word = nextUint32();
    requireCondition(Number.isSafeInteger(word) && word >= 0 && word < MAX_RANDOM_BOUND, 'INVALID_RANDOM_VALUE');
  } while (word >= limit);
  return word % bound;
}

/** Node server-only implementation of RandomSource. Snapshots contain a secret. */
export class CounterRandom {
  #seed;
  #key;
  #counter;
  #block;
  #blockIndex = -1;

  constructor(seed, counter = 0) {
    requireCondition(typeof seed === 'string' && /^[0-9a-f]{64}$/.test(seed), 'INVALID_SEED');
    requireCondition(Number.isSafeInteger(counter) && counter >= 0, 'INVALID_RANDOM_COUNTER');
    this.#seed = seed;
    this.#key = Buffer.from(seed, 'hex');
    this.#counter = counter;
  }

  #nextUint32() {
    requireCondition(this.#counter < Number.MAX_SAFE_INTEGER, 'RNG_EXHAUSTED');
    const index = Math.floor(this.#counter / 8);
    if (this.#blockIndex !== index) {
      this.#block = createHmac('sha256', this.#key).update(`nine-to-ruin:rng:v1:${index}`).digest();
      this.#blockIndex = index;
    }
    const word = this.#block.readUInt32BE((this.#counter % 8) * 4);
    this.#counter += 1;
    return word;
  }

  nextInt(bound) { return uniformInt(() => this.#nextUint32(), bound); }

  snapshot() { return { algorithm: RNG_VERSION, seed: this.#seed, counter: this.#counter }; }

  static fromSnapshot(snapshot) {
    requireCondition(snapshot?.algorithm === RNG_VERSION, 'RNG_VERSION_MISMATCH');
    return new CounterRandom(snapshot.seed, snapshot.counter);
  }
}
