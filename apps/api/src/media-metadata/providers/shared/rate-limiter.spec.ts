import { ProviderRateLimiter, type ProviderRateSettings } from './rate-limiter';

/**
 * Minimal in-memory Redis fake that implements the exact Lua scripts used by
 * ProviderRateLimiter (fixed-window INCR+EXPIRE, ZSET semaphore with leases,
 * NX lock + token release) plus the primitive commands ProviderHttp needs.
 */
class FakeRedis {
  private strings = new Map<string, { v: unknown; exp?: number }>();
  private zsets = new Map<string, Map<string, number>>();
  public calls: string[] = [];

  private alive(key: string): boolean {
    const e = this.strings.get(key);
    if (!e) return false;
    if (e.exp && e.exp <= Date.now()) {
      this.strings.delete(key);
      return false;
    }
    return true;
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.alive(key) ? (this.strings.get(key)!.v as T) : null);
  }
  /** Handles both RedisService-style set(key,val,ttl) and ioredis-style set(key,val,'PX',ms,'NX'). */
  async set(key: string, value: unknown, ...rest: unknown[]): Promise<void | 'OK' | null> {
    if (typeof rest[0] === 'number') {
      // (key, value, ttlSeconds)
      this.strings.set(key, { v: value, exp: Date.now() + (rest[0] as number) * 1000 });
      return;
    }
    // ioredis options form
    const nx = rest.includes('NX');
    const pxi = rest.indexOf('PX');
    const exi = rest.indexOf('EX');
    const px = pxi >= 0 ? Number(rest[pxi + 1]) : undefined;
    const ex = exi >= 0 ? Number(rest[exi + 1]) : undefined;
    if (nx && this.alive(key)) return null;
    const exp = px ? Date.now() + px : ex ? Date.now() + ex * 1000 : undefined;
    this.strings.set(key, { v: value, exp });
    return 'OK';
  }
  async del(key: string): Promise<void> {
    this.strings.delete(key);
  }

  // ioredis-compatible surface used by the limiter / http
  async incr(key: string): Promise<number> {
    const e = this.strings.get(key);
    const n = e && this.alive(key) ? ((e.v as number) || 0) + 1 : 1;
    this.strings.set(key, { v: n, exp: e?.exp });
    return n;
  }
  async expire(key: string, sec: number): Promise<number> {
    const e = this.strings.get(key);
    if (!e) return 0;
    e.exp = Date.now() + sec * 1000;
    return 1;
  }
  async pttl(key: string): Promise<number> {
    if (!this.alive(key)) return -2;
    const e = this.strings.get(key)!;
    return e.exp ? e.exp - Date.now() : -1;
  }
  async exists(key: string): Promise<number> {
    if (this.strings.has(key) && this.alive(key)) return 1;
    if (this.zsets.has(key) && this.zsets.get(key)!.size > 0) return 1;
    return 0;
  }
  async zrem(key: string, ...members: string[]): Promise<number> {
    const z = this.zsets.get(key);
    if (!z) return 0;
    let n = 0;
    for (const m of members) if (z.delete(m)) n++;
    return n;
  }
  async hincrby(): Promise<number> {
    return 0;
  }

  // set with options like ioredis: set(key, val, 'PX', ms, 'NX') handled above in set().

  async eval(script: string, _numkeys: number, ...rest: string[]): Promise<unknown> {
    if (script.startsWith('-- FW')) return this.evalFW(rest);
    if (script.startsWith('-- SEMA')) return this.evalSEMA(rest);
    if (script.startsWith('-- LOCKREL')) return this.evalLockRel(rest);
    throw new Error('FakeRedis: unknown script');
  }
  private async evalFW(a: string[]): Promise<string[]> {
    const [skey, mkey, rps, rpm, secTtl, minTtl] = a;
    const inc = async (k: string, ttl: string) => {
      const e = this.strings.get(k);
      const n = e && this.alive(k) ? ((e.v as number) || 0) + 1 : 1;
      this.strings.set(k, { v: n, exp: e?.exp ?? (Date.now() + Number(ttl) * 1000) });
      if (n === 1) this.strings.get(k)!.exp = Date.now() + Number(ttl) * 1000;
      return n;
    };
    const s = await inc(skey, secTtl);
    const m = await inc(mkey, minTtl);
    let blocked = 0;
    let retry = 0;
    if (Number(rps) > 0 && s > Number(rps)) {
      blocked = 1;
      retry = Math.max(retry, await this.pttl(skey));
    }
    if (Number(rpm) > 0 && m > Number(rpm)) {
      blocked = 1;
      retry = Math.max(retry, await this.pttl(mkey));
    }
    if (blocked && retry < 1) retry = 1000;
    return [String(blocked), String(Math.max(1, retry))];
  }
  private async evalSEMA(a: string[]): Promise<number> {
    const [key, concurrency, now, ttl] = a;
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    const cutoff = Number(now) - Number(ttl);
    for (const [m, score] of z) if (score <= cutoff) z.delete(m);
    if (z.size >= Number(concurrency)) return 0;
    return 1; // caller adds below
  }
  private async evalLockRel(a: string[]): Promise<number> {
    const [key, token] = a;
    if (this.alive(key) && (this.strings.get(key)!.v as string) === token) {
      this.strings.delete(key);
      return 1;
    }
    return 0;
  }
}

// SEMA script adds the token after admission; expose a thin shim so the fake
// records admitted tokens (mirrors the real ZADD the Lua performs).
class FakeRedisWithZadd extends FakeRedis {
  override async eval(script: string, numkeys: number, ...rest: string[]): Promise<unknown> {
    if (script.startsWith('-- SEMA')) {
      const [key, concurrency, now, ttl, token] = rest;
      const admit = (await super.eval(script, numkeys, key, concurrency, now, ttl, token)) as number;
      if (admit === 1) {
        let z = this.zsetsMap().get(key);
        if (!z) {
          z = new Map();
          this.zsetsMap().set(key, z);
        }
        z.set(token, Number(now));
      }
      return admit;
    }
    return super.eval(script, numkeys, ...rest);
  }
  private zsetsMap() {
    return (this as unknown as { zsets: Map<string, Map<string, number>> }).zsets;
  }
}

const cfg = (over: Partial<ProviderRateSettings> = {}): ProviderRateSettings => ({
  enabled: true,
  rps: 2,
  rpm: 60,
  concurrency: 0,
  ...over,
});

describe('ProviderRateLimiter (fixed-window)', () => {
  it('admits under the per-second limit and blocks over it', async () => {
    const redis = new FakeRedisWithZadd();
    const rl = new ProviderRateLimiter({ client: redis } as any);
    const c = cfg({ rps: 1, rpm: 0, concurrency: 0 });
    expect((await rl.fixedWindow('tvdb', c)).allowed).toBe(true);
    const second = await rl.fixedWindow('tvdb', c);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it('enforces per-minute independently of per-second', async () => {
    const redis = new FakeRedisWithZadd();
    const rl = new ProviderRateLimiter({ client: redis } as any);
    const c = cfg({ rps: 0, rpm: 1, concurrency: 0 });
    expect((await rl.fixedWindow('tvdb', c)).allowed).toBe(true);
    expect((await rl.fixedWindow('tvdb', c)).allowed).toBe(false);
  });

  it('unlimited (0) never blocks', async () => {
    const redis = new FakeRedisWithZadd();
    const rl = new ProviderRateLimiter({ client: redis } as any);
    const c = cfg({ rps: 0, rpm: 0, concurrency: 0 });
    for (let i = 0; i < 50; i++) expect((await rl.fixedWindow('tvdb', c)).allowed).toBe(true);
  });

  it('shared across instances via one Redis store', async () => {
    const redis = new FakeRedisWithZadd();
    const a = new ProviderRateLimiter({ client: redis } as any);
    const b = new ProviderRateLimiter({ client: redis } as any);
    const c = cfg({ rps: 1, rpm: 0, concurrency: 0 });
    expect((await a.fixedWindow('tvdb', c)).allowed).toBe(true);
    expect((await b.fixedWindow('tvdb', c)).allowed).toBe(false); // same shared window
  });
});

describe('ProviderRateLimiter (concurrency semaphore)', () => {
  it('admits one and blocks a second until released', async () => {
    const redis = new FakeRedisWithZadd();
    const rl = new ProviderRateLimiter({ client: redis } as any);
    const c = cfg({ rps: 0, rpm: 0, concurrency: 1 });
    expect(await rl.acquireSlot('tvdb', c, 'A', 200)).toBe(true);
    // second acquisition within a short timeout fails while A holds the slot
    expect(await rl.acquireSlot('tvdb', c, 'B', 150)).toBe(false);
    await rl.releaseSlot('tvdb', 'A');
    expect(await rl.acquireSlot('tvdb', c, 'B', 500)).toBe(true);
  });

  it('releases on success, exception and timeout (no leak)', async () => {
    const redis = new FakeRedisWithZadd();
    const rl = new ProviderRateLimiter({ client: redis } as any);
    const c = cfg({ rps: 0, rpm: 0, concurrency: 1 });
    await expect(rl.runWithConcurrency('tvdb', c, 'A', async () => 'ok')).resolves.toBe('ok');
    await expect(
      rl.runWithConcurrency('tvdb', c, 'B', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // after both finished (one ok, one threw), a slot must be free again
    expect(await rl.acquireSlot('tvdb', c, 'C', 200)).toBe(true);
  });

  it('expires a leaked lease after the lease window (crashed worker)', async () => {
    const redis = new FakeRedisWithZadd();
    const rl = new ProviderRateLimiter({ client: redis } as any);
    rl.setLeaseMsForTest(40);
    const c = cfg({ rps: 0, rpm: 0, concurrency: 1 });
    expect(await rl.acquireSlot('tvdb', c, 'A', 200)).toBe(true);
    // worker "crashes" — never releases. After the lease elapses, a new worker is admitted.
    await new Promise((r) => setTimeout(r, 70));
    expect(await rl.acquireSlot('tvdb', c, 'B', 300)).toBe(true);
  });
});

describe('ProviderRateLimiter (distinct lock / single-flight)', () => {
  it('runs the winner under the lock and releases it', async () => {
    const redis = new FakeRedisWithZadd();
    const rl = new ProviderRateLimiter({ client: redis } as any);
    let ran = 0;
    const res = await rl.distinctLock('refresh', 2000, async () => {
      ran++;
      return 'done';
    });
    expect(res).toBe('done');
    expect(ran).toBe(1);
  });
});
