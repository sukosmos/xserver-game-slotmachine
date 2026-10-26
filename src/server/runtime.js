import { mkdirSync, lstatSync, chmodSync, existsSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { GameError, requireCondition } from '../domain/errors.js';
import { GameStore } from './store.js';
import { loadRules } from './load-rules.js';

/** Private local storage. Key creation uses an atomic no-replace link for concurrent starts. */
export function openRuntime(directory = process.env.NINE_DATA_DIR ?? '.runtime') {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  requireCondition(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'INVALID_STORAGE_DIRECTORY');
  chmodSync(root, 0o700);
  const keyPath = join(root, 'master.key');
  const filename = join(root, 'game.sqlite');
  if (!existsSync(keyPath)) {
    requireCondition(!existsSync(filename), 'STORAGE_KEY_MISSING');
    const temporary = join(root, `.key-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, keyPath); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { unlinkSync(temporary); }
    const directoryFd = openSync(root, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key;
  try { key = readFileSync(fd); } finally { closeSync(fd); }
  if (key.length !== 32) throw new GameError('INVALID_STORAGE_KEY');
  chmodSync(keyPath, 0o600);
  return new GameStore({ filename, key, rules: loadRules() });
}
