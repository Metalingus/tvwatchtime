import { WatchForgeClient } from './watchforge.client';
import { ProviderHttp } from './shared/provider-http';

function fixture() {
  const cache = new Map<string, unknown>();
  const redis: any = {
    get: jest.fn(async (key: string) => cache.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
    client: {
      hincrby: jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
      del: jest.fn(async (key: string) => {
        cache.delete(key);
      }),
      get: jest.fn(async (key: string) => cache.get(key) ?? null),
      incr: jest.fn(async () => 1),
    },
  };
  const limiter: any = {
    fixedWindow: jest.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
    dailyBudget: jest.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
    runWithConcurrency: jest.fn(async (_p, _c, _t, fn) => fn()),
    distinctLock: jest.fn(async (_k, _t, fn) => fn()),
  };
  const settings: any = {
    watchforge: jest.fn(async () => ({
      enabled: true,
      rps: 1,
      rpm: 50,
      concurrency: 1,
      requestsPerDay: 900,
      timeoutMs: 1000,
      maxRetries: 0,
      cacheTtlSec: 86400,
      negativeCacheTtlSec: 3600,
    })),
    watchforgeCredentials: jest.fn(async () => ({ apiKey: 'private-test-key' })),
  };
  const http = new ProviderHttp(redis, limiter, settings);
  const fetcher = jest.fn(async () => new Response(JSON.stringify(catalog()), { status: 200 }));
  http.setFetchImpl(fetcher);
  return {
    client: new WatchForgeClient(settings, http, limiter, redis),
    fetcher,
    cache,
    redis,
    limiter,
    settings,
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

describe('WatchForgeClient', () => {
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
    const [url, init] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
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
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.limiter.dailyBudget).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...catalog(), media_type: 'tv' },
    { ...catalog(), tmdb: 999 },
    { ...catalog(), ids: { ...catalog().ids, tvdb: ['0'] } },
    { ...catalog(), queried: { provider: 'tvdb', media_type: 'movie', id: '585' } },
    { ...catalog(), queried: { provider: 'tmdb', media_type: 'movie', id: '999' } },
  ])('rejects mismatched or malformed identities before caching', async (body) => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
    expect(await f.client.lookup(query)).toMatchObject({
      status: 'deferred',
      reason: 'invalid_response',
    });
    expect([...f.cache.keys()].some((key) => key.startsWith('PC:'))).toBe(false);
  });

  it('retains multiple aliases without choosing one as an automatic repair target', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(
      async () =>
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
    f.fetcher.mockImplementation(
      async () =>
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
    f.fetcher.mockImplementation(async () => new Response('{}', { status: 503 }));
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
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a missing catalog mapping without treating it as a provider outage', async () => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => new Response('{}', { status: 404 }));
    expect(await f.client.lookup(query)).toEqual({ status: 'unmapped' });
    expect(await f.client.lookup(query)).toEqual({ status: 'unmapped' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('defers on quota exhaustion without an HTTP request or circuit-breaker failure', async () => {
    const f = fixture();
    f.limiter.dailyBudget.mockResolvedValue({ allowed: false, retryAfterMs: 3600000 });
    expect(await f.client.lookup(query)).toMatchObject({ status: 'deferred', reason: 'quota' });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.redis.client.incr).not.toHaveBeenCalled();
    f.limiter.fixedWindow.mockClear();
    await f.client.lookup({ ...query, id: '586' });
    expect(f.limiter.fixedWindow).not.toHaveBeenCalled();
  });

  it('honors Retry-After across different identities while allowing cached reads', async () => {
    const f = fixture();
    await f.client.lookup(query);
    f.fetcher.mockImplementation(
      async () =>
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
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])(
    'pauses invalid authorization (%s) without leaking the key',
    async (status) => {
      const f = fixture();
      f.fetcher.mockImplementation(async () => new Response('{}', { status }));
      const result = await f.client.lookup(query);
      expect(result).toMatchObject({ status: 'deferred', reason: 'auth' });
      expect(JSON.stringify(result)).not.toContain('private-test-key');
      await f.client.lookup({ ...query, id: '586' });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
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
