export class GameError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

export function requireCondition(condition, code, message) {
  if (!condition) throw new GameError(code, message);
}
