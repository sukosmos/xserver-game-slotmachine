import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { GameError, requireCondition } from '../domain/errors.js';

export function createVault(key) {
  requireCondition(Buffer.isBuffer(key) && key.length === 32, 'INVALID_STORAGE_KEY');
  const secret = Buffer.from(key);
  return {
    seal(value, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') });
    },
    open(envelope, context) {
      try {
        const { v, iv, tag, data } = JSON.parse(envelope);
        if (v !== 1) throw new Error('format');
        const nonce = Buffer.from(iv, 'base64url');
        const authTag = Buffer.from(tag, 'base64url');
        if (nonce.length !== 12 || authTag.length !== 16) throw new Error('size');
        const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(authTag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
      } catch { throw new GameError('STORAGE_CORRUPT', 'Cannot authenticate stored data'); }
    },
  };
}
