import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRun, applyAction, canClaim, validateAction } from '../domain/run.js';
import { getShopView } from '../domain/shop.js';
import { stringifyExact } from '../domain/exact.js';
import { requireCondition } from '../domain/errors.js';
import { CounterRandom, generateSeed, RNG_VERSION } from './random.js';
import { hasMilestone, milestoneRewardView } from '../domain/milestone.js';

function jsonValue(value) { return JSON.parse(stringifyExact(value)); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function rulesFingerprint(rules) {
  const raw = { balance: rules.balance, lines: rules.lineDefinitions, catalog: rules.catalog };
  return createHash('sha256').update(JSON.stringify(canonical(raw))).digest('hex');
}

// Explicit allowlist: new private state fields must never leak automatically.
function publicState(runId, state, rules) {
  return jsonValue({
    runId, rulesVersion: state.rulesVersion, catalogVersion: state.catalogVersion, linesVersion: state.linesVersion,
    phase: state.phase, roundIndex: state.roundIndex, completedRounds: state.completedRounds,
    roundScore: state.roundScore, runTotalScore: state.runTotalScore, targetScore: state.targetScore,
    handsRemaining: state.handsRemaining, canClaim: canClaim(state), revision: state.revision,
    ...(state.roundHands !== undefined ? { roundHands: state.roundHands } : {}),
    ...(state.handSequence !== undefined ? { handSequence: state.handSequence, pendingNextHandWeightBuffs: state.pendingNextHandWeightBuffs } : {}),
    ...(hasMilestone(rules) ? { cardChoice:state.phase === 'CARD_CHOICE' ? { slots:state.cardOffer.map(({ slotId }) => ({ slotId })) } : null,
      milestoneReward:milestoneRewardView(state, rules), roundWildAvailable:state.roundWildAvailable } : {}),
    items: state.items.map(({ instanceId, itemId, acquiredOrder, activeFromRound, remainingCharges, remainingSpins, purchaseCounter, lastTriggeredRound }) => ({
      instanceId, itemId, acquiredOrder, activeFromRound, remainingCharges, remainingSpins, purchaseCounter, lastTriggeredRound,
    })),
    consecutiveWinHands: state.consecutiveWinHands, coins: state.coins, shop: getShopView(state, rules),
  });
}

function validateCommand(command) {
  requireCondition(command !== null && typeof command === 'object' && !Array.isArray(command), 'INVALID_COMMAND');
  requireCondition(['expectedRevision', 'idempotencyKey'].every((field) => Object.hasOwn(command, field)), 'INVALID_COMMAND');
  const { expectedRevision, idempotencyKey, ...action } = command;
  validateAction(action, 'INVALID_COMMAND');
  requireCondition(Number.isSafeInteger(command.expectedRevision) && command.expectedRevision >= 0, 'INVALID_COMMAND');
  requireCondition(typeof command.idempotencyKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(command.idempotencyKey), 'INVALID_COMMAND');
}

/**
 * In-process server authority for the Phase 3 harness, not an HTTP/auth service.
 * The constructor and exportAudit are server-internal, never request handlers.
 * A production adapter must provide authenticated userId and durable transactions.
 */
export class GameSession {
  #rules;
  #runId;
  #userId;
  #seed;
  #state;
  #rng;
  #initialItemIds;
  #actions = [];
  #responses = new Map();

  constructor(rules, { userId, runId = randomUUID(), seed = generateSeed(), initialItemIds = [] }) {
    requireCondition(typeof userId === 'string' && userId.length > 0, 'INVALID_OWNER');
    requireCondition(typeof runId === 'string' && runId.length > 0, 'INVALID_RUN_ID');
    this.#rules = rules;
    this.#runId = runId;
    this.#userId = userId;
    this.#seed = seed;
    this.#state = createRun(rules, { initialItemIds });
    this.#initialItemIds = [...initialItemIds];
    this.#rng = new CounterRandom(seed);
  }

  #assertOwner(userId) { requireCondition(userId === this.#userId, 'NOT_OWNER'); }

  getState(userId) {
    this.#assertOwner(userId);
    return publicState(this.#runId, this.#state, this.#rules);
  }

  execute(userId, input) {
    this.#assertOwner(userId);
    validateCommand(input);
    const command = { ...input };
    const cached = this.#responses.get(command.idempotencyKey);
    if (cached) {
      requireCondition(isDeepStrictEqual(cached.command, command), 'IDEMPOTENCY_CONFLICT');
      return structuredClone(cached.response);
    }
    requireCondition(command.expectedRevision === this.#state.revision, 'STALE_REVISION');

    // Compute on an isolated RNG cursor. A rejected action cannot consume randomness.
    const before = this.#rng.snapshot();
    const rng = CounterRandom.fromSnapshot(before);
    const { expectedRevision, idempotencyKey, ...action } = command;
    const { state, event, randomTrace } = applyAction(this.#state, action, this.#rules, rng);
    const response = { state: publicState(this.#runId, state, this.#rules), event: jsonValue(event) };
    const record = { command, rngBefore: before.counter, rngAfter: rng.snapshot().counter, randomTrace, response };

    // Synchronous commit, no I/O or await between validation and mutation.
    this.#state = state;
    this.#rng = rng;
    this.#actions.push(structuredClone(record));
    this.#responses.set(command.idempotencyKey, structuredClone({ command, response }));
    return structuredClone(response);
  }

  /** Contains the secret seed. For server audit storage/tests only. */
  exportAudit() {
    return structuredClone({
      format: 'slot-audit-v3', rngVersion: RNG_VERSION,
      rulesVersion: this.#rules.rulesVersion, catalogVersion: this.#rules.catalogVersion, linesVersion: this.#rules.linesVersion,
      rulesFingerprint: rulesFingerprint(this.#rules), runId: this.#runId, userId: this.#userId,
      initialSeed: this.#seed,
      initialItemIds: this.#initialItemIds,
      initialState: publicState(this.#runId, createRun(this.#rules, { initialItemIds: this.#initialItemIds }), this.#rules),
      actions: this.#actions,
      finalState: publicState(this.#runId, this.#state, this.#rules),
    });
  }
}

/** Recompute trusted server audit data; mismatched versions/content fail closed. */
export function restoreSession(rules, audit) {
  requireCondition(audit?.format === 'slot-audit-v3' && Array.isArray(audit.actions) && Array.isArray(audit.initialItemIds), 'INVALID_AUDIT');
  requireCondition(audit.rngVersion === RNG_VERSION, 'RNG_VERSION_MISMATCH');
  requireCondition(audit.rulesVersion === rules.rulesVersion && audit.catalogVersion === rules.catalogVersion
    && audit.linesVersion === rules.linesVersion, 'RULES_VERSION_MISMATCH');
  requireCondition(audit.rulesFingerprint === rulesFingerprint(rules), 'RULES_FINGERPRINT_MISMATCH');
  const session = new GameSession(rules, { userId: audit.userId, runId: audit.runId, seed: audit.initialSeed, initialItemIds: audit.initialItemIds });
  for (const record of audit.actions) {
    const response = session.execute(audit.userId, record.command);
    requireCondition(isDeepStrictEqual(response, record.response), 'REPLAY_MISMATCH');
  }
  requireCondition(isDeepStrictEqual(session.exportAudit(), audit), 'REPLAY_MISMATCH');
  return session;
}

export function replayAudit(rules, audit) {
  return restoreSession(rules, audit).getState(audit.userId);
}
