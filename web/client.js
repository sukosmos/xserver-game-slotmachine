export class ApiError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export class GameClient {
  constructor({ fetcher = globalThis.fetch.bind(globalThis), storage = globalThis.sessionStorage } = {}) {
    this.fetcher = fetcher; this.storage = storage; this.owner = null;
    this.token = storage.getItem('nine.token') ?? '';
  }
  setToken(token) { this.token = token; if (token) this.storage.setItem('nine.token', token); else this.storage.removeItem('nine.token'); }
  setOwner(owner) {
    this.owner = owner;
    if (this.pending() && this.pending().owner !== owner) this.storage.removeItem('nine.pending');
  }
  pending() {
    try { return JSON.parse(this.storage.getItem('nine.pending') ?? 'null'); }
    catch { this.storage.removeItem('nine.pending'); return null; }
  }
  async get(path) { return this.request(path); }
  async request(path, body, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await this.fetcher(`/api/game/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new ApiError(data.error?.code ?? 'REQUEST_FAILED', response.status);
      return data;
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('CONNECTION_LOST'); }
    finally { clearTimeout(timer); }
  }
  async mutate(path, body, key = globalThis.crypto.randomUUID()) {
    if (this.pending()) throw new ApiError('PENDING_ACTION');
    if (!this.owner) throw new ApiError('UNAUTHENTICATED', 401);
    this.storage.setItem('nine.pending', JSON.stringify({ path, body, key, owner: this.owner }));
    return this.retry();
  }
  async retry() {
    const pending = this.pending();
    if (!pending || pending.owner !== this.owner) throw new ApiError('INVALID_PENDING_ACTION');
    try {
      const result = await this.request(pending.path, pending.body, pending.key);
      this.storage.removeItem('nine.pending');
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && ![401, 429].includes(error.status)) this.storage.removeItem('nine.pending');
      throw error;
    }
  }
}
