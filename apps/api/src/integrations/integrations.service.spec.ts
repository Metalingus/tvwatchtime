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

describe('IntegrationsService media open targets', () => {
  it('returns a Jellyfin details URL for a matched synced media item', async () => {
    const prisma = {
      userIntegration: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'integration-1',
          connectedAt: new Date(),
          serverUrl: 'https://media.example.com/jellyfin',
        }),
      },
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
        findUnique: jest.fn().mockResolvedValue({
          id: 'integration-1',
          connectedAt: new Date(),
          serverUrl: 'https://media.example.com/jellyfin',
          credentialsEncrypted: 'encrypted',
        }),
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
