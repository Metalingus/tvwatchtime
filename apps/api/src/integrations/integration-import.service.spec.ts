import { IntegrationImportService } from './integration-import.service';

describe('IntegrationImportService authoritative show state', () => {
  it('overwrites dropped and paused flags without checking manual ownership', async () => {
    const prisma = {
      userShowStatus: {
        createMany: jest.fn().mockResolvedValue({ count: 3 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
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
      import: {
        create: jest.fn().mockResolvedValue({ id: 'import-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
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
    expect(integrationData.recordSync).toHaveBeenCalledWith('integration-1', 'user-1', 'import-1');
  });
});
