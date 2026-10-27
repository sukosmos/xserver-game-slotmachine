import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, openSync, chmodSync, constants } from 'node:fs';
import { GameError, requireCondition } from '../domain/errors.js';
import { parseRules } from '../domain/rules.js';
import { compareRecords } from '../domain/ranking.js';
import { GameSession, restoreSession, rulesFingerprint } from './session.js';
import { createVault } from './vault.js';
import { publicCatalog } from './catalog.js';
import { upgradeView } from './upgrades.js';
import { createRankSnapshot } from './rank-snapshot.js';
import { spinPresentation } from './presentation.js';

const terminal = (state) => ['RUN_FAILED', 'RUN_WON'].includes(state.phase);
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const owner = (id) => requireCondition(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id), 'INVALID_OWNER');
const keyValid = (key) => requireCondition(typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key), 'INVALID_COMMAND');
const boundedLimit = (limit) => requireCondition(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_LIMIT');
const context = (row) => JSON.stringify(['run-v1', row.id, row.owner_id, row.rules_hash, row.created_at]);
const recordOf = (row) => ({ completedRounds: row.completed_rounds, runTotalScore: row.score, endedAt: row.ended_at });

/** Server-only persistence adapter. No process-local session cache can outlive a failed commit. */
export class GameStore {
  #db;
  #rules;
  #vault;
  #key;
  #now;
  #closed = false;

  constructor({ filename, key, rules, now = Date.now }) {
    this.#vault = createVault(key);
    this.#key = Buffer.from(key);
    this.#rules = rules;
    this.#now = now;
    if (filename !== ':memory:') {
      const fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      chmodSync(filename, 0o600);
    }
    this.#db = new DatabaseSync(filename);
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#transaction(() => {
        const version = this.#db.prepare('PRAGMA user_version').get().user_version;
        requireCondition([0, 1, 2].includes(version), 'UNSUPPORTED_STORAGE_VERSION');
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS rulesets (hash TEXT PRIMARY KEY, definition TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, rules_hash TEXT NOT NULL REFERENCES rulesets(hash),
            audit TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
          ) STRICT;
          CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner_id, created_at DESC, id);
          CREATE TABLE IF NOT EXISTS creations (
            owner_id TEXT NOT NULL, request_key TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
            response TEXT NOT NULL, PRIMARY KEY(owner_id, request_key)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS leaderboard (
            owner_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
            completed_rounds INTEGER NOT NULL, score TEXT NOT NULL,
            ended_at INTEGER NOT NULL, rules_version TEXT NOT NULL
          ) STRICT;

        `);
        if (version < 2) this.#db.exec('ALTER TABLE leaderboard ADD COLUMN snapshot TEXT; PRAGMA user_version = 2;');
        const check = this.#db.prepare("SELECT value FROM metadata WHERE name = 'key-check'").get();
        if (check) {
          try { requireCondition(this.#vault.open(check.value, 'storage-key-v1') === 'nine-to-ruin', 'STORAGE_KEY_MISMATCH'); }
          catch { throw new GameError('STORAGE_KEY_MISMATCH'); }
        } else this.#db.prepare("INSERT INTO metadata VALUES ('key-check', ?)").run(this.#vault.seal('nine-to-ruin', 'storage-key-v1'));
        const definition = { balance: rules.balance, lines: rules.lineDefinitions, catalog: rules.catalog };
        this.#db.prepare('INSERT OR IGNORE INTO rulesets VALUES (?, ?)').run(rulesFingerprint(rules), JSON.stringify(definition));
      });
    } catch (error) { this.#db.close(); this.#closed = true; throw error; }
  }

  #transaction(work) {
    let started = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE'); started = true;
      const value = work();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      if (started) { try { this.#db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back. */ } }
      if (error instanceof GameError) throw error;
      if (error.errcode === 5 || error.errcode === 6) throw new GameError('STORAGE_BUSY');
      throw new GameError('STORAGE_ERROR', 'Database transaction failed');
    }
  }

  #time(previous = 0) {
    const time = this.#now();
    requireCondition(Number.isSafeInteger(time) && time >= 0, 'INVALID_SERVER_TIME');
    return Math.max(time, previous);
  }

  #load(userId, runId) {
    owner(userId);
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ? AND owner_id = ?').get(runId, userId);
    requireCondition(row !== undefined, 'RUN_NOT_FOUND');
    const definition = this.#db.prepare('SELECT definition FROM rulesets WHERE hash = ?').get(row.rules_hash);
    requireCondition(definition !== undefined, 'STORAGE_CORRUPT');
    let rules;
    try { rules = parseRules(JSON.parse(definition.definition)); }
    catch { throw new GameError('STORAGE_CORRUPT'); }
    requireCondition(rulesFingerprint(rules) === row.rules_hash, 'STORAGE_CORRUPT');
    const audit = this.#vault.open(row.audit, context(row));
    requireCondition(audit.runId === row.id && audit.userId === userId && audit.rulesFingerprint === row.rules_hash, 'STORAGE_CORRUPT');
    const session = restoreSession(rules, audit);
    return { row, audit, session, rules };
  }

  createRun(userId, idempotencyKey) {
    owner(userId); keyValid(idempotencyKey);
    return this.#transaction(() => {
      const cached = this.#db.prepare('SELECT response FROM creations WHERE owner_id = ? AND request_key = ?').get(userId, idempotencyKey);
      if (cached) {
        const response = JSON.parse(cached.response);
        const { rules } = this.#load(userId, response.state.runId);
        return { ...response, upgrades: upgradeView(response.state, rules) };
      }
      const session = new GameSession(this.#rules, { userId });
      const response = { state: session.getState(userId) };
      const time = this.#time();
      const row = { id: response.state.runId, owner_id: userId, rules_hash: rulesFingerprint(this.#rules), created_at: time };
      const encrypted = this.#vault.seal(session.exportAudit(), context(row));
      this.#db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, NULL)').run(row.id, userId, row.rules_hash, encrypted, time, time);
      this.#db.prepare('INSERT INTO creations VALUES (?, ?, ?, ?)').run(userId, idempotencyKey, row.id, JSON.stringify(response));
      return { ...response, upgrades: upgradeView(response.state, this.#rules) };
    });
  }

  getRun(userId, runId) {
    const { row, audit, session, rules } = this.#load(userId, runId);
    const state = session.getState(userId);
    const lastSpin = audit.actions.findLast((action) => action.command.type === 'SPIN')?.response.event ?? null;
    return {
      state, upgrades: upgradeView(state, rules), lastEvent: audit.actions.at(-1)?.response.event ?? null,
      lastSpin, presentation: spinPresentation(lastSpin, rules),
      createdAt: row.created_at, updatedAt: row.updated_at, endedAt: row.ended_at,
    };
  }

  catalog(userId, runId) {
    owner(userId);
    return publicCatalog(runId ? this.#load(userId, runId).rules : this.#rules);
  }

  listRuns(userId, limit = 20) {
    owner(userId); boundedLimit(limit);
    const rows = this.#db.prepare('SELECT id FROM runs WHERE owner_id = ? ORDER BY created_at DESC, id ASC LIMIT ?').all(userId, limit);
    return { runs: rows.map(({ id }) => {
      const { state, createdAt, updatedAt, endedAt } = this.getRun(userId, id);
      return { runId: id, phase: state.phase, roundIndex: state.roundIndex, completedRounds: state.completedRounds,
        runTotalScore: state.runTotalScore, revision: state.revision, createdAt, updatedAt, endedAt };
    }) };
  }

  execute(userId, runId, command) {
    return this.#transaction(() => {
      const { row, session, audit, rules } = this.#load(userId, runId);
      const response = session.execute(userId, command);
      const projected = { ...response, upgrades: upgradeView(response.state, rules), presentation: spinPresentation(response.event, rules) };
      const next = session.exportAudit();
      if (next.finalState.revision === audit.finalState.revision) return projected;
      const time = this.#time(row.updated_at);
      const endedAt = terminal(next.finalState) ? time : null;
      this.#db.prepare('UPDATE runs SET audit = ?, updated_at = ?, ended_at = ? WHERE id = ?')
        .run(this.#vault.seal(next, context(row)), time, endedAt, runId);
      if (endedAt !== null) this.#recordBest(userId, next, rules, endedAt);
      return projected;
    });
  }

  #recordBest(userId, audit, rules, endedAt) {
    const state = audit.finalState;
    const previous = this.#db.prepare('SELECT * FROM leaderboard WHERE owner_id = ?').get(userId);
    const candidate = { completedRounds: state.completedRounds, runTotalScore: state.runTotalScore, endedAt };
    if (previous && compareRecords(candidate, recordOf(previous)) >= 0) return;
    this.#db.prepare(`INSERT INTO leaderboard (owner_id, run_id, completed_rounds, score, ended_at, rules_version, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET run_id=excluded.run_id, completed_rounds=excluded.completed_rounds,
      score=excluded.score, ended_at=excluded.ended_at, rules_version=excluded.rules_version, snapshot=excluded.snapshot`)
      .run(userId, state.runId, state.completedRounds, state.runTotalScore, endedAt, state.rulesVersion, JSON.stringify(createRankSnapshot(audit, rules, state)));
  }

  playerId(userId) {
    owner(userId);
    return createHmac('sha256', this.#key).update(`player:${userId}`).digest('hex').slice(0, 24);
  }

  leaderboard(limit = 20) {
    boundedLimit(limit);
    // Canonical nonnegative decimal TEXT sorts exactly by digit count then binary text.
    const rows = this.#db.prepare(`SELECT * FROM leaderboard ORDER BY completed_rounds DESC,
      length(score) DESC, score COLLATE BINARY DESC, ended_at ASC, run_id ASC LIMIT ?`).all(limit);
    return { entries: rows.map((row, index) => ({ rank: index + 1, playerId: this.playerId(row.owner_id), runId: row.run_id,
      completedRounds: row.completed_rounds, runTotalScore: row.score, endedAt: row.ended_at, rulesVersion: row.rules_version })) };
  }

  leaderboardDetail(runId) {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM leaderboard WHERE run_id = ?').get(runId);
      requireCondition(row !== undefined, 'RANK_NOT_FOUND');
      let snapshot;
      if (row.snapshot) snapshot = JSON.parse(row.snapshot);
      else {
        // Old records may point at a run that has since entered Endless. Select the ranked terminal revision.
        const { audit, rules } = this.#load(row.owner_id, row.run_id);
        snapshot = createRankSnapshot(audit, rules, recordOf(row));
        this.#db.prepare('UPDATE leaderboard SET snapshot = ? WHERE run_id = ?').run(JSON.stringify(snapshot), runId);
      }
      return { runId: row.run_id, playerId: this.playerId(row.owner_id), snapshot };
    });
  }

  issueToken(userId) {
    owner(userId);
    const token = randomBytes(32).toString('base64url');
    this.#db.prepare('INSERT INTO tokens VALUES (?, ?)').run(hashToken(token), userId);
    return token;
  }

  authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.#db.prepare('SELECT owner_id FROM tokens WHERE hash = ?').get(hashToken(token))?.owner_id ?? null;
  }

  revokeTokens(userId) { owner(userId); return this.#db.prepare('DELETE FROM tokens WHERE owner_id = ?').run(userId).changes; }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
