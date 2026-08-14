import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

@Injectable()
export class IntegrationCredentialService {
  constructor(private readonly config: ConfigService) {}

  private key(): Buffer {
    const secret =
      this.config.get<string>('commentImages.encryptionMasterKey') ||
      'dev-master-key-change-in-prod-32bytes!';
    return createHash('sha256').update(secret, 'utf8').digest();
  }

  encrypt(value: Record<string, unknown>): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  decrypt<T extends Record<string, unknown>>(value: string): T {
    try {
      const data = Buffer.from(value, 'base64');
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const encrypted = data.subarray(28);
      const decipher = createDecipheriv(ALGORITHM, this.key(), iv);
      decipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'),
      ) as T;
    } catch {
      throw new InternalServerErrorException('Integration credentials could not be decrypted');
    }
  }
}
