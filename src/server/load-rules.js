import { readFileSync } from 'node:fs';
import { parseRules } from '../domain/rules.js';
import { GameError } from '../domain/errors.js';

export function loadRules(directory = new URL('../../data/', import.meta.url)) {
  try {
    const read = (filename) => JSON.parse(readFileSync(new URL(filename, directory), 'utf8'));
    return parseRules({ balance: read('balance.v0.json'), lines: read('lines.v0.json'), catalog: read('items.v0.json') });
  } catch (error) {
    if (error instanceof GameError) throw error;
    throw new GameError('INVALID_RULES', `Cannot load rule JSON: ${error.message}`);
  }
}
