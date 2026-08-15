import { IntegrationDataService } from './integration-data.service';

function createService() {
  const prisma: any = {
    integrationSyncedItem: {
      findMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    importItem: { findMany: jest.fn().mockResolvedValue([]) },
    favorite: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    watchlistItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    rating: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    userEpisodeStatus: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    userMovieStatus: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    watchHistory: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    customList: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    customListItem: {
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (operations: unknown) => {
      if (Array.isArray(operations)) return Promise.all(operations);
      if (typeof operations === 'function') return (operations as any)(prisma);
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

  it('retracts only an Emby contribution missing from a complete snapshot', async () => {
    const { service, prisma } = createService();
    const previous = {
      sourceKey: 'emby:movie:movie-1:favorite',
      entityType: 'WATCHLIST_MOVIE',
      mediaId: 'media-1',
      episodeId: null,
      targetRecordId: 'watchlist-1',
    };
    prisma.integrationSyncedItem.findMany
      .mockResolvedValueOnce([previous])
      .mockResolvedValueOnce([previous])
      .mockResolvedValueOnce([]);
    prisma.watchlistItem.findUnique.mockResolvedValue({
      id: 'watchlist-1',
      source: 'EMBY',
    });

    await service.recordSync('integration-1', 'user-1', 'EMBY', 'import-1', ['WATCHLIST_MOVIE']);

    expect(prisma.watchlistItem.delete).toHaveBeenCalledWith({
      where: { id: 'watchlist-1' },
    });
    expect(prisma.integrationSyncedItem.deleteMany).toHaveBeenCalledWith({
      where: {
        integrationId: 'integration-1',
        sourceKey: { in: ['emby:movie:movie-1:favorite'] },
      },
    });
  });

  it('retracts only Plex contributions inside the completed source-key scope', async () => {
    const { service, prisma } = createService();
    const serverEpisode = {
      sourceKey: 'plex:machine-1:show:show-1:episode:episode-1:watched',
      entityType: 'WATCHED_EPISODE',
      mediaId: 'show-media-1',
      episodeId: 'episode-1',
      targetRecordId: 'episode-status-1',
    };
    prisma.integrationSyncedItem.findMany
      .mockResolvedValueOnce([serverEpisode])
      .mockResolvedValueOnce([serverEpisode])
      .mockResolvedValueOnce([]);
    prisma.userEpisodeStatus.findUnique.mockResolvedValue({
      id: 'episode-status-1',
      source: 'PLEX',
    });

    await service.recordSync(
      'integration-1',
      'user-1',
      'PLEX',
      'import-1',
      [],
      [
        {
          entityType: 'WATCHED_EPISODE',
          sourceKeyPrefix: 'plex:machine-1:show:',
        },
      ],
    );

    expect(prisma.integrationSyncedItem.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        integrationId: 'integration-1',
        OR: [
          {
            entityType: 'WATCHED_EPISODE',
            sourceKey: { startsWith: 'plex:machine-1:show:' },
          },
        ],
      },
      select: {
        sourceKey: true,
        entityType: true,
        mediaId: true,
        episodeId: true,
        targetRecordId: true,
      },
    });
    expect(prisma.integrationSyncedItem.deleteMany).toHaveBeenCalledWith({
      where: {
        integrationId: 'integration-1',
        sourceKey: { in: [serverEpisode.sourceKey] },
      },
    });
  });

  it('retracts a legacy Plex title match when the current item has no trusted ID', async () => {
    const { service, prisma } = createService();
    const sourceKey = 'plex:machine-1:movie:movie-1:watched';
    const previous = {
      sourceKey,
      entityType: 'WATCHED_MOVIE',
      mediaId: 'media-1',
      episodeId: null,
      targetRecordId: 'movie-status-1',
    };
    prisma.integrationSyncedItem.findMany
      .mockResolvedValueOnce([previous])
      .mockResolvedValueOnce([previous])
      .mockResolvedValueOnce([]);
    prisma.userMovieStatus.findUnique.mockResolvedValue({
      id: 'movie-status-1',
      source: 'PLEX',
    });

    await service.recordSync('integration-1', 'user-1', 'PLEX', 'import-1', [], [], [sourceKey]);

    expect(prisma.integrationSyncedItem.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        integrationId: 'integration-1',
        OR: [{ sourceKey: { in: [sourceKey] } }],
      },
      select: {
        sourceKey: true,
        entityType: true,
        mediaId: true,
        episodeId: true,
        targetRecordId: true,
      },
    });
    expect(prisma.userMovieStatus.delete).toHaveBeenCalledWith({
      where: { id: 'movie-status-1' },
    });
  });
});
