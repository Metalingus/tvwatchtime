import { MediaType } from '@prisma/client';
import { DiscoveryService } from './discovery.service';
import { TmdbProvider } from './providers/tmdb.provider';
import { ProviderError } from './providers/shared/provider-errors';

/** posterLast: stable poster-last ordering for merged search result windows. */
describe('DiscoveryService.posterLast', () => {
  const make = (rows: { id: string; posterUrl: string | null }[]) => {
    const prisma = {
      mediaItem: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
    );
    return { svc, prisma };
  };

  it('pushes posterless media to the bottom, preserving order within each group', async () => {
    const { svc } = make([
      { id: 'b', posterUrl: 'p.jpg' },
      { id: 'd', posterUrl: 'p.jpg' },
    ]);
    const out = await svc.posterLast(['a', 'b', 'c', 'd', 'e']);
    expect(out).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('keeps everything when all have posters', async () => {
    const { svc } = make([
      { id: 'a', posterUrl: 'p.jpg' },
      { id: 'b', posterUrl: 'p.jpg' },
      { id: 'c', posterUrl: 'p.jpg' },
    ]);
    expect(await svc.posterLast(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('keeps everything when none have posters', async () => {
    const { svc } = make([]);
    expect(await svc.posterLast(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('is a no-op for an empty window', async () => {
    const { svc, prisma } = make([]);
    expect(await svc.posterLast([])).toEqual([]);
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });
});

describe('DiscoveryService.fetchCardDtos', () => {
  it('returns persisted movie cards without blocking on provider locale hydration', async () => {
    const meta = { ensureListLocaleOverrides: jest.fn() };
    const prisma = {
      mediaItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'movie1',
            type: MediaType.MOVIE,
            title: 'Movie',
            titles: {},
            posterUrl: null,
            posterUrls: {},
            backdropUrl: null,
            backdropUrls: {},
            rating: 7,
            movie: { releaseYear: 2024 },
            show: null,
            watchlist: [],
            favorites: [],
            showStatuses: [],
            movieStatuses: [{ id: 'status1', watched: true }],
          },
        ]),
      },
    };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      meta as any,
      prisma as any,
      {} as any,
      {} as any,
    );

    const cards = await svc.fetchCardDtos(['movie1'], 'u1', 60);

    expect(cards).toEqual([
      expect.objectContaining({ id: 'movie1', title: 'Movie', watched: true }),
    ]);
    expect(meta.ensureListLocaleOverrides).not.toHaveBeenCalled();
  });
});

/** Forgiving search: originalTitle matching + normalized token-AND tier. */
describe('DiscoveryService forgiving search', () => {
  const make = () => {
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      hydrationJob: { findFirst: jest.fn().mockResolvedValue(null) },
      mediaItem: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const hydration = {
      enqueueTvdbSearch: jest.fn().mockResolvedValue(undefined),
      enqueueClassifyCandidate: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new DiscoveryService(
      { enabled: false } as any, // tmdb disabled → window exhausts without provider calls
      { enabled: false } as any, // tvdb disabled → no fallback
      {} as any,
      prisma as any,
      { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(null) } as any,
      hydration as any,
    );
    return { svc, prisma };
  };

  it('initialSearch matches the show originalTitle in the exact and contains tiers', async () => {
    const { svc, prisma } = make();
    await (svc as any).initialSearch('Two Worlds', { q: 'Two Worlds' });
    const [exactCall, containsCall] = prisma.mediaItem.findMany.mock.calls.map((c) => c[0]);
    expect(exactCall.where.OR).toEqual([
      { title: { equals: 'Two Worlds', mode: 'insensitive' } },
      { show: { is: { originalTitle: { equals: 'Two Worlds', mode: 'insensitive' } } } },
    ]);
    expect(containsCall.where.OR).toEqual([
      { title: { contains: 'Two Worlds', mode: 'insensitive' } },
      { show: { is: { originalTitle: { contains: 'Two Worlds', mode: 'insensitive' } } } },
    ]);
  });

  it('initialSearch adds a per-token AND tier so partial multi-word terms match ("Two Worlds" → "W-Two Worlds")', async () => {
    const { svc, prisma } = make();
    await (svc as any).initialSearch('Two Worlds', { q: 'Two Worlds' });
    expect(prisma.mediaItem.findMany).toHaveBeenCalledTimes(3);
    const tokenCall = prisma.mediaItem.findMany.mock.calls[2][0];
    expect(tokenCall.where.AND).toEqual([
      {
        OR: [
          { title: { contains: 'two', mode: 'insensitive' } },
          { show: { is: { originalTitle: { contains: 'two', mode: 'insensitive' } } } },
        ],
      },
      {
        OR: [
          { title: { contains: 'worlds', mode: 'insensitive' } },
          { show: { is: { originalTitle: { contains: 'worlds', mode: 'insensitive' } } } },
        ],
      },
    ]);
  });

  it('initialSearch normalizes punctuation/hyphens before tokenizing ("W-Two Worlds" → w, two, worlds)', async () => {
    const { svc, prisma } = make();
    await (svc as any).initialSearch('W-Two  Worlds', { q: 'W-Two  Worlds' });
    const tokenCall = prisma.mediaItem.findMany.mock.calls[2][0];
    expect(tokenCall.where.AND.map((c: any) => c.OR[0].title.contains)).toEqual([
      'w',
      'two',
      'worlds',
    ]);
  });

  it('initialSearch skips the token tier for single-token terms', async () => {
    const { svc, prisma } = make();
    await (svc as any).initialSearch('Arcane', { q: 'Arcane' });
    expect(prisma.mediaItem.findMany).toHaveBeenCalledTimes(2);
  });

  it('initialSearch keeps exact/contains hits out of the token tier', async () => {
    const { svc, prisma } = make();
    prisma.mediaItem.findMany
      .mockResolvedValueOnce([{ id: 'exact-1' }])
      .mockResolvedValueOnce([{ id: 'contains-1' }])
      .mockResolvedValueOnce([]);
    const entry = await (svc as any).initialSearch('Two Worlds', { q: 'Two Worlds' });
    expect(prisma.mediaItem.findMany.mock.calls[2][0].where.id).toEqual({
      notIn: ['exact-1', 'contains-1'],
    });
    expect(entry.ids).toEqual(['exact-1', 'contains-1']);
  });

  it('searchViaDb matches the show originalTitle alongside title', async () => {
    const { svc, prisma } = make();
    jest.spyOn(svc as any, 'fetchListDtos').mockResolvedValue([]);
    await (svc as any).searchViaDb('two worlds', { q: 'two worlds' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { title: { contains: 'two worlds', mode: 'insensitive' } },
      { show: { is: { originalTitle: { contains: 'two worlds', mode: 'insensitive' } } } },
    ]);
  });

  it('searchViaDb applies known curated tags with OR semantics', async () => {
    const { svc, prisma } = make();
    jest.spyOn(svc as any, 'fetchListDtos').mockResolvedValue([]);

    await (svc as any).searchViaDb('drama', {
      q: 'drama',
      tags: 'j-drama,unknown,isekai,j-drama',
    });

    expect(prisma.mediaItem.findMany.mock.calls[0][0].where.tags).toEqual({
      some: {
        tag: { slug: { in: ['j-drama', 'isekai'] } },
      },
    });
  });
});

describe('DiscoveryService hideAnimeInExplore', () => {
  const make = (
    profile: {
      hideAnimeInExplore: boolean;
      exploreDefaultFilters?: Record<string, unknown> | null;
    } | null,
  ) => {
    const cache = new Map<string, unknown>();
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(profile) },
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(),
    };
    const redis = {
      get: jest.fn(async (key: string) => cache.get(key) ?? null),
      set: jest.fn().mockResolvedValue(null),
      client: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        eval: jest.fn(async (...args: unknown[]) => {
          if (args[1] === 2) cache.set(args[3] as string, JSON.parse(args[5] as string));
          return 1;
        }),
      },
    };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      redis as any,
      {} as any,
    );
    return { svc, prisma, redis, cache };
  };

  /** Drive rankForYouIds past the early returns with one affinity genre. */
  const mockRankingQueries = (prisma: any) => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 2 }]) // weighted genres
      .mockResolvedValueOnce([]) // keywords
      .mockResolvedValueOnce([{ c: 1 }]); // distinct tracked-media count
  };

  /** One rankable candidate so forYou produces a non-empty (cacheable) ranking. */
  const CANDIDATE = {
    id: 'cand-1',
    rating: 8,
    popularity: 10,
    genres: [{ genre: { name: 'Drama' } }],
    show: { keywords: [], yearStart: new Date().getFullYear() },
  };

  it('resolveHideAnime reads the profile flag (false when absent/anonymous)', async () => {
    const { svc, prisma } = make({ hideAnimeInExplore: true });
    await expect((svc as any).resolveHideAnime('u1')).resolves.toBe(true);
    expect(prisma.userProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { hideAnimeInExplore: true },
    });

    const noProfile = make(null);
    await expect((noProfile.svc as any).resolveHideAnime('u1')).resolves.toBe(false);

    const anon = make(null);
    await expect((anon.svc as any).resolveHideAnime(undefined)).resolves.toBe(false);
    expect(anon.prisma.userProfile.findUnique).not.toHaveBeenCalled();
  });

  it('excludes ANIME-classified rows from the for-you candidate pool when the flag is set', async () => {
    const { svc, prisma } = make({ hideAnimeInExplore: true });
    mockRankingQueries(prisma);
    await (svc as any).rankForYouIds('u1', undefined, true);
    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contentClassification: { not: 'ANIME' } }),
      }),
    );
  });

  it('leaves the for-you candidate where clause unchanged when the flag is off', async () => {
    const { svc, prisma } = make(null);
    mockRankingQueries(prisma);
    await (svc as any).rankForYouIds('u1');
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('contentClassification');
  });

  it('forYou resolves the flag from the profile and scopes the cache key by it', async () => {
    const { svc, prisma, redis, cache } = make({ hideAnimeInExplore: true });
    mockRankingQueries(prisma);
    prisma.mediaItem.findMany.mockResolvedValue([CANDIDATE]);
    jest.spyOn(svc as any, 'fetchCardDtos').mockResolvedValue([]);
    await svc.forYou('u1', 1, 10);
    const key = [...cache.keys()].find((candidate) => candidate.includes(':rank:show:'))!;
    expect(key).toContain('foryou:v4:u1:rank:show:');
    expect(key).toContain('noanime');
    expect(redis.get).toHaveBeenCalledWith(key);
  });

  it('forYou keeps the unfiltered cache key when the flag is off', async () => {
    const { svc, prisma, cache } = make({ hideAnimeInExplore: false });
    mockRankingQueries(prisma);
    prisma.mediaItem.findMany.mockResolvedValue([CANDIDATE]);
    jest.spyOn(svc as any, 'fetchCardDtos').mockResolvedValue([]);
    await svc.forYou('u1', 1, 10);
    const key = [...cache.keys()].find((candidate) => candidate.includes(':rank:show:'))!;
    expect(key).toContain('foryou:v4:u1:rank:show:');
    expect(key).not.toContain('noanime');
  });

  it('stores an empty cold-start ranking only with the transient TTL', async () => {
    const { svc, prisma, redis, cache } = make(null);
    // No taste signal or library at all: all aggregates/exclusions empty → ranking [].
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    jest.spyOn(svc as any, 'fetchCardDtos').mockResolvedValue([]);
    const res = await svc.forYou('u1', 1, 10);
    expect(res.items).toEqual([]);
    const rankKey = [...cache.keys()].find((candidate) => candidate.includes(':rank:show:'))!;
    expect(cache.get(rankKey)).toEqual(expect.objectContaining({ ids: [] }));
    expect(redis.client.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      expect.any(String),
      rankKey,
      '0',
      expect.any(String),
      '30',
    );
  });

  it('serves a light-metadata library an immediate transient fallback', async () => {
    const { svc, prisma, cache } = make(null);
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // weighted genres not hydrated yet
      .mockResolvedValueOnce([]) // keywords not hydrated yet
      .mockResolvedValueOnce([{ c: 1 }]);
    prisma.mediaItem.findMany.mockResolvedValue([CANDIDATE]);
    jest.spyOn(svc as any, 'fetchCardDtos').mockResolvedValue([CANDIDATE]);

    const res = await svc.forYou('u1', 1, 10);

    expect(res.items).toEqual([CANDIDATE]);
    expect(prisma.mediaItem.findMany.mock.calls[0][0].where).not.toHaveProperty('genres');
    expect(prisma.mediaItem.findMany.mock.calls[0][0].where.watchlist).toEqual({
      none: { userId: 'u1' },
    });
    const rankKey = [...cache.keys()].find((candidate) => candidate.includes(':rank:show:'))!;
    expect(cache.get(rankKey)).toEqual(expect.objectContaining({ ids: ['cand-1'] }));
  });

  it('shares one taste query batch between concurrent show and movie ranking work', async () => {
    const { svc, prisma } = make(null);
    mockRankingQueries(prisma);

    const [showsTaste, moviesTaste] = await Promise.all([
      (svc as any).personalizationTaste('u1', '0'),
      (svc as any).personalizationTaste('u1', '0'),
    ]);

    expect(showsTaste).toBe(moviesTaste);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('serves the last ranking immediately while a newer generation rebuilds', async () => {
    const { svc, redis, cache } = make({ hideAnimeInExplore: false });
    redis.client.get.mockResolvedValue('2');
    const key = (svc as any).forYouKey(MediaType.SHOW, 'u1', undefined, false, undefined);
    cache.set(key, { version: '1', ids: ['old-result'], builtAt: new Date().toISOString() });
    const rebuild = jest.spyOn(svc as any, 'rebuildPersonalizedIds').mockResolvedValue(['new']);
    jest
      .spyOn(svc as any, 'fetchCardDtos')
      .mockImplementation(async (ids: unknown) => ids as string[]);

    const result = await svc.forYou('u1', 1, 10);

    expect(result.items).toEqual(['old-result']);
    expect(rebuild).toHaveBeenCalledWith(
      MediaType.SHOW,
      'u1',
      undefined,
      false,
      undefined,
      key,
      '2',
      expect.objectContaining({ version: '1' }),
    );
  });

  it('does not repeat a generation already completed before the warmer starts', async () => {
    const { svc, cache } = make({ hideAnimeInExplore: false });
    const key = (svc as any).forYouKey(MediaType.SHOW, 'u1', undefined, false, undefined);
    cache.set(key, { version: '0', ids: ['fresh-result'], builtAt: new Date().toISOString() });
    const rebuild = jest.spyOn(svc as any, 'rebuildPersonalizedIds');

    await expect(
      (svc as any).personalizedIds(MediaType.SHOW, 'u1', undefined, undefined, true, false),
    ).resolves.toEqual(['fresh-result']);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('warms show and movie rankings for the saved Explore defaults', async () => {
    const { svc } = make({
      hideAnimeInExplore: false,
      exploreDefaultFilters: {
        genre: 'drama',
        excludeGenres: ['horror'],
        order: 'releaseDate',
        country: 'CA',
        hideAnime: true,
      },
    });
    const personalizedIds = jest.spyOn(svc as any, 'personalizedIds').mockResolvedValue([]);

    await svc.warmPersonalizedRecommendations('u1');

    const expectedFilters = {
      excludeGenres: 'horror',
      country: 'CA',
      sort: 'releaseDate',
      hideAnime: true,
    };
    expect(personalizedIds).toHaveBeenCalledWith(
      MediaType.SHOW,
      'u1',
      'drama',
      expectedFilters,
      true,
      true,
    );
    expect(personalizedIds).toHaveBeenCalledWith(
      MediaType.MOVIE,
      'u1',
      'drama',
      expectedFilters,
      true,
      true,
    );
  });
});

/** Explore filters on the DB browse paths: exclusion, country, sort, hideAnime toggle. */
describe('DiscoveryService explore filters (DB paths)', () => {
  const make = () => {
    const cache = new Map<string, unknown>();
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      mediaItem: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      genre: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(),
    };
    const redis = {
      get: jest.fn(async (key: string) => cache.get(key) ?? null),
      set: jest.fn().mockResolvedValue(null),
      client: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        eval: jest.fn(async (...args: unknown[]) => {
          if (args[1] === 2) cache.set(args[3] as string, JSON.parse(args[5] as string));
          return 1;
        }),
      },
    };
    const svc = new DiscoveryService(
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      redis as any,
      {} as any,
    );
    jest.spyOn(svc as any, 'fetchListDtos').mockResolvedValue([]);
    jest.spyOn(svc as any, 'fetchCardDtos').mockResolvedValue([]);
    return { svc, prisma, cache };
  };

  it('searchViaDb excludes genres via a none on the genres relation (normalized slugs)', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', excludeGenres: ' Horror, anime ' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.genres.none).toEqual({
      genre: { slug: { in: ['horror', 'anime'], mode: 'insensitive' } },
    });
  });

  it('searchViaDb keeps the inclusion some alongside the exclusion none', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', genre: 'drama', excludeGenres: 'horror' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.genres.some).toEqual({
      genre: { slug: { equals: 'drama', mode: 'insensitive' } },
    });
    expect(where.genres.none).toEqual({
      genre: { slug: { in: ['horror'], mode: 'insensitive' } },
    });
  });

  it('searchViaDb maps country to originCountries for shows (unknown origin kept)', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', type: MediaType.SHOW, country: 'jp' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.show).toEqual({
      is: { OR: [{ originCountries: { has: 'JP' } }, { originCountries: { isEmpty: true } }] },
    });
    expect(where).not.toHaveProperty('movie');
  });

  it('searchViaDb maps country to the production country for movies (STRICT)', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', type: MediaType.MOVIE, country: 'us' });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.movie).toEqual({
      is: {
        OR: [
          { country: { equals: 'US', mode: 'insensitive' } },
          {
            country: {
              in: ['United States of America', 'United States'],
              mode: 'insensitive',
            },
          },
        ],
      },
    });
    expect(where).not.toHaveProperty('show');
  });

  it('searchViaDb sorts shows by yearStart and movies by releaseDate (default popularity)', async () => {
    const s = make();
    await (s.svc as any).searchViaDb('term', {
      q: 'term',
      type: MediaType.SHOW,
      sort: 'releaseDate',
    });
    expect(s.prisma.mediaItem.findMany.mock.calls[0][0].orderBy).toEqual({
      show: { yearStart: 'desc' },
    });

    const m = make();
    await (m.svc as any).searchViaDb('term', {
      q: 'term',
      type: MediaType.MOVIE,
      sort: 'releaseDate',
    });
    expect(m.prisma.mediaItem.findMany.mock.calls[0][0].orderBy).toEqual({
      movie: { releaseDate: 'desc' },
    });

    const d = make();
    await (d.svc as any).searchViaDb('term', { q: 'term', type: MediaType.MOVIE });
    expect(d.prisma.mediaItem.findMany.mock.calls[0][0].orderBy).toEqual({ popularity: 'desc' });
  });

  it('searchViaDb ORs the explicit hideAnime toggle with the (off) profile flag', async () => {
    const { svc, prisma } = make();
    await (svc as any).searchViaDb('term', { q: 'term', hideAnime: true });
    expect(prisma.mediaItem.findMany.mock.calls[0][0].where.contentClassification).toEqual({
      not: 'ANIME',
    });
  });

  it('topDb applies exclusion + country + releaseDate sort for movies', async () => {
    const { svc, prisma } = make();
    await (svc as any).topDb(MediaType.MOVIE, 20, 'u1', {
      excludeGenres: 'horror',
      country: 'us',
      sort: 'releaseDate',
    });
    const call = prisma.mediaItem.findMany.mock.calls[0][0];
    expect(call.where.genres.none).toEqual({
      genre: { slug: { in: ['horror'], mode: 'insensitive' } },
    });
    expect(call.where.movie).toEqual({
      is: {
        OR: [
          { country: { equals: 'US', mode: 'insensitive' } },
          {
            country: {
              in: ['United States of America', 'United States'],
              mode: 'insensitive',
            },
          },
        ],
      },
    });
    expect(call.orderBy).toEqual({ movie: { releaseDate: 'desc' } });
  });

  it('topDb applies country via originCountries + yearStart sort for shows', async () => {
    const { svc, prisma } = make();
    await (svc as any).topDb(MediaType.SHOW, 20, 'u1', { country: 'KR', sort: 'releaseDate' });
    const call = prisma.mediaItem.findMany.mock.calls[0][0];
    expect(call.where.show).toEqual({
      is: { OR: [{ originCountries: { has: 'KR' } }, { originCountries: { isEmpty: true } }] },
    });
    expect(call.orderBy).toEqual({ show: { yearStart: 'desc' } });
  });

  it('topDb leaves where/orderBy untouched without filters', async () => {
    const { svc, prisma } = make();
    await (svc as any).topDb(MediaType.SHOW, 20, 'u1');
    const call = prisma.mediaItem.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('genres');
    expect(call.where).not.toHaveProperty('show');
    expect(call.orderBy).toEqual({ popularity: 'desc' });
  });

  it('rankForYouIds applies exclusion and country to the candidate pool', async () => {
    const { svc, prisma } = make();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 2 }]) // weighted genres
      .mockResolvedValueOnce([]) // keywords
      .mockResolvedValueOnce([{ c: 1 }]); // distinct tracked-media count
    await (svc as any).rankForYouIds('u1', undefined, false, {
      excludeGenres: 'anime,horror',
      country: 'kr',
    });
    const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
    expect(where.genres.none).toEqual({
      genre: { slug: { in: ['anime', 'horror'], mode: 'insensitive' } },
    });
    expect(where.show).toEqual({
      is: { OR: [{ originCountries: { has: 'KR' } }, { originCountries: { isEmpty: true } }] },
    });
  });

  it('starts keyword affinity from the small watched/favorite/watchlist set', async () => {
    const { svc, prisma } = make();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ c: 1 }]);

    await (svc as any).rankForYouIds('u1');

    const sql = (prisma.$queryRaw.mock.calls[1][0] as readonly string[]).join(' ');
    expect(sql).toContain('WITH taste_media AS MATERIALIZED');
    expect(sql).toContain('SELECT media_id FROM watchlist_items');
    expect(sql).toContain('FROM taste_media t');
    expect(sql).toContain('JOIN shows s ON s.media_id = t.media_id');
    expect(sql).toContain('JOIN movies m ON m.media_id = t.media_id');
  });

  it('builds recommendations immediately from a watchlist-only taste signal', async () => {
    const { svc, prisma } = make();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 2 }]) // weighted genres
      .mockResolvedValueOnce([]) // keywords
      .mockResolvedValueOnce([{ c: 1 }]); // distinct tracked-media count
    prisma.mediaItem.findMany.mockResolvedValue([
      {
        id: 'new-recommendation',
        rating: 8,
        genres: [{ genre: { name: 'Drama' } }],
        show: { keywords: [], yearStart: new Date().getFullYear() },
        movie: null,
      },
    ]);

    await expect((svc as any).rankForYouIds('u1')).resolves.toEqual({
      ids: ['new-recommendation'],
      cacheable: true,
      candidateCount: 1,
    });
    expect(prisma.mediaItem.findMany.mock.calls[0][0].where.watchlist).toEqual({
      none: { userId: 'u1' },
    });
  });

  it('builds a movie candidate pool and preserves watched/watchlist/favorite exclusions', async () => {
    const { svc, prisma } = make();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ c: 3 }]);

    await (svc as any).rankForYouIds('u1', undefined, false, undefined, MediaType.MOVIE);

    const call = prisma.mediaItem.findMany.mock.calls[0][0];
    expect(call.where.type).toBe(MediaType.MOVIE);
    expect(call.where.watchHistory).toEqual({ none: { userId: 'u1' } });
    expect(call.where.watchlist).toEqual({ none: { userId: 'u1' } });
    expect(call.where.favorites).toEqual({ none: { userId: 'u1' } });
    expect(call.include.movie).toEqual({ select: { keywords: true, releaseYear: true } });
  });

  it('filterEntriesExcluding keeps entries with UNKNOWN origin for shows', async () => {
    const { svc } = make();
    const entries = [
      { id: 'a', g: [], oc: [] }, // unknown origin → keep (shows)
      { id: 'b', g: [], oc: ['JP'] }, // provably not US → drop
      { id: 'c', g: [], oc: ['US'] }, // provably US → keep
    ] as any;
    const out = await (svc as any).filterEntriesExcluding(entries, [], 'US', 'show');
    expect(out.map((e: any) => e.id)).toEqual(['a', 'c']);
  });

  it('filterEntriesExcluding is STRICT for movies (DB production country)', async () => {
    const { svc, prisma } = make();
    prisma.movie.findMany.mockResolvedValue([{ mediaId: 'b' }]);
    const entries = [
      { id: 'a', g: [], oc: [] }, // not US in DB → drop
      { id: 'b', g: [], oc: [] }, // US in DB → keep
    ] as any;
    const out = await (svc as any).filterEntriesExcluding(entries, [], 'US', 'movie');
    expect(prisma.movie.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ mediaId: { in: ['a', 'b'] } }) }),
    );
    expect(out.map((e: any) => e.id)).toEqual(['b']);
  });

  it('forYou adds the filter fingerprint to the cache key', async () => {
    const { svc, prisma, cache } = make();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ c: 1 }]);
    // One rankable candidate → non-empty ranking → the cache set happens.
    prisma.mediaItem.findMany.mockResolvedValue([
      {
        id: 'cand-1',
        rating: 8,
        popularity: 10,
        genres: [{ genre: { name: 'Drama' } }],
        show: { keywords: [], yearStart: new Date().getFullYear() },
      },
    ]);
    await svc.forYou('u1', 1, 10, undefined, { excludeGenres: 'horror', country: 'JP' });
    const key = [...cache.keys()].find((candidate) => candidate.includes(':rank:show:'))!;
    expect(key).toContain('foryou:v4:u1:rank:show:');
    expect(key).toContain('horror');
    expect(key).toContain('JP');
  });

  it('uses an independent movie cache namespace', async () => {
    const { svc, prisma, cache } = make();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ name: 'Drama', c: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ c: 1 }]);
    prisma.mediaItem.findMany.mockResolvedValue([
      {
        id: 'movie-candidate',
        rating: 8,
        popularity: 10,
        genres: [{ genre: { name: 'Drama' } }],
        show: null,
        movie: { keywords: [], releaseYear: new Date().getFullYear() },
      },
    ]);

    await svc.moviesForYou('u1', 1, 10);

    expect([...cache.keys()]).toEqual(
      expect.arrayContaining([expect.stringContaining('foryou:v4:u1:rank:movie:')]),
    );
  });
});

/** Trending sort: TMDB trending has no server-side sort, so sort=releaseDate
 *  re-orders the window/page locally (newest first, unknown years last). */
describe('DiscoveryService trending release-date sort', () => {
  const make = (years: Record<string, number | null>) => {
    const tmdb = { enabled: true };
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      hydrationJob: { findFirst: jest.fn().mockResolvedValue(null) },
      mediaItem: {
        findMany: jest.fn().mockResolvedValue(
          Object.entries(years).map(([id, y]) => ({
            id,
            show: { yearStart: y },
            movie: null,
          })),
        ),
      },
    };
    const svc = new DiscoveryService(
      tmdb as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(svc as any, 'fetchListDtos').mockImplementation(async (ids: unknown) => ids as any);
    jest.spyOn(svc as any, 'fetchCardDtos').mockImplementation(async (ids: unknown) => ids as any);
    jest
      .spyOn(svc as any, 'cachedListEntries')
      .mockResolvedValue(Object.keys(years).map((id) => ({ id, g: [], oc: [] })));
    return { svc, prisma };
  };

  it('re-orders the trending page newest-first when sort=releaseDate', async () => {
    const { svc } = make({ a: 2015, b: 2024, c: null, d: 2020 });
    const res = await svc.trendingShows(undefined, 1, 20, undefined, { sort: 'releaseDate' });
    expect(res.items).toEqual(['b', 'd', 'a', 'c']);
  });

  it('keeps the trending order on the default popularity sort', async () => {
    const { svc, prisma } = make({ a: 2015, b: 2024, c: null, d: 2020 });
    const res = await svc.trendingShows(undefined, 1, 20);
    expect(res.items).toEqual(['a', 'b', 'c', 'd']);
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('discoverSections keeps the trending path for every sort (sorting happens inside)', async () => {
    const { svc } = make({ a: 2015, b: 2024 });
    const tmdb = (svc as any).tmdb;
    tmdb.discoverShows = jest.fn();
    tmdb.discoverMovies = jest.fn();
    await svc.discoverSections(undefined, undefined, { sort: 'releaseDate' });
    expect(tmdb.discoverShows).not.toHaveBeenCalled();
    expect(tmdb.discoverMovies).not.toHaveBeenCalled();
  });
});

/** Curated TMDB lists (top-rated / now-playing / upcoming) share the listPage flow. */
describe('DiscoveryService curated lists', () => {
  const make = () => {
    const tmdb = {
      enabled: true,
      topRatedShows: jest.fn().mockResolvedValue([]),
      topRatedMovies: jest.fn().mockResolvedValue([]),
      nowPlayingMovies: jest.fn().mockResolvedValue([]),
      trendingShows: jest.fn().mockResolvedValue([]),
      trendingMovies: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      userProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      hydrationJob: { findFirst: jest.fn().mockResolvedValue(null) },
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new DiscoveryService(
      tmdb as any,
      {} as any,
      {} as any,
      prisma as any,
      redis as any,
      {} as any,
    );
    jest.spyOn(svc as any, 'cachedListEntries').mockResolvedValue([{ id: 'x', g: [], oc: [] }]);
    jest.spyOn(svc as any, 'fetchListDtos').mockImplementation(async (ids: unknown) => ids as any);
    jest.spyOn(svc as any, 'fetchCardDtos').mockImplementation(async (ids: unknown) => ids as any);
    return { svc, tmdb, prisma };
  };

  it('topRatedShows/topRatedMovies route through their provider endpoints', async () => {
    const { svc, tmdb } = make();
    expect(await svc.topRatedShows(undefined, 1, 20)).toEqual({
      items: ['x'],
      page: 1,
      hasMore: false,
    });
    expect(await svc.topRatedMovies(undefined, 1, 20)).toEqual({
      items: ['x'],
      page: 1,
      hasMore: false,
    });
    expect((svc as any).cachedListEntries).toHaveBeenCalledWith(
      'list:ids:v1:top-rated',
      'show',
      1,
      expect.any(Function),
    );
    expect((svc as any).cachedListEntries).toHaveBeenCalledWith(
      'list:ids:v1:top-rated',
      'movie',
      1,
      expect.any(Function),
    );
    expect(tmdb.trendingShows).not.toHaveBeenCalled();
  });

  it('nowPlayingMovies routes through its provider endpoint', async () => {
    const { svc } = make();
    await svc.nowPlayingMovies(undefined, 2, 20);
    expect((svc as any).cachedListEntries).toHaveBeenCalledWith(
      'list:ids:v1:now-playing',
      'movie',
      2,
      expect.any(Function),
    );
  });

  it('discoverSections returns only compact catalog sections', async () => {
    const { svc } = make();
    const res = await svc.discoverSections(undefined);
    expect(res).toEqual({
      trendingShows: ['x'],
      trendingMovies: ['x'],
      topRatedShows: ['x'],
      topRatedMovies: ['x'],
      nowPlayingMovies: ['x'],
    });
  });

  it('paginates a completed scheduled snapshot and pins subsequent pages to it', async () => {
    const { svc, tmdb, prisma } = make();
    const ids = Array.from({ length: 45 }, (_, index) => `show-${index + 1}`);
    prisma.hydrationJob.findFirst.mockResolvedValue({
      id: 'snapshot-1',
      items: ids.map((mediaId) => ({ mediaId })),
    });
    prisma.mediaItem.findMany.mockResolvedValue(ids.map((id) => ({ id })));

    const res = await svc.topRatedShows(
      undefined,
      2,
      20,
      undefined,
      undefined,
      false,
      'snapshot-1',
    );

    expect(res).toEqual({
      items: ids.slice(20, 40),
      page: 2,
      hasMore: true,
      snapshotId: 'snapshot-1',
    });
    expect(prisma.hydrationJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'snapshot-1',
          status: 'completed',
          railSnapshot: true,
        }),
        select: expect.objectContaining({
          items: expect.objectContaining({
            where: expect.objectContaining({ status: { in: ['done', 'fallback'] } }),
          }),
        }),
      }),
    );
    expect(tmdb.topRatedShows).not.toHaveBeenCalled();
    expect((svc as any).cachedListEntries).not.toHaveBeenCalled();
  });

  it('applies tag multi-select to completed scheduled snapshots', async () => {
    const { svc, prisma } = make();
    prisma.hydrationJob.findFirst.mockResolvedValue({
      id: 'snapshot-tags',
      items: [{ mediaId: 'show-1' }],
    });
    prisma.mediaItem.findMany.mockResolvedValue([{ id: 'show-1' }]);

    await svc.topRatedShows(undefined, 1, 20, undefined, {
      tags: 'k-drama,j-drama,unknown',
    });

    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: {
            some: {
              tag: { slug: { in: ['k-drama', 'j-drama'] } },
            },
          },
        }),
      }),
    );
  });

  it('uses the filtered provider window for a tag-only rail request', async () => {
    const { svc } = make();
    const listWindow = jest
      .spyOn(svc as any, 'listWindow')
      .mockResolvedValue({ ids: ['tagged-show'], upstreamPages: 1, exhausted: true });

    await expect(
      svc.topRatedShows(undefined, 1, 20, undefined, { tags: 'k-drama' }),
    ).resolves.toEqual({
      items: ['tagged-show'],
      page: 1,
      hasMore: false,
    });
    expect(listWindow).toHaveBeenCalledWith(
      'list:filtered:v1:top-rated',
      'show',
      undefined,
      20,
      false,
      { tags: 'k-drama' },
      expect.any(Function),
    );
  });

  it('falls back to a paginated DB rail when TMDB fails before the first snapshot', async () => {
    const { svc, prisma } = make();
    (svc as any).cachedListEntries.mockRejectedValueOnce(
      new ProviderError('network', 'tmdb network: fetch failed'),
    );
    prisma.mediaItem.findMany.mockResolvedValue([{ id: 'db-1' }]);

    await expect(svc.topRatedShows(undefined, 1, 20)).resolves.toEqual({
      items: ['db-1'],
      page: 1,
      hasMore: false,
    });
  });

  it('keeps tag filters when a provider rail falls back to the database', async () => {
    const { svc, prisma } = make();
    (svc as any).cachedListEntries.mockRejectedValueOnce(
      new ProviderError('network', 'tmdb network: fetch failed'),
    );
    prisma.mediaItem.findMany.mockResolvedValue([{ id: 'db-tagged' }]);

    await svc.topRatedShows(undefined, 1, 20, undefined, { tags: 'sitcom,true-crime' });

    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: {
            some: {
              tag: { slug: { in: ['sitcom', 'true-crime'] } },
            },
          },
        }),
      }),
    );
  });
});

describe('DiscoveryService provider search degradation', () => {
  const make = () => {
    const tmdb = {
      enabled: true,
      searchShows: jest
        .fn()
        .mockRejectedValue(new ProviderError('network', 'tmdb network: fetch failed')),
      searchMovies: jest
        .fn()
        .mockRejectedValue(new ProviderError('network', 'tmdb network: fetch failed')),
    };
    const tvdb = {
      enabled: true,
      searchShows: jest.fn().mockResolvedValue({
        items: [{ tvdbId: 42, title: 'TVDB result', year: 2024 }],
      }),
      searchMovies: jest.fn().mockResolvedValue({ items: [] }),
    };
    const meta = {
      lightUpsertShowTvdb: jest.fn().mockResolvedValue('tvdb-1'),
      lightUpsertMovieTvdb: jest.fn(),
    };
    const prisma = {
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const hydration = {
      enqueueTvdbSearch: jest.fn().mockResolvedValue(undefined),
      enqueueClassifyCandidate: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new DiscoveryService(
      tmdb as any,
      tvdb as any,
      meta as any,
      prisma as any,
      {} as any,
      hydration as any,
    );
    return { svc, tmdb, tvdb };
  };

  it('retains local IDs when every requested TMDB branch has a network failure', async () => {
    const { svc } = make();
    const entry = await (svc as any).fetchNextTmdbPage(
      'Strange',
      { q: 'Strange' },
      { ids: ['local-1'], genreIds: {}, tmdbPagesFetched: 0, exhausted: false },
    );

    expect(entry).toEqual({
      ids: ['local-1'],
      genreIds: {},
      tmdbPagesFetched: 1,
      exhausted: true,
    });
  });

  it('uses TVDB when local search is empty and TMDB is unavailable', async () => {
    const { svc, tvdb } = make();
    const entry = await (svc as any).initialSearch('Strange', {
      q: 'Strange',
      type: MediaType.SHOW,
    });

    expect(entry.ids).toEqual(['tvdb-1']);
    expect(entry.exhausted).toBe(true);
    expect(tvdb.searchShows).toHaveBeenCalledWith('strange', 1);
  });
});

/** TMDB discover: exclusion/country params + app-level sort mapping. */
describe('TmdbProvider discover filters', () => {
  const make = () => {
    const client = {
      enabled: true,
      img: jest.fn(() => null),
      get: jest.fn().mockResolvedValue({ results: [], total_results: 0 }),
    };
    return { provider: new TmdbProvider(client as any), client };
  };

  it('discoverShows passes without_genres + with_origin_country and maps releaseDate sort', async () => {
    const { provider, client } = make();
    await provider.discoverShows({ excludeGenres: [27, 16], country: 'JP', sort: 'releaseDate' });
    expect(client.get).toHaveBeenCalledWith(
      '/discover/tv',
      expect.objectContaining({
        without_genres: '27,16',
        with_origin_country: 'JP',
        sort_by: 'first_air_date.desc',
      }),
    );
  });

  it('discoverMovies passes without_genres + with_origin_country and maps releaseDate sort', async () => {
    const { provider, client } = make();
    await provider.discoverMovies({ excludeGenres: [27], country: 'US', sort: 'releaseDate' });
    expect(client.get).toHaveBeenCalledWith(
      '/discover/movie',
      expect.objectContaining({
        without_genres: '27',
        with_origin_country: 'US',
        sort_by: 'primary_release_date.desc',
      }),
    );
  });

  it('keeps popularity.desc as the default and passes raw TMDB sort strings through', async () => {
    const d = make();
    await d.provider.discoverMovies({});
    expect(d.client.get).toHaveBeenCalledWith(
      '/discover/movie',
      expect.objectContaining({ sort_by: 'popularity.desc', without_genres: undefined }),
    );

    const r = make();
    await r.provider.discoverShows({ sort: 'vote_average.desc' });
    expect(r.client.get).toHaveBeenCalledWith(
      '/discover/tv',
      expect.objectContaining({ sort_by: 'vote_average.desc' }),
    );
  });
});
