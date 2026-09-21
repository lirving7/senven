import { createHash, randomBytes } from 'node:crypto';

/** Cookie 里放明文 token；数据库只存其哈希（sha256）。库泄露 ≠ 会话可被冒用。 */

export const SESSION_TOKEN_BYTES = 32;

export function newSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
