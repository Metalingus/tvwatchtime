import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { ImportMatcher, needsTvdbRehydration } from './matcher';

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

  it('IMDB id: local mapping wins → 0.9 (no external fetch)', async () => {
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

/** Fake Prisma for the /find matching + episode recovery paths. */
function fakePrismaFind(opts: {
  mediaById?: Record<string, { id: string; title: string }>;
  episodeBySE?: Record<string, { id: string }>;
  episodeCount?: number;
} = {}) {
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
    episode: {
      count: async () => opts.episodeCount ?? 0,
      findFirst: async (args: any) => {
        const key = `${args?.where?.season?.number}:${args?.where?.number}`;
        return opts.episodeBySE?.[key] ?? null;
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
    const meta = { lightUpsertShow: jest.fn(async () => 'm-find'), lightUpsertMovie: jest.fn(), lightUpsertShowTvdb: jest.fn() };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({
        movie: null,
        show: { tmdbId: 1399, genreIds: [18, 10765], originCountries: ['US'] },
        episode: null,
      })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, fakeTvdb as any);
    const res = await matcher.matchMedia('game of thrones', 'Game of Thrones', 'SHOW', 2011, undefined, null, '121361');
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('121361', 'tvdb_id');
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({ tmdbId: 1399, title: 'Game of Thrones', year: 2011 });
    expect(meta.lightUpsertShowTvdb).not.toHaveBeenCalled();
    expect(fakeTvdb.getShow).not.toHaveBeenCalled();
    expect(res).toEqual({ mediaId: 'm-find', confidence: 0.95, matchedTitle: 'Game of Thrones' });
  });

  it('movie: /find hit → light TMDB movie upsert (0.95)', async () => {
    const { prisma } = fakePrismaFind();
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn(async () => 'm-mov'), lightUpsertShowTvdb: jest.fn() };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async () => ({ movie: { tmdbId: 680, genreIds: [12] }, show: null, episode: null })),
    };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, fakeTvdb as any);
    const res = await matcher.matchMedia('pulp fiction', 'Pulp Fiction', 'MOVIE', 1994, undefined, null, '16858');
    expect(meta.lightUpsertMovie).toHaveBeenCalledWith({ tmdbId: 680, title: 'Pulp Fiction', year: 1994 });
    expect(res.mediaId).toBe('m-mov');
    expect(res.confidence).toBe(0.95);
  });

  it('anime show (Animation + JP): TVDB-authoritative record + TVDB-first hydration + TMDB id attached', async () => {
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
    };
    const tvdbShow = { title: 'Naruto', overview: null, posterUrl: null, backdropUrl: null, popularity: 0, yearStart: 2002 };
    const tvdb = { enabled: true, getShow: jest.fn(async () => tvdbShow), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);

    const res = await matcher.matchMedia('naruto', 'Naruto', 'SHOW', 2002, undefined, null, '78857');
    expect(tvdb.getShow).toHaveBeenCalledWith(78857);
    expect(meta.lightUpsertShowTvdb).toHaveBeenCalled();
    expect(meta.lightUpsertShow).not.toHaveBeenCalled();
    expect(res).toEqual({ mediaId: 'm-anime', confidence: 0.9, matchedTitle: 'Naruto' });
    // TMDB id from /find attached for cross-lookups
    expect(state.externalIdCreate).toHaveBeenCalledWith({
      data: { mediaId: 'm-anime', provider: ExternalProvider.TMDB, providerEntityKind: 'SERIES', value: '65930' },
    });
    // providerPref → ensureShowHydrated hydrates from TVDB first
    await matcher.ensureShowHydrated('m-anime');
    expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(80379);
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
  });

  it('/find miss + TVDB enabled → direct TVDB recovery (0.85)', async () => {
    const { prisma } = fakePrismaFind();
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn(), lightUpsertShowTvdb: jest.fn(async () => 'm-tvdb') };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdbShow = { title: 'Show', overview: null, posterUrl: null, backdropUrl: null, popularity: 0, yearStart: 2019 };
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
    const res = await matcher.matchByExternalIds({ imdb: 'tt0206512' }, 'SHOW', 'SpongeBob', 'spongebob', 1999);
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('tt0206512', 'imdb_id');
    expect(res).toEqual({ mediaId: 'm-imdb', confidence: 0.9, matchedTitle: 'SpongeBob' });
  });
});

describe('ImportMatcher — recoverEpisodeByTvdbId (/find recovery)', () => {  it('resolves via TMDB /find season/episode numbers and attaches the TMDB episode id', async () => {
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
    expect(state.episodeExternalIdUpsert).toHaveBeenCalled();
  });

  it('returns null when the /find episode belongs to a different show (TMDB id mismatch)', async () => {
    const { prisma } = fakePrismaFind({ episodeBySE: { '1:9': { id: 'ep-19' } } });
    // media-scoped TMDB lookup returns a DIFFERENT show id than /find's show_id
    (prisma.externalId.findFirst as any) = async (args: any) =>
      args?.where?.mediaId && args?.where?.provider === ExternalProvider.TMDB ? { value: '999' } : null;
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

  it('returns null for empty ids, disabled TMDB, or /find misses', async () => {
    const { prisma } = fakePrismaFind();
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, tmdb as any, {} as any);
    expect(await matcher.recoverEpisodeByTvdbId('m1', null)).toBeNull();
    expect(await matcher.recoverEpisodeByTvdbId('m1', '7968847')).toBeNull();
    const disabled = new ImportMatcher(prisma as any, fakeMeta() as any, { enabled: false } as any, {} as any);
    expect(await disabled.recoverEpisodeByTvdbId('m1', '7968847')).toBeNull();
  });
});

describe('ImportMatcher — multi-id TVDB authority gate (dead sibling ids)', () => {
  it('tries every collected id in order: dead id fails, live id resolves', async () => {
    const { prisma } = fakePrismaFind();
    const meta = { lightUpsertShow: jest.fn(async () => 'm-spartacus'), lightUpsertMovie: jest.fn() };
    const tmdb = {
      enabled: true,
      findByExternalId: jest.fn(async (id: string) =>
        id === '465189'
          ? { movie: null, show: { tmdbId: 240459, genreIds: [18, 10759], originCountries: ['US'] }, episode: null }
          : null, // 442083 is a dead TVDB id — /find returns nothing
      ),
    };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchMedia(
      'spartacus house of ashur', 'Spartacus: House of Ashur', 'SHOW', 2025,
      undefined, null, '442083', ['442083', '465189'],
    );
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('442083', 'tvdb_id');
    expect(tmdb.findByExternalId).toHaveBeenCalledWith('465189', 'tvdb_id');
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({ tmdbId: 240459, title: 'Spartacus: House of Ashur', year: 2025 });
    expect(res).toEqual({ mediaId: 'm-spartacus', confidence: 0.95, matchedTitle: 'Spartacus: House of Ashur' });
  });

  it('refuses title fallback when EVERY collected id fails (even with a DB title match)', async () => {
    const { prisma } = fakePrismaFind();
    (prisma.mediaItem.findFirst as any) = async () => ({ id: 'm-wrong', title: 'Spartacus: House of Ashur' });
    const meta = { lightUpsertShow: jest.fn(), lightUpsertMovie: jest.fn() };
    const tmdb = { enabled: true, findByExternalId: jest.fn(async () => null) };
    const tvdb = { enabled: false, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, meta as any, tmdb as any, tvdb as any);
    const res = await matcher.matchMedia(
      'spartacus house of ashur', 'Spartacus: House of Ashur', 'SHOW', 2025,
      undefined, null, '442083', ['442083', '465189'],
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
    expect(meta.lightUpsertShow).toHaveBeenCalledWith({ tmdbId: 73613, title: 'The Mantis', year: 2017 });
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
    expect(needsTvdbRehydration({ seasonEpisodes: [{ season: 7, maxEpisode: 26 }] }, hydrated(9, { 7: 25 }))).toBe(true);
    expect(needsTvdbRehydration({ seasonEpisodes: [{ season: 1, maxEpisode: 10 }] }, hydrated(2, { 1: 1 }))).toBe(true);
  });

  it('is false when the hydrated structure covers the footprint', () => {
    expect(needsTvdbRehydration({ maxSeason: 4, seasonEpisodes: [{ season: 2, maxEpisode: 13 }] }, hydrated(4, { 2: 13 }))).toBe(false);
    expect(needsTvdbRehydration({ maxSeason: null, seasonEpisodes: null }, hydrated(1, {}))).toBe(false);
  });

  it('ignores specials (S0) even when nothing is hydrated there', () => {
    expect(needsTvdbRehydration({ seasonEpisodes: [{ season: 0, maxEpisode: 5 }] }, hydrated(3, {}))).toBe(false);
  });
});
