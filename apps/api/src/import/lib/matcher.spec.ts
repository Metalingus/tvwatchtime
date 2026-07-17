import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { ImportMatcher } from './matcher';

/** Minimal fake Prisma for the matcher's DB surface. */
function fakePrisma(opts: {
  extByTvdb?: { media: { id: string; title: string } } | null;
  exactMedia?: { id: string; title: string } | null;
  likeMedia?: { id: string; title: string }[];
} = {}) {
  return {
    externalId: {
      findFirst: async (args: any) => {
        if (args?.where?.provider === ExternalProvider.THE_TVDB) return opts.extByTvdb ?? null;
        return null;
      },
    },
    mediaItem: {
      findFirst: async () => opts.exactMedia ?? null,
      findMany: async () => opts.likeMedia ?? [],
    },
    episode: { count: async () => 0, findFirst: async () => null },
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
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, '123');
    expect(res.mediaId).toBe('m1');
    expect(res.confidence).toBeGreaterThanOrEqual(0.9);
    expect(tvdb.getShow).not.toHaveBeenCalled(); // no external call
  });

  it('with raw TVDB id present but no local mapping: refuses title fallback → NEEDS_REVIEW', async () => {
    // A local DB match by title exists, but the raw TVDB ID (999) has no local mapping.
    // Authority gate: TVDB ID present → ONLY TVDB resolution. Title matching is forbidden.
    // Since TVDB is disabled, resolution fails → returns null (NEEDS_REVIEW), NOT the title match.
    const prisma = fakePrisma({ exactMedia: { id: 'm-local', title: 'Show' } });
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, tvdb as any);
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
    const matcher = new ImportMatcher(prisma as any, fakeMeta('m-recovered') as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, '123');
    expect(tvdb.getShow).toHaveBeenCalledWith(123);
    expect(res.mediaId).toBe('m-recovered');
    expect(res.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('returns unmatched (no TVDB call) when there is no raw TVDB id and no match', async () => {
    const prisma = fakePrisma({});
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: async () => ({ items: [], total: 0 }) };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, null);
    expect(res.mediaId).toBeNull();
    expect(tvdb.getShow).not.toHaveBeenCalled();
  });
});

/** Fake Prisma for the Trakt external-id paths (TMDB/TVDB/IMDB + episode external ids). */
function fakePrismaExt(opts: {
  extByTmdb?: { media: { id: string; title: string } } | null;
  extByTvdb?: { media: { id: string; title: string } } | null;
  extByImdb?: { media: { id: string; title: string } } | null;
  epExtByProvider?: Record<string, { episodeId: string } | null>;
} = {}) {
  return {
    externalId: {
      findFirst: async (args: any) => {
        const p = args?.where?.provider;
        if (p === ExternalProvider.TMDB) return opts.extByTmdb ?? null;
        if (p === ExternalProvider.THE_TVDB) return opts.extByTvdb ?? null;
        if (p === ExternalProvider.IMDB) return opts.extByImdb ?? null;
        return null;
      },
    },
    episodeExternalId: {
      findFirst: async (args: any) => opts.epExtByProvider?.[args?.where?.provider] ?? null,
    },
    mediaItem: { findFirst: async () => null, findMany: async () => [] },
    episode: { count: async () => 0, findFirst: async () => null },
    $queryRaw: async () => [] as any[],
  };
}

describe('ImportMatcher — matchByExternalIds (Trakt)', () => {
  it('TMDB id: local TMDB mapping wins without any external call', async () => {
    const prisma = fakePrismaExt({ extByTmdb: { media: { id: 'm-tmdb', title: 'Show' } } });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({ trakt: 1, tmdb: 387, tvdb: 75886, imdb: 'tt1' }, 'SHOW', 'Show', 'show', 1999);
    expect(res).toEqual({ mediaId: 'm-tmdb', confidence: 0.95, matchedTitle: 'Show' });
    expect(meta.lightUpsertShow).not.toHaveBeenCalled();
    expect(tvdb.getShow).not.toHaveBeenCalled();
  });

  it('TMDB id miss + tmdb enabled (SHOW): light-upserts by id (no heavy getShow)', async () => {
    const prisma = fakePrismaExt({});
    const meta = { lightUpsertShow: jest.fn(async () => 'm-new'), lightUpsertMovie: jest.fn() };
    const tmdb = { enabled: true, getShow: jest.fn(), getMovie: jest.fn() };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({ tmdb: 387 }, 'SHOW', 'Show', 'show', 1999);
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({ tmdbId: 387, title: 'Show', year: 1999 });
    expect(tmdb.getShow).not.toHaveBeenCalled(); // shows stay light — hydration happens post-match
    expect(res).toEqual({ mediaId: 'm-new', confidence: 0.95, matchedTitle: 'Show' });
  });

  it('TMDB id miss + tmdb enabled (MOVIE): fetches the movie once, then light-upserts', async () => {
    const prisma = fakePrismaExt({});
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn(async () => 'm-mov') };
    const tmdb = {
      enabled: true,
      getMovie: jest.fn(async () => ({ tmdbId: 6075, title: 'Movie', overview: null, posterUrl: null, backdropUrl: null, rating: 8, popularity: 5, releaseYear: 1993 })),
    };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({ tmdb: 6075 }, 'MOVIE', 'Movie', 'movie', 1993);
    expect(tmdb.getMovie).toHaveBeenCalledWith(6075);
    expect(meta.lightUpsertMovie).toHaveBeenCalled();
    expect(res.mediaId).toBe('m-mov');
    expect(res.confidence).toBe(0.95);
  });

  it('TMDB unusable (disabled) + TVDB id present → TVDB authority gate', async () => {
    const prisma = fakePrismaExt({ extByTvdb: { media: { id: 'm-tvdb', title: 'Show' } } });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({ tmdb: 999, tvdb: 75886 }, 'SHOW', 'Show', 'show', 1999);
    expect(res).toEqual({ mediaId: 'm-tvdb', confidence: 0.95, matchedTitle: 'Show' });
    expect(tvdb.getShow).not.toHaveBeenCalled(); // local TVDB mapping sufficed
  });

  it('IMDB id: local mapping only → 0.9 (no external fetch)', async () => {
    const prisma = fakePrismaExt({ extByImdb: { media: { id: 'm-imdb', title: 'Show' } } });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchByExternalIds({ imdb: 'tt0206512' }, 'SHOW', 'Show', 'show', 1999);
    expect(res).toEqual({ mediaId: 'm-imdb', confidence: 0.9, matchedTitle: 'Show' });
  });

  it('no usable ids → regular title fallback', async () => {
    const prisma = fakePrismaExt({});
    (prisma.mediaItem.findFirst as any) = async () => ({ id: 'm-title', title: 'Show' });
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
    const prisma = fakePrismaExt({ epExtByProvider: { [ExternalProvider.TMDB]: { episodeId: 'ep-1' } } });
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, {} as any);
    const id = await matcher.resolveEpisodeByExternalIds('m1', { tmdb: 1249456, tvdb: 3448811 });
    expect(id).toBe('ep-1');
  });

  it('falls back to the TVDB episode id when TMDB misses', async () => {
    const prisma = fakePrismaExt({
      epExtByProvider: { [ExternalProvider.TMDB]: null, [ExternalProvider.THE_TVDB]: { episodeId: 'ep-2' } },
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
