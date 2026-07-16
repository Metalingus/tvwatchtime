import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    const url = config.get<string>('redis.url');
    const host = config.get<string>('redis.host');
    const port = config.get<number>('redis.port');
    const password = config.get<string>('redis.password');

    const opts: any = { maxRetriesPerRequest: null, enableReadyCheck: false };
    if (password) opts.password = password;

    this.client = url
      ? new IORedis(url, opts)
      : new IORedis({ host, port, ...opts });

    this.client.on('error', (e) => this.logger.error(`Redis error: ${e.message}`));
    this.client.on('connect', () => this.logger.log('Redis connected'));
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Delete every key matching a glob pattern (e.g. `watchnext:${userId}:*`).
   * Needed because user caches are language-suffixed
   * (watchnext:userId:en, watchnext:userId:fr, …) so a plain del() of the bare
   * key never hits them. Uses SCAN (non-blocking) + DEL in batches.
   */
  async delByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) {
        deleted += await this.client.del(...keys);
      }
    } while (cursor !== '0');
    return deleted;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
