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

  it('does NOT call TVDB when a confident local DB match already exists (raw id present)', async () => {
    const prisma = fakePrisma({ exactMedia: { id: 'm-local', title: 'Show' } });
    const tvdb = { enabled: true, getShow: jest.fn(), searchShows: jest.fn() };
    const matcher = new ImportMatcher(prisma as any, fakeMeta() as any, fakeTmdb as any, tvdb as any);
    const res = await matcher.matchMedia('show', 'Show', 'SHOW', null, null, null, '999');
    expect(res.mediaId).toBe('m-local');
    expect(tvdb.getShow).not.toHaveBeenCalled();
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
