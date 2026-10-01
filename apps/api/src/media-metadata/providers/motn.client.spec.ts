import { MotnClient, parseQuotaReset, parseTopShows } from './motn.client';
import { ProviderThrottled } from './shared/provider-http';

const row = (over: Record<string, unknown> = {}) => ({
  showType: 'movie',
  imdbId: 'tt6933238',
  tmdbId: 'movie/1492640',
  title: 'UNABOMBER',
  releaseYear: 2026,
  streamingOptions: { us: [{ service: { id: 'prime' }, type: 'subscription' }] },
  ...over,
});

describe('parseTopShows', () => {
  it('keeps ranked items with typed TMDB ids and the service option types', () => {
    const list = parseTopShows(
      [
        row(),
        row({
          showType: 'series',
          tmdbId: 'tv/299939',
          imdbId: 'tt13207736',
          title: 'Monster',
          firstAirYear: 2026,
          streamingOptions: { us: [{ service: { id: 'prime' }, type: 'rent' }] },
        }),
      ],
      'US',
      'prime',
    );
    expect(list.dropped).toBe(0);
    expect(list.items).toEqual([
      {
        kind: 'MOVIE',
        tmdbId: 1492640,
        imdbId: 'tt6933238',
        title: 'UNABOMBER',
        year: 2026,
        optionTypes: ['subscription'],
      },
      {
        kind: 'SHOW',
        tmdbId: 299939,
        imdbId: 'tt13207736',
        title: 'Monster',
        year: 2026,
        optionTypes: ['rent'],
      },
    ]);
  });

  it('drops items whose TMDB namespace disagrees with the show type or is malformed', () => {
    const list = parseTopShows(
      [
        row({ tmdbId: 'tv/1' }),
        row({ tmdbId: 'movie/abc' }),
        row({ tmdbId: null }),
        row({ showType: 'episode' }),
        row({ imdbId: 'nm123' }),
      ],
      'US',
      'netflix',
    );
    expect(list.dropped).toBe(4);
    expect(list.items).toEqual([expect.objectContaining({ imdbId: null, optionTypes: [] })]);
  });

  it('rejects a non-array payload instead of caching it', () => {
    expect(() => parseTopShows({ shows: [] }, 'US', 'netflix')).toThrow('invalid top list');
  });
});

describe('parseQuotaReset', () => {
  it('accepts ISO dates, epoch seconds/milliseconds and relative seconds', () => {
    expect(parseQuotaReset('2026-11-01T00:00:00Z')).toBe('2026-11-01T00:00:00.000Z');
    expect(parseQuotaReset('1793491200')).toBe(new Date(1793491200 * 1000).toISOString());
    expect(parseQuotaReset('1793491200000')).toBe(new Date(1793491200000).toISOString());
    expect(parseQuotaReset('60', 0)).toBe(new Date(60_000).toISOString());
    expect(parseQuotaReset('soon')).toBeNull();
    expect(parseQuotaReset(null)).toBeNull();
  });
});

describe('MotnClient', () => {
  function setup(quota: unknown = null) {
    const store = new Map<string, unknown>(quota ? [['MOTN:quota', quota]] : []);
    const redis: any = {
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: unknown) => void store.set(key, value)),
    };
    const config: any = {
      motn: jest.fn(async () => ({
        enabled: true,
        baseUrl: 'https://api.movieofthenight.com/v4',
        maxRetries: 0,
      })),
      motnCredentials: jest.fn(async () => ({ apiKey: 'test-key' })),
    };
    const http: any = { fetchJson: jest.fn(async () => ({ items: [], dropped: 0 })) };
    return { client: new MotnClient(config, http, redis), http, redis, store };
  }

  it('requests one day-scoped, cached chart with the key header and no retries', async () => {
    const { client, http } = setup();
    await client.topShows('us', 'netflix');
    const opts = http.fetchJson.mock.calls[0][0];
    expect(opts.url).toBe(
      'https://api.movieofthenight.com/v4/shows/top?country=us&service=netflix',
    );
    expect(opts.headers['X-API-Key']).toBe('test-key');
    expect(opts.cacheKey).toMatch(/^motn:top:v1:US:netflix:\d{4}-\d{2}-\d{2}$/);
    expect(opts.config.maxRetries).toBe(0);
  });

  it('records the quota headers until the reset', async () => {
    const { client, store } = setup();
    const headers = new Headers({
      'x-quota-used': '2',
      'x-quota-granted': '1000',
      'x-quota-reset': '2099-11-01T00:00:00Z',
    });
    await client.observeQuota(headers);
    expect(store.get('MOTN:quota')).toMatchObject({
      used: 2,
      granted: 1000,
      remaining: 998,
      resetAt: '2099-11-01T00:00:00.000Z',
    });
  });

  it('refuses to spend once the observed quota is exhausted', async () => {
    const { client, http } = setup({
      used: 1000,
      granted: 1000,
      remaining: 0,
      resetAt: '2099-11-01T00:00:00Z',
    });
    await client.topShows('US', 'hbo');
    await expect(http.fetchJson.mock.calls[0][0].beforeRequest()).rejects.toBeInstanceOf(
      ProviderThrottled,
    );
  });
});
