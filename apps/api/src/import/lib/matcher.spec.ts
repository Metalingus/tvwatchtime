import { ExternalProvider, MediaType, ProviderEntityKind } from '@tvwatch/shared';
import { ImportMatcher, needsTvdbRehydration } from './matcher';
import { ProviderError } from '../../media-metadata/providers/shared/provider-errors';

/** Minimal fake Prisma for the matcher's DB surface. */
function fakePrisma(
  opts: {
    extByTvdb?: { media: { id: string; title: string; type?: MediaType } } | null;
    extByTvdbMovie?: { media: { id: string; title: string; type?: MediaType } } | null;
    tmdbMovieExternal?: { value: string; releaseYear: number | null } | null;
    exactMedia?: { id: string; title: string } | null;
    likeMedia?: { id: string; title: string }[];
  } = {},
) {
  const extMedia = opts.extByTvdb?.media ? { type: MediaType.SHOW, ...opts.extByTvdb.media } : null;
  return {
    externalId: {
      findFirst: async (args: any) => {
        if (args?.where?.provider === ExternalProvider.THE_TVDB) {
          if (
            args?.where?.providerEntityKind === ProviderEntityKind.MOVIE &&
            opts.extByTvdbMovie?.media
          ) {
            return {
              media: { type: MediaType.MOVIE, ...opts.extByTvdbMovie.media },
            };
          }
          return extMedia ? { media: extMedia } : null;
        }
        if (
          args?.where?.provider === ExternalProvider.TMDB &&
          args?.where?.providerEntityKind === ProviderEntityKind.MOVIE &&
          opts.tmdbMovieExternal
        ) {
          return {
            value: opts.tmdbMovieExternal.value,
            media: { movie: { releaseYear: opts.tmdbMovieExternal.releaseYear } },
          };
        }
        return null;
      },
    },
    mediaItem: {
      findFirst: async () => opts.exactMedia ?? null,
      findMany: async () => opts.likeMedia ?? [],
    },
    mediaTitleAlias: { findMany: async () => [] },
    episode: { count: async () => 0, findMany: async () => [] },
    $queryRaw: async () => [] as any[],
  };
}

const fakeMeta = (tvdbUpsertId = 'm-tvdb') => ({
  lightUpsertShowTvdb: async () => tvdbUpsertId,
  lightUpsertMovieTvdb: async () => tvdbUpsertId,
  ensureShowFull: async () => undefined,
});

const fakeTmdb = { enabled: false, searchShows: async () => ({ items: [], total: 0 }) };

describe('ImportMatcher — conditional TVDB recovery (Phase 9)', () => {
  it('Step 0: reuses a verified LOCAL TVDB mapping without any external call', async () => {
    const prisma = fakePrisma({ extByTvdb: { media: { id: 'm1', title: 'Show' } } });
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const tmdb = { enabled: true, findByExternalId: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, tmdb as any, tvdb as any);
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, '123');
    expect(res.mediaId).toBe('m1');
    expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    expect(tmdb.findByExternalId).not.toHaveBeenCalled();
    expect(tvdb.getShow).not.toHaveBeenCalled(); // no external call
  });

  it('Step 0: rejects a local TVDB mapping of the wrong media type', async () => {
    const prisma = fakePrisma({
      extByTvdb: { media: { id: 'm1', title: 'Sense8', type: MediaType.SHOW } },
    });
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      tvdb as any,
    );
    const res = await matcher.matchMedia('sense8', 'Sense8', 'MOVIE', null, null, null, '268156');
    expect(res.mediaId).toBeNull();
    expect(res.confidence).toBe(0);
    expect(tvdb.getShow).not.toHaveBeenCalled(); // local mapping — no external call
  });

  it('with raw TVDB id present but no local mapping: refuses title fallback → NEEDS_REVIEW', async () => {
    // A local DB match by title exists, but the raw TVDB ID (999) has no local mapping.
    // Authority gate: TVDB ID present → ONLY TVDB resolution. Title matching is forbidden.
    // Since TVDB is disabled, resolution fails → returns null (NEEDS_REVIEW), NOT the title match.
    const prisma = fakePrisma({ exactMedia: { id: 'm-local', title: 'Show' } });
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      tvdb as any,
    );
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, '999');
    expect(res.mediaId).toBeNull(); // TVDB ID present but unresolvable → NOT title-matched
    expect(res.confidence).toBe(0);
    expect(tvdb.getShow).not.toHaveBeenCalled(); // TVDB disabled → no API call
  });

  it('Step 5: falls back to TVDB exact-id recovery ONLY when unresolved', async () => {
    const prisma = fakePrisma({}); // no local mapping, no DB match
    const tvdbShow = {
      type: MediaType.SHOW,
      tmdbId: 0,
      title: 'Show',
      overview: 'O',
      posterUrl: null,
      backdropUrl: null,
      yearStart: 2019,
      popularity: 0,
    };
    const tvdb = {
      enabled: true,
      searchShows: async () => ({ items: [], total: 0 }),
      getShow: jest.fn(async () => tvdbShow),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta('m-recovered') as any,
      fakeTmdb as any,
      tvdb as any,
    );
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, '123');
    expect(tvdb.getShow).toHaveBeenCalledWith(123);
    expect(res.mediaId).toBe('m-recovered');
    expect(res.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('returns unmatched (no TVDB call) when there is no raw TVDB id and no match', async () => {
    const prisma = fakePrisma({});
    const tvdb = {
      enabled: true,
      getShow: jest.fn(),
      searchShows: async () => ({ items: [], total: 0 }),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      tvdb as any,
    );
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, null);
    expect(res.mediaId).toBeNull();
    expect(tvdb.getShow).not.toHaveBeenCalled();
  });
});

/** Fake Prisma for the Trakt external-id paths (TMDB/TVDB/IMDB + episode external ids). */
function fakePrismaExt(
  opts: {
    extByTmdb?: { media: { id: string; title: string; type?: MediaType } } | null;
    extByTvdb?: { media: { id: string; title: string; type?: MediaType } } | null;
    extByImdb?: { media: { id: string; title: string; type?: MediaType } } | null;
    epExtByProvider?: Record<string, { episodeId: string } | null>;
  } = {},
) {
  const withType = (e?: { media: { id: string; title: string; type?: MediaType } } | null) =>
    e?.media ? { media: { type: MediaType.SHOW, ...e.media } } : null;
  return {
    externalId: {
      findFirst: async (args: any) => {
        const p = args?.where?.provider;
        if (p === ExternalProvider.TMDB) return withType(opts.extByTmdb);
        if (p === ExternalProvider.THE_TVDB) return withType(opts.extByTvdb);
        if (p === ExternalProvider.IMDB) return withType(opts.extByImdb);
        return null;
      },
      create: jest.fn(async () => ({})),
    },
    episodeExternalId: {
      findFirst: async (args: any) => opts.epExtByProvider?.[args?.where?.provider] ?? null,
    },
    mediaItem: { findFirst: async () => null, findMany: async () => [] },
    mediaTitleAlias: { findMany: async () => [] },
    episode: { count: async () => 0, findMany: async () => [] },
    $queryRaw: async () => [] as any[],
  };
}

describe('ImportMatcher — matchByExternalIds (Trakt)', () => {
  it('TMDB id: local TMDB mapping wins without any external call', async () => {
    const prisma = fakePrismaExt({
      extByTmdb: { media: { id: 'm-tmdb', title: 'Show', type: MediaType.SHOW } },
    });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds(
      { trakt: 1, tmdb: 387, tvdb: 75886, imdb: 'tt1' },
      'SHOW',
      'Show',
      'show',
      1999,
    );
    expect(res).toEqual({ mediaId: 'm-tmdb', confidence: 0.95, matchedTitle: 'Show' });
    expect(meta.lightUpsertShow).not.toHaveBeenCalled();
    expect(tvdb.getShow).not.toHaveBeenCalled();
  });

  it('rejects a wrong-type local TMDB mapping and continues to a compatible IMDb identity', async () => {
    const prisma = fakePrismaExt({
      extByTmdb: { media: { id: 'wrong-movie', title: 'Wrong', type: MediaType.MOVIE } },
      extByImdb: { media: { id: 'right-show', title: 'Right', type: MediaType.SHOW } },
    });
    const matcher = new ImportMatcher(
      prisma as any,
      { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() } as any,
      { enabled: false } as any,
      { enabled: false } as any,
    );

    const res = await matcher.matchByExternalIds(
      { tmdb: 1, imdb: 'tt-right' },
      'SHOW',
      'Right',
      'right',
      2020,
    );

    expect(res).toEqual({ mediaId: 'right-show', confidence: 0.9, matchedTitle: 'Right' });
  });

  it('TMDB id miss + tmdb enabled (SHOW): validates with a lightweight routing profile', async () => {
    const prisma = fakePrismaExt({});
    const meta = { lightUpsertShow: jest.fn(async () => 'm-new'), lightUpsertMovie: jest.fn() };
    const tmdb = {
      enabled: true,
      getShowRoutingProfile: jest.fn().mockResolvedValue({
        tmdbId: 387,
        title: 'Show',
        yearStart: 1999,
        genreIds: [],
        keywords: [],
        tvdbId: 75886,
        imdbId: 'tt1',
      }),
    };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({ tmdb: 387 }, 'SHOW', 'Show', 'show', 1999);
    expect(tmdb.getShowRoutingProfile).toHaveBeenCalledWith(387);
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({ tmdbId: 387, title: 'Show', year: 1999 });
    expect(res).toEqual({ mediaId: 'm-new', confidence: 0.95, matchedTitle: 'Show' });
  });

  it('TMDB id miss + tmdb enabled (MOVIE): validates with a lightweight routing profile', async () => {
    const prisma = fakePrismaExt({});
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn(async () => 'm-mov') };
    const tmdb = {
      enabled: true,
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 6075,
        title: 'Movie',
        releaseYear: 1993,
        genreIds: [],
        keywords: [],
        imdbId: 'tt2',
      })),
    };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({ tmdb: 6075 }, 'MOVIE', 'Movie', 'movie', 1993);
    expect(tmdb.getMovieRoutingProfile).toHaveBeenCalledWith(6075);
    expect(meta.lightUpsertMovie).toHaveBeenCalled();
    expect(res.mediaId).toBe('m-mov');
    expect(res.confidence).toBe(0.95);
  });

  it('TMDB unusable (disabled) + TVDB id present → TVDB authority gate', async () => {
    const prisma = fakePrismaExt({ extByTvdb: { media: { id: 'm-tvdb', title: 'Show' } } });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds(
      { tmdb: 999, tvdb: 75886 },
      'SHOW',
      'Show',
      'show',
      1999,
    );
    expect(res).toEqual({ mediaId: 'm-tvdb', confidence: 0.95, matchedTitle: 'Show' });
    expect(tvdb.getShow).not.toHaveBeenCalled(); // local TVDB mapping sufficed
  });

  it('IMDB id: local mapping wins → 0.9 (no external fetch)', async () => {
    const prisma = fakePrismaExt({ extByImdb: { media: { id: 'm-imdb', title: 'Show' } } });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const tmdb = { enabled: true, findByExternalId: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds(
      { imdb: 'tt0206512' },
      'SHOW',
      'Show',
      'show',
      1999,
    );
    expect(res).toEqual({ mediaId: 'm-imdb', confidence: 0.9, matchedTitle: 'Show' });
    expect(tmdb.findByExternalId).not.toHaveBeenCalled();
  });

  it('conflicting ids: a kind-compatible IMDB movie wins over an unrelated TVDB series', async () => {
    const prisma = fakePrismaExt({
      extByTvdb: {
        media: { id: 'm-calimero', title: 'Calimero', type: MediaType.SHOW },
      },
    });
    const meta = {
      lightUpsertShow: jest.fn(),
      lightUpsertMovie: jest.fn(async () => 'm-thor'),
    };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: { tmdbId: 616037 },
        show: null,
        episode: null,
      })),
    };
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);

    const res = await matcher.matchByExternalIds(
      { imdb: 'tt10648342', tvdb: 131141 },
      'MOVIE',
      'Thor: Love and Thunder',
      'thor love and thunder',
      2022,
    );

    expect(tmdb.findByExternalId).toHaveBeenCalledWith('tt10648342', 'imdb_id');
    expect(meta.lightUpsertMovie).toHaveBeenCalledWith({
      tmdbId: 616037,
      title: 'Thor: Love and Thunder',
      year: 2022,
    });
    expect(prisma.externalId.create).toHaveBeenCalledWith({
      data: {
        mediaId: 'm-thor',
        provider: ExternalProvider.IMDB,
        providerEntityKind: ProviderEntityKind.MOVIE,
        value: 'tt10648342',
      },
    });
    expect(res).toEqual({
      mediaId: 'm-thor',
      confidence: 0.9,
      matchedTitle: 'Thor: Love and Thunder',
    });
  });

  it('no usable ids → regular title fallback', async () => {
    const prisma = fakePrismaExt({});
    (prisma.mediaItem.findMany as any) = async () => [
      {
        id: 'm-title',
        title: 'Show',
        popularity: 1,
        show: { yearStart: 1999, originalTitle: null, seasonsCount: 1, seasons: [] },
        movie: null,
      },
    ];
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({}, 'SHOW', 'Show', 'show', 1999);
    expect(res.mediaId).toBe('m-title');
    expect(res.confidence).toBe(0.9);
  });
});

describe('ImportMatcher — resolveEpisodeByExternalIds (Trakt)', () => {
  it('resolves an episode by TMDB episode external id, scoped to the matched show', async () => {
    const prisma = fakePrismaExt({
      epExtByProvider: { [ExternalProvider.TMDB]: { episodeId: 'ep-1' } },
    });
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, {} as any);
    const id = await matcher.resolveEpisodeByExternalIds('m1', { tmdb: 1249456, tvdb: 3448811 });
    expect(id).toBe('ep-1');
  });

  it('falls back to the TVDB episode id when TMDB misses', async () => {
    const prisma = fakePrismaExt({
      epExtByProvider: {
        [ExternalProvider.TMDB]: null,
        [ExternalProvider.THE_TVDB]: { episodeId: 'ep-2' },
      },
    });
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, {} as any);
    const id = await matcher.resolveEpisodeByExternalIds('m1', { tmdb: 1249456, tvdb: 3448811 });
    expect(id).toBe('ep-2');
  });

  it('returns null when no episode external id resolves', async () => {
    const prisma = fakePrismaExt({});
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, {} as any);
    const id = await matcher.resolveEpisodeByExternalIds('m1', { tmdb: 1, tvdb: 2 });
    expect(id).toBeNull();
  });
});

describe('ImportMatcher — bulk local prefetch', () => {
  it('serves a prefetched media external id without a per-item lookup or provider call', async () => {
    const findFirst = jest.fn(async () => null);
    const prisma = {
      externalId: {
        findFirst,
        findMany: jest.fn(async () => [
          {
            provider: ExternalProvider.TMDB,
            providerEntityKind: ProviderEntityKind.SERIES,
            value: '42',
            media: { id: 'm-42', title: 'Known Show', type: MediaType.SHOW },
          },
        ]),
      },
    };
    const tmdb = { enabled: true, getShowRoutingProfile: jest.fn() };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      tmdb as any,
      { enabled: false } as any,
    );

    await matcher.prefetchMediaExternalIds([
      {
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: '42',
      },
    ]);
    const result = await matcher.matchByExternalIds(
      { tmdb: 42 },
      'SHOW',
      'Known Show',
      'known show',
      2020,
    );

    expect(result.mediaId).toBe('m-42');
    expect(findFirst).not.toHaveBeenCalled();
    expect(tmdb.getShowRoutingProfile).not.toHaveBeenCalled();
  });

  it('serves prefetched episode aliases and S/E coordinates without per-item queries', async () => {
    const episodeFindFirst = jest.fn(async () => null);
    const episodeFindMany = jest.fn(async () => [
      {
        id: 'ep-1',
        number: 2,
        season: { number: 1, show: { mediaId: 'm-1' } },
      },
    ]);
    const prisma = {
      episodeExternalId: {
        findFirst: episodeFindFirst,
        findMany: jest.fn(async () => [
          {
            provider: ExternalProvider.THE_TVDB,
            value: '9001',
            episodeId: 'ep-1',
            episode: { season: { show: { mediaId: 'm-1' } } },
          },
        ]),
      },
      episode: { findMany: episodeFindMany },
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: false } as any,
    );

    await Promise.all([
      matcher.prefetchEpisodeExternalIds([
        { mediaId: 'm-1', provider: ExternalProvider.THE_TVDB, value: '9001' },
      ]),
      matcher.prefetchEpisodeCoordinates([{ mediaId: 'm-1', season: 1, episode: 2 }]),
    ]);

    await expect(matcher.resolveEpisodeByExternalIds('m-1', { tvdb: 9001 })).resolves.toBe('ep-1');
    await expect(matcher.resolveEpisode('m-1', 1, 2)).resolves.toBe('ep-1');
    expect(episodeFindFirst).not.toHaveBeenCalled();
    expect(episodeFindMany).toHaveBeenCalledTimes(1);
  });

  it('lets exact TVDB episode owners win over a same-title series/title match', async () => {
    const prisma = {
      episodeExternalId: {
        findMany: jest.fn(async () =>
          ['6432185', '6440863'].map((value, index) => ({
            provider: ExternalProvider.THE_TVDB,
            value,
            episodeId: `ep-${index + 1}`,
            episode: {
              season: {
                show: {
                  mediaId: 'vikings-2013',
                  media: { title: 'Vikings' },
                },
              },
            },
          })),
        ),
      },
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: false } as any,
    );

    await matcher.prefetchEpisodeParents([
      { provider: ExternalProvider.THE_TVDB, value: '6432185' },
      { provider: ExternalProvider.THE_TVDB, value: '6440863' },
    ]);
    const result = matcher.matchPrefetchedShowByEpisodeIds(['6432185', '6440863']);

    expect(result).toEqual({
      mediaId: 'vikings-2013',
      confidence: 0.95,
      matchedTitle: 'Vikings',
      conflict: false,
      matchedAliasCount: 2,
    });

    const fallback = jest.fn(async () => ({
      mediaId: 'vikings-2012',
      confidence: 0.9,
      matchedTitle: 'Vikings',
    }));
    await expect(
      matcher.matchShowWithEpisodeParent(['6432185', '6440863'], fallback),
    ).resolves.toEqual(result);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('refuses to choose when imported episode aliases point to different parent shows', async () => {
    const prisma = {
      episodeExternalId: {
        findMany: jest.fn(async () => [
          {
            provider: ExternalProvider.THE_TVDB,
            value: '1',
            episodeId: 'ep-1',
            episode: {
              season: { show: { mediaId: 'show-a', media: { title: 'Show A' } } },
            },
          },
          {
            provider: ExternalProvider.THE_TVDB,
            value: '2',
            episodeId: 'ep-2',
            episode: {
              season: { show: { mediaId: 'show-b', media: { title: 'Show B' } } },
            },
          },
        ]),
      },
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: false } as any,
    );

    await matcher.prefetchEpisodeParents([
      { provider: ExternalProvider.THE_TVDB, value: '1' },
      { provider: ExternalProvider.THE_TVDB, value: '2' },
    ]);

    const conflict = {
      mediaId: null,
      confidence: 0,
      matchedTitle: null,
      conflict: true,
      matchedAliasCount: 2,
    };
    expect(matcher.matchPrefetchedShowByEpisodeIds(['1', '2'])).toEqual(conflict);

    const fallback = jest.fn(async () => ({
      mediaId: 'title-guess',
      confidence: 0.9,
      matchedTitle: 'Show A',
    }));
    await expect(matcher.matchShowWithEpisodeParent(['1', '2'], fallback)).resolves.toEqual(
      conflict,
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to series or title matching only when no local episode owner exists', async () => {
    const matcher = new ImportMatcher(
      {} as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: false } as any,
    );
    const fallbackResult = {
      mediaId: 'fallback-show',
      confidence: 0.9,
      matchedTitle: 'Fallback Show',
    };
    const fallback = jest.fn(async () => fallbackResult);

    await expect(matcher.matchShowWithEpisodeParent(['missing'], fallback)).resolves.toEqual({
      ...fallbackResult,
      conflict: false,
      matchedAliasCount: 0,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('ImportMatcher — safe local duplicate-title matching', () => {
  const candidate = (
    id: string,
    yearStart: number,
    seasons: Array<{ number: number; episodeCount: number }>,
  ) => ({
    id,
    title: 'Vikings',
    popularity: id === 'vikings-2012' ? 100 : 50,
    show: {
      yearStart,
      originalTitle: null,
      seasonsCount: seasons.length,
      seasons: seasons.map((season) => ({ ...season, isSpecial: false })),
    },
    movie: null,
  });

  const build = (candidates: any[]) => {
    const prisma = {
      mediaItem: { findMany: jest.fn(async () => candidates) },
      mediaTitleAlias: { findMany: jest.fn(async () => []) },
    };
    return new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      { enabled: false } as any,
      { enabled: false } as any,
    );
  };

  it('selects Vikings (2013) because it can contain the imported S4/S5 episodes', async () => {
    const matcher = build([
      candidate('vikings-2012', 2012, [{ number: 1, episodeCount: 3 }]),
      candidate('vikings-2013', 2013, [
        { number: 1, episodeCount: 9 },
        { number: 2, episodeCount: 10 },
        { number: 3, episodeCount: 10 },
        { number: 4, episodeCount: 20 },
        { number: 5, episodeCount: 20 },
        { number: 6, episodeCount: 20 },
        { number: 7, episodeCount: 8 },
      ]),
    ]);

    const result = await matcher.matchMedia('vikings', 'Vikings', 'SHOW', null, {
      maxSeason: 5,
      seasonEpisodes: [
        { season: 4, maxEpisode: 20 },
        { season: 5, maxEpisode: 20 },
      ],
    });

    expect(result).toEqual({
      mediaId: 'vikings-2013',
      confidence: 0.9,
      matchedTitle: 'Vikings',
    });
  });

  it('rejects an exact-title show that cannot contain the imported footprint', async () => {
    const matcher = build([
      {
        ...candidate('harry-potter-2026', 2026, [
          { number: 1, episodeCount: 1 },
          { number: 2, episodeCount: 1 },
        ]),
        title: 'Harry Potter',
      },
    ]);

    const result = await matcher.matchMedia('harry potter', 'Harry Potter', 'SHOW', null, {
      maxSeason: 8,
      seasonEpisodes: [{ season: 8, maxEpisode: 1 }],
    });

    expect(result.mediaId).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('keeps same-title years separate in the match cache', async () => {
    const prisma = {
      mediaItem: {
        findMany: jest.fn(async () => [
          {
            id: 'dune-1984',
            title: 'Dune',
            popularity: 90,
            show: null,
            movie: { releaseYear: 1984 },
          },
          {
            id: 'dune-2021',
            title: 'Dune',
            popularity: 80,
            show: null,
            movie: { releaseYear: 2021 },
          },
        ]),
      },
      mediaTitleAlias: { findMany: jest.fn(async () => []) },
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      { enabled: false } as any,
      { enabled: false } as any,
    );

    await expect(matcher.matchMedia('dune', 'Dune', 'MOVIE', 1984)).resolves.toMatchObject({
      mediaId: 'dune-1984',
    });
    await expect(matcher.matchMedia('dune', 'Dune', 'MOVIE', 2021)).resolves.toMatchObject({
      mediaId: 'dune-2021',
    });
  });
});

/** Fake Prisma for the /find matching + episode recovery paths. */
function fakePrismaFind(
  opts: {
    mediaById?: Record<string, { id: string; title: string }>;
    episodeBySE?: Record<string, { id: string }>;
    episodeCount?: number;
  } = {},
) {
  const state = {
    externalIdCreate: jest.fn(async () => ({})),
    episodeExternalIdUpsert: jest.fn(async () => ({})),
    extByProvider: {} as Record<string, { media: { id: string; title: string } } | null>,
  };
  const prisma = {
    externalId: {
      findFirst: async (args: any) => {
        const p = args?.where?.provider;
        if (args?.where?.mediaId) {
          // media-scoped lookup (e.g. ensureShowHydrated / recoverEpisodeByTvdbId)
          if (p === ExternalProvider.THE_TVDB) return { value: '80379' };
          return null;
        }
        return state.extByProvider[p] ?? null;
      },
      create: state.externalIdCreate,
    },
    episodeExternalId: {
      findFirst: async () => null,
      upsert: state.episodeExternalIdUpsert,
    },
    mediaItem: { findFirst: async () => null, findMany: async () => [] },
    mediaTitleAlias: { findMany: async () => [] },
    episode: {
      count: async () => opts.episodeCount ?? 0,
      findMany: async (args: any) => {
        const key = `${args?.where?.season?.number}:${args?.where?.number}`;
        const episode = opts.episodeBySE?.[key] ?? null;
        return episode ? [episode] : [];
      },
    },
    $queryRaw: async () => [] as any[],
  };
  return { prisma, state };
}

describe('ImportMatcher — TMDB /find translation (matchByTvdbId)', () => {
  const fakeTvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };

  it('non-anime show: /find hit → light TMDB upsert (0.95), no TVDB/search calls', async () => {
    const { prisma } = fakePrismaFind();
    const meta = {
      lightUpsertShow: jest.fn(async () => 'm-find'),
      lightUpsertMovie: jest.fn(),
      lightUpsertShowTvdb: jest.fn(),
    };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: { tmdbId: 1399, genreIds: [18, 10765], originCountries: ['US'] },
        episode: null,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, fakeTvdb as any);
    const res = await matcher.matchMedia(
      'game of thrones',
      'Game of Thrones',
      'SHOW',
      2011,
      undefined,
      null,
      '121361',
    );
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('121361', 'tvdb_id');
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({
      tmdbId: 1399,
      title: 'Game of Thrones',
      year: 2011,
    });
    expect(meta.lightUpsertShowTvdb).not.toHaveBeenCalled();
    expect(fakeTvdb.getShow).not.toHaveBeenCalled();
    expect(res).toEqual({ mediaId: 'm-find', confidence: 0.95, matchedTitle: 'Game of Thrones' });
  });

  it('canonicalizes a spreadsheet-formatted TVDB id before provider lookup', async () => {
    const { prisma } = fakePrismaFind();
    const meta = {
      lightUpsertShow: jest.fn(async () => 'm-find'),
      lightUpsertMovie: jest.fn(),
      lightUpsertShowTvdb: jest.fn(),
    };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: { tmdbId: 1399, genreIds: [18], originCountries: ['US'] },
        episode: null,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, fakeTvdb as any);

    const res = await matcher.matchMedia(
      'game of thrones',
      'Game of Thrones',
      'SHOW',
      2011,
      undefined,
      null,
      '00121361.0',
    );

    expect(tmdb.findByExternalId).toHaveBeenCalledWith('121361', 'tvdb_id');
    expect(res.mediaId).toBe('m-find');
  });

  it('movie: TVDB remote ids bridge to the canonical movie without TMDB tvdb_id /find', async () => {
    const { prisma } = fakePrismaFind();
    const meta = {
      lightUpsertShow: jest.fn(),
      lightUpsertMovie: jest.fn(),
      lightUpsertShowTvdb: jest.fn(),
      lightUpsertMovieTvdb: jest.fn(async () => 'm-mov'),
    };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(),
    };
    const tvdb = {
      enabled: true,
      getMovie: jest.fn(async () => ({
        title: 'Pulp Fiction',
        overview: null,
        posterUrl: null,
        backdropUrl: null,
        popularity: 0,
        releaseYear: 1994,
        externals: [
          { provider: ExternalProvider.THE_TVDB, value: '16858' },
          { provider: ExternalProvider.IMDB, value: 'tt0110912' },
          { provider: ExternalProvider.TMDB, value: '680' },
        ],
      })),
      getShow: jest.fn(),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchMedia(
      'pulp fiction',
      'Pulp Fiction',
      'MOVIE',
      1994,
      undefined,
      null,
      '16858',
    );
    expect(tmdb.findByExternalId).not.toHaveBeenCalled();
    expect(meta.lightUpsertMovieTvdb).toHaveBeenCalledWith({
      tvdbId: 16858,
      tmdbId: 680,
      imdbId: 'tt0110912',
      title: 'Pulp Fiction',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      popularity: 0,
      year: 1994,
    });
    expect(res.mediaId).toBe('m-mov');
    expect(res.confidence).toBe(0.85);
  });

  it('anime show (TMDB Animation + anime keyword): TVDB-authoritative record + TMDB id attached', async () => {
    const { prisma, state } = fakePrismaFind();
    const meta = {
      lightUpsertShow: jest.fn(),
      lightUpsertMovie: jest.fn(),
      lightUpsertShowTvdb: jest.fn(async () => 'm-anime'),
      ensureShowFull: jest.fn(),
      ensureShowFullTvdb: jest.fn(async () => undefined),
    };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: { tmdbId: 65930, genreIds: [16, 10759], originCountries: ['JP'] },
        episode: null,
      })),
      getShowRoutingProfile: jest.fn(async () => ({
        tmdbId: 65930,
        title: 'Naruto',
        yearStart: 2002,
        genreIds: [16, 10759],
        keywords: ['anime'],
        tvdbId: 78857,
        imdbId: 'tt0409591',
      })),
    };
    const tvdbShow = {
      title: 'Naruto',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      popularity: 0,
      yearStart: 2002,
    };
    const tvdb = { enabled: true, getShow: jest.fn(async () => tvdbShow), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'naruto',
      'Naruto',
      'SHOW',
      2002,
      undefined,
      null,
      '78857',
    );
    expect(tvdb.getShow).toHaveBeenCalledWith(78857);
    expect(meta.lightUpsertShowTvdb).toHaveBeenCalled();
    expect(meta.lightUpsertShow).not.toHaveBeenCalled();
    expect(res).toEqual({ mediaId: 'm-anime', confidence: 0.9, matchedTitle: 'Naruto' });
    // TMDB id from /find attached for cross-lookups
    expect(state.externalIdCreate).toHaveBeenCalledWith({
      data: {
        mediaId: 'm-anime',
        provider: ExternalProvider.TMDB,
        providerEntityKind: 'SERIES',
        value: '65930',
      },
    });
    // providerPref → ensureShowHydrated hydrates from TVDB first
    await matcher.ensureShowHydrated('m-anime');
    expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(80379, undefined, {
      forceRefresh: true,
      skipClassification: true,
    });
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
  });

  it('force-hydrates a recently light-upserted TVDB-only show with zero episodes', async () => {
    const { prisma } = fakePrismaFind({ episodeCount: 0 });
    const releaseHydration = Promise.resolve('m1');
    const meta = {
      ensureShowFullTvdb: jest.fn(() => releaseHydration),
      ensureShowFull: jest.fn(),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      meta as any,
      { enabled: false } as any,
      { enabled: true } as any,
    );

    await Promise.all([matcher.ensureShowHydrated('m1'), matcher.ensureShowHydrated('m1')]);

    expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1);
    expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(80379, undefined, {
      forceRefresh: true,
      skipClassification: true,
    });
  });

  it('/find miss + TVDB enabled → direct TVDB recovery (0.85)', async () => {
    const { prisma } = fakePrismaFind();
    const meta = {
      lightUpsertShow: jest.fn(),
      lightUpsertMovie: jest.fn(),
      lightUpsertShowTvdb: jest.fn(async () => 'm-tvdb'),
    };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdbShow = {
      title: 'Show',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      popularity: 0,
      yearStart: 2019,
    };
    const tvdb = { enabled: true, getShow: jest.fn(async () => tvdbShow), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', 2019, undefined, null, '123');
    expect(tmdb.findByExternalId).toHaveBeenCalled();
    expect(tvdb.getShow).toHaveBeenCalledWith(123);
    expect(res.mediaId).toBe('m-tvdb');
    expect(res.confidence).toBe(0.85);
  });

  it('IMDB id: /find recovery when the local mapping misses', async () => {
    const { prisma } = fakePrismaFind();
    const meta = { lightUpsertShow: jest.fn(async () => 'm-imdb'), lightUpsertMovie: jest.fn() };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: { tmdbId: 387, genreIds: [16, 35], originCountries: ['US'] },
        episode: null,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, {} as any);
    const res = await matcher.matchByExternalIds(
      { imdb: 'tt0206512' },
      'SHOW',
      'SpongeBob',
      'spongebob',
      1999,
    );
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('tt0206512', 'imdb_id');
    expect(res).toEqual({ mediaId: 'm-imdb', confidence: 0.9, matchedTitle: 'SpongeBob' });
  });
});

describe('ImportMatcher — recoverEpisodeByTvdbId (provider recovery)', () => {
  it('resolves via TMDB /find and attaches both TMDB and original TVDB episode aliases', async () => {
    const { prisma, state } = fakePrismaFind({ episodeBySE: { '1:9': { id: 'ep-19' } } });
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: null,
        episode: { tmdbEpisodeId: 2449623, showId: 109958, season: 1, episode: 9 },
      })),
    };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, tmdb as any, {} as any);
    const id = await matcher.recoverEpisodeByTvdbId('m1', '7968847');
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('7968847', 'tvdb_id');
    expect(id).toBe('ep-19');
    expect(state.episodeExternalIdUpsert).toHaveBeenCalledTimes(2);
    expect(state.episodeExternalIdUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ provider: ExternalProvider.TMDB, value: '2449623' }),
      }),
    );
    expect(state.episodeExternalIdUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ provider: ExternalProvider.THE_TVDB, value: '7968847' }),
      }),
    );
  });

  it('returns null when the /find episode belongs to a different show (TMDB id mismatch)', async () => {
    const { prisma } = fakePrismaFind({ episodeBySE: { '1:9': { id: 'ep-19' } } });
    // media-scoped TMDB lookup returns a DIFFERENT show id than /find's show_id
    (prisma.externalId.findFirst as any) = async (args: any) =>
      args?.where?.mediaId && args?.where?.provider === ExternalProvider.TMDB
        ? { value: '999' }
        : null;
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: null,
        episode: { tmdbEpisodeId: 2449623, showId: 109958, season: 1, episode: 9 },
      })),
    };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, tmdb as any, {} as any);
    const id = await matcher.recoverEpisodeByTvdbId('m1', '7968847');
    expect(id).toBeNull();
  });

  it('falls back to the exact TVDB episode when TMDB /find misses', async () => {
    const { prisma, state } = fakePrismaFind({ episodeBySE: { '1:4': { id: 'ep-tvdb' } } });
    (prisma.externalId.findFirst as any) = async (args: any) => {
      if (args?.where?.mediaId && args?.where?.provider === ExternalProvider.TMDB) {
        return { value: '109958' };
      }
      if (args?.where?.mediaId && args?.where?.provider === ExternalProvider.THE_TVDB) {
        return { value: '80379' };
      }
      return null;
    };
    const meta = {
      ...fakeMeta(),
      ensureShowFullTvdb: jest.fn(async () => undefined),
    };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getEpisode: jest.fn(async () => ({
        tvdbEpisodeId: 7968847,
        seriesId: 80379,
        seasonNumber: 1,
        absoluteNumber: 4,
        episode: { number: 4 },
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);

    await expect(matcher.recoverEpisodeByTvdbId('m1', '7968847')).resolves.toBe('ep-tvdb');
    expect(tvdb.getEpisode).toHaveBeenCalledWith(7968847);
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(state.episodeExternalIdUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          provider: ExternalProvider.THE_TVDB,
          value: '7968847',
        }),
      }),
    );
  });

  it('rejects a TVDB episode belonging to a different parent series', async () => {
    const { prisma } = fakePrismaFind({ episodeBySE: { '1:4': { id: 'ep-tvdb' } } });
    const meta = {
      ...fakeMeta(),
      ensureShowFullTvdb: jest.fn(async () => undefined),
    };
    const tvdb = {
      enabled: true,
      getEpisode: jest.fn(async () => ({
        tvdbEpisodeId: 7968847,
        seriesId: 999,
        seasonNumber: 1,
        absoluteNumber: 4,
        episode: { number: 4 },
      })),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      meta as any,
      { enabled: false } as any,
      tvdb as any,
    );

    await expect(matcher.recoverEpisodeByTvdbId('m1', '7968847')).resolves.toBeNull();
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
  });

  it('maps cross-provider numbering by exact provider title and air date', async () => {
    const { prisma, state } = fakePrismaFind();
    (prisma.externalId.findFirst as any) = async (args: any) => {
      if (args?.where?.mediaId && args?.where?.provider === ExternalProvider.TMDB) {
        return { value: '25298' };
      }
      if (args?.where?.mediaId && args?.where?.provider === ExternalProvider.THE_TVDB) {
        return { value: '85401' };
      }
      return null;
    };
    (prisma.episode.findMany as any) = async (args: any) =>
      args?.where?.airDate
        ? [
            { id: 'grammy-premiere', title: '68th Grammy Awards Premiere Ceremony' },
            { id: 'grammy-main', title: 'The 68th Annual Grammy Awards' },
          ]
        : [];
    const meta = {
      ...fakeMeta(),
      ensureShowFullTvdb: jest.fn(async () => 'm1'),
    };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getEpisode: jest.fn(async () => ({
        tvdbEpisodeId: 11237418,
        seriesId: 85401,
        seasonNumber: 1,
        absoluteNumber: 68,
        episode: {
          number: 68,
          title: 'The 68th Annual Grammy Awards',
          airDate: '2026-02-01',
        },
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);

    await expect(matcher.recoverEpisodeByTvdbId('m1', '11237418')).resolves.toBe('grammy-main');
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(state.episodeExternalIdUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          episodeId: 'grammy-main',
          provider: ExternalProvider.THE_TVDB,
          value: '11237418',
        }),
      }),
    );
  });

  it('returns null for empty ids or when no enabled provider can recover the episode', async () => {
    const { prisma } = fakePrismaFind();
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, tmdb as any, {} as any);
    expect(await matcher.recoverEpisodeByTvdbId('m1', null)).toBeNull();
    expect(await matcher.recoverEpisodeByTvdbId('m1', '7968847')).toBeNull();
    const disabled = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      { enabled: false } as any,
      {} as any,
    );
    expect(await disabled.recoverEpisodeByTvdbId('m1', '7968847')).toBeNull();
  });
});

describe('ImportMatcher — multi-id TVDB authority gate (dead sibling ids)', () => {
  it('tries every collected id in order: dead id fails, live id resolves', async () => {
    const { prisma } = fakePrismaFind();
    const meta = {
      lightUpsertShow: jest.fn(async () => 'm-spartacus'),
      lightUpsertMovie: jest.fn(),
    };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(
        async (id: string) =>
          id === '465189'
            ? {
                movie: null,
                show: { tmdbId: 240459, genreIds: [18, 10759], originCountries: ['US'] },
                episode: null,
              }
            : null, // 442083 is a dead TVDB id — /find returns nothing
      ),
    };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchMedia(
      'spartacus house of ashur',
      'Spartacus: House of Ashur',
      'SHOW',
      2025,
      undefined,
      null,
      '442083',
      ['442083', '465189'],
    );
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('442083', 'tvdb_id');
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('465189', 'tvdb_id');
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({
      tmdbId: 240459,
      title: 'Spartacus: House of Ashur',
      year: 2025,
    });
    expect(res).toEqual({
      mediaId: 'm-spartacus',
      confidence: 0.95,
      matchedTitle: 'Spartacus: House of Ashur',
    });
  });

  it('refuses title fallback when EVERY collected id fails (even with a DB title match)', async () => {
    const { prisma } = fakePrismaFind();
    (prisma.mediaItem.findFirst as any) = async () => ({
      id: 'm-wrong',
      title: 'Spartacus: House of Ashur',
    });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchMedia(
      'spartacus house of ashur',
      'Spartacus: House of Ashur',
      'SHOW',
      2025,
      undefined,
      null,
      '442083',
      ['442083', '465189'],
    );
    expect(res.mediaId).toBeNull(); // id authority: no silent title match to another show
  });
});

describe('ImportMatcher — recoverShowByEpisodeId (show-level /find via episode id)', () => {
  it('identifies the show from a TVDB episode id and light-upserts it', async () => {
    const { prisma } = fakePrismaFind();
    const meta = { lightUpsertShow: jest.fn(async () => 'm-mantis'), lightUpsertMovie: jest.fn() };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: null,
        episode: { tmdbEpisodeId: 111, showId: 73613, season: 1, episode: 1 },
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, {} as any);
    const res = await matcher.recoverShowByEpisodeId('The Mantis', 2017, '5934058');
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('5934058', 'tvdb_id');
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({
      tmdbId: 73613,
      title: 'The Mantis',
      year: 2017,
    });
    expect(res).toEqual({ mediaId: 'm-mantis', confidence: 0.9, matchedTitle: 'The Mantis' });
  });

  it('returns null when /find has no episode result or the id is empty', async () => {
    const { prisma } = fakePrismaFind();
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, {} as any);
    expect((await matcher.recoverShowByEpisodeId('X', null, '1')).mediaId).toBeNull();
    expect((await matcher.recoverShowByEpisodeId('X', null, null)).mediaId).toBeNull();
    expect(meta.lightUpsertShow).not.toHaveBeenCalled();
  });

  it('uses the local episode external-id mapping first (no provider calls)', async () => {
    const { prisma } = fakePrismaFind();
    (prisma.episodeExternalId.findFirst as any) = jest.fn(async () => ({
      episode: { season: { show: { media: { id: 'm-local', title: 'Local Show' } } } },
    }));
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, {} as any);

    const res = await matcher.recoverShowByEpisodeId('X', null, '7052975');

    expect(res).toEqual({ mediaId: 'm-local', confidence: 0.95, matchedTitle: 'Local Show' });
    expect(tmdb.findByExternalId).not.toHaveBeenCalled();
    expect(meta.lightUpsertShow).not.toHaveBeenCalled();
  });

  it('falls back to TVDB: episode → parent series id → authority gate (TVDB-only shows)', async () => {
    const { prisma } = fakePrismaFind();
    const meta = {
      lightUpsertShow: jest.fn(async () => 'm-tvdb-show'),
      lightUpsertShowTvdb: jest.fn(async () => 'm-tvdb-show'),
      lightUpsertMovie: jest.fn(),
    };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getEpisode: jest.fn(async () => ({ seriesId: 359983 })),
      getShow: jest.fn(async () => ({
        title: 'White Dragon',
        overview: 'O',
        posterUrl: null,
        backdropUrl: null,
        popularity: 0,
        yearStart: 2018,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);

    const res = await matcher.recoverShowByEpisodeId('White Dragon', 2018, '7052975');

    expect(tvdb.getEpisode).toHaveBeenCalledWith(7052975);
    expect(tvdb.getShow).toHaveBeenCalledWith(359983);
    expect(res).toEqual({ mediaId: 'm-tvdb-show', confidence: 0.85, matchedTitle: 'White Dragon' });
  });
});

describe('ImportMatcher — anthology episode target routing', () => {
  it('routes a TVDB season-two episode into its separate TMDB one-season show', async () => {
    const { prisma, state } = fakePrismaFind({
      episodeCount: 9,
      episodeBySE: { '1:1': { id: 'bly-manor-s01e01' } },
    });
    const meta = {
      ...fakeMeta(),
      lightUpsertShow: jest.fn(async () => 'bly-manor'),
    };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: null,
        episode: {
          tmdbEpisodeId: 2428510,
          showId: 109958,
          season: 1,
          episode: 1,
        },
      })),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      meta as any,
      tmdb as any,
      { enabled: false } as any,
    );

    await expect(
      matcher.recoverEpisodeTargetByTvdbId('The Haunting', null, '7697199'),
    ).resolves.toEqual({
      mediaId: 'bly-manor',
      episodeId: 'bly-manor-s01e01',
    });
    expect(tmdb.findByExternalId).toHaveBeenCalledTimes(1);
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('7697199', 'tvdb_id');
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({
      tmdbId: 109958,
      title: 'The Haunting',
      year: null,
    });
    expect(state.episodeExternalIdUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          episodeId: 'bly-manor-s01e01',
          provider: ExternalProvider.THE_TVDB,
          value: '7697199',
        }),
      }),
    );
  });
});

describe('needsTvdbRehydration (structural guard)', () => {
  const hydrated = (maxSeason: number, perSeason: Record<number, number>) => ({
    maxSeason,
    maxEpisodeBySeason: new Map(Object.entries(perSeason).map(([k, v]) => [Number(k), v])),
  });

  it('is true when the hydrated show lacks whole seasons (reboot continuation)', () => {
    expect(needsTvdbRehydration({ maxSeason: 18 }, hydrated(14, {}))).toBe(true);
  });

  it('is true when a referenced season has too few episodes (partial hydration / merged hour-longs)', () => {
    expect(
      needsTvdbRehydration(
        { seasonEpisodes: [{ season: 7, maxEpisode: 26 }] },
        hydrated(9, { 7: 25 }),
      ),
    ).toBe(true);
    expect(
      needsTvdbRehydration(
        { seasonEpisodes: [{ season: 1, maxEpisode: 10 }] },
        hydrated(2, { 1: 1 }),
      ),
    ).toBe(true);
  });

  it('is false when the hydrated structure covers the footprint', () => {
    expect(
      needsTvdbRehydration(
        { maxSeason: 4, seasonEpisodes: [{ season: 2, maxEpisode: 13 }] },
        hydrated(4, { 2: 13 }),
      ),
    ).toBe(false);
    expect(needsTvdbRehydration({ maxSeason: null, seasonEpisodes: null }, hydrated(1, {}))).toBe(
      false,
    );
  });

  it('ignores specials (S0) even when nothing is hydrated there', () => {
    expect(
      needsTvdbRehydration({ seasonEpisodes: [{ season: 0, maxEpisode: 5 }] }, hydrated(3, {})),
    ).toBe(false);
  });
});

describe('ImportMatcher — dead TVDB id title fallback', () => {
  const meta = () => ({
    lightUpsertShow: jest.fn(async () => 'm-lotm'),
    lightUpsertMovie: jest.fn(async () => 'm-lotm'),
    lightUpsertShowTvdb: jest.fn(async () => 'm-tvdb'),
    lightUpsertMovieTvdb: jest.fn(async () => 'm-tvdb'),
    ensureShowFull: jest.fn(async () => undefined),
  });

  it('rejects a fuzzy provider suggestion when every authoritative id is dead', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(async () => ({
        items: [{ tmdbId: 240001, title: 'Lord of Mysteries' }],
        total: 1,
      })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      searchShows: jest.fn(),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'lord of the mysteries',
      'Lord of the Mysteries',
      'SHOW',
      null,
      undefined,
      null,
      '438102',
    );

    expect(tmdb.searchShows).toHaveBeenCalledWith('Lord of the Mysteries', 1);
    expect(res.mediaId).toBeNull();
    expect(m.lightUpsertShow).not.toHaveBeenCalled();
  });

  it('allows an exact provider title after every authoritative id is confirmed dead', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(async () => ({
        items: [{ tmdbId: 240001, title: 'Lord of the Mysteries' }],
        total: 1,
      })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      searchShows: jest.fn(),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'lord of the mysteries',
      'Lord of the Mysteries',
      'SHOW',
      null,
      undefined,
      null,
      '438102',
    );

    expect(res).toEqual({
      mediaId: 'm-lotm',
      confidence: 0.75,
      matchedTitle: 'Lord of the Mysteries',
    });
    expect(m.lightUpsertShow).toHaveBeenCalled();
  });

  it('still refuses title fallback on an inconclusive failure (non-404)', async () => {
    const prisma = fakePrisma({});
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new Error('throttled internally: tvdb');
      }),
      searchShows: jest.fn(),
    };
    const matcher = new ImportMatcher(prisma as any, meta() as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'lord of the mysteries',
      'Lord of the Mysteries',
      'SHOW',
      null,
      undefined,
      null,
      '438102',
    );

    expect(res.mediaId).toBeNull();
    expect(tmdb.searchShows).not.toHaveBeenCalled();
  });
});

describe('ImportMatcher — matchByTitleVerified (resolve by name)', () => {
  const meta = () => ({
    lightUpsertShow: jest.fn(async () => 'm-show'),
    lightUpsertMovie: jest.fn(async () => 'm-movie'),
    lightUpsertShowTvdb: jest.fn(async () => 'm-tvdb'),
    lightUpsertMovieTvdb: jest.fn(async () => 'm-tvdb'),
    ensureShowFull: jest.fn(async () => undefined),
  });

  it('accepts a TMDB hit whose ORIGINAL title matches (language aware)', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      searchMovies: jest.fn(async () => ({
        items: [
          { tmdbId: 412121, title: 'Miracle in Cell No. 7', originalTitle: '7. Koğuştaki Mucize' },
        ],
        total: 1,
      })),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      m as any,
      tmdb as any,
      { enabled: false } as any,
    );

    const res = await matcher.matchByTitleVerified(
      '7 kogustaki mucize',
      '7. Koğuştaki Mucize',
      'MOVIE',
      null,
    );

    expect(m.lightUpsertMovie).toHaveBeenCalled();
    expect(res).toEqual({
      mediaId: 'm-movie',
      confidence: 0.85,
      matchedTitle: 'Miracle in Cell No. 7',
    });
  });

  it('rejects a TMDB hit whose name does NOT match (no first-hit gambles)', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      searchMovies: jest.fn(async () => ({
        items: [{ tmdbId: 1, title: 'Some Other Movie', originalTitle: null }],
        total: 1,
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      m as any,
      tmdb as any,
      { enabled: false } as any,
    );

    const res = await matcher.matchByTitleVerified('kogustaki', 'Koğuştaki', 'MOVIE', null);

    expect(m.lightUpsertMovie).not.toHaveBeenCalled();
    expect(res.mediaId).toBeNull();
  });

  it('matches a local row via its indexed localized-title alias', async () => {
    const prisma = fakePrisma({});
    (prisma.mediaTitleAlias.findMany as any) = jest.fn(async () => [
      {
        title: '7. Koğuştaki Mucize',
        media: { id: 'm-tr', title: 'Miracle in Cell No. 7' },
      },
    ]);
    const matcher = new ImportMatcher(
      prisma as any,
      meta() as any,
      fakeTmdb as any,
      { enabled: false } as any,
    );

    const res = await matcher.matchByTitleVerified(
      '7 kogustaki mucize',
      '7. Koğuştaki Mucize',
      'MOVIE',
      null,
    );

    expect(res).toEqual({
      mediaId: 'm-tr',
      confidence: 0.85,
      matchedTitle: 'Miracle in Cell No. 7',
    });
  });

  it('disambiguates duplicate show titles by the season/episode footprint', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      searchShows: jest.fn(async () => ({
        items: [
          { tmdbId: 1, title: 'Silo', originalTitle: null },
          { tmdbId: 2, title: 'Silo', originalTitle: null },
        ],
        total: 2,
      })),
      getShow: jest.fn(async (id: number) =>
        id === 1
          ? { seasonsCount: 1, seasons: [{ number: 1, episodeCount: 10, isSpecial: false }] }
          : {
              seasonsCount: 4,
              seasons: [
                { number: 1, episodeCount: 10, isSpecial: false },
                { number: 2, episodeCount: 10, isSpecial: false },
                { number: 3, episodeCount: 10, isSpecial: false },
                { number: 4, episodeCount: 10, isSpecial: false },
              ],
            },
      ),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      m as any,
      tmdb as any,
      { enabled: false } as any,
    );

    const res = await matcher.matchByTitleVerified('silo', 'Silo', 'SHOW', {
      maxSeason: 4,
      seasonEpisodes: [{ season: 4, maxEpisode: 8 }],
    });

    expect(m.lightUpsertShow).toHaveBeenCalledWith(expect.objectContaining({ tmdbId: 2 }));
    expect(res.mediaId).toBe('m-show');
  });
});

describe('ImportMatcher — incompatible external-id types', () => {
  const meta = () => ({
    lightUpsertShow: jest.fn(async () => 'm-show'),
    lightUpsertMovie: jest.fn(async () => 'm-movie'),
    lightUpsertShowTvdb: jest.fn(async () => 'm-tvdb-show'),
    lightUpsertMovieTvdb: jest.fn(async () => 'm-tvdb-movie'),
    ensureShowFull: jest.fn(async () => undefined),
  });

  it('SHOW item hitting a local MOVIE mapping rejects it before attachment', async () => {
    const prisma = fakePrisma({
      extByTvdb: { media: { id: 'm-mov', title: 'Some Movie', type: MediaType.MOVIE } },
    });
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta() as any, fakeTmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'some movie',
      'Some Movie',
      'SHOW',
      null,
      null,
      null,
      '555',
    );

    expect(res).toEqual({ mediaId: null, confidence: 0, matchedTitle: null });
  });

  it('reclassifies a TV Time show identity when TVDB and its TMDB cross-id verify a movie', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 370755,
        title: 'Tales of Zestiria: Dawn of the Shepherd',
        releaseYear: 2014,
        genreIds: [16],
        keywords: ['anime'],
        imdbId: 'tt4086432',
      })),
      searchShows: jest.fn(),
    };
    const tvdbMovie = {
      title: 'Tales of Zestiria: Doushi no Yoake',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      popularity: 1,
      releaseYear: 2014,
      externals: [
        { provider: ExternalProvider.TMDB, value: '370755' },
        { provider: ExternalProvider.IMDB, value: 'tt4086432' },
      ],
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => tvdbMovie),
      searchShows: jest.fn(),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'tales of zestiria doushi no yoake',
      'Tales of Zestiria: Doushi no Yoake',
      'SHOW',
      2014,
      undefined,
      null,
      '302177',
    );

    expect(res).toEqual({
      mediaId: null,
      confidence: 0,
      matchedTitle: null,
      reclassifiedMovie: {
        mediaId: 'm-tvdb-movie',
        confidence: 0.95,
        matchedTitle: 'Tales of Zestiria: Dawn of the Shepherd',
        tvdbId: 302177,
        tmdbId: 370755,
      },
      allDead: true,
    });
    expect(m.lightUpsertMovieTvdb).toHaveBeenCalledWith(
      expect.objectContaining({ tvdbId: 302177, tmdbId: 370755, year: 2014 }),
    );
    expect(tmdb.searchShows).not.toHaveBeenCalled();

    const externalIdResult = await matcher.matchByExternalIds(
      { tvdb: 302177 },
      'SHOW',
      'Tales of Zestiria: Doushi no Yoake',
      'tales of zestiria doushi no yoake',
      2014,
      null,
    );
    expect(externalIdResult.reclassifiedMovie).toMatchObject({
      mediaId: 'm-tvdb-movie',
      tmdbId: 370755,
    });
  });

  it('reuses an already-verified local TVDB-to-TMDB movie identity without provider calls', async () => {
    const prisma = fakePrisma({
      extByTvdbMovie: {
        media: {
          id: 'movie-zestiria',
          title: 'Tales of Zestiria: Doushi no Yoake',
          type: MediaType.MOVIE,
        },
      },
      tmdbMovieExternal: { value: '370755', releaseYear: 2014 },
    });
    const tvdb = { enabled: false, getShow: jest.fn(), getMovie: jest.fn() };
    const tmdb = { enabled: false, findByExternalId: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta() as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'tales of zestiria doushi no yoake',
      'Tales of Zestiria: Doushi no Yoake',
      'SHOW',
      2014,
      undefined,
      null,
      '302177',
    );

    expect(res.reclassifiedMovie).toMatchObject({
      mediaId: 'movie-zestiria',
      tvdbId: 302177,
      tmdbId: 370755,
    });
    expect(tvdb.getShow).not.toHaveBeenCalled();
    expect(tvdb.getMovie).not.toHaveBeenCalled();
  });

  it('does not reclassify an opposite-kind TVDB movie when its title does not match', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 999,
        title: 'An Unrelated Movie',
        releaseYear: 2014,
        genreIds: [],
        keywords: [],
        imdbId: null,
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => ({
        title: 'An Unrelated Movie',
        releaseYear: 2014,
        externals: [{ provider: ExternalProvider.TMDB, value: '999' }],
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'tales of zestiria doushi no yoake',
      'Tales of Zestiria: Doushi no Yoake',
      'SHOW',
      2014,
      undefined,
      null,
      '302177',
    );

    expect(res.reclassifiedMovie).toBeUndefined();
    expect(m.lightUpsertMovieTvdb).not.toHaveBeenCalled();
  });

  it('trusts a local TVDB movie alias without calling the provider bridge', async () => {
    const prisma = fakePrisma({
      extByTvdb: { media: { id: 'historical-row', title: 'Pulp Fiction', type: MediaType.MOVIE } },
    });
    const m = meta();
    const tvdb = { enabled: true, getShow: jest.fn(), getMovie: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, m as any, fakeTmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'pulp fiction',
      'Pulp Fiction',
      'MOVIE',
      1994,
      null,
      null,
      '16858',
    );

    expect(m.lightUpsertMovieTvdb).not.toHaveBeenCalled();
    expect(tvdb.getMovie).not.toHaveBeenCalled();
    expect(res).toEqual({
      mediaId: 'historical-row',
      confidence: 0.95,
      matchedTitle: 'Pulp Fiction',
    });
  });

  it('MOVIE item whose id /finds only a SERIES does not create or attach a show', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: { tmdbId: 45950, genreIds: [], originCountries: ['US'] },
        episode: null,
      })),
    };
    const tvdb = { enabled: false, getShow: jest.fn(), getMovie: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'one piece',
      'One Piece',
      'MOVIE',
      null,
      undefined,
      null,
      '81797',
    );

    expect(m.lightUpsertShow).not.toHaveBeenCalled();
    expect(m.lightUpsertMovie).not.toHaveBeenCalled();
    expect(res).toEqual({ mediaId: null, confidence: 0, matchedTitle: null });
  });

  it('MOVIE item probes but never persists a live sibling SHOW id', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getMovie: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getShow: jest.fn(async () => ({
        title: 'Bleach',
        overview: 'O',
        posterUrl: null,
        backdropUrl: null,
        popularity: 0,
        yearStart: 2004,
      })),
      searchShows: jest.fn(),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'bleach',
      'Bleach',
      'MOVIE',
      null,
      undefined,
      null,
      '74796',
    );

    expect(tvdb.getMovie).toHaveBeenCalledWith(74796);
    expect(tvdb.getShow).toHaveBeenCalledWith(74796);
    expect(m.lightUpsertShowTvdb).not.toHaveBeenCalled();
    expect(res).toEqual({ mediaId: null, confidence: 0, matchedTitle: null });
  });

  it('MOVIE item: 404 on BOTH endpoints is dead → movie title fallback is allowed', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchMovies: jest.fn(async () => ({ items: [{ tmdbId: 777, title: 'Dracula' }], total: 1 })),
    };
    const tvdb = {
      enabled: true,
      getMovie: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'dracula',
      'Dracula',
      'MOVIE',
      null,
      undefined,
      null,
      '361160',
    );

    expect(tmdb.searchMovies).toHaveBeenCalledWith('Dracula', 1);
    expect(res).toEqual({ mediaId: 'm-movie', confidence: 0.75, matchedTitle: 'Dracula' });
  });

  it('MOVIE item: 404 on the movie endpoint + throttle on the series probe stays inconclusive (no title fallback)', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchMovies: jest.fn(),
    };
    const tvdb = {
      enabled: true,
      getMovie: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getShow: jest.fn(async () => {
        throw new Error('throttled internally: tvdb');
      }),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'bleach',
      'Bleach',
      'MOVIE',
      null,
      undefined,
      null,
      '74796',
    );

    expect(res.mediaId).toBeNull();
    expect(tmdb.searchMovies).not.toHaveBeenCalled();
  });
});

describe('ImportMatcher — pickBestTitleMatch (recency/year-aware title pick)', () => {
  const meta = () => ({
    lightUpsertShow: jest.fn(async () => 'm-show'),
    lightUpsertMovie: jest.fn(async () => 'm-movie'),
    lightUpsertShowTvdb: jest.fn(async () => 'm-tvdb'),
    lightUpsertMovieTvdb: jest.fn(async () => 'm-tvdb'),
    ensureShowFull: jest.fn(async () => undefined),
  });
  // TMDB ranks the historically famous entry first: classic precedes the remake.
  const remakePair = () => [
    { tmdbId: 1, title: 'Dune', year: 1984, popularity: 95 },
    { tmdbId: 2, title: 'Dune', year: 2021, popularity: 60 },
    { tmdbId: 3, title: 'Dune Warriors', year: 2024, popularity: 5 }, // not an exact match
  ];
  const tmdbWith = (items: any[]) => ({
    enabled: true,
    searchMovies: jest.fn(async () => ({ items, total: items.length })),
    searchShows: jest.fn(async () => ({ items: [], total: 0 })),
  });
  const build = (tmdb: any) => {
    const m = meta();
    return {
      m,
      tmdb,
      matcher: new ImportMatcher(fakePrisma({}) as any, m as any, tmdb, {
        enabled: false,
      } as any),
    };
  };

  it('with an import year, picks the candidate within ±1y (not the first hit)', async () => {
    const tmdb = tmdbWith(remakePair());
    const { matcher, m } = build(tmdb);
    const res = await matcher.matchMedia('dune', 'Dune', 'MOVIE', 2021, null);
    expect(res.mediaId).toBe('m-movie');
    // The light upsert must receive the 2021 remake, not the 1984 classic in slot 0.
    const upserted = (m.lightUpsertMovie as jest.Mock).mock.calls[0]?.[0];
    expect(upserted?.tmdbId).toBe(2);
  });

  it('without an import year, picks the MOST RECENT exact match', async () => {
    const tmdb = tmdbWith(remakePair());
    const { matcher, m } = build(tmdb);
    await matcher.matchMedia('dune', 'Dune', 'MOVIE', undefined, null);
    const upserted = (m.lightUpsertMovie as jest.Mock).mock.calls[0]?.[0];
    expect(upserted?.tmdbId).toBe(2);
  });

  it('an old import year still picks the classic (year-aware filter wins)', async () => {
    const tmdb = tmdbWith(remakePair());
    const { matcher, m } = build(tmdb);
    await matcher.matchMedia('dune', 'Dune', 'MOVIE', 1984, null);
    const upserted = (m.lightUpsertMovie as jest.Mock).mock.calls[0]?.[0];
    expect(upserted?.tmdbId).toBe(1);
  });

  it('accepts an exact TMDB original-language movie title as a confident match', async () => {
    const tmdb = tmdbWith([
      {
        tmdbId: 597398,
        title: 'Away',
        originalTitle: 'Projām',
        year: 2019,
        popularity: 5,
      },
    ]);
    const { matcher } = build(tmdb);

    await expect(matcher.matchMedia('projam', 'Projām', 'MOVIE', 2020, null)).resolves.toEqual({
      mediaId: 'm-movie',
      confidence: 0.75,
      matchedTitle: 'Away',
    });
  });

  it('breaks same-year ties by popularity', async () => {
    const tmdb = tmdbWith([
      { tmdbId: 1, title: 'Dune', year: 2021, popularity: 10 },
      { tmdbId: 2, title: 'Dune', year: 2021, popularity: 90 },
    ]);
    const { matcher, m } = build(tmdb);
    await matcher.matchMedia('dune', 'Dune', 'MOVIE', undefined, null);
    const upserted = (m.lightUpsertMovie as jest.Mock).mock.calls[0]?.[0];
    expect(upserted?.tmdbId).toBe(2);
  });

  it('matchByTitleVerified also prefers the most recent verified hit', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = tmdbWith([
      { tmdbId: 1, title: 'Dune', originalTitle: 'Dune', year: 1984, popularity: 95 },
      { tmdbId: 2, title: 'Dune', originalTitle: 'Dune', year: 2021, popularity: 60 },
    ]);
    const matcher = new ImportMatcher(
      prisma as any,
      m as any,
      tmdb as any,
      {
        enabled: false,
      } as any,
    );
    const res = await matcher.matchByTitleVerified('dune', 'Dune', 'MOVIE', null);
    expect(res.mediaId).toBe('m-movie');
    const upserted = (m.lightUpsertMovie as jest.Mock).mock.calls[0]?.[0];
    expect(upserted?.tmdbId).toBe(2);
  });
});
