import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { ConfigService } from '@nestjs/config';

/** Simple local temp storage for uploaded import files (S3 path left as a TODO hook). */
export class ImportStorage {
  readonly dir: string;
  constructor(private readonly config: ConfigService) {
    this.dir = join(process.cwd(), 'storage', 'imports');
  }

  async ensure() {
    await mkdir(this.dir, { recursive: true });
  }

  keyFor(importId: string, originalName: string) {
    const ext = (originalName.split('.').pop() || 'bin').toLowerCase();
    return join(this.dir, `${importId}.${ext}`);
  }

  async write(importId: string, originalName: string, bytes: Buffer) {
    await this.ensure();
    const key = this.keyFor(importId, originalName);
    await writeFile(key, bytes);
    return key;
  }

  read(key: string) {
    return readFile(key);
  }

  async delete(key: string) {
    await rm(key, { force: true });
  }

  sha256(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex');
  }
}

export const newId = () => randomUUID();
