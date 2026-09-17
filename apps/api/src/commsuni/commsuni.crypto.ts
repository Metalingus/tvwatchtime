import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

export function seal(secret: string, value: unknown): string {
  if (secret.length < 32) throw new Error('CommsUni encryption secret is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function unseal<T>(secret: string, value: string): T {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(secret).digest(),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
  ) as T;
}
