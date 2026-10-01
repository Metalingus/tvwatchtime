import { ConflictException } from '@nestjs/common';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { MetadataBackfillService } from './metadata-backfill.service';
import { CastDedupService } from './cast-dedup.service';
import { StructureRemapService } from './structure-remap.service';
import { ProviderError } from './providers/shared/provider-errors';
import { ProviderThrottled } from './providers/shared/provider-http';

type FnMap = Record<string, jest.Mock>;

function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function mockPrisma() {
  const p = {
    mediaItem: model(['count', 'findMany', 'findUnique', 'groupBy', 'update']),
    episode: model(['count']),
    externalId: model(['findMany', 'findFirst', 'create', 'deleteMany']),
    show: model(['delete']),
    movie: model(['delete']),
    userEpisodeStatus: model(['count']),
    userMovieStatus: model(['deleteMany']),
    watchHistory: model(['deleteMany']),
    rating: model(['count']),
    reaction: model(['count']),
    characterVote: model(['count']),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(p))),
  } as any;
  // The anime stale-row count is raw SQL ($queryRaw) — distinguish it from other raw
  // queries by shape and answer with the per-test __staleRows value.
  p.__staleRows = 0;
  p.__setStaleRows = (n: number) => {
    p.__staleRows = n;
  };
  p.$queryRaw.mockImplementation((parts: any) => {
    const sql = Array.isArray(parts) ? parts.join(' ') : String(parts ?? '');
    if (sql.includes('hydrateNotFoundAt')) return Promise.resolve([]); // parked prefetch
    if (!sql.includes('metadataProvenance') && sql.includes('episode_external_ids')) {
      return Promise.resolve([{ c: BigInt(p.__staleRows) }]);
    }
    return Promise.resolve([{ c: BigInt(0) }]);
  });
  p.userEpisodeStatus.count.mockResolvedValue(0);
  p.rating.count.mockResolvedValue(0);
  p.reaction.count.mockResolvedValue(0);
  p.characterVote.count.mockResolvedValue(0);
  p.userMovieStatus.deleteMany.mockResolvedValue({ count: 0 });
  p.watchHistory.deleteMany.mockResolvedValue({ count: 0 });
  return p;
}

function mockMeta() {
  return {
    ensureShowFull: jest.fn().mockResolvedValue('m1'),
    ensureShowFullTvdb: jest.fn().mockResolvedValue('m1'),
    refreshTmdbShowSupplements: jest.fn().mockResolvedValue({ refreshed: true, tmdbId: 42 }),
    ensureMovieFull: jest.fn().mockResolvedValue('m1'),
    ensureMovieFullTvdb: jest.fn().mockResolvedValue('m1'),
    scheduleClassification: jest.fn().mockResolvedValue(undefined),
    scheduleStructureEvaluation: jest.fn().mockResolvedValue(undefined),
  } as any;
}

const animeShow = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  title: 'Naruto',
  type: 'SHOW',
  externalIds: [
    { provider: ExternalProvider.TMDB, value: '11', providerEntityKind: 'SERIES' },
    { provider: ExternalProvider.THE_TVDB, value: '789', providerEntityKind: 'SERIES' },
  ],
  show: { yearStart: 2002 },
  ...over,
});

describe('MetadataBackfillService — backfill anime routing (isAnimeMedia)', () => {
  function make(candidate: any) {
    const prisma: any = {
      mediaItem: {
        findMany: jest.fn(async () => [candidate]),
        count: jest.fn(async () => 0),
        // hydrateOne reads the structureProvider stamp before routing.
        findUnique: jest.fn(async () => ({ metadataProvenance: null })),
      },
      episode: { count: jest.fn(async () => 0) },
      $queryRaw: jest.fn(async () => []), // parked prefetch
      $executeRaw: jest.fn(async () => 0),
    };
    const service = new MetadataBackfillService(
      prisma,
      mockMeta(),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CastDedupService(),
    );
    return { service, prisma };
  }

  const candidate = (over: Record<string, any> = {}) => ({
    id: 'm1',
    title: 'Re:Zero',
    type: 'SHOW',
    metadataRefreshedAt: null,
    externalIds: [
      { provider: 'TMDB', value: '65942', providerEntityKind: 'SERIES' },
      { provider: 'THE_TVDB', value: '305089', providerEntityKind: 'SERIES' },
    ],
    genres: [],
    show: { keywords: null },
    movie: null,
    contentClassification: 'GENERAL',
    ...over,
  });

  it('an old ANIME verdict alone cannot select TVDB structure', async () => {
    const { service } = make(candidate({ contentClassification: 'ANIME' }));
    const animeFix = jest
      .spyOn(service as any, 'fixAnimeShowFromTvdb')
      .mockResolvedValue({ fixed: true, remapped: 0 } as any);
    const meta = (service as any).meta;

    await service.backfillBatch(1);

    expect(animeFix).not.toHaveBeenCalled();
    expect(meta.ensureShowFull).toHaveBeenCalledWith(65942);
  });

  it('the anime keyword alone cannot select TVDB structure', async () => {
    const { service } = make(candidate({ show: { keywords: ['anime', 'isekai'] } }));
    const animeFix = jest
      .spyOn(service as any, 'fixAnimeShowFromTvdb')
      .mockResolvedValue({ fixed: true, remapped: 0 } as any);

    await service.backfillBatch(1);

    expect(animeFix).not.toHaveBeenCalled();
    expect((service as any).meta.ensureShowFull).toHaveBeenCalledWith(65942);
  });

  it('Animation plus the anime keyword selects the TVDB repair', async () => {
    const { service } = make(
      candidate({
        show: { keywords: ['anime'], structureProvider: 'TVDB' },
        genres: [{ genre: { slug: 'animation', name: 'Animation' } }],
      }),
    );
    const animeFix = jest
      .spyOn(service as any, 'fixAnimeShowFromTvdb')
      .mockResolvedValue({ fixed: true, remapped: 0 } as any);
    const meta = (service as any).meta;

    await service.backfillBatch(1);

    expect(animeFix).toHaveBeenCalledWith('m1');
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
  });
});

describe('MetadataBackfillService.repairNonEnglishBase', () => {
  function make(candidates: any[], localeAfterRepair = 'en') {
    const prisma: any = {
      mediaItem: {
        findMany: jest.fn(async () => candidates),
        findUnique: jest.fn(async () => ({ titleLocale: localeAfterRepair })),
        update: jest.fn(async () => ({})),
      },
      $queryRaw: jest.fn(async () => candidates.map((c) => ({ id: c.id }))),
      $executeRaw: jest.fn(async () => 0),
    };
    const meta = mockMeta();
    const service = new MetadataBackfillService(
      prisma,
      meta,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CastDedupService(),
    );
    return { service, prisma, meta };
  }

  const row = (over: Record<string, any> = {}) => ({
    id: 'm1',
    title: 'Chirurgové',
    type: 'SHOW',
    externalIds: [{ provider: 'TMDB', value: '1416', providerEntityKind: 'SERIES' }],
    genres: [],
    ...over,
  });

  it('re-hydrates TMDB rows with a forced refresh stamp', async () => {
    const { service, prisma, meta } = make([row()]);
    const res = await service.repairNonEnglishBase();
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { metadataRefreshedAt: null },
    });
    expect(meta.ensureShowFull).toHaveBeenCalledWith(1416);
    expect(res).toEqual(
      expect.objectContaining({ processed: 1, succeeded: 1, failed: 0, sample: ['Chirurgové'] }),
    );
  });

  it('Animation alone remains TMDB-authoritative', async () => {
    const { service, meta } = make([
      row({
        id: 'a1',
        genres: [{ genre: { slug: 'animation', name: 'Animation' } }],
        externalIds: [
          { provider: 'TMDB', value: '1416', providerEntityKind: 'SERIES' },
          { provider: 'THE_TVDB', value: '789', providerEntityKind: 'SERIES' },
        ],
      }),
    ]);
    const animeFix = jest
      .spyOn(service as any, 'fixAnimeShowFromTvdb')
      .mockResolvedValue(undefined as any);

    await service.repairNonEnglishBase();

    expect(meta.ensureShowFull).toHaveBeenCalledWith(1416);
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(animeFix).not.toHaveBeenCalled();
  });

  it('strict Animation plus anime keyword uses the locked anime repair', async () => {
    const { service, meta } = make([
      row({
        id: 'c1',
        contentClassification: 'GENERAL',
        show: {
          keywords: ['anime', 'isekai'],
          structureProvider: 'TVDB',
          structureReason: 'ANIME_TVDB',
        },
        genres: [{ genre: { slug: 'animation', name: 'Animation' } }],
        externalIds: [
          { provider: 'TMDB', value: '1', providerEntityKind: 'SERIES' },
          { provider: 'THE_TVDB', value: '305089', providerEntityKind: 'SERIES' },
        ],
      }),
    ]);
    const animeFix = jest
      .spyOn(service as any, 'fixAnimeShowFromTvdb')
      .mockResolvedValue({ fixed: true, remapped: 0 } as any);

    await service.repairNonEnglishBase();

    expect(animeFix).toHaveBeenCalledWith('c1');
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
  });

  it('falls back to TVDB for TVDB-only rows (movie path for movies)', async () => {
    const { service, meta } = make([
      row({
        id: 'm2',
        title: 'X',
        type: 'MOVIE',
        externalIds: [{ provider: 'THE_TVDB', value: '777', providerEntityKind: 'MOVIE' }],
      }),
      row({ id: 'm3', title: 'NoIds', externalIds: [] }),
    ]);
    const res = await service.repairNonEnglishBase();
    expect(meta.ensureMovieFullTvdb).toHaveBeenCalledWith(777);
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(1); // m3 has nothing to hydrate from
  });

  it('excludes rows that failed this repair in the last 7 days', async () => {
    const { service, prisma } = make([row()]);

    await service.repairNonEnglishBase();

    const [parts] = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    expect(parts.join(' ')).toContain('enBaseRepairFailedAt');
    expect(parts.join(' ')).toContain("INTERVAL '7 days'");
  });

  it('parks a row that is still non-English after the forced re-hydration', async () => {
    const { service, prisma } = make([row()], 'cs');

    const res = await service.repairNonEnglishBase();

    expect(res).toMatchObject({ succeeded: 0, failed: 1 });
    // The failure stamp keeps it out of the next runs instead of re-hydrating it every time.
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('stamps failures so repeated manual runs can advance past them', async () => {
    const { service, prisma } = make([
      row({
        id: 'bad-1',
        externalIds: [{ provider: 'IMDB', value: 'tt123', providerEntityKind: 'MOVIE' }],
      }),
    ]);

    const res = await service.repairNonEnglishBase();

    expect(res.failed).toBe(1);
    const [parts, ...vals] = (prisma.$executeRaw as jest.Mock).mock.calls.find((c) =>
      c[0].join(' ').includes('enBaseRepairFailedAt'),
    );
    expect(parts.join(' ')).toContain('enBaseRepairFailReason');
    expect(vals).toContain('bad-1');
  });
});

describe('MetadataBackfillService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let meta: ReturnType<typeof mockMeta>;
  let redis: any;
  let tmdb: any;
  let tvdb: any;
  let tmdbProvider: any;
  let structureRemap: any;
  let service: MetadataBackfillService;

  beforeEach(() => {
    prisma = mockPrisma();
    meta = mockMeta();
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      delByPattern: jest.fn().mockResolvedValue(0),
      client: { scan: jest.fn().mockResolvedValue(['0', []]), del: jest.fn() },
    };
    tmdb = { enabled: true, get: jest.fn().mockResolvedValue(undefined) };
    tvdb = { enabled: true, searchShows: jest.fn() };
    tmdbProvider = { getTvdbIdForShow: jest.fn().mockResolvedValue(null) };
    structureRemap = {
      remapShow: jest.fn().mockResolvedValue({ stale: 0, mapped: 0, unmapped: 0 }),
    };
    service = new MetadataBackfillService(
      prisma,
      meta,
      {} as any,
      redis,
      tmdb,
      tvdb,
      tmdbProvider,
      structureRemap,
      new CastDedupService(),
    );
  });

  describe('rehydrateAnimeFromTvdb', () => {
    /** Candidates for the batch: raw selection + findUnique (fix reload) + ≥1 stale row. */
    const mockCandidates = (list: any[]) => {
      prisma.__setStaleRows(1);
      prisma.$queryRaw.mockImplementation((parts: any) => {
        const sql = Array.isArray(parts) ? parts.join(' ') : String(parts ?? '');
        if (!sql.includes('metadataProvenance') && sql.includes('episode_external_ids')) {
          return Promise.resolve([{ c: BigInt(prisma.__staleRows) }]);
        }
        return Promise.resolve(list);
      });
      prisma.mediaItem.findUnique.mockImplementation(({ where: { id } }: any) =>
        Promise.resolve(list.find((c) => c.id === id) ?? null),
      );
    };

    it('does nothing when TVDB is not configured', async () => {
      tvdb.enabled = false;
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.processed).toBe(0);
      expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('rehydrates TMDB-structured animation shows from their stored TVDB id', async () => {
      mockCandidates([animeShow()]);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(
        789,
        undefined,
        expect.objectContaining({ forceRefresh: true, writeScope: 'STRUCTURE_REMAP' }),
      );
      expect(res).toMatchObject({
        processed: 1,
        succeeded: 1,
        failed: 0,
        rateLimited: 0,
        noTvdbId: 0,
      });
    });

    it('resolves a missing TVDB id through corroborated WatchForge evidence, never a title search', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      (service as any).reconciler = {
        resolveProviderIdentity: jest.fn().mockResolvedValue({
          status: 'verified',
          anchorVerified: true,
          externals: [
            { provider: ExternalProvider.THE_TVDB, providerEntityKind: 'SERIES', value: '555' },
          ],
        }),
      };
      prisma.externalId.findFirst.mockResolvedValue(null);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(prisma.externalId.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaId: 'm1',
          provider: ExternalProvider.THE_TVDB,
          value: '555',
        }),
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(
        555,
        undefined,
        expect.objectContaining({ forceRefresh: true, writeScope: 'STRUCTURE_REMAP' }),
      );
      expect(res.succeeded).toBe(1);
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect((service as any).reconciler.resolveProviderIdentity).toHaveBeenCalledWith(
        { provider: 'tmdb', id: '11', mediaType: 'tv' },
        { lane: 'repair' },
      );
    });

    it('rejects search hits whose title or year does not match', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tvdb.searchShows.mockResolvedValue({
        items: [
          { tvdbId: 555, title: 'Naruto', year: 1990 }, // year mismatch
          { tvdbId: 556, title: 'Naruto Shippuden', year: 2002 }, // title mismatch
        ],
        total: 2,
      });
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.noTvdbId).toBe(1);
      expect(prisma.externalId.create).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('never hijacks a TVDB id already linked to a different media row', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      (service as any).reconciler = {
        resolveProviderIdentity: jest.fn().mockResolvedValue({
          status: 'verified',
          anchorVerified: true,
          externals: [
            { provider: ExternalProvider.THE_TVDB, providerEntityKind: 'SERIES', value: '555' },
          ],
        }),
      };
      prisma.externalId.findFirst.mockResolvedValue({ mediaId: 'someone-else' });
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.noTvdbId).toBe(0);
      expect(res.identityCollisions).toBe(1);
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
      expect(
        prisma.$executeRaw.mock.calls.some((call: any[]) =>
          call[0].join(' ').includes('tvdbIdentityCollision'),
        ),
      ).toBe(true);
      expect(prisma.externalId.create).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('resolves a missing TVDB id via TMDB /external_ids before any title search', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '65942' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(305089);
      prisma.externalId.findFirst.mockResolvedValue(null);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(tmdbProvider.getTvdbIdForShow).toHaveBeenCalledWith(65942);
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(prisma.externalId.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaId: 'm1',
          provider: ExternalProvider.THE_TVDB,
          value: '305089',
        }),
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(
        305089,
        undefined,
        expect.objectContaining({ forceRefresh: true, writeScope: 'STRUCTURE_REMAP' }),
      );
      expect(res.succeeded).toBe(1);
    });

    it('never title-searches TVDB when neither TMDB nor WatchForge supplies the id', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(null);
      tvdb.searchShows.mockResolvedValue({
        items: [{ tvdbId: 555, title: 'Naruto', year: 2002 }],
        total: 1,
      });
      (service as any).reconciler = {
        resolveProviderIdentity: jest.fn().mockResolvedValue({ status: 'unmapped' }),
      };
      prisma.externalId.findFirst.mockResolvedValue(null);
      const res = await service.rehydrateAnimeFromTvdb();
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(res.noTvdbId).toBe(1);
    });

    it('retries later instead of stamping no-TVDB-id when WatchForge is deferred', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(null);
      (service as any).reconciler = {
        resolveProviderIdentity: jest
          .fn()
          .mockResolvedValue({ status: 'deferred', reason: 'quota' }),
      };
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res.noTvdbId).toBe(0);
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('skips the show when TMDB’s tvdb_id is claimed by another media row (duplicate)', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(305089);
      prisma.externalId.findFirst.mockResolvedValue({ mediaId: 'the-real-rezero' });
      const res = await service.rehydrateAnimeFromTvdb();
      // Never title-search past TMDB's authoritative id — would merge structures.
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(res.noTvdbId).toBe(0);
      expect(res.identityCollisions).toBe(1);
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('ignores movie-kind aliases when resolving a show structure identity', async () => {
      mockCandidates([
        animeShow({
          externalIds: [
            {
              provider: ExternalProvider.TMDB,
              providerEntityKind: ProviderEntityKind.SERIES,
              value: '11',
            },
            {
              provider: ExternalProvider.THE_TVDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: '555',
            },
          ],
        }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(305089);
      prisma.externalId.findFirst.mockResolvedValue(null);
      const result = await service.rehydrateAnimeFromTvdb();
      expect(result.succeeded).toBe(1);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(305089, undefined, expect.any(Object));
    });

    it('records a concurrent alias claimant as a collision rather than provider absence', async () => {
      mockCandidates([
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      ]);
      tmdbProvider.getTvdbIdForShow.mockResolvedValue(305089);
      prisma.externalId.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ mediaId: 'winner' });
      prisma.externalId.create.mockRejectedValue({ code: 'P2002' });
      const result = await service.rehydrateAnimeFromTvdb();
      expect(result).toMatchObject({ identityCollisions: 1, noTvdbId: 0, failed: 0 });
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    });

    it('remaps stale TMDB episode rows onto the TVDB structure after a fix', async () => {
      mockCandidates([animeShow()]);
      structureRemap.remapShow.mockResolvedValue({ stale: 52, mapped: 50, unmapped: 2 });
      const res = await service.rehydrateAnimeFromTvdb();
      expect(structureRemap.remapShow).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      expect(res.remapped).toBe(50);
    });

    it('short-circuits without provider calls when no stale rows remain', async () => {
      mockCandidates([animeShow()]);
      prisma.__setStaleRows(0); // already fully TVDB-structured
      const res = await service.rehydrateAnimeFromTvdb();
      expect(tmdbProvider.getTvdbIdForShow).not.toHaveBeenCalled();
      expect(tvdb.searchShows).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(res.succeeded).toBe(0);
      expect(res.noTvdbId).toBe(1); // counted as not-fixed
    });

    it('stops the batch early on a real TVDB 429', async () => {
      mockCandidates([animeShow(), animeShow({ id: 'm2', title: 'Bleach' })]);
      meta.ensureShowFullTvdb.mockRejectedValue(
        new ProviderError('rate_limited', '429', 429, 5000),
      );
      const res = await service.rehydrateAnimeFromTvdb();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1); // second show never attempted
      expect(res).toMatchObject({ processed: 2, succeeded: 0, failed: 0, rateLimited: 1 });
    });

    it('stops the batch early on internal throttling', async () => {
      mockCandidates([animeShow(), animeShow({ id: 'm2', title: 'Bleach' })]);
      meta.ensureShowFullTvdb.mockRejectedValue(new ProviderThrottled('tvdb', 1000));
      const res = await service.rehydrateAnimeFromTvdb();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1);
      expect(res.rateLimited).toBe(1);
    });

    it('counts ordinary failures and continues', async () => {
      mockCandidates([animeShow(), animeShow({ id: 'm2', title: 'Bleach' })]);
      meta.ensureShowFullTvdb.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('m2');
      const res = await service.rehydrateAnimeFromTvdb();
      expect(res).toMatchObject({ processed: 2, succeeded: 1, failed: 1, rateLimited: 0 });
    });
  });

  describe('fixAnimeShowFromTvdb', () => {
    it('forces TVDB hydration and remaps when stale rows exist', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(animeShow());
      prisma.__setStaleRows(52);
      structureRemap.remapShow.mockResolvedValue({ stale: 52, mapped: 50, unmapped: 2 });
      const res = await service.fixAnimeShowFromTvdb('m1');
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(
        789,
        undefined,
        expect.objectContaining({ forceRefresh: true, writeScope: 'STRUCTURE_REMAP' }),
      );
      expect(structureRemap.remapShow).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      // The typed Show fields are stamped by StructureRemapService; JSON remains only
      // as a temporary compatibility marker during rollout.
      expect(prisma.mediaItem.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: {
          metadataProvenance: {
            animeTvdbRemapVersion: StructureRemapService.MATCHER_VERSION,
            structureProvider: 'tvdb',
            structureRemapVersion: StructureRemapService.MATCHER_VERSION,
          },
        },
      });
      expect(res).toMatchObject({ fixed: true, remapped: 50, report: { mapped: 50 } });
    });

    it('returns fixed=false when the TVDB id cannot be resolved', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(
        animeShow({ externalIds: [{ provider: ExternalProvider.TMDB, value: '11' }] }),
      );
      prisma.__setStaleRows(1);
      tvdb.searchShows.mockResolvedValue({ items: [], total: 0 });
      const res = await service.fixAnimeShowFromTvdb('m1');
      expect(res.fixed).toBe(false);
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
      expect(structureRemap.remapShow).not.toHaveBeenCalled();
    });

    it('coalesces concurrent repairs for the same show (detail + episodes race)', async () => {
      prisma.mediaItem.findUnique.mockResolvedValue(animeShow());
      prisma.__setStaleRows(52);
      let release!: (v: string) => void;
      meta.ensureShowFullTvdb.mockImplementation(
        () =>
          new Promise<string>((r) => {
            release = r;
          }),
      );
      const p1 = service.fixAnimeShowFromTvdb('m1');
      const p2 = service.fixAnimeShowFromTvdb('m1');
      // Let the shared repair reach the (pending) TVDB hydration before releasing it.
      await new Promise((r) => setImmediate(r));
      release('m1');
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1); // one shared repair
      expect(r1.fixed).toBe(true);
      expect(r2.fixed).toBe(true);
      // After completion the next call is free to repair again if needed.
      prisma.__setStaleRows(0);
      const r3 = await service.fixAnimeShowFromTvdb('m1');
      expect(r3.fixed).toBe(false);
    });
  });

  describe('backfillBatch (hydrateOne)', () => {
    it('hydrates strict anime shows from TVDB even without existing structure', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        {
          ...animeShow(),
          show: { yearStart: 2002, keywords: ['anime'], structureProvider: 'TVDB' },
          genres: [{ genre: { slug: 'animation', name: 'Animation' } }],
        },
      ]);
      prisma.__setStaleRows(0); // no existing structure → would normally go TMDB
      await service.backfillBatch(10);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(789);
      expect(meta.ensureShowFull).not.toHaveBeenCalled();
    });

    it('still hydrates non-animation stubs from TMDB', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        {
          id: 'm9',
          title: 'House',
          type: 'SHOW',
          externalIds: [
            { provider: ExternalProvider.TMDB, value: '11', providerEntityKind: 'SERIES' },
          ],
          genres: [{ genre: { slug: 'drama', name: 'Drama' } }],
        },
      ]);
      prisma.__setStaleRows(0);
      await service.backfillBatch(10);
      expect(meta.ensureShowFull).toHaveBeenCalledWith(11);
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('parks stubs whose provider id is dead (404) and excludes parked rows from candidates', async () => {
      prisma.mediaItem.findMany.mockResolvedValue([
        {
          id: 'm9',
          title: 'House',
          type: 'SHOW',
          externalIds: [
            { provider: ExternalProvider.TMDB, value: '11', providerEntityKind: 'SERIES' },
          ],
          genres: [],
        },
      ]);
      prisma.__setStaleRows(0);
      meta.ensureShowFull.mockRejectedValueOnce(new ProviderError('not_found', 'tmdb 404', 404));
      const res = await service.backfillBatch(10);
      expect(res).toMatchObject({ succeeded: 0, failed: 0, parked: 1 });
      expect(prisma.$executeRaw).toHaveBeenCalled();
      // Candidate selection excludes rows parked in the last 90 days.
      const where = prisma.mediaItem.findMany.mock.calls[0][0].where;
      expect(where).toHaveProperty('id.notIn');
      const prefetchSql = (prisma.$queryRaw as jest.Mock).mock.calls
        .map((c) => (Array.isArray(c[0]) ? c[0].join(' ') : String(c[0] ?? '')))
        .find((s) => s.includes('hydrateNotFoundAt'));
      expect(prefetchSql).toBeTruthy();
    });
  });

  describe('refreshTrackedTvdbSchedules', () => {
    it('pins refreshes to TVDB authority', async () => {
      redis.client.set = jest.fn().mockResolvedValue('OK');
      redis.client.eval = jest.fn().mockResolvedValue(1);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'tvdb-show-1',
          title: 'Tracked Show',
          tvdb_id: '101',
          metadata_refreshed_at: new Date('2026-08-11'),
          structure_reason: 'GENERAL_TVDB',
          structure_rule_version: 2,
          structure_decided_at: new Date('2026-08-01'),
        },
      ]);
      prisma.mediaItem.findUnique.mockResolvedValueOnce({ metadataRefreshedAt: new Date() });
      const result = await service.refreshTrackedTvdbSchedules(25);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(
        101,
        undefined,
        expect.objectContaining({
          forceRefresh: true,
          bypassProviderCache: true,
          skipTmdbSupplements: true,
          decision: expect.objectContaining({ provider: 'TVDB', tvdbId: 101 }),
        }),
      );
      expect(meta.ensureShowFull).not.toHaveBeenCalled();
      expect(redis.client.eval).toHaveBeenCalled();
      const sql = prisma.$queryRaw.mock.calls[0][0].join(' ');
      expect(sql).toContain('AS tvdb_id');
      expect(sql).toContain('structure_provider::text');
      expect(result).toMatchObject({ selected: 1, processed: 1, refreshed: 1 });
    });

    it('does not overlap another TVDB schedule refresh', async () => {
      redis.client.set = jest.fn().mockResolvedValue(null);

      const result = await service.refreshTrackedTvdbSchedules(25);

      expect(result).toMatchObject({ locked: true, processed: 0 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    });

    it('defers provider structural conflicts to structure evaluation', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'tvdb-show-2',
          title: 'Changed Show',
          tvdb_id: '202',
          metadata_refreshed_at: new Date('2026-08-11'),
          structure_reason: 'GENERAL_TVDB',
          structure_rule_version: 2,
          structure_decided_at: new Date('2026-08-01'),
        },
      ]);
      meta.ensureShowFullTvdb.mockRejectedValueOnce(
        new Error('syncSeasons: canonical coordinate changed'),
      );

      const result = await service.refreshTrackedTvdbSchedules(25);

      expect(meta.scheduleStructureEvaluation).toHaveBeenCalledWith('tvdb-show-2');
      expect(result).toMatchObject({ processed: 1, deferred: 1, failed: 0 });
    });
  });

  describe('syncTmdbChanges', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

    it('refreshes only TMDB supplemental fields for shows structurally owned by TVDB', async () => {
      redis.get.mockResolvedValue(daysAgo(2).toISOString()); // one window
      tmdb.get.mockImplementation((path: string) =>
        Promise.resolve(
          path === '/tv/changes'
            ? { results: [{ id: 42 }], total_pages: 1 }
            : { results: [], total_pages: 1 },
        ),
      );
      prisma.externalId.findMany.mockResolvedValue([
        {
          mediaId: 'm1',
          value: '42',
          media: { type: 'SHOW', externalIds: [], show: { structureProvider: 'TVDB' } },
        },
        {
          mediaId: 'm2',
          value: '42',
          media: { type: 'SHOW', externalIds: [], show: { structureProvider: 'TMDB' } },
        },
      ]);
      const res = await service.syncTmdbChanges();
      expect(prisma.externalId.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ providerEntityKind: ProviderEntityKind.SERIES }),
        }),
      );
      expect(redis.delByPattern).toHaveBeenNthCalledWith(1, 'PC:tmdb:*');
      expect(redis.delByPattern).toHaveBeenNthCalledWith(2, 'NC:tmdb:*');
      expect(meta.refreshTmdbShowSupplements).toHaveBeenCalledTimes(1);
      expect(meta.refreshTmdbShowSupplements).toHaveBeenCalledWith('m1', { force: true });
      expect(meta.ensureShowFull).toHaveBeenCalledTimes(1);
      expect(meta.ensureShowFull).toHaveBeenCalledWith(42);
      expect(res).toMatchObject({ matched: 2, hydrated: 2, skippedAnime: 1 });
    });

    it('keeps TMDB TV and movie id namespaces separate', async () => {
      tmdb.get.mockImplementation((path: string) =>
        Promise.resolve(
          path === '/tv/changes'
            ? { results: [{ id: 42 }], total_pages: 1 }
            : { results: [], total_pages: 1 },
        ),
      );
      prisma.externalId.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.providerEntityKind === ProviderEntityKind.SERIES
            ? [
                {
                  mediaId: 'show-42',
                  value: '42',
                  media: {
                    type: 'SHOW',
                    externalIds: [],
                    show: { structureProvider: 'TMDB' },
                  },
                },
              ]
            : [
                {
                  mediaId: 'movie-42',
                  value: '42',
                  media: { type: 'MOVIE', externalIds: [], show: null },
                },
              ],
        ),
      );

      const result = await service.syncTmdbChanges(daysAgo(3).toISOString().slice(0, 10));

      expect(prisma.externalId.findMany).toHaveBeenCalledTimes(1);
      expect(meta.ensureShowFull).toHaveBeenCalledWith(42);
      expect(meta.ensureMovieFull).not.toHaveBeenCalled();
      expect(result.matched).toBe(1);
    });

    it('does not hydrate or advance the cursor when TMDB cache invalidation fails', async () => {
      tmdb.get.mockImplementation((path: string) =>
        Promise.resolve(
          path === '/tv/changes'
            ? { results: [{ id: 42 }], total_pages: 1 }
            : { results: [], total_pages: 1 },
        ),
      );
      prisma.externalId.findMany.mockResolvedValue([
        {
          mediaId: 'show-42',
          value: '42',
          media: { type: 'SHOW', externalIds: [], show: { structureProvider: 'TMDB' } },
        },
      ]);
      redis.delByPattern.mockRejectedValueOnce(new Error('Redis unavailable'));

      await expect(service.syncTmdbChanges()).rejects.toThrow('Redis unavailable');

      expect(meta.ensureShowFull).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalledWith(
        'TMDB_CHANGES_LAST_RUN',
        expect.anything(),
        expect.anything(),
      );
    });

    it('uses the custom start date for one-off runs without moving the Redis cursor', async () => {
      const calls: any[] = [];
      tmdb.get.mockImplementation((path: string, params: any) => {
        calls.push({ path, params });
        return Promise.resolve({ results: [], total_pages: 1 });
      });
      redis.get.mockResolvedValue('2026-07-18T00:00:00.000Z'); // stored cursor (ignored for custom)

      await service.syncTmdbChanges('2026-07-01');

      const tvCall = calls.find((c) => c.path === '/tv/changes');
      expect(tvCall.params).toMatchObject({ start_date: '2026-07-01' });
      // The daily progression is never disturbed by one-off backfills.
      expect(redis.set).not.toHaveBeenCalledWith(
        'TMDB_CHANGES_LAST_RUN',
        expect.anything(),
        expect.anything(),
      );
    });

    it('stores the cursor for normal (non-custom) runs without a short expiry', async () => {
      tmdb.get.mockResolvedValue({ results: [], total_pages: 1 });
      await service.syncTmdbChanges();
      // It used to expire after 30 days, silently skipping changes after a long outage.
      expect(redis.set).toHaveBeenCalledWith(
        'TMDB_CHANGES_LAST_RUN',
        expect.any(String),
        10 * 365 * 24 * 60 * 60,
      );
    });

    it('replays a gap longer than TMDB’s 14-day limit window by window, advancing the cursor', async () => {
      const ranges: Array<{ start: string; end: string }> = [];
      tmdb.get.mockImplementation((path: string, params: any) => {
        if (path === '/tv/changes') ranges.push({ start: params.start_date, end: params.end_date });
        return Promise.resolve({ results: [], total_pages: 1 });
      });
      redis.get.mockResolvedValue(daysAgo(30).toISOString());

      const result = await service.syncTmdbChanges();

      expect(result.windows).toBe(3);
      expect(ranges).toHaveLength(3);
      for (const range of ranges) {
        const days = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000;
        expect(days).toBeLessThanOrEqual(14);
      }
      const cursorWrites = (redis.set as jest.Mock).mock.calls.filter(
        ([key]) => key === 'TMDB_CHANGES_LAST_RUN',
      );
      expect(cursorWrites).toHaveLength(3);
    });
  });

  describe('backfillCharacterIds', () => {
    it('rehydrates shows whose cast lacks characterExternalId (one TVDB call per show)', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 'm1', title: 'The Office', tvdb_id: '73255' },
        { id: 'm2', title: 'Broadchurch', tvdb_id: '73996' },
      ]);
      const res = await service.backfillCharacterIds();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(2);
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(73255, undefined, {
        skipClassification: true,
        forceRefresh: true,
        writeScope: 'CAST_ONLY',
      });
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(73996, undefined, {
        skipClassification: true,
        forceRefresh: true,
        writeScope: 'CAST_ONLY',
      });
      expect(res).toMatchObject({ processed: 2, succeeded: 2, failed: 0, rateLimited: 0 });
    });

    it('stops early on TVDB rate limits', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 'm1', title: 'The Office', tvdb_id: '73255' },
        { id: 'm2', title: 'Broadchurch', tvdb_id: '73996' },
      ]);
      meta.ensureShowFullTvdb.mockRejectedValue(new ProviderThrottled('tvdb', 1000));
      const res = await service.backfillCharacterIds();
      expect(meta.ensureShowFullTvdb).toHaveBeenCalledTimes(1);
      expect(res.rateLimited).toBe(1);
    });

    it('parks shows whose TVDB series id is dead (404) for 90 days', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { id: 'm1', title: 'The Office', tvdb_id: '73255' },
        { id: 'm2', title: 'Broadchurch', tvdb_id: '73996' },
      ]);
      meta.ensureShowFullTvdb.mockRejectedValueOnce(
        new ProviderError('not_found', 'tvdb 404', 404),
      );
      const res = await service.backfillCharacterIds();
      expect(res).toMatchObject({ succeeded: 1, failed: 0, rateLimited: 0, parked: 1 });
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('does nothing when TVDB is not configured', async () => {
      tvdb.enabled = false;
      const res = await service.backfillCharacterIds();
      expect(res.processed).toBe(0);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});

describe('MetadataBackfillService — recommendations backfill', () => {
  function make(opts: {
    candidates?: any[];
    componentLinks?: any[];
    enabled?: boolean;
    providerImpl?: (id: number) => Promise<any[]>;
  }) {
    const prisma: any = {
      mediaItem: {
        count: jest.fn(async () => 0),
        groupBy: jest.fn(async () => []),
        update: jest.fn(async () => ({})),
      },
      mediaCanonicalLink: {
        findMany: jest.fn(async () => opts.componentLinks ?? []),
      },
      $queryRaw: jest.fn(async () => opts.candidates ?? []),
      $executeRaw: jest.fn(async () => 0),
    };
    const redis: any = { get: jest.fn(async () => null) };
    const tmdbProvider: any = {
      enabled: opts.enabled ?? true,
      getShowRecommendations: jest.fn(opts.providerImpl ?? (async () => [])),
      getMovieRecommendations: jest.fn(opts.providerImpl ?? (async () => [])),
    };
    const service = new MetadataBackfillService(
      prisma,
      {} as any,
      {} as any,
      redis,
      {} as any,
      {} as any,
      tmdbProvider,
      {} as any,
      new CastDedupService(),
    );
    return { service, prisma, tmdbProvider };
  }

  const candidate = (over: Record<string, unknown> = {}) => ({
    id: 'm1',
    title: 'The Office',
    type: 'SHOW',
    tmdb: '2316',
    ...over,
  });

  it('health stat selects rows with a TMDB id and recommendations_synced_at IS NULL', async () => {
    const { service, prisma } = make({});
    const stats = await service.getHealthStats();
    expect(stats).toMatchObject({ recommendationsMissing: 0 });
    const sqls = (prisma.$queryRaw as jest.Mock).mock.calls.map((c) =>
      (Array.isArray(c[0]) ? c[0].join(' ') : String(c[0] ?? '')).replace(/\s+/g, ' '),
    );
    expect(
      sqls.some(
        (s) => s.includes('recommendations_synced_at IS NULL') && s.includes("e.provider = 'TMDB'"),
      ),
    ).toBe(true);
    expect(sqls.some((s) => s.includes('media_canonical_links'))).toBe(true);
  });

  it('counts anime structure contamination and missing TVDB identity in one EXISTS query', async () => {
    const { service, prisma } = make({});

    await service.getHealthStats();

    const sqls = (prisma.$queryRaw as jest.Mock).mock.calls
      .map((c) => (Array.isArray(c[0]) ? c[0].join(' ') : String(c[0] ?? '')).replace(/\s+/g, ' '))
      .filter((sql) => sql.includes('WITH contaminated AS MATERIALIZED'));
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('count(*) FILTER (WHERE missing_tvdb AND NOT duplicate)');
    // TVDB ids owned by another row are duplicates for identity maintenance, counted apart.
    expect(sqls[0]).toContain('count(*) FILTER (WHERE duplicate)');
    expect(sqls[0]).toContain('AND EXISTS (');
    expect(sqls[0]).not.toContain('count(DISTINCT e.id)');
  });

  it('derives the dashboard dual-structure count from the repair selector', async () => {
    const { service } = make({});
    const selector = jest.spyOn(service as any, 'countDualStructureShows').mockResolvedValue(2);

    const stats = await service.getHealthStats();

    expect(selector).toHaveBeenCalledTimes(1);
    expect(stats.dualStructureShows).toBe(2);
  });

  it('keeps the dual-structure metric separate from the authority reevaluation queue', async () => {
    const { service, prisma } = make({});

    await (service as any).countDualStructureShows();

    const query = (prisma.$queryRaw as jest.Mock).mock.calls.at(-1)?.[0] as
      { strings?: readonly string[] } | undefined;
    const sql = query?.strings?.join(' ') ?? '';
    expect(sql).toContain('FROM structural_candidates');
    expect(sql).not.toContain('FROM candidates');
  });

  it('returns a short refreshing response instead of blocking a cold admin request', async () => {
    const { service } = make({});
    jest.spyOn(service as any, 'startHealthStatsRefresh').mockImplementation(() => undefined);

    const response = await service.getHealthStats(false, false, { backgroundOnMiss: true });

    expect(response).toEqual({
      _health: { status: 'refreshing', stale: false, computedAt: null },
    });
    expect((service as any).startHealthStatsRefresh).toHaveBeenCalledTimes(1);
  });

  it('serves the last snapshot immediately while a production refresh runs', async () => {
    const { service } = make({});
    const computedAt = '2026-08-02T12:00:00.000Z';
    (service as any).redis.get.mockImplementation(async (key: string) =>
      key.endsWith(':snapshot') ? { computedAt, stats: { total: 42 } } : null,
    );
    jest.spyOn(service as any, 'startHealthStatsRefresh').mockImplementation(() => undefined);

    const response = await service.getHealthStats(false, false, { backgroundOnMiss: true });

    expect(response).toEqual({
      total: 42,
      _health: { status: 'refreshing', stale: true, computedAt },
    });
  });

  it('repair selection SQL mirrors the stat (null stamp + TMDB id), writes snapshot + stamp', async () => {
    const recs = [{ tmdbId: 5, type: 'SHOW', title: 'Parks and Recreation' }];
    const { service, prisma, tmdbProvider } = make({
      candidates: [candidate()],
      providerImpl: async () => recs,
    });

    const res = await service.repairRecommendations(100);

    const [parts] = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    const sql = parts.join(' ');
    expect(sql).toContain('recommendations_synced_at IS NULL');
    expect(tmdbProvider.getShowRecommendations).toHaveBeenCalledWith(2316);
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { recommendations: recs, recommendationsSyncedAt: expect.any(Date) },
    });
    expect(res).toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      parked: 0,
      sample: ['The Office'],
    });
  });

  it('movies use the movie endpoint; empty provider results still stamp the row', async () => {
    const { service, prisma, tmdbProvider } = make({
      candidates: [candidate({ type: 'MOVIE', tmdb: '550' })],
      providerImpl: async () => [],
    });

    const res = await service.repairRecommendations(100);

    expect(tmdbProvider.getMovieRecommendations).toHaveBeenCalledWith(550);
    expect(tmdbProvider.getShowRecommendations).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { recommendations: [], recommendationsSyncedAt: expect.any(Date) },
    });
    expect(res.succeeded).toBe(1);
  });

  it('merges verified TMDB component recommendations for a TVDB canonical root', async () => {
    const { service, prisma, tmdbProvider } = make({
      candidates: [candidate({ id: 'monster', title: 'Monster (2022)', tmdb: null })],
      componentLinks: [
        {
          relation: 'EXACT_DUPLICATE',
          source: { recommendations: null, externalIds: [{ value: '329491' }] },
        },
        {
          relation: 'SEASON_COMPONENT',
          source: { recommendations: [], externalIds: [{ value: '113988' }] },
        },
        {
          relation: 'SEASON_COMPONENT',
          source: { recommendations: [], externalIds: [{ value: '225634' }] },
        },
      ],
      providerImpl: async (id) => {
        if (id === 329491) throw new ProviderError('not_found', 'tmdb cached 404', 404);
        if (id === 113988) {
          return [
            { tmdbId: 500, type: 'SHOW', title: 'Shared', rating: 7 },
            { tmdbId: 225634, type: 'SHOW', title: 'Monster component' },
          ];
        }
        return [
          { tmdbId: 500, type: 'SHOW', title: 'Shared', rating: 8 },
          { tmdbId: 600, type: 'SHOW', title: 'Other' },
        ];
      },
    });

    const res = await service.repairRecommendations(100);

    expect(tmdbProvider.getShowRecommendations.mock.calls.map((call: any[]) => call[0])).toEqual([
      329491, 113988, 225634,
    ]);
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'monster' },
      data: {
        recommendations: [
          { tmdbId: 500, type: 'SHOW', title: 'Shared', rating: 8 },
          { tmdbId: 600, type: 'SHOW', title: 'Other' },
        ],
        recommendationsSyncedAt: expect.any(Date),
      },
    });
    expect(res).toMatchObject({ processed: 1, succeeded: 1, failed: 0, parked: 0 });
  });

  it('uses a retained component snapshot when its TMDB endpoint is gone', async () => {
    const retained = [{ tmdbId: 700, type: 'SHOW', title: 'Retained' }];
    const { service, prisma } = make({
      candidates: [candidate({ id: 'canonical', tmdb: null })],
      componentLinks: [
        {
          relation: 'SEASON_COMPONENT',
          source: { recommendations: retained, externalIds: [{ value: '123' }] },
        },
      ],
      providerImpl: async () => {
        throw new ProviderError('not_found', 'tmdb cached 404', 404);
      },
    });

    const res = await service.repairRecommendations(100);

    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'canonical' },
      data: { recommendations: retained, recommendationsSyncedAt: expect.any(Date) },
    });
    expect(res).toMatchObject({ succeeded: 1, failed: 0, parked: 0 });
  });

  it('stops early on TMDB rate limits without stamping the failed row', async () => {
    const { service, prisma, tmdbProvider } = make({
      candidates: [candidate(), candidate({ id: 'm2', title: 'Parks and Rec' })],
      providerImpl: async () => {
        throw new ProviderThrottled('tmdb', 1000);
      },
    });

    const res = await service.repairRecommendations(100);

    expect(tmdbProvider.getShowRecommendations).toHaveBeenCalledTimes(1);
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    expect(res).toMatchObject({ processed: 0, succeeded: 0, failed: 0 });
  });

  it('does nothing when TMDB is not configured', async () => {
    const { service, prisma } = make({ enabled: false });
    const res = await service.repairRecommendations(100);
    expect(res.processed).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('parks dead TMDB ids (404 / cached 404) for 90 days instead of failing every run', async () => {
    const { service, prisma, tmdbProvider } = make({
      candidates: [candidate()],
      providerImpl: async () => {
        throw new ProviderError('not_found', 'tmdb cached 404', 404);
      },
    });

    const res = await service.repairRecommendations(100);

    expect(res).toMatchObject({ processed: 1, succeeded: 0, failed: 0, parked: 1 });
    // Parked via a provenance stamp — no recommendations snapshot write.
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled();
    const [parts, key] = (prisma.$executeRaw as jest.Mock).mock.calls[0];
    expect(parts.join(' ')).toContain('metadata_provenance');
    expect(key).toBe('recsCheckedAt');
  });

  it('candidate SQL excludes rows parked in the last 90 days', async () => {
    const { service, prisma } = make({ candidates: [] });
    await service.repairRecommendations(100);
    const [parts] = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    const sql = parts.join(' ');
    expect(sql).toContain('recsCheckedAt');
    expect(sql).toContain("INTERVAL '90 days'");
  });

  it('non-404 errors still fail without parking', async () => {
    const { service, prisma } = make({
      candidates: [candidate()],
      providerImpl: async () => {
        throw new ProviderError('upstream', 'tmdb 500', 500);
      },
    });

    const res = await service.repairRecommendations(100);

    expect(res).toMatchObject({ processed: 1, succeeded: 0, failed: 1, parked: 0 });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('MetadataBackfillService — repair progress tracking', () => {
  function make() {
    return new MetadataBackfillService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CastDedupService(),
    );
  }

  it('reports a running job and merges partial updates', () => {
    const service = make();
    (service as any).trackRepair('english-base', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    (service as any).trackRepair('english-base', { total: 10 });
    (service as any).trackRepair('english-base', {
      processed: 4,
      succeeded: 3,
      failed: 1,
      current: 'Chirurgové',
    });

    expect(service.getRepairProgress()).toEqual({
      'english-base': expect.objectContaining({
        running: true,
        processed: 4,
        total: 10,
        succeeded: 3,
        failed: 1,
        current: 'Chirurgové',
      }),
    });
  });

  it('keeps recently-finished jobs visible, prunes after 60s', () => {
    const service = make();
    (service as any).trackRepair('character-ids', {
      running: false,
      processed: 5,
      total: 5,
      succeeded: 5,
      failed: 0,
      finishedAt: new Date(),
    });
    (service as any).trackRepair('anime-rehydrate', {
      running: false,
      processed: 9,
      total: 9,
      succeeded: 9,
      failed: 0,
      finishedAt: new Date(Date.now() - 61_000),
    });

    const progress = service.getRepairProgress();
    expect(progress['character-ids']).toEqual(expect.objectContaining({ running: false }));
    expect(progress['anime-rehydrate']).toBeUndefined();
  });

  it('a real repair run leaves a finished progress entry', async () => {
    const prisma: any = {
      mediaItem: {
        findMany: jest.fn(async () => [
          {
            id: 'm1',
            title: 'Chirurgové',
            type: 'SHOW',
            externalIds: [{ provider: 'TMDB', value: '1416', providerEntityKind: 'SERIES' }],
            genres: [],
          },
        ]),
        findUnique: jest.fn(async () => ({ titleLocale: 'en' })),
        update: jest.fn(async () => ({})),
      },
      $queryRaw: jest.fn(async () => [{ id: 'm1' }]),
      $executeRaw: jest.fn(async () => 0),
    };
    const service = new MetadataBackfillService(
      prisma,
      mockMeta(),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CastDedupService(),
    );

    await service.repairNonEnglishBase();

    const progress = service.getRepairProgress();
    expect(progress['english-base']).toEqual(
      expect.objectContaining({
        running: false,
        processed: 1,
        total: 1,
        succeeded: 1,
        failed: 0,
        finishedAt: expect.any(Date),
      }),
    );
  });
});

describe('MetadataBackfillService.backfillRatings', () => {
  function make(rows: any[], tmdbProviderOver: Record<string, any> = {}) {
    const prisma = mockPrisma();
    prisma.$queryRaw.mockResolvedValue(rows);
    const tmdbProvider = {
      enabled: true,
      findByExternalIdStrict: jest.fn(async () => null),
      localizedShowBase: jest.fn(async () => ({ rating: null })),
      localizedMovieBase: jest.fn(async () => ({ rating: null })),
      ...tmdbProviderOver,
    };
    const tvdb = { enabled: true, fetchImdbId: jest.fn(async () => null) };
    const service = new MetadataBackfillService(
      prisma,
      mockMeta(),
      {} as any,
      {} as any,
      {} as any,
      tvdb as any,
      tmdbProvider as any,
      {} as any,
      new CastDedupService(),
    );
    return { service, prisma, tmdbProvider, tvdb };
  }

  const row = (over: Record<string, any> = {}) => ({
    id: 'm1',
    title: 'TVDB-only show',
    type: 'SHOW',
    tmdb_id: null,
    tvdb_id: '123',
    ...over,
  });

  it('stamps definitive TVDB-only no-match rows so they drain from the next run', async () => {
    const { service, prisma } = make([row()]);

    const res = await service.backfillRatings(1);

    expect(res).toEqual(expect.objectContaining({ processed: 1, noneAtSource: 1, failed: 0 }));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [parts, ...vals] = (prisma.$executeRaw as jest.Mock).mock.calls[0];
    expect(parts.join('?')).toContain('ratingCheckedAt');
    expect(vals).toContain('m1');
  });

  it('does not stamp throttled external-id lookups', async () => {
    const { service, prisma } = make([row()], {
      findByExternalIdStrict: jest.fn(async () => {
        throw new ProviderThrottled('tmdb', 60_000);
      }),
    });

    const res = await service.backfillRatings(1);

    expect(res.rateLimited).toBe(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('stamps definitive TMDB 404s instead of retrying them every run', async () => {
    const { service, prisma } = make(
      [row({ tmdb_id: '999', tvdb_id: null, title: 'Missing TMDB row' })],
      {
        localizedShowBase: jest.fn(async () => {
          throw new ProviderError('not_found', 'tmdb cached 404', 404);
        }),
      },
    );

    const res = await service.backfillRatings(1);

    expect(res).toEqual(expect.objectContaining({ noneAtSource: 1, failed: 0 }));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('refreshes a TMDB supplement and records provider provenance', async () => {
    const { service, prisma } = make(
      [row({ tmdb_id: '77', tvdb_id: '123', title: 'TVDB-owned show' })],
      { localizedShowBase: jest.fn(async () => ({ rating: 8.4 })) },
    );

    const res = await service.backfillRatings(1);

    expect(res).toEqual(expect.objectContaining({ succeeded: 1, failed: 0 }));
    const [parts, ...vals] = (prisma.$executeRaw as jest.Mock).mock.calls[0];
    expect(parts.join('?')).toContain('ratingProvider');
    expect(parts.join('?')).toContain('ratingRefreshedAt');
    expect(vals).toEqual(expect.arrayContaining([8.4, 'm1']));
    const [queryParts] = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    expect(queryParts.join('?')).toContain('ratingRefreshedAt');
  });
});

describe('MetadataBackfillService.repairNonEnglishContent', () => {
  function make(
    rows: any[],
    providerBase: string | { title: string; overview?: string | null } | null,
  ) {
    const prisma = mockPrisma();
    prisma.$executeRaw = jest.fn(async () => 0);
    prisma.$queryRaw.mockResolvedValue(rows.map((r) => ({ id: r.id })));
    prisma.mediaItem.findMany.mockResolvedValue(rows);
    const meta = mockMeta();
    const base =
      typeof providerBase === 'string' ? { title: providerBase, overview: null } : providerBase;
    const tmdbProvider = {
      enabled: true,
      localizedShowBase: jest.fn(async () => base),
      localizedMovieBase: jest.fn(async () => base),
    };
    const redis = { get: jest.fn(async () => ''), set: jest.fn(async () => undefined) };
    const service = new MetadataBackfillService(
      prisma,
      meta,
      {} as any,
      redis as any,
      {} as any,
      {} as any,
      tmdbProvider as any,
      {} as any,
      new CastDedupService(),
    );
    return { service, prisma, meta, redis };
  }

  const row = (over: Record<string, any> = {}) => ({
    id: 'm1',
    title: 'Chirurgové',
    titles: null,
    overview: null,
    overviews: null,
    type: 'SHOW',
    contentClassification: null,
    show: { keywords: [] },
    movie: null,
    externalIds: [{ provider: 'TMDB', value: '1416', providerEntityKind: 'SERIES' }],
    genres: [],
    ...over,
  });

  it('re-hydrates rows whose English-visible title differs from the provider', async () => {
    const { service, prisma, meta } = make([row()], "Grey's Anatomy");

    const res = await service.repairNonEnglishContent();

    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { metadataRefreshedAt: null },
    });
    expect(meta.ensureShowFull).toHaveBeenCalledWith(1416);
    expect(res).toEqual(
      expect.objectContaining({ processed: 1, verified: 0, fixed: 1, failed: 0 }),
    );
    expect(res.sample[0]).toContain("Grey's Anatomy");
    const verifiedWrite = (prisma.$executeRaw as jest.Mock).mock.calls.find((c) =>
      c[0].join(' ').includes('enContentVerifiedTitle'),
    );
    expect(verifiedWrite).toBeTruthy();
    expect(verifiedWrite.slice(1)).toContain("Grey's Anatomy");
  });

  it('re-hydrates rows whose English-visible overview differs even when the title matches', async () => {
    const { service, prisma, meta } = make(
      [
        row({
          title: 'The X-Files',
          overview: 'Agent Fox Mulder a agentka Dana Scullyová vyšetřují Akta X.',
        }),
      ],
      { title: 'The X-Files', overview: 'FBI agents investigate unexplained cases.' },
    );

    const res = await service.repairNonEnglishContent();

    expect(meta.ensureShowFull).toHaveBeenCalledWith(1416);
    expect(res).toEqual(
      expect.objectContaining({ processed: 1, verified: 0, fixed: 1, failed: 0 }),
    );
    const verifiedWrite = (prisma.$executeRaw as jest.Mock).mock.calls.find((c) =>
      c[0].join(' ').includes('enContentVerifiedOverview'),
    );
    expect(verifiedWrite).toBeTruthy();
    expect(verifiedWrite.slice(1)).toContain('FBI agents investigate unexplained cases.');
  });

  it('does not count a row as fixed when the stored overview remains wrong after rehydrate', async () => {
    const staleOverview = 'Agent Fox Mulder a agentka Dana Scullyová vyšetřují Akta X.';
    const { service, prisma, meta } = make(
      [row({ title: 'The X-Files', overview: staleOverview })],
      { title: 'The X-Files', overview: 'FBI agents investigate unexplained cases.' },
    );
    prisma.mediaItem.findUnique.mockResolvedValue({
      title: 'The X-Files',
      titles: { en: 'The X-Files' },
      overview: staleOverview,
      overviews: null,
    });

    const res = await service.repairNonEnglishContent();

    expect(meta.ensureShowFull).toHaveBeenCalledWith(1416);
    expect(res).toEqual(
      expect.objectContaining({ processed: 1, verified: 0, fixed: 0, failed: 1 }),
    );
    const failureWrite = (prisma.$executeRaw as jest.Mock).mock.calls.find((c) =>
      c[0].join(' ').includes('enContentRepairFailedAt'),
    );
    expect(failureWrite).toBeTruthy();
    expect(failureWrite.slice(1)).toContain('overview still differs after rehydrate');
  });

  it('verifies and skips legit non-ASCII English titles (Pokémon false alarm)', async () => {
    const { service, meta } = make([row({ id: 'm2', title: 'Pokémon' })], 'Pokémon');

    const res = await service.repairNonEnglishContent();

    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(res).toEqual(
      expect.objectContaining({ processed: 1, verified: 1, fixed: 0, failed: 0 }),
    );
  });

  it("the 'en' override slot wins over a foreign base (already displays English)", async () => {
    const { service, meta } = make(
      [row({ titles: { en: "Grey's Anatomy", cs: 'Chirurgové' } })],
      "Grey's Anatomy",
    );

    const res = await service.repairNonEnglishContent();

    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(res.verified).toBe(1);
  });

  it('unverifiable rows (provider gives no title) count as failed, never guessed', async () => {
    const { service, meta } = make([row()], null);

    const res = await service.repairNonEnglishContent();

    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(res).toEqual(
      expect.objectContaining({ processed: 1, verified: 0, fixed: 0, failed: 1 }),
    );
  });

  it('comparison is punctuation/case-insensitive (curly quotes are not a mismatch)', async () => {
    const { service, meta } = make([row({ title: 'Grey’s Anatomy' })], "Grey's Anatomy");

    const res = await service.repairNonEnglishContent();

    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(res.verified).toBe(1);
  });

  it('deep mode pages with its own cursor and wraps at the end of the catalog', async () => {
    const { service, redis } = make([row()], "Grey's Anatomy");

    await service.repairNonEnglishContent(10, true); // 1 row < take → wrap

    expect(redis.set).toHaveBeenCalledWith('EN_CONTENT_DEEP_CURSOR', '', 86400 * 30);
  });

  it('remembers verified rows in metadata_provenance so they leave the suspect pool', async () => {
    const { service, prisma } = make([row({ id: 'm2', title: 'Pokémon' })], 'Pokémon');

    await service.repairNonEnglishContent();

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [parts, ...vals] = (prisma.$executeRaw as jest.Mock).mock.calls[0];
    expect(parts.join('?')).toContain('enContentVerifiedTitle');
    expect(vals).toContain('Pokémon');
  });

  it('suspect selection skips remembered rows and orders by popularity', async () => {
    const { service, prisma } = make([row()], "Grey's Anatomy");

    await service.repairNonEnglishContent();

    const [parts] = (prisma.$queryRaw as jest.Mock).mock.calls[0];
    const sql = parts.join(' ');
    expect(sql).toContain('enContentVerifiedTitle');
    expect(sql).toContain('enContentVerifiedOverview');
    expect(sql).toContain('enContentVerifiedEpisodeFingerprint');
    expect(sql).toContain('episodes e');
    expect(sql).toContain('regexp_replace');
    expect(sql).toContain('md5');
    expect(sql).toContain('string_agg');
    expect(sql).toContain('ORDER BY m.popularity DESC');
  });

  it("marks viewers' stats snapshots stale after a title fix (profile marathons refresh)", async () => {
    const { service, prisma } = make([row()], "Grey's Anatomy");

    await service.repairNonEnglishContent();

    const calls = (prisma.$executeRaw as jest.Mock).mock.calls;
    const staleWrite = calls.find((c) => c[0].join(' ').includes('user_stats_summary'));
    expect(staleWrite).toBeTruthy();
    expect(staleWrite![0].join(' ')).toContain('stale = true');
  });
});

describe('MetadataBackfillService.repairBannerPosters', () => {
  it('clears the freshness stamp and re-hydrates from TVDB (fixed mapper re-picks artworks)', async () => {
    const prisma = mockPrisma();
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'm1',
        title: 'Show A',
        type: 'SHOW',
        structureProvider: 'TVDB',
        tmdb: null,
        tvdb: '368495',
        posterUrl: 'https://artworks.thetvdb.com/banners/v4/series/368495/banners/foo.jpg',
        posterUrls: null,
      },
      {
        id: 'm2',
        title: 'Movie B',
        type: 'MOVIE',
        structureProvider: null,
        tmdb: null,
        tvdb: '777',
        posterUrl: 'https://artworks.thetvdb.com/banners/v4/movie/777/banners/foo.jpg',
        posterUrls: null,
      },
    ]);
    const meta = mockMeta();
    const service = new MetadataBackfillService(
      prisma,
      meta,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CastDedupService(),
    );

    const res = await service.repairBannerPosters();

    expect(meta.ensureShowFullTvdb).toHaveBeenCalledWith(368495, undefined, {
      skipClassification: true,
      forceRefresh: true,
      writeScope: 'ARTWORK_ONLY',
    });
    expect(meta.ensureMovieFullTvdb).toHaveBeenCalledWith(777);
    expect(res).toEqual(expect.objectContaining({ processed: 2, succeeded: 2, failed: 0 }));
  });

  it('normalizes duplicated TVDB artwork prefixes without re-hydrating proper poster URLs', async () => {
    const prisma = mockPrisma();
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'm1',
        title: 'Show A',
        type: 'SHOW',
        structureProvider: 'TVDB',
        tmdb: null,
        tvdb: '417289',
        posterUrl:
          'https://artworks.thetvdb.com/banners/https://artworks.thetvdb.com/banners/v4/series/417289/posters/621e6277de9a1.jpg',
        posterUrls: {
          en: 'https://artworks.thetvdb.com/banners/https://artworks.thetvdb.com/banners/v4/series/417289/posters/621e6277de9a1.jpg',
        },
      },
    ]);
    const meta = mockMeta();
    const service = new MetadataBackfillService(
      prisma,
      meta,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CastDedupService(),
    );

    const res = await service.repairBannerPosters();

    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: {
        posterUrl:
          'https://artworks.thetvdb.com/banners/v4/series/417289/posters/621e6277de9a1.jpg',
        posterUrls: {
          en: 'https://artworks.thetvdb.com/banners/v4/series/417289/posters/621e6277de9a1.jpg',
        },
      },
    });
    expect(meta.ensureShowFullTvdb).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ processed: 1, succeeded: 1, failed: 0 }));
  });
});

describe('MetadataBackfillService movie duplicate merge data preservation', () => {
  it('uses the canonical recovery ledger instead of deleting the source movie', async () => {
    const repairEligible = jest.fn().mockResolvedValue({ status: 'applied' });
    const prisma = { mediaItem: { delete: jest.fn() } };
    const service = new MetadataBackfillService(
      prisma as any,
      mockMeta(),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new CastDedupService(),
      { repairEligible } as any,
    );
    await (service as any).mergeDuplicateMovieRows('src', 'dst');
    expect(repairEligible).toHaveBeenCalledWith('src', 'consolidate', 'dst');
    expect(prisma.mediaItem.delete).not.toHaveBeenCalled();
  });
});
