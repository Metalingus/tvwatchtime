import * as Crypto from 'expo-crypto';

/**
 * RFC 4122 v4 UUID that works in every browser context.
 *
 * expo-crypto's web `randomUUID()` calls `crypto.randomUUID`, which browsers only expose in
 * secure contexts (HTTPS or localhost). A self-hosted web app opened over plain HTTP on a LAN
 * address throws there, so fall back to `getRandomValues`, which every context provides.
 */
export function randomUUID(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    return uuidFromBytes(randomBytes());
  }
}

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  try {
    Crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function uuidFromBytes(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
