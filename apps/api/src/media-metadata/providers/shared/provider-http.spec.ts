import { ProviderHttp, ProviderThrottled } from './provider-http';
import { ProviderError } from './provider-errors';
import type { ProviderResilienceConfig } from './provider-config.service';

/** Fake RedisService surface used by ProviderHttp (cache + breaker + metrics). */
class FakeRedis {
  private store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.has(key) ? (this.store.get(key) as T) : null);
  }
  async set(key: string, value: unknown, _ttl = 60): Promise<void> {
    this.store.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  client = {
    incr: async (k: string) => {
      const n = ((this.store.get(k) as number) || 0) + 1;
      this.store.set(k, n);
      return n;
    },
    expire: async (_k: string, _s: number) => 1,
    del: async (k: string) => {
      this.store.delete(k);
      return 1;
    },
    get: async (k: string) => (this.store.has(k) ? ((this.store.get(k) as string) ?? null) : null),
    hincrby: async () => 0,
  };
  clear() {
    this.store.clear();
  }
}

/** Stub rate limiter: always admits, runs fn directly. */
const stubLimiter = () => ({
  fixedWindow: async () => ({ allowed: true as const, retryAfterMs: 0 }),
  runWithConcurrency: async (_p: string, _c: unknown, _t: string, fn: () => Promise<unknown>) => fn(),
  acquireSlot: async () => true,
  releaseSlot: async () => undefined,
  distinctLock: async <T>(_k: string, _t: number, fn: () => Promise<T>) => fn(),
});

const baseCfg = (): ProviderResilienceConfig => ({
  tag: 'x',
  enabled: true,
  rps: 0,
  rpm: 0,
  concurrency: 0,
  timeoutMs: 5000,
  maxRetries: 2,
  backoffBaseMs: 1,
  backoffMaxMs: 5,
  cacheTtlSec: 60,
  negativeCacheTtlSec: 60,
});

/** Build a fake fetch that returns the given sequence of responses. */
function seqFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  let i = 0;
  let calls = 0;
  const fn = async (_url: string, init: RequestInit) => {
    calls++;
    const r = responses[Math.min(i, responses.length - 1)];
    if (r.status !== 200 || i < responses.length) i++;
    // honor abort signal (timeout test)
    if (init.signal) {
      const sig = init.signal as AbortSignal;
      if (sig.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body ?? {},
    } as unknown as Response;
  };
  return { fn, calls: () => calls };
}

const makeHttp = () => {
  const redis = new FakeRedis();
  const http = new ProviderHttp(redis as any, stubLimiter() as any, null as any);
  return { http, redis };
};

describe('ProviderHttp — cache', () => {
  it('serves a positive cache hit without calling the provider', async () => {
    const { http, redis } = makeHttp();
    await redis.set('PC:tmdb:/x', { cached: true });
    const f = seqFetch([{ status: 200, body: { live: true } }]);
    http.setFetchImpl(f.fn);
    const out = await http.fetchJson<any>({ provider: 'tmdb', config: baseCfg(), url: 'u', cacheKey: 'tmdb:/x' });
    expect(out).toEqual({ cached: true });
    expect(f.calls()).toBe(0);
  });

  it('caches a 404 negatively and does not retry it', async () => {
    const { http } = makeHttp();
    const f = seqFetch([{ status: 404 }]);
    http.setFetchImpl(f.fn);
    await expect(
      http.fetchJson({ provider: 'tmdb', config: baseCfg(), url: 'u', cacheKey: 'tmdb:/x' }),
    ).rejects.toMatchObject({ category: 'not_found' });
    expect(f.calls()).toBe(1); // no retries on 404
    // second call served from negative cache, still no provider call
    await expect(
      http.fetchJson({ provider: 'tmdb', config: baseCfg(), url: 'u', cacheKey: 'tmdb:/x' }),
    ).rejects.toMatchObject({ category: 'not_found' });
    expect(f.calls()).toBe(1);
  });
});

describe('ProviderHttp — retry classification', () => {
  it('retries 429 honoring Retry-After then succeeds', async () => {
    const { http } = makeHttp();
    const f = seqFetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 200, body: { ok: 1 } },
    ]);
    http.setFetchImpl(f.fn);
    const out = await http.fetchJson<any>({ provider: 'tmdb', config: baseCfg(), url: 'u' });
    expect(out).toEqual({ ok: 1 });
    expect(f.calls()).toBe(2);
  });

  it('retries 5xx then fails after max retries', async () => {
    const { http } = makeHttp();
    const f = seqFetch([{ status: 503 }]);
    http.setFetchImpl(f.fn);
    await expect(http.fetchJson({ provider: 'tmdb', config: baseCfg(), url: 'u' })).rejects.toMatchObject({
      category: 'upstream',
    });
    // initial + maxRetries(2) = 3 attempts
    expect(f.calls()).toBe(3);
  });

  it('retries network errors then fails', async () => {
    const { http } = makeHttp();
    let calls = 0;
    http.setFetchImpl(async () => {
      calls++;
      throw new Error('ECONNRESET');
    });
    await expect(http.fetchJson({ provider: 'tmdb', config: baseCfg(), url: 'u' })).rejects.toMatchObject({
      category: 'network',
    });
    expect(calls).toBe(3);
  });

  it('does NOT retry a 400', async () => {
    const { http } = makeHttp();
    const f = seqFetch([{ status: 400 }]);
    http.setFetchImpl(f.fn);
    await expect(http.fetchJson({ provider: 'tmdb', config: baseCfg(), url: 'u' })).rejects.toMatchObject({
      category: 'client',
    });
    expect(f.calls()).toBe(1);
  });

  it('aborts on timeout and classifies as timeout (not retried indefinitely)', async () => {
    const cfg = { ...baseCfg(), timeoutMs: 30, maxRetries: 1 };
    const { http } = makeHttp();
    let calls = 0;
    http.setFetchImpl((_u, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    });
    await expect(http.fetchJson({ provider: 'tmdb', config: cfg, url: 'u' })).rejects.toMatchObject({
      category: 'timeout',
    });
    expect(calls).toBe(2); // retried once (timeout is retryable), then gave up
  });
});

describe('ProviderHttp — coalescing', () => {
  it('collapses concurrent identical cacheKey calls to one provider call', async () => {
    const { http } = makeHttp();
    let calls = 0;
    http.setFetchImpl(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ v: 1 }) } as unknown as Response;
    });
    const opts = { provider: 'tmdb', config: baseCfg(), url: 'u', cacheKey: 'tmdb:/x' };
    const [a, b] = await Promise.all([http.fetchJson(opts), http.fetchJson(opts)]);
    expect(a).toEqual({ v: 1 });
    expect(b).toEqual({ v: 1 });
    expect(calls).toBe(1);
  });
});

describe('ProviderHttp — circuit breaker', () => {
  it('opens after the failure threshold and rejects with circuit_open', async () => {
    const { http } = makeHttp();
    http.setFetchImpl(async () => {
      return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    });
    const cfg = { ...baseCfg(), maxRetries: 0 }; // fail fast
    // threshold is 10 within the window; exhaust it
    for (let i = 0; i < 10; i++) {
      await expect(http.fetchJson({ provider: 'tmdb', config: cfg, url: 'u' })).rejects.toBeDefined();
    }
    await expect(http.fetchJson({ provider: 'tmdb', config: cfg, url: 'u' })).rejects.toMatchObject({
      category: 'circuit_open',
    });
  });
});

describe('ProviderThrottled is not a ProviderError', () => {
  it('is a distinct, non-failure signal', () => {
    const t = new ProviderThrottled('tvdb', 1234);
    expect(t).toBeInstanceOf(ProviderThrottled);
    expect(t).not.toBeInstanceOf(ProviderError);
    expect(t.retryAfterMs).toBe(1234);
  });
});
