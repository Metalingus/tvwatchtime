// Account-restore tokens let a person's own data export prove which (now deleted) account it
// came from, so a re-import can reclaim the contributions account deletion moved to that
// account's anonymous ghost. The token is an HMAC over the original user id; it never grants
// access to a live account and is useless once the ghost's rows have been reclaimed.

import { createHmac, timingSafeEqual } from 'crypto';

const TOKEN_VERSION = 'v1';
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const signature = (secret: string, userId: string): Buffer =>
  createHmac('sha256', secret)
    .update(`tvwatchtime:account-restore:${TOKEN_VERSION}:${userId}`)
    .digest();

export function signAccountRestoreToken(secret: string, userId: string): string {
  if (!secret || !USER_ID_PATTERN.test(userId)) throw new Error('Cannot sign restore token');
  return `${TOKEN_VERSION}.${userId}.${signature(secret, userId).toString('base64url')}`;
}

/** Returns the original user id for a valid token, otherwise null. Never throws. */
export function verifyAccountRestoreToken(secret: string, token: unknown): string | null {
  if (!secret || typeof token !== 'string' || token.length > 256) return null;
  const [version, userId, encoded, ...rest] = token.split('.');
  if (rest.length || version !== TOKEN_VERSION || !userId || !encoded) return null;
  if (!USER_ID_PATTERN.test(userId)) return null;
  const expected = signature(secret, userId);
  let provided: Buffer;
  try {
    provided = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? userId : null;
}
