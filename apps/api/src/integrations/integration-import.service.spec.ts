jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
import { IntegrationImportService } from './integration-import.service';

describe('IntegrationImportService authoritative show state', () => {
  it('overwrites dropped and paused flags without checking manual ownership', async () => {
    const prisma: any = {
      importLog: { create: jest.fn().mockResolvedValue({}) },
      userShowStatus: {
        createMany: jest.fn().mockResolvedValue({ count: 3 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (operations: any) =>
        typeof operations === 'function' ? operations(prisma) : Promise.all(operations),
      ),
    };
    const service = new IntegrationImportService(prisma as any, {} as any, {} as any, {} as any);

    await (service as any).applyShowTrackingStates('user-1', [
      { mediaId: 'dropped-show', state: 'DROPPED' },
      { mediaId: 'paused-show', state: 'PAUSED' },
      { mediaId: 'active-show', state: 'ACTIVE' },
    ]);

    expect(prisma.userShowStatus.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: 'user-1',
          mediaId: 'dropped-show',
          dropped: true,
          pausedAt: null,
        },
        {
          userId: 'user-1',
          mediaId: 'paused-show',
          dropped: false,
          pausedAt: expect.any(Date),
        },
        {
          userId: 'user-1',
          mediaId: 'active-show',
          dropped: false,
          pausedAt: null,
        },
      ],
      skipDuplicates: true,
    });
    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', mediaId: { in: ['dropped-show'] } },
      data: { dropped: true, pausedAt: null },
    });
    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', mediaId: { in: ['paused-show'] } },
      data: { dropped: false, pausedAt: expect.any(Date) },
    });
    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', mediaId: { in: ['active-show'] } },
      data: { dropped: false, pausedAt: null },
    });
  });
});

describe('IntegrationImportService provider lists', () => {
  it('stages Jellyfin collections as private lists with matched list items', async () => {
    const prisma = {
      importLog: { create: jest.fn().mockResolvedValue({}) },
      import: {
        create: jest.fn().mockResolvedValue({ id: 'import-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      externalId: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { mediaId: 'media-1', provider: 'TMDB', providerEntityKind: 'MOVIE', value: '10' },
          ]),
      },
    };
    const matcher = {
      matchByExternalIds: jest.fn().mockResolvedValue({
        mediaId: 'media-1',
        confidence: 1,
        matchedTitle: 'Collection Movie',
      }),
    };
    const imports = {
      confirm: jest.fn().mockResolvedValue({
        importId: 'import-1',
        created: 2,
        skipped: 0,
      }),
    };
    const integrationData = {
      recordSync: jest.fn().mockResolvedValue(undefined),
    };
    const service = new IntegrationImportService(
      prisma as any,
      matcher as any,
      imports as any,
      integrationData as any,
    );

    await service.stageAndApply('integration-1', 'user-1', 'JELLYFIN', [
      {
        entityType: 'LIST',
        mediaType: 'MOVIE',
        title: 'My Collection',
        ids: {},
        listKey: 'boxset:box-1',
        listTitle: 'My Collection',
        sourceKey: 'boxset:box-1:list',
      },
      {
        entityType: 'LIST_ITEM',
        mediaType: 'MOVIE',
        title: 'Collection Movie',
        ids: { tmdb: 10 },
        listKey: 'boxset:box-1',
        listOrder: 0,
        sourceKey: 'boxset:box-1:item:movie-1',
      },
    ]);

    const rows = prisma.importItem.createMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      expect.objectContaining({
        sourceEntityType: 'LIST',
        status: 'MATCHED',
        matchedMediaId: null,
        normalizedData: expect.objectContaining({
          sourceKey: 'boxset:box-1',
          title: 'My Collection',
          visibility: 'PRIVATE',
        }),
      }),
      expect.objectContaining({
        sourceEntityType: 'LIST_ITEM',
        status: 'MATCHED',
        matchedMediaId: 'media-1',
        normalizedData: expect.objectContaining({
          sourceKey: 'boxset:box-1',
          mediaType: 'movie',
          order: 0,
        }),
      }),
    ]);
    expect(imports.confirm).toHaveBeenCalledWith('user-1', 'import-1');
    expect(integrationData.recordSync).toHaveBeenCalledWith(
      'integration-1',
      'user-1',
      'JELLYFIN',
      'import-1',
      undefined,
      undefined,
      [],
    );
  });

  it('skips Plex media without an IMDb, TMDb, or TVDb identity', async () => {
    const prisma = {
      importLog: { create: jest.fn().mockResolvedValue({}) },
      import: {
        create: jest.fn().mockResolvedValue({ id: 'import-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const matcher = {
      matchByExternalIds: jest.fn(),
    };
    const imports = {
      confirm: jest.fn().mockResolvedValue({
        importId: 'import-1',
        created: 0,
        skipped: 0,
      }),
    };
    const integrationData = {
      recordSync: jest.fn().mockResolvedValue(undefined),
    };
    const service = new IntegrationImportService(
      prisma as any,
      matcher as any,
      imports as any,
      integrationData as any,
    );

    await expect(
      service.stageAndApply('integration-1', 'user-1', 'PLEX', [
        {
          entityType: 'WATCHED_MOVIE',
          mediaType: 'MOVIE',
          title: 'Ambiguous Movie',
          year: 2024,
          ids: {},
          sourceKey: 'plex:machine-1:movie:movie-1:watched',
        },
      ]),
    ).resolves.toMatchObject({ received: 0, matched: 0, unmatched: 0 });

    expect(matcher.matchByExternalIds).not.toHaveBeenCalled();
    expect(prisma.import.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ totalRows: 0 }),
    });
    expect(prisma.importItem.createMany).not.toHaveBeenCalled();
    expect(integrationData.recordSync).toHaveBeenCalledWith(
      'integration-1',
      'user-1',
      'PLEX',
      'import-1',
      undefined,
      undefined,
      ['plex:machine-1:movie:movie-1:watched'],
    );
  });
});

describe('IntegrationImportService trusted matches', () => {
  function fixture(owners: Array<Record<string, string>>, match: Record<string, unknown>) {
    const prisma: any = {
      importLog: { create: jest.fn().mockResolvedValue({}) },
      import: {
        create: jest.fn().mockResolvedValue({ id: 'import-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      externalId: { findMany: jest.fn().mockResolvedValue(owners) },
      mediaCanonicalLink: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.sourceMediaId === 'source-row'
            ? { targetMediaId: 'media-1', status: 'ACTIVE' }
            : null,
        ),
      },
    };
    const matcher = { matchByExternalIds: jest.fn().mockResolvedValue(match) };
    const imports = { confirm: jest.fn().mockResolvedValue({ created: 0, skipped: 0 }) };
    const service = new IntegrationImportService(
      prisma,
      matcher as any,
      imports as any,
      { recordSync: jest.fn() } as any,
    );
    const stage = (ids: Record<string, unknown>) =>
      service.stageAndApply('integration-1', 'user-1', 'EMBY', [
        {
          entityType: 'WATCHED_MOVIE',
          mediaType: 'MOVIE',
          title: 'Remake',
          year: 2020,
          ids,
          sourceKey: 'movie-1',
        } as any,
      ]);
    const row = () => prisma.importItem.createMany.mock.calls[0][0].data[0];
    return { stage, row, prisma };
  }

  it('matches when the matched row owns one of the item ids', async () => {
    const f = fixture(
      [{ mediaId: 'media-1', provider: 'TMDB', providerEntityKind: 'MOVIE', value: '10' }],
      { mediaId: 'media-1', confidence: 0.95, matchedTitle: 'Remake' },
    );
    await f.stage({ tmdb: 10 });
    expect(f.row()).toMatchObject({ status: 'MATCHED', matchedMediaId: 'media-1' });
  });

  it('rejects a title guess that the item ids do not back, writing nothing', async () => {
    const f = fixture([], { mediaId: 'other-remake', confidence: 0.8, matchedTitle: 'Remake' });
    await f.stage({ tmdb: 10, imdb: 'tt10' });
    expect(f.row()).toMatchObject({ status: 'UNMATCHED', matchedMediaId: null });
  });

  it('rejects a match whose id belongs to a different row', async () => {
    const f = fixture(
      [{ mediaId: 'another-row', provider: 'TMDB', providerEntityKind: 'MOVIE', value: '10' }],
      { mediaId: 'media-1', confidence: 0.95, matchedTitle: 'Remake' },
    );
    await f.stage({ tmdb: 10 });
    expect(f.row()).toMatchObject({ status: 'UNMATCHED', matchedMediaId: null });
  });

  it('trusts an id owned by a canonical source redirected to the matched row', async () => {
    const f = fixture(
      [{ mediaId: 'source-row', provider: 'TMDB', providerEntityKind: 'MOVIE', value: '10' }],
      { mediaId: 'media-1', confidence: 0.95, matchedTitle: 'Remake' },
    );
    await f.stage({ tmdb: 10 });
    expect(f.row()).toMatchObject({ status: 'MATCHED', matchedMediaId: 'media-1' });
  });

  it('accepts an id-less item only on a near-certain title match', async () => {
    const sure = fixture([], { mediaId: 'media-1', confidence: 0.9, matchedTitle: 'Remake' });
    await sure.stage({});
    expect(sure.row()).toMatchObject({ status: 'MATCHED', matchedMediaId: 'media-1' });
    const fuzzy = fixture([], { mediaId: 'media-1', confidence: 0.5, matchedTitle: 'Remake' });
    await fuzzy.stage({});
    expect(fuzzy.row()).toMatchObject({ status: 'UNMATCHED', matchedMediaId: null });
    expect(fuzzy.prisma.externalId.findMany).not.toHaveBeenCalled();
  });
});

describe('IntegrationImportService episode fallback without episode ids', () => {
  const episodes = [
    { id: 's1e1', number: 1, title: 'Pilot', season: { number: 1 } },
    { id: 's1e2', number: 2, title: 'The Return', season: { number: 1 } },
    { id: 's2e1', number: 1, title: 'New Blood', season: { number: 2 } },
  ];
  function setup(structure: Record<string, unknown> | null) {
    const prisma: any = {
      importLog: { create: jest.fn().mockResolvedValue({}) },
      import: {
        create: jest.fn().mockResolvedValue({ id: 'import-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      externalId: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { mediaId: 'show', provider: 'TMDB', providerEntityKind: 'SERIES', value: '10' },
          ]),
      },
      show: { findUnique: jest.fn().mockResolvedValue(structure) },
      episode: { findMany: jest.fn().mockResolvedValue(episodes) },
    };
    const matcher = {
      matchByExternalIds: jest.fn().mockResolvedValue({
        mediaId: 'show',
        confidence: 0.95,
        matchedTitle: 'Show',
      }),
      resolveEpisodeByExternalIds: jest.fn().mockResolvedValue(null),
    };
    const service = new IntegrationImportService(
      prisma,
      matcher as any,
      { confirm: jest.fn().mockResolvedValue({}) } as any,
      { recordSync: jest.fn() } as any,
    );
    const sync = (items: Array<{ season: number; episode: number; episodeTitle?: string }>) =>
      service.stageAndApply(
        'integration-1',
        'user-1',
        'JELLYFIN',
        items.map((e, i) => ({
          entityType: 'WATCHED_EPISODE' as const,
          mediaType: 'SHOW' as const,
          title: 'Show',
          ids: { tmdb: 10 },
          episodeIds: {},
          sourceKey: `ep-${i}`,
          ...e,
        })),
      );
    const rows = () => prisma.importItem.createMany.mock.calls[0][0].data;
    return { sync, rows, prisma };
  }
  const EQUIVALENT = {
    structureProvider: 'TMDB',
    structureReason: 'GENERAL_TMDB',
    structureRuleVersion: 2,
  };
  const ANIME = {
    structureProvider: 'TVDB',
    structureReason: 'ANIME_TVDB',
    structureRuleVersion: 2,
  };

  it('trusts season/episode numbers when TMDB and TVDB numbering are equivalent', async () => {
    const f = setup(EQUIVALENT);
    await f.sync([{ season: 1, episode: 2 }]);
    expect(f.rows()[0]).toMatchObject({ status: 'MATCHED', matchedEpisodeId: 's1e2' });
  });

  it('uses a unique episode title on an ambiguous graph, even when the numbers differ', async () => {
    const f = setup(ANIME);
    await f.sync([{ season: 1, episode: 14, episodeTitle: 'New Blood' }]);
    expect(f.rows()[0]).toMatchObject({ status: 'MATCHED', matchedEpisodeId: 's2e1' });
  });

  it('accepts numbers on an ambiguous graph only when the whole synced footprint fits', async () => {
    const fits = setup(ANIME);
    await fits.sync([
      { season: 1, episode: 1 },
      { season: 2, episode: 1 },
    ]);
    expect(fits.rows().map((r: any) => r.matchedEpisodeId)).toEqual(['s1e1', 's2e1']);

    // Absolute numbering (S1E13) cannot exist in the TVDB graph: nothing is guessed.
    const absolute = setup(ANIME);
    await absolute.sync([
      { season: 1, episode: 1 },
      { season: 1, episode: 13 },
    ]);
    expect(absolute.rows().map((r: any) => r.status)).toEqual(['UNMATCHED', 'UNMATCHED']);
  });

  it('ignores generic episode titles as evidence', async () => {
    const f = setup(ANIME);
    await f.sync([
      { season: 1, episode: 2, episodeTitle: 'Episode 2' },
      { season: 1, episode: 13 },
    ]);
    expect(f.rows()[0]).toMatchObject({ status: 'UNMATCHED' });
  });

  it('treats unknown structure authority as ambiguous', async () => {
    const f = setup(null);
    await f.sync([{ season: 1, episode: 13 }]);
    expect(f.rows()[0]).toMatchObject({ status: 'UNMATCHED' });
  });
});
