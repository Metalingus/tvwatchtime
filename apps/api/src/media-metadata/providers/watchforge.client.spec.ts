import { Logger } from '@nestjs/common';
import { WatchForgeClient } from './watchforge.client';
import { ProviderHttp } from './shared/provider-http';
import { WatchForgeBudget } from './watchforge-budget.service';
import { WatchForgeLedger } from './watchforge-ledger.service';

function fakeRedis() {
  const cache = new Map<string, unknown>();
  const hashes = new Map<string, Record<string, string>>();
  const redis: any = {
    get: jest.fn(async (key: string) => cache.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
    client: {
      hincrby: jest.fn(async (key: string, field: string, by: number) => {
        const hash = hashes.get(key) ?? {};
        hash[field] = String(Number(hash[field] ?? 0) + by);
        hashes.set(key, hash);
        return Number(hash[field]);
      }),
      hgetall: jest.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) })),
      hset: jest.fn(async (key: string, ...pairs: string[]) => {
        const hash = hashes.get(key) ?? {};
        for (let i = 0; i < pairs.length; i += 2) hash[pairs[i]] = pairs[i + 1];
        hashes.set(key, hash);
      }),
      expire: jest.fn(async () => 1),
      del: jest.fn(async (...keys: string[]) => {
        for (const key of keys) cache.delete(key);
      }),
      get: jest.fn(async (key: string) => cache.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown, ..._args: unknown[]) => {
        if (cache.has(key)) return null;
        cache.set(key, value);
        return 'OK';
      }),
      incr: jest.fn(async () => 1),
    },
  };
  return { redis, cache, hashes };
}

function fakePrisma() {
  const lookups = new Map<string, any>();
  const usage = new Map<string, number>();
  const key = (w: any) => [w.provider, w.mediaType, w.externalId].join('|');
  return {
    lookups,
    usage,
    prisma: {
      watchForgeLookup: {
        findUnique: jest.fn(async ({ where }: any) => lookups.get(key(where.provider_mediaType_externalId)) ?? null),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const k = key(where.provider_mediaType_externalId);
          lookups.set(k, { ...(lookups.get(k) ?? create), ...update });
        }),
      },
      watchForgeUsageDay: {
        findMany: jest.fn(async ({ where }: any) =>
          [...usage.entries()]
            .filter(([k]) => k.startsWith(where.day.toISOString().slice(0, 10)))
            .map(([k, requests]) => ({ lane: k.split('|')[1], requests })),
        ),
        upsert: jest.fn(async ({ where }: any) => {
          const k = where.day_lane.day.toISOString().slice(0, 10) + '|' + where.day_lane.lane;
          usage.set(k, (usage.get(k) ?? 0) + 1);
        }),
      },
    } as any,
  };
}

function fixture() {
  const { redis, cache, hashes } = fakeRedis();
  const db = fakePrisma();
  const limiter: any = {
    fixedWindow: jest.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
    runWithConcurrency: jest.fn(async (_p, _c, _t, fn) => fn()),
    distinctLock: jest.fn(async (_k, _t, fn) => fn()),
  };
  const settings: any = {
    watchforge: jest.fn(async () => ({
      enabled: true,
      rps: 1,
      rpm: 50,
      concurrency: 1,
      timeoutMs: 1000,
      maxRetries: 0,
      cacheTtlSec: 86400,
      negativeCacheTtlSec: 3600,
      requestsPerDayCap: null,
      fallbackRequestsPerDay: 900,
      lanes: { interactive: 0.45, repair: 0.25, backlog: 0.3 },
      backlogReleaseHourUtc: 24,
    })),
    watchforgeCredentials: jest.fn(async () => ({ apiKey: 'private-test-key' })),
  };
  const http = new ProviderHttp(redis, limiter, settings);
  let lookupResponse: () => Response = () =>
    new Response(JSON.stringify(catalog()), { status: 200 });
  const fetcher = jest.fn(async (url: string) =>
    url.endsWith('/v1/me')
      ? new Response(JSON.stringify({ rate_limit: { per_day: 1000, per_minute: 60 } }))
      : lookupResponse(),
  );
  http.setFetchImpl(fetcher as any);
  const budget = new WatchForgeBudget(db.prisma, redis);
  const ledger = new WatchForgeLedger(db.prisma);
  return {
    client: new WatchForgeClient(settings, http, limiter, redis, budget, ledger),
    fetcher,
    /** Paid catalog lookups only (excludes /me account refreshes). */
    lookups: () => fetcher.mock.calls.filter(([url]) => String(url).includes('/catalog/lookup')),
    respond: (fn: () => Response) => {
      lookupResponse = fn;
    },
    cache,
    hashes,
    db,
    redis,
    limiter,
    settings,
    budget,
  };
}
const query = { provider: 'tmdb' as const, mediaType: 'movie' as const, id: '585' };
function catalog() {
  return {
    wf_id: '99999999999999999999',
    media_type: 'movie',
    title: 'Monsters, Inc.',
    year: 2001,
    tmdb: 585,
    tvdb: 331,
    imdb: 'tt0198781',
    tvtime_uuid: null,
    ids: { tmdb: ['585'], tvdb: ['331'], imdb: ['tt0198781'], tvtime_uuid: [] },
  };
}
const spendHashes = (f: ReturnType<typeof fixture>) =>
  [...f.hashes.entries()].filter(([key]) => key.includes(':spend:')).map(([, hash]) => hash);
const spent = (f: ReturnType<typeof fixture>) =>
  spendHashes(f).reduce(
    (sum, hash) => sum + Object.values(hash).reduce((s, v) => s + Number(v), 0),
    0,
  );

describe('WatchForgeClient', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('uses explicit namespaces, header auth, and retains large WFDB IDs as strings', async () => {
    const f = fixture();
    const result = await f.client.lookup(query);
    expect(result).toMatchObject({
      status: 'found',
      identity: {
        wfId: '99999999999999999999',
        ids: { tmdb: ['585'], tvdb: ['331'] },
      },
    });
    const [url, init] = f.lookups()[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://api.watchforge.app/v1/catalog/lookup?type=tmdb&media_type=movie&id=585',
    );
    expect(init.headers).toEqual({ Authorization: 'Bearer private-test-key' });
    expect(JSON.stringify(result)).not.toContain('private-test-key');
  });

  it('coalesces lookups and does not charge the daily budget for cache hits', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.client.lookup(query), f.client.lookup(query)]);
    expect(a).toEqual(b);
    await f.client.lookup(query);
    expect(f.lookups()).toHaveLength(1);
    expect(spent(f)).toBe(1);
  });

  it('charges the lane named by the caller and mirrors spend durably', async () => {
    const f = fixture();
    await f.client.lookup(query, { lane: 'interactive' });
    await f.client.lookup({ ...query, id: '586' });
    expect(spendHashes(f)).toEqual([{ interactive: '1', repair: '1' }]);
    expect([...f.db.usage.values()].reduce((s, n) => s + n, 0)).toBe(2);
  });

  it('learns the account daily limit from /me once and applies a safety margin', async () => {
    const f = fixture();
    await f.client.lookup(query);
    await f.client.lookup({ ...query, id: '586' });
    expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/v1/me'))).toHaveLength(1);
    const usage: any = await f.client.usage();
    expect(usage).toMatchObject({ limit: 980, limitSource: 'provider', used: 2 });
  });

  it.each([
    { ...catalog(), media_type: 'tv' },
    { ...catalog(), tmdb: 999 },
    { ...catalog(), ids: { ...catalog().ids, tvdb: ['0'] } },
    { ...catalog(), queried: { provider: 'tvdb', media_type: 'movie', id: '585' } },
    { ...catalog(), queried: { provider: 'tmdb', media_type: 'movie', id: '999' } },
  ])('rejects mismatched or malformed identities before caching', async (body) => {
    const f = fixture();
    f.respond(() => new Response(JSON.stringify(body), { status: 200 }));
    expect(await f.client.lookup(query)).toMatchObject({
      status: 'deferred',
      reason: 'invalid_response',
    });
    expect([...f.cache.keys()].some((key) => key.startsWith('PC:'))).toBe(false);
  });

  it('quarantines one malformed record without pausing other identities or paying again', async () => {
    const f = fixture();
    f.respond(() => new Response(JSON.stringify({ ...catalog(), tmdb: 999 }), { status: 200 }));
    await f.client.lookup(query);
    expect(await f.client.lookup(query)).toMatchObject({ reason: 'invalid_response' });
    f.respond(() => new Response(JSON.stringify(catalog()), { status: 200 }));
    expect(await f.client.lookup({ ...query, id: '586' })).toMatchObject({
      status: 'deferred', // parse still rejects id 586 against the 585 fixture, but it was asked
    });
    expect(f.lookups()).toHaveLength(2);
  });

  it('never pays twice for an unmapped identifier, even after the Redis cache is lost', async () => {
    const f = fixture();
    f.respond(() => new Response('{}', { status: 404 }));
    expect(await f.client.lookup(query)).toEqual({ status: 'unmapped' });
    for (const key of [...f.cache.keys()]) if (key.startsWith('NC:')) f.cache.delete(key);
    expect(await f.client.lookup(query)).toEqual({ status: 'unmapped' });
    expect(f.lookups()).toHaveLength(1);
  });

  it('remembers ambiguous identifiers instead of paying for every repeat', async () => {
    const f = fixture();
    f.respond(() => new Response('{}', { status: 409 }));
    for (let i = 0; i < 3; i++)
      expect(await f.client.lookup(query)).toEqual({ status: 'conflict', reason: 'ambiguous_id' });
    expect(f.lookups()).toHaveLength(1);
  });

  it('pays again only for an explicit fresh re-verification', async () => {
    const f = fixture();
    f.respond(() => new Response('{}', { status: 404 }));
    await f.client.lookup(query);
    await f.client.lookup(query, { fresh: true });
    expect(f.lookups()).toHaveLength(2);
  });

  it('lets a lock waiter reuse the holder outcome instead of paying again', async () => {
    const f = fixture();
    f.respond(() => new Response('{}', { status: 409 }));
    await f.client.lookup(query); // holder paid and recorded "ambiguous"
    f.limiter.distinctLock.mockImplementation(async () => undefined); // next caller only waited
    for (const key of [...f.cache.keys()]) f.cache.delete(key);
    const result = await (f.client as any).lookupIdentity(query, { fresh: false });
    expect(result).toEqual({ status: 'conflict', reason: 'ambiguous_id' });
    expect(f.lookups()).toHaveLength(1);
  });

  it('does not pause WatchForge for everyone when a local concurrency slot times out', async () => {
    const f = fixture();
    await f.client.usage(); // warm the /me account limit so the next slot is the lookup's
    f.limiter.runWithConcurrency.mockRejectedValueOnce(new Error('concurrency timeout for watchforge'));
    expect(await f.client.lookup(query)).toMatchObject({ status: 'deferred', reason: 'unavailable' });
    expect(await f.client.lookup({ ...query, id: '586' })).toMatchObject({ status: 'deferred' });
    expect([...f.cache.keys()].some((key) => key.endsWith(':pause'))).toBe(false);
  });

  it('retains multiple aliases without choosing one as an automatic repair target', async () => {
    const f = fixture();
    f.respond(
      () =>
        new Response(
          JSON.stringify({
            ...catalog(),
            ids: { ...catalog().ids, tvdb: ['331', '999'] },
          }),
        ),
    );
    expect(await f.client.lookup(query)).toMatchObject({
      status: 'found',
      identity: { ids: { tvdb: ['331', '999'] } },
    });
  });

  it('accepts the live API tvtime namespace for UUID lookup', async () => {
    const f = fixture(),
      id = '50321201-f5ab-4896-96c3-a36cc5ba1b47';
    f.respond(
      () =>
        new Response(
          JSON.stringify({
            ...catalog(),
            queried: { provider: 'tvtime', media_type: 'movie', id },
            tvtime_uuid: id,
            ids: { ...catalog().ids, tvtime_uuid: [id], tvtime: [id] },
          }),
          { status: 200 },
        ),
    );
    expect(
      await f.client.lookup({ provider: 'tvtime_uuid', mediaType: 'movie', id }),
    ).toMatchObject({ status: 'found' });
  });

  it('short-circuits 600 identities during cooldown before any rate-limit waiting', async () => {
    const f = fixture();
    f.respond(() => new Response('{}', { status: 503 }));
    await f.client.lookup(query);
    f.limiter.fixedWindow.mockClear();
    f.limiter.distinctLock.mockClear();
    for (let i = 0; i < 600; i++)
      expect(await f.client.lookup({ ...query, id: String(1000 + i) })).toMatchObject({
        status: 'deferred',
        reason: 'unavailable',
      });
    expect(f.limiter.fixedWindow).not.toHaveBeenCalled();
    expect(f.limiter.distinctLock).not.toHaveBeenCalled();
    expect(f.lookups()).toHaveLength(1);
  });

  it('defers on lane exhaustion without an HTTP request or circuit-breaker failure', async () => {
    const f = fixture();
    jest.spyOn(f.budget, 'admit').mockResolvedValue({ allowed: false, retryAfterMs: 3600000 });
    expect(await f.client.lookup(query)).toMatchObject({ status: 'deferred', reason: 'quota' });
    expect(f.lookups()).toHaveLength(0);
    expect(f.redis.client.incr).not.toHaveBeenCalled();
    f.limiter.fixedWindow.mockClear();
    await f.client.lookup({ ...query, id: '586' });
    expect(f.limiter.fixedWindow).not.toHaveBeenCalled();
  });

  it('keeps the interactive lane open when the repair lane is exhausted', async () => {
    const f = fixture();
    jest
      .spyOn(f.budget, 'admit')
      .mockImplementation(async (_cred, lane) =>
        lane === 'repair' ? { allowed: false, retryAfterMs: 3600000 } : { allowed: true, retryAfterMs: 0 },
      );
    expect(await f.client.lookup(query, { lane: 'repair' })).toMatchObject({ reason: 'quota' });
    expect(await f.client.lookup({ ...query, id: '586' }, { lane: 'interactive' })).toMatchObject({
      status: 'deferred', // 586 fails validation against the fixture, but the request was allowed
    });
    expect(f.lookups()).toHaveLength(1);
  });

  it('honors Retry-After across different identities while allowing cached reads', async () => {
    const f = fixture();
    await f.client.lookup(query);
    f.respond(
      () =>
        new Response('{}', {
          status: 429,
          headers: { 'Retry-After': '3600' },
        }),
    );
    expect(await f.client.lookup({ ...query, id: '586' })).toMatchObject({
      status: 'deferred',
      reason: 'quota',
    });
    expect(await f.client.lookup({ ...query, id: '587' })).toMatchObject({
      status: 'deferred',
      reason: 'quota',
    });
    expect(await f.client.lookup(query)).toMatchObject({ status: 'found' });
    expect(f.lookups()).toHaveLength(2);
  });

  it('records the provider daily window from X-RateLimit headers', async () => {
    const f = fixture();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    f.respond(
      () =>
        new Response(JSON.stringify(catalog()), {
          status: 200,
          headers: {
            'X-RateLimit-Limit': '1000',
            'X-RateLimit-Remaining': '120',
            'X-RateLimit-Reset': String(reset),
          },
        }),
    );
    await f.client.lookup(query);
    const usage: any = await f.client.usage();
    expect(usage.providerRemaining).toBe(120);
  });

  it.each([401, 403])(
    'pauses invalid authorization (%s) without leaking the key',
    async (status) => {
      const f = fixture();
      f.respond(() => new Response('{}', { status }));
      const result = await f.client.lookup(query);
      expect(result).toMatchObject({ status: 'deferred', reason: 'auth' });
      expect(JSON.stringify(result)).not.toContain('private-test-key');
      await f.client.lookup({ ...query, id: '586' });
      expect(f.lookups()).toHaveLength(1);
    },
  );

  it('does not access the provider when disabled or the input ID is invalid', async () => {
    const f = fixture();
    f.settings.watchforgeCredentials.mockResolvedValue({});
    expect(await f.client.lookup(query)).toMatchObject({ status: 'deferred', reason: 'disabled' });
    expect(await f.client.lookup({ ...query, id: '9007199254740993' })).toEqual({
      status: 'conflict',
      reason: 'invalid_identity',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
