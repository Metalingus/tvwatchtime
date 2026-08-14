import { IntegrationDataService } from './integration-data.service';

function createService() {
  const prisma = {
    integrationSyncedItem: {
      findMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn(),
    },
    importItem: { findMany: jest.fn().mockResolvedValue([]) },
    favorite: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    watchlistItem: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    rating: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    userEpisodeStatus: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    userMovieStatus: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    watchHistory: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (operations: unknown) => {
      if (Array.isArray(operations)) return Promise.all(operations);
      return operations;
    }),
  };
  const imports = {
    rebuildShowStatusesForMediaIds: jest.fn().mockResolvedValue(undefined),
    invalidateImportedLibrary: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new IntegrationDataService(prisma as any, imports as any),
    prisma,
    imports,
  };
}

describe('IntegrationDataService', () => {
  it('preserves a provider contribution that the user has made authoritative', async () => {
    const { service, prisma } = createService();
    prisma.integrationSyncedItem.findMany
      .mockResolvedValueOnce([
        {
          sourceKey: 'simkl:favorite:1',
          entityType: 'FAVORITE_MOVIE',
          mediaId: 'media-1',
          episodeId: null,
          targetRecordId: 'favorite-1',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.favorite.findUnique.mockResolvedValue({ id: 'favorite-1', source: 'MANUAL' });

    const result = await service.clear('user-1', 'integration-1', 'SIMKL', false);

    expect(result).toMatchObject({ removed: 0, transferred: 0, preserved: 1 });
    expect(prisma.favorite.delete).not.toHaveBeenCalled();
  });

  it('deletes only the record still owned by the provider', async () => {
    const { service, prisma } = createService();
    prisma.integrationSyncedItem.findMany
      .mockResolvedValueOnce([
        {
          sourceKey: 'jellyfin:favorite:1',
          entityType: 'FAVORITE_MOVIE',
          mediaId: 'media-1',
          episodeId: null,
          targetRecordId: 'favorite-1',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.favorite.findUnique.mockResolvedValue({ id: 'favorite-1', source: 'JELLYFIN' });

    const result = await service.clear('user-1', 'integration-1', 'JELLYFIN', true);

    expect(result).toMatchObject({ removed: 1, transferred: 0, preserved: 0 });
    expect(prisma.favorite.delete).toHaveBeenCalledWith({ where: { id: 'favorite-1' } });
    expect(prisma.integrationSyncedItem.deleteMany).toHaveBeenCalledWith({
      where: { integrationId: 'integration-1' },
    });
  });

  it('can clear only legacy Jellyfin favorite contributions during migration', async () => {
    const { service, prisma } = createService();
    prisma.integrationSyncedItem.findMany
      .mockResolvedValueOnce([
        {
          sourceKey: 'series:series-1:favorite',
          entityType: 'FAVORITE_SHOW',
          mediaId: 'media-1',
          episodeId: null,
          targetRecordId: 'favorite-1',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.favorite.findUnique.mockResolvedValue({ id: 'favorite-1', source: 'JELLYFIN' });

    await service.clear('user-1', 'integration-1', 'JELLYFIN', true, [
      'FAVORITE_SHOW',
      'FAVORITE_MOVIE',
    ]);

    expect(prisma.favorite.delete).toHaveBeenCalledWith({ where: { id: 'favorite-1' } });
    expect(prisma.integrationSyncedItem.deleteMany).toHaveBeenCalledWith({
      where: {
        integrationId: 'integration-1',
        entityType: { in: ['FAVORITE_SHOW', 'FAVORITE_MOVIE'] },
      },
    });
  });

  it('transfers watched ownership to completed TV Time history', async () => {
    const { service, prisma } = createService();
    prisma.integrationSyncedItem.findMany
      .mockResolvedValueOnce([
        {
          sourceKey: 'simkl:movie:1',
          entityType: 'WATCHED_MOVIE',
          mediaId: 'media-1',
          episodeId: null,
          targetRecordId: 'movie-status-1',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.importItem.findMany.mockResolvedValue([
      {
        sourceEntityType: 'WATCHED_MOVIE',
        matchedMediaId: 'media-1',
        matchedEpisodeId: null,
        rawData: {},
        normalizedData: { voteKey: 'tvtime:movie:1' },
      },
    ]);
    prisma.userMovieStatus.findUnique.mockResolvedValue({
      id: 'movie-status-1',
      source: 'SIMKL',
    });

    const result = await service.clear('user-1', 'integration-1', 'SIMKL', false);

    expect(result).toMatchObject({ removed: 0, transferred: 1, preserved: 0 });
    expect(prisma.userMovieStatus.update).toHaveBeenCalledWith({
      where: { id: 'movie-status-1' },
      data: { source: 'TVTIME', sourceKey: 'tvtime:movie:1' },
    });
    expect(prisma.watchHistory.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', source: 'SIMKL', sourceKey: 'simkl:movie:1' },
      data: { source: 'TVTIME', sourceKey: 'tvtime:movie:1' },
    });
  });
});
