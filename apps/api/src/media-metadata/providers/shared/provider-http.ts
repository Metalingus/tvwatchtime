import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../common/redis/redis.service';
import { ProviderConfigService, type ProviderResilienceConfig } from './provider-config.service';
import { ProviderRateLimiter } from './rate-limiter';
import { ProviderError } from './provider-errors';

/**
 * Thrown when an internal fixed-window limit is exhausted beyond the inline-wait cap.
 * This is NOT a ProviderError and is NOT counted as a provider failure — BullMQ
 * processors should reschedule the job with `retryAfterMs`.
 */
export class ProviderThrottled extends Error {
  constructor(public readonly provider: string, public readonly retryAfterMs: number) {
    super(`throttled internally: ${provider}`);
    this.name = 'ProviderThrottled';
  }
}

export interface FetchOpts {
  /** Provider tag (used for rate limits, breaker, metrics). */
  provider: string;
  config: ProviderResilienceConfig;
  url: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Stable cache key (already locale-aware) — omit to disable caching. */
  cacheKey?: string;
}

interface BreakerState {
  threshold: number;
  windowSec: number;
  cooldownSec: number;
}

/** A pluggable fetch implementation (defaults to global fetch; fakes in tests). */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Single HTTP gateway for every metadata provider. Provider-specific URL/header
 * construction stays in the clients; this layer owns cache, rate limiting,
 * concurrency, timeout, retry/backoff, circuit breaking, coalescing and metrics.
 *
 * Internal throttling (fixed-window exhausted) returns a retry delay and is never
 * treated as a provider failure.
 */
@Injectable()
export class ProviderHttp {
  private readonly logger = new Logger(ProviderHttp.name);
  /** Inline cap for waiting on internal throttle before surfacing ProviderThrottled. */
  private readonly maxThrottleWaitMs = 5000;
  private readonly breaker: BreakerState = { threshold: 10, windowSec: 60, cooldownSec: 60 };
  /** In-process request coalescing (per cacheKey). */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Injectable fetch (tests pass a fake; production uses global fetch). */
  private fetchImpl: FetchImpl = (u, i) => fetch(u, i);

  constructor(
    private readonly redis: RedisService,
    private readonly rateLimiter: ProviderRateLimiter,
    private readonly config: ProviderConfigService,
  ) {}

  /** Tests override the fetch implementation. */
  setFetchImpl(fn: FetchImpl) {
    this.fetchImpl = fn;
  }

  async fetchJson<T>(opts: FetchOpts): Promise<T> {
    const { provider, config: cfg } = opts;
    if (!cfg.enabled) throw new ProviderError('upstream', `${provider} disabled`, 503);

    // 1) Cache (positive + negative)
    if (opts.cacheKey) {
      const hit = await this.redis.get<T>(`PC:${opts.cacheKey}`);
      if (hit !== null) {
        await this.metric(provider, 'cacheHits', 1);
        return hit;
      }
      const neg = await this.redis.get<{ status: number }>(`NC:${opts.cacheKey}`);
      if (neg !== null) throw new ProviderError('not_found', `${provider} cached 404`, 404);
    }

    // 2) Circuit breaker
    await this.guardBreaker(provider);

    // 3) Internal throttle (wait inline, bounded; never a provider failure)
    await this.awaitThrottle(provider, cfg);

    // 4) Concurrency slot + retry loop
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    return this.rateLimiter.runWithConcurrency(provider, cfg, token, () =>
      opts.cacheKey ? this.coalesce(opts) : this.fetchWithRetry<T>(opts),
    ) as Promise<T>;
  }

  // ---- coalescing (in-process + distributed) ----
  private async coalesce<T>(opts: FetchOpts): Promise<T> {
    const key = opts.cacheKey!;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = (async () => {
      try {
        return await this.fetchWithRetry<T>(opts);
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  private async fetchWithRetry<T>(opts: FetchOpts): Promise<T> {
    const { provider, config: cfg } = opts;
    await this.metric(provider, 'requests', 1);
    let lastErr: ProviderError | undefined;
    const max = cfg.maxRetries;
    for (let attempt = 0; attempt <= max; attempt++) {
      const start = Date.now();
      try {
        const json = await this.doFetch<T>(opts);
        await this.metric(provider, 'latSum', Date.now() - start);
        await this.metric(provider, 'latCount', 1);
        await this.breakerSuccess(provider);
        if (opts.cacheKey) await this.redis.set(`PC:${opts.cacheKey}`, json, cfg.cacheTtlSec);
        return json;
      } catch (e) {
        const err = this.asProviderError(e);
        await this.metric(provider, 'latSum', Date.now() - start);
        await this.metric(provider, 'latCount', 1);
        lastErr = err;
        const realProviderFailure =
          err.category === 'upstream' || err.category === 'network' || err.category === 'timeout';
        if (!err.retryable || attempt === max) {
          if (realProviderFailure) {
            await this.breakerFailure(provider);
            await this.metric(provider, 'failures', 1);
          }
          if (err.category === 'rate_limited') await this.metric(provider, 'r429', 1);
          if (err.category === 'not_found' && opts.cacheKey) {
            await this.redis.set(`NC:${opts.cacheKey}`, { status: 404 }, cfg.negativeCacheTtlSec);
          }
          throw err;
        }
        await this.metric(provider, 'retries', 1);
        if (err.category === 'rate_limited') await this.metric(provider, 'r429', 1);
        await this.sleep(this.backoff(cfg, attempt, err.retryAfterMs));
      }
    }
    throw lastErr ?? new ProviderError('upstream', `${provider} failed`, 502);
  }

  private async doFetch<T>(opts: FetchOpts): Promise<T> {
    const { provider, config: cfg } = opts;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(opts.url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted) throw new ProviderError('timeout', `${provider} timeout`, 408);
      throw new ProviderError('network', `${provider} network: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) throw new ProviderError('not_found', `${provider} 404`, 404);
    if (res.status === 401) throw new ProviderError('auth', `${provider} 401`, 401);
    if (res.status === 429) {
      const ra = this.parseRetryAfter(res.headers.get('retry-after'));
      throw new ProviderError('rate_limited', `${provider} 429`, 429, ra ?? undefined);
    }
    if (res.status >= 500) throw new ProviderError('upstream', `${provider} ${res.status}`, res.status);
    if (!res.ok) throw new ProviderError('client', `${provider} ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  // ---- throttle (internal, never a failure) ----
  private async awaitThrottle(provider: string, cfg: ProviderResilienceConfig): Promise<void> {
    const deadline = Date.now() + this.maxThrottleWaitMs;
    for (;;) {
      const { allowed, retryAfterMs } = await this.rateLimiter.fixedWindow(provider, cfg);
      if (allowed) return;
      const wait = Math.min(retryAfterMs, Math.max(0, deadline - Date.now()));
      if (wait <= 0) throw new ProviderThrottled(provider, retryAfterMs);
      await this.sleep(wait);
    }
  }

  // ---- circuit breaker ----
  private async guardBreaker(provider: string): Promise<void> {
    const open = await this.redis.get<number>(`CB:${provider}:open`);
    if (open !== null) throw new ProviderError('circuit_open', `${provider} circuit open`, 503);
  }
  private async breakerFailure(provider: string): Promise<void> {
    const key = `CB:${provider}:fail`;
    const n = await this.incrTtl(key, this.breaker.windowSec);
    if (n >= this.breaker.threshold) {
      await this.redis.set(`CB:${provider}:open`, 1, this.breaker.cooldownSec);
      this.logger.warn(`Provider ${provider} circuit OPEN (${n} failures in ${this.breaker.windowSec}s)`);
    }
  }
  private async breakerSuccess(provider: string): Promise<void> {
    const c = this.redis.client as unknown as {
      del: (k: string) => Promise<number>;
      get: (k: string) => Promise<string | null>;
    };
    await c.del(`CB:${provider}:fail`).catch(() => undefined);
    const open = await c.get(`CB:${provider}:open`).catch(() => null);
    if (open !== null) await c.del(`CB:${provider}:open`).catch(() => undefined);
  }
  private async incrTtl(key: string, ttlSec: number): Promise<number> {
    const c = this.redis.client as unknown as {
      incr: (k: string) => Promise<number>;
      expire: (k: string, s: number) => Promise<number>;
    };
    const n = await c.incr(key);
    if (n === 1) await c.expire(key, ttlSec);
    return n;
  }

  // ---- metrics ----
  private async metric(provider: string, field: string, by = 1): Promise<void> {
    const c = this.redis.client as unknown as {
      hincrby: (k: string, f: string, v: number) => Promise<number>;
      expire: (k: string, s: number) => Promise<number>;
    };
    const key = `M:${provider}:${new Date().toISOString().slice(0, 10)}`;
    try {
      await c.hincrby(key, field, by);
      await c.expire(key, 90000); // ~daily retention
    } catch {
      // metrics are best-effort
    }
  }

  // ---- helpers ----
  private backoff(cfg: ProviderResilienceConfig, attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) return retryAfterMs;
    const exp = cfg.backoffBaseMs * 2 ** attempt;
    const jitter = Math.floor(Math.random() * (cfg.backoffBaseMs / 2 + 1)); // full jitter-ish
    return Math.min(exp + jitter, cfg.backoffMaxMs);
  }
  private parseRetryAfter(h: string | null): number | null {
    if (!h) return null;
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const d = Date.parse(h);
    return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
  }
  private asProviderError(e: unknown): ProviderError {
    if (e instanceof ProviderError) return e;
    return new ProviderError('upstream', (e as Error)?.message ?? 'unknown error', 502);
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
