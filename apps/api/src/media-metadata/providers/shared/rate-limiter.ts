import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';

/** Per-provider resilience settings used by the limiter. 0/unlimited means "no limit". */
export interface ProviderRateSettings {
  enabled: boolean;
  rps: number; // 0 = unlimited
  rpm: number; // 0 = unlimited
  concurrency: number; // 0 = unlimited
}

export interface FixedWindowResult {
  allowed: boolean;
  /** Milliseconds until the blocking window resets (only meaningful when !allowed). */
  retryAfterMs: number;
}

/**
 * Redis-backed **fixed-window** rate limiter (NOT a token bucket) + a per-provider
 * concurrency semaphore (ZSET with leases) + a single-flight distinct lock.
 *
 * Shared across all API instances/workers via Redis. Internal throttling returns a
 * retry delay — it is never classified as a provider failure (see ProviderError).
 */
@Injectable()
export class ProviderRateLimiter {
  // Fixed-window check: INCR sec + min buckets atomically, return {blocked, retryMs}.
  private static readonly FW = `-- FW
local skey = KEYS[1]; local mkey = KEYS[2]
local rps = tonumber(ARGV[1]); local rpm = tonumber(ARGV[2])
local secTtl = tonumber(ARGV[3]); local minTtl = tonumber(ARGV[4])
local s = redis.call('INCR', skey); if s == 1 then redis.call('EXPIRE', skey, secTtl) end
local m = redis.call('INCR', mkey); if m == 1 then redis.call('EXPIRE', mkey, minTtl) end
local blocked = 0; local retry = 0
if rps > 0 and s > rps then blocked = 1; local t = redis.call('PTTL', skey); if t > retry then retry = t end end
if rpm > 0 and m > rpm then blocked = 1; local t = redis.call('PTTL', mkey); if t > retry then retry = t end end
if blocked == 1 and retry < 1 then retry = 1000 end
return {tostring(blocked), tostring(retry)}
`;

  // Concurrency acquire: drop expired leases, admit if below cap, register token.
  private static readonly SEMA = `-- SEMA
local key = KEYS[1]; local concurrency = tonumber(ARGV[1]); local now = tonumber(ARGV[2]); local ttl = tonumber(ARGV[3]); local token = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - ttl)
local n = redis.call('ZCARD', key)
if n >= concurrency then return 0 end
redis.call('ZADD', key, now, token)
redis.call('PEXPIRE', key, ttl + 1000)
return 1
`;

  // Distinct-lock release: only delete if we still own it.
  private static readonly LOCK_RELEASE = `-- LOCKREL
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
`;

  constructor(private readonly redis: RedisService) {}

  /** Concurrency lease duration (a crashed worker's slot expires after this). */
  private leaseMs = 30_000;
  /** Test-only override for the lease window. */
  setLeaseMsForTest(ms: number) {
    this.leaseMs = ms;
  }

  private nowMs(): number {
    return Date.now();
  }

  /** Apply per-second + per-minute fixed windows. Returns allowed + retry delay. */
  async fixedWindow(provider: string, cfg: ProviderRateSettings): Promise<FixedWindowResult> {
    if (!cfg.enabled || (cfg.rps <= 0 && cfg.rpm <= 0)) return { allowed: true, retryAfterMs: 0 };
    const bucket = this.nowMs();
    const secKey = `RL:${provider}:s:${Math.floor(bucket / 1000)}`;
    const minKey = `RL:${provider}:m:${Math.floor(bucket / 60000)}`;
    const res = (await this.redis.client.eval(
      ProviderRateLimiter.FW,
      2,
      secKey,
      minKey,
      String(cfg.rps),
      String(cfg.rpm),
      '2', // sec ttl
      '65', // min ttl (window + slack)
    )) as string[];
    const blocked = Number(res[0]) === 1;
    return { allowed: !blocked, retryAfterMs: blocked ? Math.max(1, Number(res[1])) : 0 };
  }

  /** Try once to acquire a concurrency slot; returns true if admitted. */
  private async trySlot(provider: string, cfg: ProviderRateSettings, token: string): Promise<boolean> {
    if (!cfg.enabled || cfg.concurrency <= 0) return true;
    const key = `SEMA:${provider}`;
    const res = (await this.redis.client.eval(
      ProviderRateLimiter.SEMA,
      1,
      key,
      String(cfg.concurrency),
      String(this.nowMs()),
      String(this.leaseMs),
      token,
    )) as number;
    return res === 1;
  }

  async releaseSlot(provider: string, token: string): Promise<void> {
    await this.redis.client.zrem(`SEMA:${provider}`, token).catch(() => undefined);
  }

  /** Block until a concurrency slot is acquired (or timeout); throws on timeout. */
  async acquireSlot(provider: string, cfg: ProviderRateSettings, token: string, timeoutMs = 30_000): Promise<boolean> {
    if (!cfg.enabled || cfg.concurrency <= 0) return true;
    const deadline = this.nowMs() + timeoutMs;
    while (this.nowMs() < deadline) {
      if (await this.trySlot(provider, cfg, token)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  /** Acquire a slot, run fn, always release (finally). Lease protects against leaks. */
  async runWithConcurrency<T>(provider: string, cfg: ProviderRateSettings, token: string, fn: () => Promise<T>): Promise<T> {
    const ok = await this.acquireSlot(provider, cfg, token);
    if (!ok) throw new Error(`concurrency timeout for ${provider}`);
    try {
      return await fn();
    } finally {
      await this.releaseSlot(provider, token);
    }
  }

  /**
   * Single-flight distinct lock: the caller that wins the lock runs `fn`; concurrent
   * callers with the same key wait for it to finish. Used for TVDB token refresh and
   * request dedup. Returns fn's result to all waiters via the provided reader.
   */
  async distinctLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const token = `${this.nowMs()}:${Math.random().toString(36).slice(2)}`;
    const lockKey = `LOCK:${key}`;
    const acquired = (await this.redis.client.set(lockKey, token, 'PX', ttlMs, 'NX')) === 'OK';
    if (acquired) {
      try {
        return await fn();
      } finally {
        await this.redis.client.eval(ProviderRateLimiter.LOCK_RELEASE, 1, lockKey, token).catch(() => undefined);
      }
    }
    // Lost the lock — wait for the holder, polling lock absence.
    const waited = await this.waitForLock(lockKey, ttlMs + 5000);
    if (!waited) {
      // Holder never released in time; take over.
      return this.distinctLock(key, ttlMs, fn);
    }
    // The caller is responsible for reading the shared result (e.g. the refreshed token)
    // after this resolves; for refresh flows the reader re-reads Redis. Return undefined
    // to signal "someone else handled it".
    return undefined as unknown as T;
  }

  private async waitForLock(lockKey: string, timeoutMs: number): Promise<boolean> {
    const deadline = this.nowMs() + timeoutMs;
    while (this.nowMs() < deadline) {
      const exists = await this.redis.client.exists(lockKey);
      if (!exists) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }
}
