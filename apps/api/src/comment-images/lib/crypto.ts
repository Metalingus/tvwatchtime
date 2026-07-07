import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGO = 'aes-256-gcm';

export interface EncryptedPayload {
  ciphertext: Buffer;
  encryptedDataKey: string; // data key encrypted with master key, base64
  iv: string; // base64
  authTag: string; // base64
}

export interface DecryptionMeta {
  encryptedDataKey: string;
  iv: string;
  authTag: string;
}

/** Encrypt image bytes with a per-image random data key (envelope encryption). */
export function encryptImage(plaintext: Buffer, masterKeyHex: string): EncryptedPayload {
  const masterKey = Buffer.from(masterKeyHex, 'hex');
  if (masterKey.length !== 32) throw new Error('Master key must be 32 bytes (64 hex chars)');

  const dataKey = randomBytes(32);
  const iv = randomBytes(12);

  const cipher = createCipheriv(ALGO, dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Encrypt data key with master key
  const keyCipher = createCipheriv(ALGO, masterKey, iv);
  const encryptedDataKey = Buffer.concat([keyCipher.update(dataKey), keyCipher.final()]);
  const keyAuthTag = keyCipher.getAuthTag();

  return {
    ciphertext,
    encryptedDataKey: Buffer.concat([encryptedDataKey, keyAuthTag]).toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/** Decrypt image bytes using stored metadata + master key. */
export function decryptImage(ciphertext: Buffer, meta: DecryptionMeta, masterKeyHex: string): Buffer {
  const masterKey = Buffer.from(masterKeyHex, 'hex');

  // Decrypt data key
  const encKeyBuf = Buffer.from(meta.encryptedDataKey, 'base64');
  const keyCiphertext = encKeyBuf.subarray(0, encKeyBuf.length - 16);
  const keyAuthTag = encKeyBuf.subarray(encKeyBuf.length - 16);
  const iv = Buffer.from(meta.iv, 'base64');

  const keyDecipher = createDecipheriv(ALGO, masterKey, iv);
  keyDecipher.setAuthTag(keyAuthTag);
  const dataKey = Buffer.concat([keyDecipher.update(keyCiphertext), keyDecipher.final()]);

  // Decrypt image
  const decipher = createDecipheriv(ALGO, dataKey, iv);
  decipher.setAuthTag(Buffer.from(meta.authTag, 'base64'));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
