import { ConflictException } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';

describe('IntegrationsService scheduled sync', () => {
  it('refreshes stale accounts in a bounded batch and isolates failures', async () => {
    const prisma = {
      userIntegration: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 'user-1', provider: 'STREMIO' },
          { userId: 'user-2', provider: 'JELLYFIN' },
          { userId: 'user-3', provider: 'STREMIO' },
        ]),
      },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'jobs.integrationSyncBatchSize') return 25;
        if (key === 'jobs.integrationSyncStaleHours') return 6;
        return undefined;
      }),
    };
    const service = new IntegrationsService(
      prisma as any,
      config as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service, 'sync')
      .mockResolvedValueOnce({
        provider: 'STREMIO',
        importId: 'import-1',
        received: 5,
        matched: 5,
        unmatched: 0,
        created: 2,
        skipped: 3,
      })
      .mockRejectedValueOnce(new ConflictException('already syncing'))
      .mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(service.syncDue()).resolves.toEqual({
      selected: 3,
      succeeded: 1,
      failed: 1,
      busy: 1,
      created: 2,
      skipped: 3,
    });
    expect(prisma.userIntegration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 25,
        where: expect.objectContaining({
          provider: { not: 'SIMKL' },
          connectedAt: { not: null },
        }),
      }),
    );
  });
});

describe('IntegrationsService foreground sync', () => {
  it('selects only stale connected integrations and keeps SIMKL non-manual', async () => {
    const prisma = {
      userIntegration: {
        findMany: jest.fn().mockResolvedValue([{ provider: 'SIMKL' }, { provider: 'JELLYFIN' }]),
      },
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service, 'sync')
      .mockResolvedValueOnce({
        provider: 'SIMKL',
        importId: 'import-1',
        received: 2,
        matched: 2,
        unmatched: 0,
        created: 2,
        skipped: 0,
      })
      .mockResolvedValueOnce({
        provider: 'JELLYFIN',
        importId: 'import-2',
        received: 1,
        matched: 1,
        unmatched: 0,
        created: 1,
        skipped: 0,
      });

    await expect(service.syncForeground('user-1')).resolves.toEqual({
      selected: 2,
      succeeded: 2,
      failed: 0,
      busy: 0,
      created: 3,
      skipped: 0,
    });
    expect(prisma.userIntegration.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        connectedAt: { not: null },
        paused: false,
        itemsDisabled: false,
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: expect.any(Date) } }],
      },
      orderBy: [{ lastSyncedAt: 'asc' }, { updatedAt: 'asc' }],
      select: { provider: true },
    });
    expect(service.sync).toHaveBeenNthCalledWith(1, 'user-1', 'SIMKL');
    expect(service.sync).toHaveBeenNthCalledWith(2, 'user-1', 'JELLYFIN');
  });
});

describe('IntegrationsService connection flow', () => {
  it('reports an unclaimed Plex PIN as pending without changing stored credentials', async () => {
    const prisma = {
      userIntegration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'integration-1',
          credentialsEncrypted: 'encrypted-pending',
        }),
        update: jest.fn(),
      },
    };
    const pending = {
      id: '123',
      code: 'ABCD',
      clientIdentifier: 'client-1',
      verificationUrl: 'https://app.plex.tv/auth',
      expiresAt: '2999-01-01T00:00:00.000Z',
      pollAfterSeconds: 2,
    };
    const secrets = { decrypt: jest.fn().mockReturnValue({ pending }) };
    const plex = { completeLink: jest.fn().mockResolvedValue(null) };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      plex as any,
    );

    await expect(service.completeLink('user-1', 'PLEX')).resolves.toEqual({
      provider: 'PLEX',
      connected: false,
      pending: true,
    });
    expect(plex.completeLink).toHaveBeenCalledWith({
      id: '123',
      code: 'ABCD',
      clientIdentifier: 'client-1',
    });
    expect(prisma.userIntegration.update).not.toHaveBeenCalled();
  });

  it('finishes Plex server selection before the initial sync starts', async () => {
    const prisma = {
      userIntegration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'integration-1',
          credentialsEncrypted: 'encrypted-account',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const secrets = {
      decrypt: jest.fn().mockReturnValue({
        accountToken: 'account-token',
        clientIdentifier: 'client-1',
      }),
      encrypt: jest.fn().mockReturnValue('encrypted-server'),
    };
    const plex = {
      listServers: jest
        .fn()
        .mockResolvedValue([{ machineIdentifier: 'machine-1', name: 'Home', owned: true }]),
      resolveServer: jest.fn().mockResolvedValue({
        machineIdentifier: 'machine-1',
        name: 'Home',
        owned: true,
        serverUrl: 'https://plex.example.com',
        accessToken: 'server-token',
      }),
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      plex as any,
    );
    const sync = jest.spyOn(service, 'sync');

    await expect(service.selectPlexServer('user-1', 'machine-1')).resolves.toEqual({
      provider: 'PLEX',
      connected: true,
    });
    expect(sync).not.toHaveBeenCalled();
  });

  it('connects Plex in account-only mode when the selected server is not reachable', async () => {
    const prisma = {
      userIntegration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'integration-1',
          credentialsEncrypted: 'encrypted-account',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const secrets = {
      decrypt: jest.fn().mockReturnValue({
        accountToken: 'account-token',
        clientIdentifier: 'client-1',
      }),
      encrypt: jest.fn().mockReturnValue('encrypted-server'),
    };
    const plex = {
      listServers: jest
        .fn()
        .mockResolvedValue([{ machineIdentifier: 'machine-1', name: 'Home', owned: true }]),
      resolveServer: jest.fn().mockRejectedValue(new Error('No reachable server')),
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      plex as any,
    );

    await expect(service.selectPlexServer('user-1', 'machine-1')).resolves.toEqual({
      provider: 'PLEX',
      connected: true,
    });
    expect(prisma.userIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          displayName: 'Home',
          serverUrl: null,
          connectedAt: expect.any(Date),
        }),
      }),
    );
  });
});

describe('IntegrationsService Plex account fallback', () => {
  it('imports cloud account data when the selected Plex server fetch fails', async () => {
    const prisma = {
      userIntegration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'integration-1',
          connectedAt: new Date(),
          credentialsEncrypted: 'encrypted',
          paused: false,
          itemsDisabled: false,
          lastSyncStatus: 'IDLE',
          syncCursor: null,
          syncSettings: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const credentials = {
      accountToken: 'account-token',
      clientIdentifier: 'client-1',
      machineIdentifier: 'machine-1',
    };
    const cloudPayload = {
      items: [
        {
          entityType: 'WATCHLIST_MOVIE',
          mediaType: 'MOVIE',
          title: 'Cloud Movie',
          ids: { tmdb: 10 },
          sourceKey: 'plex:watchlist:movie:10',
        },
      ],
      cursor: null,
      snapshotScopes: [{ entityType: 'WATCHLIST_MOVIE', sourceKeyPrefix: 'plex:watchlist:' }],
    };
    const integrationImport = {
      stageAndApply: jest.fn().mockResolvedValue({
        importId: 'import-1',
        received: 1,
        matched: 1,
        unmatched: 0,
        created: 1,
        skipped: 0,
      }),
    };
    const plex = {
      sync: jest.fn().mockRejectedValue(new Error('No reachable Plex server')),
      syncAccount: jest.fn().mockResolvedValue(cloudPayload),
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      { decrypt: jest.fn().mockReturnValue(credentials) } as any,
      integrationImport as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      plex as any,
    );

    await expect(service.sync('user-1', 'PLEX')).resolves.toEqual({
      provider: 'PLEX',
      importId: 'import-1',
      received: 1,
      matched: 1,
      unmatched: 0,
      created: 1,
      skipped: 0,
    });
    expect(plex.syncAccount).toHaveBeenCalledWith(credentials);
    expect(integrationImport.stageAndApply).toHaveBeenCalledWith(
      'integration-1',
      'user-1',
      'PLEX',
      cloudPayload.items,
      undefined,
      cloudPayload.snapshotScopes,
    );
  });
});

describe('IntegrationsService media open targets', () => {
  it('returns a Jellyfin details URL for a matched synced media item', async () => {
    const prisma = {
      userIntegration: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'integration-1',
            provider: 'JELLYFIN',
            connectedAt: new Date(),
            serverUrl: 'https://media.example.com/jellyfin',
            credentialsEncrypted: 'encrypted',
          },
        ]),
      },
      mediaItem: { findUnique: jest.fn().mockResolvedValue(null) },
      integrationSyncedItem: {
        findMany: jest.fn().mockResolvedValue([{ sourceKey: 'boxset:box-1:item:movie-1' }]),
      },
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.mediaOpenTargets('user-1', 'media-1')).resolves.toEqual([
      {
        provider: 'JELLYFIN',
        name: 'Jellyfin',
        url: 'https://media.example.com/jellyfin/web/#/details?id=movie-1',
      },
    ]);
    expect(prisma.integrationSyncedItem.findMany).toHaveBeenCalledWith({
      where: { integrationId: 'integration-1', mediaId: 'media-1' },
      orderBy: { lastSeenAt: 'desc' },
      select: { sourceKey: true },
    });
  });

  it('resolves an untouched media item against the connected Jellyfin library', async () => {
    const prisma = {
      userIntegration: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'integration-1',
            provider: 'JELLYFIN',
            connectedAt: new Date(),
            serverUrl: 'https://media.example.com/jellyfin',
            credentialsEncrypted: 'encrypted',
          },
        ]),
      },
      integrationSyncedItem: { findMany: jest.fn().mockResolvedValue([]) },
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({
          type: 'MOVIE',
          title: 'Library Movie',
          externalIds: [{ provider: 'TMDB', value: '10' }],
          movie: { releaseYear: 2025 },
          show: null,
        }),
      },
    };
    const secrets = {
      decrypt: jest.fn().mockReturnValue({
        serverUrl: 'https://media.example.com/jellyfin',
        accessToken: 'token',
        userId: 'jellyfin-user',
      }),
    };
    const jellyfin = { findLibraryItemId: jest.fn().mockResolvedValue('movie-2') };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      jellyfin as any,
      {} as any,
      {} as any,
    );

    await expect(service.mediaOpenTargets('user-1', 'media-2')).resolves.toEqual([
      {
        provider: 'JELLYFIN',
        name: 'Jellyfin',
        url: 'https://media.example.com/jellyfin/web/#/details?id=movie-2',
      },
    ]);
    expect(jellyfin.findLibraryItemId).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'jellyfin-user' }),
      expect.objectContaining({ mediaType: 'MOVIE', ids: { tmdb: 10 } }),
    );
  });

  it('returns a Swiftfin item link on iOS and keeps Jellyfin Web as the fallback', async () => {
    const prisma = {
      userIntegration: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'integration-1',
            provider: 'JELLYFIN',
            serverUrl: 'https://media.example.com/jellyfin',
            credentialsEncrypted: 'encrypted',
            syncSettings: { preferredOpenClient: 'SWIFTFIN' },
          },
        ]),
      },
      mediaItem: { findUnique: jest.fn().mockResolvedValue(null) },
      integrationSyncedItem: {
        findMany: jest.fn().mockResolvedValue([{ sourceKey: 'movie:movie-1:watched' }]),
      },
    };
    const secrets = {
      decrypt: jest.fn().mockReturnValue({
        serverUrl: 'https://media.example.com/jellyfin',
        accessToken: 'token',
        userId: 'user-1',
      }),
    };
    const jellyfin = { resolveServerId: jest.fn().mockResolvedValue('server-1') };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      jellyfin as any,
      {} as any,
      {} as any,
    );

    await expect(service.mediaOpenTargets('user-1', 'media-1', 'ios')).resolves.toEqual([
      {
        provider: 'JELLYFIN',
        name: 'Jellyfin',
        url: 'https://media.example.com/jellyfin/web/#/details?id=movie-1',
        nativeUrl: 'swiftfin://server-1/user-1/item/movie-1',
      },
    ]);
  });

  it('returns an Emby item link for Android unless Web is explicitly preferred', async () => {
    const integration = {
      id: 'integration-1',
      provider: 'EMBY',
      serverUrl: 'https://media.example.com/emby',
      credentialsEncrypted: 'encrypted',
      syncSettings: { preferredOpenClient: 'AUTO' },
    };
    const prisma = {
      userIntegration: { findMany: jest.fn().mockResolvedValue([integration]) },
      mediaItem: { findUnique: jest.fn().mockResolvedValue(null) },
      integrationSyncedItem: {
        findMany: jest.fn().mockResolvedValue([{ sourceKey: 'emby:movie:movie-1:watched' }]),
      },
    };
    const secrets = {
      decrypt: jest.fn().mockReturnValue({
        serverUrl: integration.serverUrl,
        accessToken: 'token',
        userId: 'user-1',
        serverId: 'server-1',
      }),
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.mediaOpenTargets('user-1', 'media-1', 'android')).resolves.toEqual([
      {
        provider: 'EMBY',
        name: 'Emby',
        url: 'https://media.example.com/web/index.html#!/item?id=movie-1&serverId=server-1',
        nativeUrl: 'emby://items/server-1/movie-1',
      },
    ]);

    integration.syncSettings.preferredOpenClient = 'WEB';
    await expect(service.mediaOpenTargets('user-1', 'media-1', 'android')).resolves.toEqual([
      {
        provider: 'EMBY',
        name: 'Emby',
        url: 'https://media.example.com/web/index.html#!/item?id=movie-1&serverId=server-1',
      },
    ]);
  });

  it('returns the Plex universal item link instead of a server-specific web route', async () => {
    const prisma = {
      userIntegration: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'integration-1',
            provider: 'PLEX',
            connectedAt: new Date(),
            serverUrl: 'https://plex.example.com',
            credentialsEncrypted: 'encrypted',
          },
        ]),
      },
      integrationSyncedItem: { findMany: jest.fn().mockResolvedValue([]) },
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({
          type: 'SHOW',
          title: 'Plex Show',
          externalIds: [{ provider: 'TMDB', value: '20' }],
          movie: null,
          show: { yearStart: 2025 },
        }),
      },
    };
    const secrets = {
      decrypt: jest.fn().mockReturnValue({
        accountToken: 'account-token',
        clientIdentifier: 'client-1',
        machineIdentifier: 'machine-1',
      }),
    };
    const plex = {
      findWatchUrl: jest.fn().mockResolvedValue('https://watch.plex.tv/show/plex-show'),
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      plex as any,
    );

    await expect(service.mediaOpenTargets('user-1', 'media-1')).resolves.toEqual([
      {
        provider: 'PLEX',
        name: 'Plex',
        url: 'https://watch.plex.tv/show/plex-show',
      },
    ]);
    expect(plex.findWatchUrl).toHaveBeenCalledWith(
      expect.objectContaining({ accountToken: 'account-token', clientIdentifier: 'client-1' }),
      expect.objectContaining({ mediaType: 'SHOW', ids: { tmdb: 20 } }),
    );
  });
});

describe('IntegrationsService settings', () => {
  it('stores an Open In client preference without resetting the sync cursor', async () => {
    const current = {
      movies: { watched: true, watchlist: true, favorites: false, ratings: false },
      shows: { watched: true, watchlist: true, favorites: false, ratings: false },
      collections: true,
    };
    const prisma = {
      userIntegration: {
        findUnique: jest.fn().mockResolvedValue({ id: 'integration-1', syncSettings: current }),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({
          ...data,
          _count: { syncedItems: 0 },
        })),
      },
    };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.updateSettings('user-1', 'EMBY', { preferredOpenClient: 'WEB' }),
    ).resolves.toEqual(expect.objectContaining({ preferredOpenClient: 'WEB' }));
    expect(prisma.userIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ syncCursor: expect.anything() }),
      }),
    );
    expect(prisma.userIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncSettings: expect.objectContaining({ preferredOpenClient: 'WEB' }),
        }),
      }),
    );
  });
});

describe('IntegrationsService disconnect', () => {
  it('removes credentials while preserving the integration row and its sync ledger', async () => {
    const prisma = {
      userIntegration: {
        findUnique: jest.fn().mockResolvedValue({ id: 'integration-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const secrets = { encrypt: jest.fn().mockReturnValue('encrypted-empty-credentials') };
    const service = new IntegrationsService(
      prisma as any,
      {} as any,
      secrets as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.disconnect('user-1', 'STREMIO')).resolves.toEqual({
      disconnected: true,
    });
    expect(prisma.userIntegration.update).toHaveBeenCalledWith({
      where: { id: 'integration-1' },
      data: {
        credentialsEncrypted: 'encrypted-empty-credentials',
        connectedAt: null,
        externalUserId: null,
        displayName: null,
        serverUrl: null,
        syncCursor: expect.anything(),
        lastSyncStatus: 'IDLE',
        lastSyncError: null,
        paused: true,
      },
    });
  });
});
