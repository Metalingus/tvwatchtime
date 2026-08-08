import { ExternalProvider, MediaType, ProviderEntityKind } from '@tvwatch/shared';
import { ImportMatcher, needsTvdbRehydration } from './matcher';
import { normTitle } from './inference';
import { ProviderError } from '../../media-metadata/providers/shared/provider-errors';
import { STRUCTURE_RULE_VERSION } from '../../media-metadata/structure-authority.service';

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
    show: { findUnique: async () => ({ structureProvider: null }) },
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

  it('revalidates an empty local TVDB show before trusting it for episode history', async () => {
    const prisma = fakePrisma({
      extByTvdb: { media: { id: 'stale-devils', title: 'Devils' } },
      likeMedia: [
        {
          id: 'canonical-devils',
          title: 'Devils',
          popularity: 10,
          show: {
            yearStart: 2020,
            originalTitle: 'Diavoli',
            seasonsCount: 2,
            seasons: [
              { number: 1, episodeCount: 10, isSpecial: false },
              { number: 2, episodeCount: 8, isSpecial: false },
            ],
          },
          movie: null,
        } as any,
      ],
    });
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, tmdb as any, tvdb as any);

    const result = await matcher.matchMedia(
      'devils',
      'Devils',
      'SHOW',
      2020,
      {
        maxSeason: 2,
        seasonEpisodes: [
          { season: 1, maxEpisode: 10 },
          { season: 2, maxEpisode: 8 },
        ],
      },
      null,
      '351424',
    );

    expect(result).toEqual({
      mediaId: 'canonical-devils',
      confidence: 0.9,
      matchedTitle: 'Devils',
    });
    expect(tmdb.findByExternalId).toHaveBeenCalledTimes(1);
    expect(tvdb.getShow).toHaveBeenCalledWith(351424);
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
    show: { findUnique: async () => ({ structureProvider: null }) },
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

  it('keeps a verified IMDb show ahead of an empty or stale TVDB series identity', async () => {
    const prisma = fakePrismaExt({
      extByImdb: { media: { id: 'imdb-show', title: 'Canonical Show', type: MediaType.SHOW } },
      extByTvdb: { media: { id: 'stale-tvdb-show', title: 'Canonical Show' } },
    });
    const tmdb = { enabled: true, findByExternalId: jest.fn() };
    const tvdb = { enabled: true, getShow: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, tmdb as any, tvdb as any);

    const result = await matcher.matchByExternalIds(
      { imdb: 'tt-canonical', tvdb: 12345 },
      'SHOW',
      'Canonical Show',
      'canonical show',
      2020,
      null,
      { maxSeason: 2, seasonEpisodes: [{ season: 2, maxEpisode: 8 }] },
    );

    expect(result).toEqual({
      mediaId: 'imdb-show',
      confidence: 0.9,
      matchedTitle: 'Canonical Show',
    });
    expect(tmdb.findByExternalId).not.toHaveBeenCalled();
    expect(tvdb.getShow).not.toHaveBeenCalled();
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

  it('batch-resolves provider-foreign TVDB aliases onto canonical TMDB episodes', async () => {
    const episodeFindFirst = jest.fn(async () => null);
    const prisma = {
      episodeExternalId: {
        findFirst: episodeFindFirst,
        findMany: jest.fn(async () => [
          {
            provider: ExternalProvider.THE_TVDB,
            value: '9001',
            episodeId: 'legacy-1',
            episode: {
              structureState: 'LEGACY_UNMAPPED',
              externalIds: [{ provider: ExternalProvider.THE_TVDB }],
              season: {
                show: { mediaId: 'm-1', structureProvider: 'TMDB' },
              },
            },
          },
          {
            provider: ExternalProvider.THE_TVDB,
            value: '9002',
            episodeId: 'legacy-2',
            episode: {
              structureState: 'ACTIVE',
              externalIds: [
                { provider: ExternalProvider.TMDB },
                { provider: ExternalProvider.THE_TVDB },
              ],
              season: {
                show: { mediaId: 'm-1', structureProvider: 'TMDB' },
              },
            },
          },
        ]),
      },
    };
    const structureRemap = {
      resolveTvdbEpisodeAliasesToCanonical: jest.fn(async () => ({
        mappings: new Map([
          ['9001', 'canonical-1'],
          ['9002', 'canonical-2'],
        ]),
        verifiedValues: new Set(['9001', '9002']),
      })),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: true, getEpisode: jest.fn() } as any,
      structureRemap as any,
    );

    const onProgress = jest.fn();
    await matcher.prefetchEpisodeExternalIds(
      [
        { mediaId: 'm-1', provider: ExternalProvider.THE_TVDB, value: '9001' },
        { mediaId: 'm-1', provider: ExternalProvider.THE_TVDB, value: '9002' },
      ],
      onProgress,
    );

    await expect(matcher.resolveEpisodeByExternalIds('m-1', { tvdb: 9001 })).resolves.toBe(
      'canonical-1',
    );
    await expect(matcher.resolveEpisodeByExternalIds('m-1', { tvdb: 9002 })).resolves.toBe(
      'canonical-2',
    );
    expect(structureRemap.resolveTvdbEpisodeAliasesToCanonical).toHaveBeenCalledTimes(1);
    expect(structureRemap.resolveTvdbEpisodeAliasesToCanonical).toHaveBeenCalledWith('m-1', [
      '9001',
      '9002',
    ]);
    expect(onProgress).toHaveBeenCalledWith(1, 1);
    expect(episodeFindFirst).not.toHaveBeenCalled();
  });

  it('accepts a proven small-footprint split when both TVDB parts map to one episode', async () => {
    const episodeFindFirst = jest.fn(async () => null);
    const prisma = {
      episodeExternalId: {
        findFirst: episodeFindFirst,
        findMany: jest.fn(async () =>
          ['1685201', '1685211'].map((value) => ({
            provider: ExternalProvider.THE_TVDB,
            value,
            episodeId: 'tmdb-combined-finale',
            episode: {
              structureState: 'ACTIVE',
              externalIds: [
                { provider: ExternalProvider.TMDB },
                { provider: ExternalProvider.THE_TVDB },
              ],
              season: { show: { mediaId: 'lost', structureProvider: 'TMDB' } },
            },
          })),
        ),
      },
    };
    const structureRemap = {
      resolveTvdbEpisodeAliasesToCanonical: jest.fn(async () => ({
        mappings: new Map([
          ['1685201', 'tmdb-combined-finale'],
          ['1685211', 'tmdb-combined-finale'],
        ]),
        verifiedValues: new Set(['1685201', '1685211']),
        safeManyToOne: true,
      })),
    };
    const hydrationQueue = { enqueueStructureEvaluation: jest.fn().mockResolvedValue(undefined) };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: true } as any,
      structureRemap as any,
      hydrationQueue as any,
    );

    await matcher.prefetchEpisodeExternalIds([
      { mediaId: 'lost', provider: ExternalProvider.THE_TVDB, value: '1685201' },
      { mediaId: 'lost', provider: ExternalProvider.THE_TVDB, value: '1685211' },
    ]);

    expect(matcher.isStructureEvaluationPending('lost')).toBe(false);
    expect(hydrationQueue.enqueueStructureEvaluation).not.toHaveBeenCalled();
    await expect(matcher.resolveEpisodeByExternalIds('lost', { tvdb: 1685201 })).resolves.toBe(
      'tmdb-combined-finale',
    );
    await expect(matcher.resolveEpisodeByExternalIds('lost', { tvdb: 1685211 })).resolves.toBe(
      'tmdb-combined-finale',
    );
    expect(episodeFindFirst).not.toHaveBeenCalled();
  });

  it('parks a many-to-one bridge that exceeds the safe footprint rule', async () => {
    const episodeFindFirst = jest.fn(async () => null);
    const prisma = {
      episodeExternalId: {
        findFirst: episodeFindFirst,
        findMany: jest.fn(async () => []),
      },
    };
    const structureRemap = {
      resolveTvdbEpisodeAliasesToCanonical: jest.fn(async () => ({
        mappings: new Map([
          ['9001', 'combined'],
          ['9002', 'combined'],
        ]),
        verifiedValues: new Set(['9001', '9002']),
        safeManyToOne: false,
      })),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: true } as any,
      structureRemap as any,
    );

    await matcher.prefetchEpisodeExternalIds([
      { mediaId: 'show-1', provider: ExternalProvider.THE_TVDB, value: '9001' },
      { mediaId: 'show-1', provider: ExternalProvider.THE_TVDB, value: '9002' },
    ]);

    expect(matcher.isStructureEvaluationPending('show-1')).toBe(true);
    await expect(matcher.resolveEpisodeByExternalIds('show-1', { tvdb: 9001 })).resolves.toBeNull();
    await expect(matcher.resolveEpisodeByExternalIds('show-1', { tvdb: 9002 })).resolves.toBeNull();
  });

  it('keeps active TVDB-authoritative aliases out of the TMDB canonical bridge', async () => {
    const prisma = {
      episodeExternalId: {
        findMany: jest.fn(async () => [
          {
            provider: ExternalProvider.THE_TVDB,
            value: '46146801',
            episodeId: 'anime-ep-1',
            episode: {
              structureState: 'ACTIVE',
              externalIds: [{ provider: ExternalProvider.THE_TVDB }],
              season: {
                show: { mediaId: 'anime-show', structureProvider: 'TVDB' },
              },
            },
          },
        ]),
      },
    };
    const structureRemap = {
      resolveTvdbEpisodeAliasesToCanonical: jest.fn(),
    };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      { enabled: true } as any,
      structureRemap as any,
    );

    await matcher.prefetchEpisodeExternalIds([
      {
        mediaId: 'anime-show',
        provider: ExternalProvider.THE_TVDB,
        value: '46146801',
      },
    ]);

    await expect(
      matcher.resolveEpisodeByExternalIds('anime-show', { tvdb: 46146801 }),
    ).resolves.toBe('anime-ep-1');
    expect(structureRemap.resolveTvdbEpisodeAliasesToCanonical).not.toHaveBeenCalled();
  });

  it('does not retry TVDB per episode after the complete batch snapshot evaluated an alias', async () => {
    const prisma = {
      episodeExternalId: {
        findMany: jest.fn(async () => []),
      },
      externalId: {
        findFirst: jest.fn(async (args: any) =>
          args?.where?.provider === ExternalProvider.THE_TVDB ? { value: '777' } : null,
        ),
      },
    };
    const structureRemap = {
      resolveTvdbEpisodeAliasesToCanonical: jest.fn(async () => ({
        mappings: new Map(),
        verifiedValues: new Set(['9001']),
      })),
    };
    const tvdb = { enabled: true, getEpisode: jest.fn() };
    const hydrationQueue = { enqueueStructureEvaluation: jest.fn().mockResolvedValue(undefined) };
    const matcher = new ImportMatcher(
      prisma as any,
      fakeMeta() as any,
      fakeTmdb as any,
      tvdb as any,
      structureRemap as any,
      hydrationQueue as any,
    );

    await matcher.prefetchEpisodeExternalIds([
      { mediaId: 'm-1', provider: ExternalProvider.THE_TVDB, value: '9001' },
    ]);
    expect(matcher.hasVerifiedTvdbEpisodeAlias('m-1', '9001')).toBe(true);
    expect(matcher.hasVerifiedTvdbEpisodeAlias('m-2', '9001')).toBe(false);
    expect(hydrationQueue.enqueueStructureEvaluation).not.toHaveBeenCalled();
    await expect(matcher.recoverEpisodeByTvdbId('m-1', '9001', true)).resolves.toBeNull();

    expect(tvdb.getEpisode).not.toHaveBeenCalled();
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
    ensureShowFullTvdb: jest.fn(async () => 'm-tvdb-anime'),
  });

  const deadLegacyAnimeTvdb = (opts: { anime?: boolean; episodeCount?: number } = {}) => ({
    enabled: true,
    getShow: jest.fn(async (tvdbId: number) => {
      if (tvdbId === 273656 || tvdbId === 278308) {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }
      return {
        title: '猫物語（黒）',
        originalTitle: '猫物語（黒）',
        yearStart: 2012,
        genres: [{ tmdbId: 0, name: opts.anime === false ? 'Animation' : 'Anime' }],
        seasonsCount: 1,
        seasons: [
          {
            number: 1,
            episodeCount: opts.episodeCount ?? 4,
            isSpecial: false,
          },
        ],
      };
    }),
    searchShows: jest.fn(async (query: string) => {
      const items =
        query === 'Nekomonogatari Black: Tsubasa Family'
          ? []
          : [
              {
                tvdbId: 461468,
                tmdbId: 0,
                type: MediaType.SHOW,
                title: '猫物語（黒）',
                aliases: ['Nekomonogatari (Black)'],
                year: 2012,
              },
            ];
      return { items, total: items.length };
    }),
  });

  it('routes a uniquely verified replacement TVDB Anime series directly to TVDB authority', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = deadLegacyAnimeTvdb();
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'nekomonogatari black tsubasa family',
      'Nekomonogatari Black: Tsubasa Family',
      'SHOW',
      null,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 4 }] },
      null,
      '273656',
    );

    expect(res).toEqual({
      mediaId: 'm-tvdb-anime',
      confidence: 0.9,
      matchedTitle: '猫物語（黒）',
    });
    expect(m.ensureShowFullTvdb).toHaveBeenCalledWith(461468, undefined, {
      forceRefresh: true,
      skipClassification: true,
      decision: {
        provider: 'TVDB',
        reason: 'ANIME_TVDB',
        ruleVersion: STRUCTURE_RULE_VERSION,
        decidedAt: expect.any(Date),
        tvdbId: 461468,
      },
    });
    expect(tvdb.searchShows).toHaveBeenNthCalledWith(1, 'Nekomonogatari Black: Tsubasa Family', 1);
    expect(tvdb.searchShows).toHaveBeenNthCalledWith(2, 'Nekomonogatari Black', 1);
    expect(tmdb.searchShows).not.toHaveBeenCalled();
    expect(m.lightUpsertShow).not.toHaveBeenCalled();
  });

  it('allows extra unwatched episodes for an exact replacement title with the same season range', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = { enabled: false, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async (tvdbId: number) => {
        if (tvdbId === 292309) throw new ProviderError('not_found', 'tvdb 404', 404);
        return {
          title: 'Hanamonogatari',
          originalTitle: '花物語',
          yearStart: 2014,
          genres: [{ tmdbId: 0, name: 'Anime' }],
          seasonsCount: 1,
          seasons: [{ number: 1, episodeCount: 5, isSpecial: false }],
        };
      }),
      searchShows: jest.fn(async () => ({
        items: [
          {
            tvdbId: 461474,
            tmdbId: 0,
            type: MediaType.SHOW,
            title: '花物語',
            aliases: [],
            year: 2014,
          },
        ],
        total: 1,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'hanamonogatari',
      'Hanamonogatari',
      'SHOW',
      2014,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 4 }] },
      null,
      '292309',
    );

    expect(res).toMatchObject({
      mediaId: 'm-tvdb-anime',
      confidence: 0.9,
      matchedTitle: 'Hanamonogatari',
    });
    expect(m.ensureShowFullTvdb).toHaveBeenCalledWith(461474, undefined, expect.any(Object));
  });

  it('uses an exact footprint to recover a shorter legacy anime title to its dedicated TVDB series', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = { enabled: false, findByExternalId: jest.fn(async () => null) };
    const tvdb = deadLegacyAnimeTvdb();
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'nekomonogatari',
      'Nekomonogatari',
      'SHOW',
      2012,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 4 }] },
      null,
      '278308',
    );

    expect(res).toMatchObject({
      mediaId: 'm-tvdb-anime',
      confidence: 0.9,
      matchedTitle: '猫物語（黒）',
    });
    expect(m.ensureShowFullTvdb).toHaveBeenCalledWith(461468, undefined, expect.any(Object));
  });

  it('collapses an explicit legacy OVA collection suffix into one verified TVDB anime series', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = { enabled: false, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async (tvdbId: number) => {
        if (tvdbId === 337493) throw new ProviderError('not_found', 'tvdb 404', 404);
        return {
          title: 'Seitokai Yakuindomo',
          originalTitle: '生徒会役員共',
          yearStart: 2010,
          genres: [{ tmdbId: 0, name: 'Anime' }],
          seasonsCount: 3,
          seasons: [
            { number: 0, episodeCount: 0, isSpecial: true },
            { number: 1, episodeCount: 0, isSpecial: false },
            { number: 2, episodeCount: 0, isSpecial: false },
          ],
          translations: { en: { title: 'Seitokai Yakuindomo' } },
        };
      }),
      getMovie: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      searchShows: jest.fn(async (query: string) => ({
        items:
          query === 'Seitokai Yakuindomo'
            ? [
                {
                  tvdbId: 173271,
                  tmdbId: 36697,
                  type: MediaType.SHOW,
                  title: '生徒会役員共',
                  aliases: ['Seitokai Yakuindomo'],
                  year: 2010,
                },
              ]
            : [],
        total: query === 'Seitokai Yakuindomo' ? 1 : 0,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'seitokai yakuindomo ovas',
      'Seitokai Yakuindomo - OVAS',
      'SHOW',
      null,
      null,
      null,
      '337493',
    );

    expect(res).toMatchObject({ mediaId: 'm-tvdb-anime', confidence: 0.9 });
    expect(m.ensureShowFullTvdb).toHaveBeenCalledWith(173271, undefined, expect.any(Object));
  });

  it('verifies a romanized stale anime title through TMDB alternative titles and structure', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(async () => ({
        items: [
          {
            tmdbId: 67800,
            type: MediaType.SHOW,
            title: "The Ancient Magus' Bride: Those Awaiting a Star",
            originalTitle: '魔法使いの嫁 星待つひと',
            year: 2016,
          },
        ],
        total: 1,
      })),
      getAlternativeTitles: jest.fn(async () => ['Mahou Tsukai no Yome: Hoshi Matsu Hito']),
      getShow: jest.fn(async () => ({
        seasonsCount: 1,
        seasons: [{ number: 1, episodeCount: 3, isSpecial: false }],
      })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'mahou tsukai no yome hoshi matsu hito',
      'Mahou Tsukai no Yome: Hoshi Matsu Hito',
      'SHOW',
      2016,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 2 }] },
      null,
      '317128',
    );

    expect(res).toMatchObject({
      mediaId: 'm-lotm',
      confidence: 0.75,
      matchedTitle: "The Ancient Magus' Bride: Those Awaiting a Star",
    });
    expect(tmdb.getAlternativeTitles).toHaveBeenCalledWith('SHOW', 67800);
  });

  it('reclassifies a one-episode stale show through an exact TMDB alternative title', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 567258,
        title: 'Street Light Stories',
        releaseYear: 2017,
        genreIds: [],
        keywords: [],
        imdbId: null,
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({
        items: [
          {
            tmdbId: 315843,
            type: MediaType.MOVIE,
            title: "Tales of Zestiria: The Shepherd's Advent",
            originalTitle: 'テイルズ オブ ゼスティリア ～導師の夜明け～',
            year: 2014,
          },
        ],
        total: 1,
      })),
      getAlternativeTitles: jest.fn(async () => ['Tales of Zestiria: Doushi no Yoake']),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => ({
        title: 'Street Light Stories',
        releaseYear: 2017,
        externals: [{ provider: ExternalProvider.TMDB, value: '567258' }],
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'tales of zestiria doushi no yoake',
      'Tales of Zestiria: Doushi no Yoake',
      'SHOW',
      2014,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 1 }] },
      null,
      '302177',
    );

    expect(res.reclassifiedMovie).toMatchObject({
      mediaId: 'm-lotm',
      matchedTitle: "Tales of Zestiria: The Shepherd's Advent",
      tmdbId: 315843,
    });
  });

  it('keeps the TV Time Revival translation scoped to a unique stale show-to-movie recovery', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 325118,
        title: 'Kingsland #1: The Dreamer',
        releaseYear: 2008,
        genreIds: [],
        keywords: [],
        imdbId: null,
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async (query: string) => ({
        items: /resurrection/i.test(query)
          ? [
              {
                tmdbId: 553837,
                type: MediaType.MOVIE,
                title: 'Code Geass: Lelouch of the Re;surrection',
                year: 2019,
              },
            ]
          : [],
        total: /resurrection/i.test(query) ? 1 : 0,
      })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => ({
        title: 'Kingsland #1: The Dreamer',
        releaseYear: 2008,
        externals: [{ provider: ExternalProvider.TMDB, value: '325118' }],
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'code geass lelouch of the revival',
      'Code Geass: Lelouch of the Revival',
      'SHOW',
      null,
      null,
      null,
      '325400',
    );

    expect(res.reclassifiedMovie).toMatchObject({ mediaId: 'm-lotm', tmdbId: 553837 });
    expect(tmdb.searchMovies).toHaveBeenCalledWith('Code Geass: Lelouch of the Resurrection', 1);
  });

  it('uses the known TV Time OVA alias only when the unique provider candidate is anime', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async (tmdbId: number) =>
        tmdbId === 470639
          ? {
              tmdbId,
              title: "I'm in Love With My Little Sister",
              releaseYear: 2005,
              genreIds: [16],
              keywords: ['anime', 'original video animation (ova)'],
              imdbId: null,
            }
          : {
              tmdbId,
              title: 'My Sister, My Love',
              releaseYear: 2007,
              genreIds: [18],
              keywords: [],
              imdbId: null,
            },
      ),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async (query: string) => ({
        items:
          query === 'Boku wa Imouto ni Koi wo Suru'
            ? [
                {
                  tmdbId: 80650,
                  type: MediaType.MOVIE,
                  title: 'My Sister, My Love',
                  originalTitle: '僕は妹に恋をする',
                  year: 2007,
                },
                {
                  tmdbId: 470639,
                  type: MediaType.MOVIE,
                  title: "I'm in Love With My Little Sister",
                  originalTitle: '僕は妹に恋をする',
                  year: 2005,
                },
              ]
            : [],
        total: query === 'Boku wa Imouto ni Koi wo Suru' ? 2 : 0,
      })),
      getAlternativeTitles: jest.fn(async (type: string, tmdbId: number) =>
        tmdbId === 470639 ? ['Boku wa Imouto ni Koi wo Suru'] : ['Boku wa imôto ni koi wo suru'],
      ),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => ({
        title: 'Sumesh & Ramesh',
        releaseYear: 2021,
        externals: [{ provider: ExternalProvider.TMDB, value: '736618' }],
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'i love my younger sister',
      'I Love My Younger Sister',
      'SHOW',
      null,
      null,
      null,
      '139391',
    );

    expect(res.reclassifiedMovie).toMatchObject({ mediaId: 'm-lotm', tmdbId: 470639 });
  });

  it('keeps an existing exact local show ahead of a broad TVDB franchise alias', async () => {
    const prisma = fakePrisma({}) as any;
    prisma.mediaItem.findMany = jest.fn(async () => [
      {
        id: 'm-akito',
        title: 'Code Geass: Akito the Exiled',
        popularity: 10,
        show: {
          yearStart: 2012,
          seasonsCount: 1,
          seasons: [{ number: 1, episodeCount: 5, isSpecial: false }],
        },
        movie: null,
      },
    ]);
    const m = meta();
    const tmdb = { enabled: false, findByExternalId: jest.fn(async () => null) };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      searchShows: jest.fn(),
    };
    const matcher = new ImportMatcher(prisma, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'code geass akito the exiled',
      'Code Geass: Akito the Exiled',
      'SHOW',
      null,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 5 }] },
      null,
      '297468',
    );

    expect(res).toEqual({
      mediaId: 'm-akito',
      confidence: 0.9,
      matchedTitle: 'Code Geass: Akito the Exiled',
    });
    expect(tvdb.searchShows).not.toHaveBeenCalled();
    expect(m.ensureShowFullTvdb).not.toHaveBeenCalled();
  });

  it('rejects a broad franchise alias whose full structure exceeds the imported series', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = { enabled: false, findByExternalId: jest.fn(async () => null) };
    const parent = {
      title: 'Code Geass: Lelouch of the Rebellion',
      originalTitle: 'コードギアス 反逆のルルーシュ',
      yearStart: 2006,
      genres: [{ tmdbId: 0, name: 'Anime' }],
      seasonsCount: 3,
      seasons: [
        { number: 1, episodeCount: 25, isSpecial: false },
        { number: 2, episodeCount: 25, isSpecial: false },
        { number: 3, episodeCount: 5, isSpecial: false },
      ],
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async (tvdbId: number) => {
        if (tvdbId === 297468) throw new ProviderError('not_found', 'tvdb 404', 404);
        return parent;
      }),
      searchShows: jest.fn(async () => ({
        items: [
          {
            tvdbId: 79525,
            tmdbId: 0,
            type: MediaType.SHOW,
            title: parent.title,
            aliases: ['Code Geass: Akito the Exiled'],
            year: 2006,
          },
        ],
        total: 1,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'code geass akito the exiled',
      'Code Geass: Akito the Exiled',
      'SHOW',
      null,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 5 }] },
      null,
      '297468',
    );

    expect(res.mediaId).toBeNull();
    expect(m.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(m.lightUpsertShowTvdb).not.toHaveBeenCalled();
  });

  it('stays unresolved when the verified TVDB Anime replacement cannot be hydrated', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    m.ensureShowFullTvdb.mockRejectedValueOnce(new Error('TVDB unavailable'));
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = deadLegacyAnimeTvdb();
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'nekomonogatari black tsubasa family',
      'Nekomonogatari Black: Tsubasa Family',
      'SHOW',
      null,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 4 }] },
      null,
      '273656',
    );

    expect(res.mediaId).toBeNull();
    expect(m.ensureShowFullTvdb).toHaveBeenCalled();
    expect(tmdb.searchShows).not.toHaveBeenCalled();
    expect(m.lightUpsertShow).not.toHaveBeenCalled();
  });

  it('does not use the exception when TVDB does not classify the replacement as Anime', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = deadLegacyAnimeTvdb({ anime: false });
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'nekomonogatari black tsubasa family',
      'Nekomonogatari Black: Tsubasa Family',
      'SHOW',
      null,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 4 }] },
      null,
      '273656',
    );

    expect(res.mediaId).toBeNull();
    expect(m.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(tmdb.searchShows).toHaveBeenCalled();
  });

  it('requires an exact footprint for a descriptive legacy-title extension', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = deadLegacyAnimeTvdb({ episodeCount: 12 });
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'nekomonogatari black tsubasa family',
      'Nekomonogatari Black: Tsubasa Family',
      'SHOW',
      null,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 4 }] },
      null,
      '273656',
    );

    expect(res.mediaId).toBeNull();
    expect(m.ensureShowFullTvdb).not.toHaveBeenCalled();
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

    expect(res).toEqual({ mediaId: null, confidence: 0, matchedTitle: null, dead: true });
  });

  it('reclassifies a legacy show identity when the same-number movie and TMDB both verify it', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 700001,
        title: 'Legacy One-Off',
        releaseYear: 2014,
        genreIds: [16],
        keywords: ['anime'],
        imdbId: 'tt4086432',
      })),
      searchShows: jest.fn(),
    };
    const tvdbMovie = {
      title: 'Legacy One-Off',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      popularity: 1,
      releaseYear: 2014,
      externals: [
        { provider: ExternalProvider.TMDB, value: '700001' },
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
      'legacy one off',
      'Legacy One-Off',
      'SHOW',
      2014,
      undefined,
      null,
      '700002',
    );

    expect(res).toEqual({
      mediaId: null,
      confidence: 0,
      matchedTitle: null,
      reclassifiedMovie: {
        mediaId: 'm-tvdb-movie',
        confidence: 0.95,
        matchedTitle: 'Legacy One-Off',
        tvdbId: 700002,
        tmdbId: 700001,
      },
      allDead: true,
    });
    expect(m.lightUpsertMovieTvdb).toHaveBeenCalledWith(
      expect.objectContaining({ tvdbId: 700002, tmdbId: 700001, year: 2014 }),
    );
    expect(tmdb.searchShows).not.toHaveBeenCalled();

    const externalIdResult = await matcher.matchByExternalIds(
      { tvdb: 700002 },
      'SHOW',
      'Legacy One-Off',
      'legacy one off',
      2014,
      null,
    );
    expect(externalIdResult.reclassifiedMovie).toMatchObject({
      mediaId: 'm-tvdb-movie',
      tmdbId: 700001,
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

  it('treats a reused TVDB number as a namespace collision when the movie title differs', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 325749,
        title: 'Street Light Stories',
        releaseYear: 2017,
        genreIds: [],
        keywords: [],
        imdbId: null,
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => ({
        title: 'Street Light Stories',
        releaseYear: 2017,
        externals: [{ provider: ExternalProvider.TMDB, value: '325749' }],
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
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

  it('recovers a one-episode stale show identity through an exact TVDB movie alias', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async (tmdbId: number) =>
        tmdbId === 378064
          ? {
              tmdbId,
              title: 'A Silent Voice',
              releaseYear: 2016,
              genreIds: [16],
              keywords: ['anime'],
              imdbId: 'tt5323662',
            }
          : {
              tmdbId,
              title: 'Dil Sala Sanki',
              releaseYear: 2016,
              genreIds: [],
              keywords: [],
              imdbId: null,
            },
      ),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async (tvdbId: number) =>
        tvdbId === 894
          ? {
              title: '聲の形',
              releaseYear: 2016,
              externals: [{ provider: ExternalProvider.TMDB, value: '378064' }],
            }
          : {
              title: 'Dil Sala Sanki',
              releaseYear: 2016,
              externals: [{ provider: ExternalProvider.TMDB, value: '400001' }],
            },
      ),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({
        items: [
          {
            tmdbId: 0,
            tvdbId: 894,
            type: MediaType.MOVIE,
            title: '聲の形',
            aliases: ['A Silent Voice'],
            year: 2016,
          },
        ],
        total: 1,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'a silent voice',
      'A Silent Voice',
      'SHOW',
      2016,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 1 }] },
      null,
      '328719',
    );

    expect(res.reclassifiedMovie).toMatchObject({
      mediaId: 'm-tvdb-movie',
      tvdbId: 894,
      tmdbId: 378064,
    });
    expect(m.lightUpsertMovieTvdb).toHaveBeenCalledWith(
      expect.objectContaining({ tvdbId: 894, tmdbId: 378064 }),
    );
    expect(m.lightUpsertMovieTvdb).not.toHaveBeenCalledWith(
      expect.objectContaining({ tvdbId: 328719 }),
    );
  });

  it('does not collapse a multi-episode TV Time group into one movie', async () => {
    const prisma = fakePrisma({});
    const m = meta();
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => null),
      getMovieRoutingProfile: jest.fn(async () => ({
        tmdbId: 490002,
        title: 'Kizumonogatari',
        releaseYear: 2016,
        genreIds: [16],
        keywords: ['anime'],
        imdbId: null,
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => {
        throw new ProviderError('not_found', 'tvdb 404', 404);
      }),
      getMovie: jest.fn(async () => ({
        title: 'Kizumonogatari',
        releaseYear: 2016,
        externals: [{ provider: ExternalProvider.TMDB, value: '490002' }],
      })),
      searchShows: jest.fn(async () => ({ items: [], total: 0 })),
      searchMovies: jest.fn(async () => ({ items: [], total: 0 })),
    };
    const matcher = new ImportMatcher(prisma as any, m as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia(
      'kizumonogatari',
      'Kizumonogatari',
      'SHOW',
      2016,
      { maxSeason: 1, seasonEpisodes: [{ season: 1, maxEpisode: 3 }] },
      null,
      '331670',
    );

    expect(res.reclassifiedMovie).toBeUndefined();
    expect(tvdb.getMovie).not.toHaveBeenCalled();
    expect(m.lightUpsertMovieTvdb).not.toHaveBeenCalled();
    expect(tvdb.searchMovies).not.toHaveBeenCalled();
    expect(tmdb.searchMovies).not.toHaveBeenCalled();
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
    expect(res).toEqual({ mediaId: null, confidence: 0, matchedTitle: null, dead: true });
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

describe('ImportMatcher — numbered TV Time movie groups', () => {
  const movieCandidate = (id: string, title: string, tmdbId: number) => ({
    id,
    title,
    titleAliases: [],
    externalIds: [{ value: String(tmdbId) }],
  });

  const matcherWithMovies = (movies: ReturnType<typeof movieCandidate>[]) => {
    const prisma = fakePrisma({}) as any;
    prisma.mediaItem.findMany = jest.fn(async () => movies);
    return new ImportMatcher(
      prisma,
      {} as any,
      { enabled: false } as any,
      { enabled: false } as any,
    );
  };

  it('maps Psycho-Pass S1E1..E3 to the three Case movies', async () => {
    const matcher = matcherWithMovies([
      movieCandidate(
        'case-1',
        'Psycho-Pass: Sinners of the System Case.1 Crime and Punishment',
        510242,
      ),
      movieCandidate('case-2', 'Psycho-Pass: Sinners of the System Case.2 First Guardian', 559562),
      movieCandidate(
        'case-3',
        'Psycho-Pass: Sinners of the System Case.3 On the Other Side of Love and Hate',
        559566,
      ),
    ]);

    const result = await matcher.matchNumberedMovieGroup('Psycho-Pass: Sinners of the System', [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
      { season: 1, episode: 3 },
    ]);

    expect(result?.axis).toBe('episode');
    expect(result?.moviesByCoordinate.get('1:1')).toMatchObject({
      mediaId: 'case-1',
      tmdbId: 510242,
    });
    expect(result?.moviesByCoordinate.get('1:2')?.mediaId).toBe('case-2');
    expect(result?.moviesByCoordinate.get('1:3')?.mediaId).toBe('case-3');
  });

  it('maps Kizumonogatari S1..S3 episode one to Part 1..Part 3', async () => {
    const matcher = matcherWithMovies([
      movieCandidate('part-1', 'Kizumonogatari Part 1: Tekketsu', 92660),
      movieCandidate('part-2', 'Kizumonogatari Part 2: Nekketsu', 362584),
      movieCandidate('part-3', 'Kizumonogatari Part 3: Reiketsu', 362585),
      movieCandidate('unrelated', 'Kizumonogatari: Koyomi Vamp', 1211760),
    ]);

    const result = await matcher.matchNumberedMovieGroup('Kizumonogatari', [
      { season: 1, episode: 1 },
      { season: 2, episode: 1 },
      { season: 3, episode: 1 },
    ]);

    expect(result?.axis).toBe('season');
    expect(result?.moviesByCoordinate.get('1:1')?.mediaId).toBe('part-1');
    expect(result?.moviesByCoordinate.get('2:1')?.mediaId).toBe('part-2');
    expect(result?.moviesByCoordinate.get('3:1')?.mediaId).toBe('part-3');
  });

  it('fails closed when an ordinal is missing or ambiguous', async () => {
    const missing = matcherWithMovies([
      movieCandidate('case-1', 'Example Case 1', 1),
      movieCandidate('case-3', 'Example Case 3', 3),
    ]);
    await expect(
      missing.matchNumberedMovieGroup('Example', [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
        { season: 1, episode: 3 },
      ]),
    ).resolves.toBeNull();

    const ambiguous = matcherWithMovies([
      movieCandidate('case-1a', 'Example Case 1: A', 1),
      movieCandidate('case-1b', 'Example Case 1: B', 2),
      movieCandidate('case-2', 'Example Case 2', 3),
    ]);
    await expect(
      ambiguous.matchNumberedMovieGroup('Example', [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ]),
    ).resolves.toBeNull();
  });

  it('maps an unnumbered Harry Potter unitary group from archive-proven movies', async () => {
    const titles = [
      ["Harry Potter and the Philosopher's Stone", 2001, 671],
      ['Harry Potter and the Chamber of Secrets', 2002, 672],
      ['Harry Potter and the Prisoner of Azkaban', 2004, 673],
      ['Harry Potter and the Goblet of Fire', 2005, 674],
      ['Harry Potter and the Order of the Phoenix', 2007, 675],
      ['Harry Potter and the Half-Blood Prince', 2009, 767],
      ['Harry Potter and the Deathly Hallows: Part 1', 2010, 12444],
      ['Harry Potter and the Deathly Hallows: Part 2', 2011, 12445],
    ] as const;
    const movies = titles.map(([title, year, tmdbId], index) => ({
      id: `hp-${index + 1}`,
      title,
      normalizedTitle: normTitle(title),
      titleAliases: [],
      movie: { releaseDate: new Date(`${year}-07-01T00:00:00.000Z`), releaseYear: year },
      externalIds: [{ value: String(tmdbId) }],
    }));
    const prisma = fakePrisma({}) as any;
    prisma.mediaItem.findMany = jest.fn(async () => movies);
    const matcher = new ImportMatcher(
      prisma,
      {} as any,
      { enabled: false } as any,
      { enabled: false } as any,
    );

    const result = await matcher.matchUnitaryMovieGroup(
      'Harry Potter',
      Array.from({ length: 8 }, (_, index) => ({ season: index + 1, episode: 1 })),
      movies.map((movie) => movie.id),
      ['351875'],
    );

    expect(result?.axis).toBe('season');
    expect(result?.moviesByCoordinate.get('1:1')).toMatchObject({ mediaId: 'hp-1', tmdbId: 671 });
    expect(result?.moviesByCoordinate.get('8:1')).toMatchObject({
      mediaId: 'hp-8',
      tmdbId: 12445,
    });
  });

  it('fails closed when an unnumbered archive movie sequence is incomplete', async () => {
    const prisma = fakePrisma({}) as any;
    prisma.mediaItem.findMany = jest.fn(async () => [
      {
        id: 'hp-1',
        title: "Harry Potter and the Philosopher's Stone",
        normalizedTitle: 'harry potter and the philosopher s stone',
        titleAliases: [],
        movie: { releaseDate: new Date('2001-11-16T00:00:00.000Z'), releaseYear: 2001 },
        externalIds: [{ value: '671' }],
      },
    ]);
    const matcher = new ImportMatcher(
      prisma,
      {} as any,
      { enabled: false } as any,
      { enabled: false } as any,
    );

    await expect(
      matcher.matchUnitaryMovieGroup(
        'Harry Potter',
        [
          { season: 1, episode: 1 },
          { season: 2, episode: 1 },
        ],
        ['hp-1'],
        ['351875'],
      ),
    ).resolves.toBeNull();
  });

  it('uses exact TVDB episode titles only for an explicitly named movie group', async () => {
    const titles = ['Dragon Ball: Curse of the Blood Rubies', 'Dragon Ball: Sleeping Princess'];
    const movies = titles.map((title, index) => ({
      id: `db-${index + 1}`,
      title,
      normalizedTitle: normTitle(title),
      titleAliases: [],
      movie: { releaseDate: null, releaseYear: 1986 + index },
      externalIds: [{ value: String(100 + index) }],
    }));
    const prisma = fakePrisma({}) as any;
    prisma.mediaItem.findMany = jest.fn(async () => movies);
    const tvdb = {
      enabled: true,
      getShow: jest.fn(async () => ({
        seasons: [
          {
            number: 1,
            episodes: titles.map((title, index) => ({ number: index + 1, title })),
          },
        ],
      })),
    };
    const matcher = new ImportMatcher(prisma, {} as any, { enabled: false } as any, tvdb as any);

    const result = await matcher.matchUnitaryMovieGroup(
      'Dragon Ball Movies',
      [
        { season: 1, episode: 1 },
        { season: 1, episode: 2 },
      ],
      [],
      ['352423'],
    );

    expect(result?.moviesByCoordinate.get('1:1')?.mediaId).toBe('db-1');
    expect(result?.moviesByCoordinate.get('1:2')?.mediaId).toBe('db-2');

    await expect(
      matcher.matchUnitaryMovieGroup(
        'Arrested Development: Fateful Consequences',
        [
          { season: 1, episode: 1 },
          { season: 1, episode: 2 },
        ],
        [],
        ['349062'],
      ),
    ).resolves.toBeNull();
    expect(tvdb.getShow).toHaveBeenCalledTimes(1);
  });

  it('maps the deleted TVDB Dragon Ball Movies group to the exact 13 canonical TMDB films', async () => {
    const tmdbIds = [
      28609, 39100, 39101, 39102, 24752, 39103, 39104, 34433, 39105, 44251, 39106, 39107, 39108,
    ];
    const movies = tmdbIds.map((tmdbId, index) => ({
      id: `dbz-${index + 1}`,
      title: `Dragon Ball Z Movie ${index + 1}`,
      normalizedTitle: `dragon ball z movie ${index + 1}`,
      titleAliases: [],
      movie: { releaseDate: null, releaseYear: 1989 + Math.floor(index / 2) },
      externalIds: [{ value: String(tmdbId) }],
    }));
    const prisma = fakePrisma({}) as any;
    prisma.mediaItem.findMany = jest.fn(async () => movies);
    const tvdb = { enabled: true, getShow: jest.fn() };
    const matcher = new ImportMatcher(prisma, {} as any, { enabled: false } as any, tvdb as any);

    const result = await matcher.matchUnitaryMovieGroup(
      'Dragon Ball Movies',
      Array.from({ length: 13 }, (_, index) => ({ season: 1, episode: index + 1 })),
      [],
      ['352423'],
    );

    expect(result?.axis).toBe('episode');
    expect(result?.moviesByCoordinate.get('1:1')).toMatchObject({
      mediaId: 'dbz-1',
      tmdbId: 28609,
    });
    expect(result?.moviesByCoordinate.get('1:13')).toMatchObject({
      mediaId: 'dbz-13',
      tmdbId: 39108,
    });
    expect(tvdb.getShow).not.toHaveBeenCalled();
  });

  it('fails the legacy Dragon Ball mapping closed when a canonical TMDB film is missing', async () => {
    const prisma = fakePrisma({}) as any;
    prisma.mediaItem.findMany = jest.fn(async () => []);
    const matcher = new ImportMatcher(
      prisma,
      {} as any,
      { enabled: false } as any,
      { enabled: false } as any,
    );

    await expect(
      matcher.matchUnitaryMovieGroup(
        'Dragon Ball Movies',
        Array.from({ length: 13 }, (_, index) => ({ season: 1, episode: index + 1 })),
        [],
        ['352423'],
      ),
    ).resolves.toBeNull();
  });
});
