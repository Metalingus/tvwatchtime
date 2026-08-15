import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ImportEntityType, IntegrationProvider, Prisma } from '@prisma/client';
import type {
  IntegrationConnectionResultDto,
  IntegrationDto,
  IntegrationOpenTargetDto,
  PlexServerSelectionDto,
  IntegrationSyncResultDto,
  UpdateIntegrationSettingsDto,
} from '@tvwatch/shared';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { IntegrationCredentialService } from './integration-credential.service';
import { IntegrationDataService } from './integration-data.service';
import { IntegrationImportService } from './integration-import.service';
import {
  jellyfinItemIdFromSourceKey,
  jellyfinWebUrl,
  JellyfinClient,
} from './providers/jellyfin.client';
import {
  embyItemIdFromSourceKey,
  embyWebUrl,
  EmbyClient,
  type EmbyCredentials,
} from './providers/emby.client';
import {
  plexItemKeyFromSourceKey,
  plexWebUrl,
  PlexClient,
  type PlexCredentials,
} from './providers/plex.client';
import {
  filterIntegrationItems,
  INTEGRATION_CAPABILITIES,
  mergeIntegrationSyncSettings,
  normalizeIntegrationSyncSettings,
} from './integration-settings';
import { SimklClient } from './providers/simkl.client';
import { StremioClient } from './providers/stremio.client';

type Credentials = Record<string, any>;
type PendingLink = {
  id?: string;
  code: string;
  clientIdentifier?: string;
  expiresAt: string;
  pollAfterSeconds: number;
  verificationUrl: string;
};
type IntegrationSyncOptions = {
  allowDisabled?: boolean;
  manualOverride?: boolean;
};
const FOREGROUND_SYNC_THROTTLE_MS = 15 * 60_000;
const LEGACY_JELLYFIN_FAVORITES: ImportEntityType[] = ['FAVORITE_SHOW', 'FAVORITE_MOVIE'];

function assertNeverProvider(provider: never): never {
  throw new BadRequestException(`Unsupported integration provider: ${String(provider)}`);
}

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly secrets: IntegrationCredentialService,
    private readonly integrationImport: IntegrationImportService,
    private readonly simkl: SimklClient,
    private readonly integrationData: IntegrationDataService,
    private readonly stremio: StremioClient,
    private readonly jellyfin: JellyfinClient,
    private readonly emby: EmbyClient,
    private readonly plex: PlexClient,
  ) {}

  private available(provider: IntegrationProvider): boolean {
    return provider !== 'SIMKL' || this.simkl.available;
  }

  private toDto(provider: IntegrationProvider, row?: any): IntegrationDto {
    return {
      provider,
      available: this.available(provider),
      connected: Boolean(row?.connectedAt),
      displayName: row?.displayName ?? null,
      serverUrl: row?.serverUrl ?? null,
      connectedAt: row?.connectedAt?.toISOString?.() ?? null,
      lastSyncedAt: row?.lastSyncedAt?.toISOString?.() ?? null,
      lastSyncStatus: (row?.lastSyncStatus ?? 'IDLE') as IntegrationDto['lastSyncStatus'],
      lastSyncError: row?.lastSyncError ?? null,
      lastImportId: row?.lastImportId ?? null,
      capabilities: INTEGRATION_CAPABILITIES[provider],
      paused: Boolean(row?.paused),
      itemsDisabled: Boolean(row?.itemsDisabled),
      syncedItemCount: row?._count?.syncedItems ?? 0,
      syncSettings: normalizeIntegrationSyncSettings(provider, row?.syncSettings),
    };
  }

  async list(userId: string): Promise<IntegrationDto[]> {
    const rows = await this.prisma.userIntegration.findMany({
      where: { userId },
      include: { _count: { select: { syncedItems: true } } },
    });
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    return (Object.values(IntegrationProvider) as IntegrationProvider[]).map((provider) =>
      this.toDto(provider, byProvider.get(provider)),
    );
  }

  async mediaOpenTargets(userId: string, mediaId: string): Promise<IntegrationOpenTargetDto[]> {
    const integrations = await this.prisma.userIntegration.findMany({
      where: {
        userId,
        provider: { in: ['JELLYFIN', 'EMBY', 'PLEX'] },
        connectedAt: { not: null },
      },
      select: {
        id: true,
        provider: true,
        serverUrl: true,
        credentialsEncrypted: true,
      },
    });
    if (!integrations.length) return [];
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: {
        type: true,
        title: true,
        externalIds: { select: { provider: true, value: true } },
        movie: { select: { releaseYear: true } },
        show: { select: { yearStart: true } },
      },
    });
    const valueFor = (provider: string) =>
      media?.externalIds.find((externalId) => externalId.provider === provider)?.value;
    const numericValueFor = (provider: string) => {
      const value = Number(valueFor(provider));
      return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    };
    const lookup = media
      ? {
          mediaType: media.type,
          title: media.title,
          year: media.type === 'MOVIE' ? media.movie?.releaseYear : media.show?.yearStart,
          ids: {
            imdb: valueFor('IMDB'),
            tmdb: numericValueFor('TMDB'),
            tvdb: numericValueFor('THE_TVDB'),
          },
        }
      : null;
    const targets: IntegrationOpenTargetDto[] = [];
    for (const integration of integrations) {
      const syncedItems = await this.prisma.integrationSyncedItem.findMany({
        where: { integrationId: integration.id, mediaId },
        orderBy: { lastSeenAt: 'desc' },
        select: { sourceKey: true },
      });
      if (integration.provider === 'JELLYFIN' && integration.serverUrl) {
        let itemId = syncedItems
          .map((item) => jellyfinItemIdFromSourceKey(item.sourceKey))
          .find((value): value is string => Boolean(value));
        if (!itemId && lookup) {
          try {
            const credentials = this.secrets.decrypt<Credentials>(integration.credentialsEncrypted);
            itemId =
              (await this.jellyfin.findLibraryItemId(
                {
                  serverUrl: String(credentials.serverUrl ?? integration.serverUrl),
                  accessToken: String(credentials.accessToken ?? ''),
                  userId: String(credentials.userId ?? ''),
                },
                lookup,
              )) ?? undefined;
          } catch {
            // Keep the connected provider visible with its server-root fallback.
          }
        }
        targets.push({
          provider: 'JELLYFIN',
          name: 'Jellyfin',
          url: jellyfinWebUrl(integration.serverUrl, itemId),
        });
      } else if (integration.provider === 'EMBY' && integration.serverUrl) {
        const credentials = this.secrets.decrypt<Credentials>(integration.credentialsEncrypted);
        const embyCredentials: EmbyCredentials = {
          serverUrl: String(credentials.serverUrl ?? integration.serverUrl),
          accessToken: String(credentials.accessToken ?? ''),
          userId: String(credentials.userId ?? ''),
          serverId: String(credentials.serverId ?? ''),
        };
        let itemId = syncedItems
          .map((item) => embyItemIdFromSourceKey(item.sourceKey))
          .find((value): value is string => Boolean(value));
        if (!itemId && lookup) {
          try {
            itemId = (await this.emby.findLibraryItemId(embyCredentials, lookup)) ?? undefined;
          } catch {
            // Keep the connected provider visible with its server-root fallback.
          }
        }
        targets.push({
          provider: 'EMBY',
          name: 'Emby',
          url: embyWebUrl(integration.serverUrl, embyCredentials.serverId, itemId),
        });
      } else if (integration.provider === 'PLEX') {
        const credentials = this.secrets.decrypt<Credentials>(integration.credentialsEncrypted);
        const plexCredentials = credentials as PlexCredentials;
        let item = syncedItems
          .map((entry) => plexItemKeyFromSourceKey(entry.sourceKey))
          .find((value) => Boolean(value));
        if (!item && lookup) {
          try {
            item = (await this.plex.findLibraryItem(plexCredentials, lookup)) ?? undefined;
          } catch {
            // Keep the connected provider visible with its account-root fallback.
          }
        }
        if (plexCredentials.machineIdentifier) {
          targets.push({
            provider: 'PLEX',
            name: 'Plex',
            url: plexWebUrl(plexCredentials.machineIdentifier, item),
          });
        }
      }
    }
    return targets;
  }

  async startLink(userId: string, provider: IntegrationProvider) {
    if (provider === 'JELLYFIN' || provider === 'EMBY') {
      throw new BadRequestException(`${provider} uses server credentials`);
    }
    if (!this.available(provider)) {
      throw new ServiceUnavailableException(`${provider} integration is not configured`);
    }
    let started:
      | Awaited<ReturnType<SimklClient['startLink']>>
      | Awaited<ReturnType<StremioClient['startLink']>>
      | Awaited<ReturnType<PlexClient['startLink']>>;
    switch (provider) {
      case 'SIMKL':
        started = await this.simkl.startLink();
        break;
      case 'STREMIO':
        started = await this.stremio.startLink();
        break;
      case 'PLEX':
        started = await this.plex.startLink();
        break;
      default:
        return assertNeverProvider(provider);
    }
    const existing = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    const credentials = existing
      ? this.secrets.decrypt<Credentials>(existing.credentialsEncrypted)
      : {};
    const pending: PendingLink = {
      ...('id' in started ? { id: started.id } : {}),
      code: started.code,
      ...('clientIdentifier' in started ? { clientIdentifier: started.clientIdentifier } : {}),
      verificationUrl: started.verificationUrl,
      expiresAt: started.expiresAt.toISOString(),
      pollAfterSeconds: started.pollAfterSeconds,
    };
    credentials.pending = pending;
    await this.prisma.userIntegration.upsert({
      where: { userId_provider: { userId, provider } },
      create: {
        userId,
        provider,
        credentialsEncrypted: this.secrets.encrypt(credentials),
      },
      update: { credentialsEncrypted: this.secrets.encrypt(credentials) },
    });
    return {
      provider,
      code: pending.code,
      verificationUrl: pending.verificationUrl,
      expiresAt: pending.expiresAt,
      pollAfterSeconds: pending.pollAfterSeconds,
    };
  }

  async completeLink(userId: string, provider: IntegrationProvider) {
    if (provider === 'JELLYFIN' || provider === 'EMBY') {
      throw new BadRequestException(`${provider} uses server credentials`);
    }
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) throw new NotFoundException('Integration connection was not started');
    const credentials = this.secrets.decrypt<Credentials>(row.credentialsEncrypted);
    const pending = credentials.pending as PendingLink | undefined;
    if (!pending || new Date(pending.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('The connection code expired; start again');
    }
    if (provider === 'PLEX') {
      if (!pending.id || !pending.clientIdentifier) {
        throw new BadRequestException('The Plex connection is invalid; start again');
      }
      const connected = await this.plex.completeLink({
        id: pending.id,
        code: pending.code,
        clientIdentifier: pending.clientIdentifier,
      });
      if (!connected.servers.length) {
        throw new BadRequestException('No accessible Plex Media Server was found');
      }
      await this.prisma.userIntegration.update({
        where: { id: row.id },
        data: {
          credentialsEncrypted: this.secrets.encrypt(connected.credentials),
          externalUserId: connected.credentials.accountId ?? null,
          displayName: connected.displayName,
          connectedAt: null,
          serverUrl: null,
          syncCursor: Prisma.DbNull,
          lastSyncStatus: 'IDLE',
          lastSyncError: null,
          paused: false,
          itemsDisabled: false,
        },
      });
      if (connected.servers.length === 1) {
        return this.selectPlexServer(userId, connected.servers[0].machineIdentifier);
      }
      const selection: PlexServerSelectionDto = {
        provider: 'PLEX',
        servers: connected.servers,
      };
      return selection;
    }
    let connectedCredentials: Credentials;
    switch (provider) {
      case 'SIMKL':
        connectedCredentials = { accessToken: await this.simkl.completeLink(pending.code) };
        break;
      case 'STREMIO':
        connectedCredentials = { authKey: await this.stremio.completeLink(pending.code) };
        break;
      default:
        return assertNeverProvider(provider);
    }
    await this.prisma.userIntegration.update({
      where: { id: row.id },
      data: {
        credentialsEncrypted: this.secrets.encrypt(connectedCredentials),
        connectedAt: new Date(),
        syncCursor: Prisma.DbNull,
        lastSyncStatus: 'IDLE',
        lastSyncError: null,
        paused: false,
        itemsDisabled: false,
      },
    });
    const result: IntegrationConnectionResultDto = { provider, connected: true };
    return result;
  }

  async connectJellyfin(
    userId: string,
    input: { serverUrl: string; username: string; password: string },
  ) {
    const connected = await this.jellyfin.connect(input.serverUrl, input.username, input.password);
    await this.prisma.userIntegration.upsert({
      where: { userId_provider: { userId, provider: 'JELLYFIN' } },
      create: {
        userId,
        provider: 'JELLYFIN',
        credentialsEncrypted: this.secrets.encrypt({
          serverUrl: connected.serverUrl,
          accessToken: connected.accessToken,
          userId: connected.userId,
        }),
        externalUserId: connected.userId,
        displayName: connected.displayName,
        serverUrl: connected.serverUrl,
        connectedAt: new Date(),
      },
      update: {
        credentialsEncrypted: this.secrets.encrypt({
          serverUrl: connected.serverUrl,
          accessToken: connected.accessToken,
          userId: connected.userId,
        }),
        externalUserId: connected.userId,
        displayName: connected.displayName,
        serverUrl: connected.serverUrl,
        connectedAt: new Date(),
        syncCursor: Prisma.DbNull,
        lastSyncStatus: 'IDLE',
        lastSyncError: null,
        paused: false,
        itemsDisabled: false,
      },
    });
    const result: IntegrationConnectionResultDto = { provider: 'JELLYFIN', connected: true };
    return result;
  }

  async connectEmby(
    userId: string,
    input: { serverUrl: string; username: string; password: string },
  ) {
    const connected = await this.emby.connect(input.serverUrl, input.username, input.password);
    const credentials: EmbyCredentials = {
      serverUrl: connected.serverUrl,
      accessToken: connected.accessToken,
      userId: connected.userId,
      serverId: connected.serverId,
    };
    await this.prisma.userIntegration.upsert({
      where: { userId_provider: { userId, provider: 'EMBY' } },
      create: {
        userId,
        provider: 'EMBY',
        credentialsEncrypted: this.secrets.encrypt(credentials),
        externalUserId: connected.userId,
        displayName: connected.displayName,
        serverUrl: connected.serverUrl,
        connectedAt: new Date(),
      },
      update: {
        credentialsEncrypted: this.secrets.encrypt(credentials),
        externalUserId: connected.userId,
        displayName: connected.displayName,
        serverUrl: connected.serverUrl,
        connectedAt: new Date(),
        syncCursor: Prisma.DbNull,
        lastSyncStatus: 'IDLE',
        lastSyncError: null,
        paused: false,
        itemsDisabled: false,
      },
    });
    const result: IntegrationConnectionResultDto = { provider: 'EMBY', connected: true };
    return result;
  }

  async selectPlexServer(userId: string, machineIdentifier: string) {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider: 'PLEX' } },
    });
    if (!row) throw new NotFoundException('Plex authorization was not started');
    const credentials = this.secrets.decrypt<PlexCredentials>(row.credentialsEncrypted);
    if (!credentials.accountToken || !credentials.clientIdentifier) {
      throw new BadRequestException('Plex authorization is incomplete');
    }
    const selectedCredentials: PlexCredentials = { ...credentials, machineIdentifier };
    const server = await this.plex.resolveServer(selectedCredentials);
    await this.prisma.userIntegration.update({
      where: { id: row.id },
      data: {
        credentialsEncrypted: this.secrets.encrypt(selectedCredentials),
        displayName: server.name,
        serverUrl: server.serverUrl,
        connectedAt: new Date(),
        syncCursor: Prisma.DbNull,
        lastSyncStatus: 'IDLE',
        lastSyncError: null,
        paused: false,
        itemsDisabled: false,
      },
    });
    const result: IntegrationConnectionResultDto = { provider: 'PLEX', connected: true };
    return result;
  }

  /** Bounded scheduled refresh for connected accounts whose last successful sync is stale. */
  async syncDue(): Promise<{
    selected: number;
    succeeded: number;
    failed: number;
    busy: number;
    created: number;
    skipped: number;
  }> {
    const configuredBatch = this.config.get<number>('jobs.integrationSyncBatchSize') ?? 25;
    const configuredHours = this.config.get<number>('jobs.integrationSyncStaleHours') ?? 6;
    const limit = Number.isFinite(configuredBatch)
      ? Math.max(1, Math.min(Math.trunc(configuredBatch), 250))
      : 25;
    const staleHours = Number.isFinite(configuredHours)
      ? Math.max(1, Math.min(configuredHours, 168))
      : 6;
    const staleBefore = new Date(Date.now() - staleHours * 60 * 60_000);
    const staleLease = new Date(Date.now() - 30 * 60_000);
    const rows = await this.prisma.userIntegration.findMany({
      where: {
        provider: { not: 'SIMKL' },
        connectedAt: { not: null },
        paused: false,
        itemsDisabled: false,
        AND: [
          { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }] },
          { OR: [{ lastSyncStatus: { not: 'SYNCING' } }, { updatedAt: { lt: staleLease } }] },
        ],
      },
      orderBy: [{ lastSyncedAt: 'asc' }, { updatedAt: 'asc' }],
      take: limit,
      select: { userId: true, provider: true },
    });

    let succeeded = 0;
    let failed = 0;
    let busy = 0;
    let created = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const result = await this.sync(row.userId, row.provider);
        succeeded++;
        created += result.created;
        skipped += result.skipped;
      } catch (error) {
        if (error instanceof ConflictException) busy++;
        else failed++;
      }
    }
    return { selected: rows.length, succeeded, failed, busy, created, skipped };
  }

  /** User-visible app launch/foreground refresh, independently throttled per integration. */
  async syncForeground(userId: string): Promise<{
    selected: number;
    succeeded: number;
    failed: number;
    busy: number;
    created: number;
    skipped: number;
  }> {
    const staleBefore = new Date(Date.now() - FOREGROUND_SYNC_THROTTLE_MS);
    const rows = await this.prisma.userIntegration.findMany({
      where: {
        userId,
        connectedAt: { not: null },
        paused: false,
        itemsDisabled: false,
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }],
      },
      orderBy: [{ lastSyncedAt: 'asc' }, { updatedAt: 'asc' }],
      select: { provider: true },
    });

    let succeeded = 0;
    let failed = 0;
    let busy = 0;
    let created = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        // Deliberately non-manual: SIMKL still checks activities and honors its own throttle.
        const result = await this.sync(userId, row.provider);
        succeeded++;
        created += result.created;
        skipped += result.skipped;
      } catch (error) {
        if (error instanceof ConflictException) busy++;
        else failed++;
      }
    }
    return { selected: rows.length, succeeded, failed, busy, created, skipped };
  }

  async sync(
    userId: string,
    provider: IntegrationProvider,
    options: IntegrationSyncOptions = {},
  ): Promise<IntegrationSyncResultDto> {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row?.connectedAt) throw new NotFoundException('Integration is not connected');
    const staleLease = new Date(Date.now() - 30 * 60_000);
    if (row.paused) {
      throw new BadRequestException('Integration sync is paused');
    }
    if (row.itemsDisabled && !options.allowDisabled) {
      throw new BadRequestException('Integration items are disabled');
    }
    const claimed = await this.prisma.userIntegration.updateMany({
      where: {
        id: row.id,
        OR: [{ lastSyncStatus: { not: 'SYNCING' } }, { updatedAt: { lt: staleLease } }],
      },
      data: { lastSyncStatus: 'SYNCING', lastSyncError: null },
    });
    if (!claimed.count) throw new ConflictException('Integration sync is already running');

    try {
      const credentials = this.secrets.decrypt<Credentials>(row.credentialsEncrypted);
      const cursor =
        row.syncCursor && typeof row.syncCursor === 'object'
          ? (row.syncCursor as Record<string, unknown>)
          : null;
      const settings = normalizeIntegrationSyncSettings(provider, row.syncSettings);
      let payload;
      switch (provider) {
        case 'SIMKL':
          payload = await this.simkl.sync(String(credentials.accessToken ?? ''), cursor, {
            forceActivityCheck: options.manualOverride,
          });
          break;
        case 'STREMIO':
          payload = await this.stremio.sync(String(credentials.authKey ?? ''));
          break;
        case 'JELLYFIN':
          payload = await this.jellyfin.sync(
            {
              serverUrl: String(credentials.serverUrl ?? ''),
              accessToken: String(credentials.accessToken ?? ''),
              userId: String(credentials.userId ?? ''),
            },
            { includeCollections: settings.collections },
          );
          break;
        case 'EMBY':
          payload = await this.emby.sync(
            {
              serverUrl: String(credentials.serverUrl ?? ''),
              accessToken: String(credentials.accessToken ?? ''),
              userId: String(credentials.userId ?? ''),
              serverId: String(credentials.serverId ?? ''),
            },
            { includeCollections: settings.collections },
          );
          break;
        case 'PLEX':
          payload = await this.plex.sync(credentials as PlexCredentials, {
            includeCollections: settings.collections,
          });
          break;
        default:
          return assertNeverProvider(provider);
      }
      if (provider === 'JELLYFIN') {
        // Older TVWatch builds mapped Jellyfin favorites to favorites. The successful
        // provider fetch above is the migration boundary; clear only those legacy
        // contributions before applying the new watchlist mapping.
        await this.integrationData.clear(userId, row.id, provider, true, LEGACY_JELLYFIN_FAVORITES);
      }
      const items = filterIntegrationItems(payload.items, settings);
      const applied = await this.integrationImport.stageAndApply(
        row.id,
        userId,
        provider,
        items,
        payload.snapshotEntityTypes,
        payload.snapshotScopes,
      );
      await this.prisma.userIntegration.update({
        where: { id: row.id },
        data: {
          syncCursor: payload.cursor ? (payload.cursor as Prisma.InputJsonValue) : Prisma.DbNull,
          lastSyncedAt: new Date(),
          lastSyncStatus: 'SUCCESS',
          lastSyncError: null,
          lastImportId: applied.importId,
        },
      });
      return { provider, ...applied };
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : 'Integration sync failed';
      await this.prisma.userIntegration
        .update({
          where: { id: row.id },
          data: { lastSyncStatus: 'FAILED', lastSyncError: message },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async disconnect(userId: string, provider: IntegrationProvider) {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (row) {
      if (provider === 'EMBY' && row.connectedAt) {
        const credentials = this.secrets.decrypt<EmbyCredentials>(row.credentialsEncrypted);
        await this.emby.logout(credentials).catch(() => undefined);
      }
      await this.prisma.userIntegration.update({
        where: { id: row.id },
        data: {
          credentialsEncrypted: this.secrets.encrypt({}),
          connectedAt: null,
          externalUserId: null,
          displayName: null,
          serverUrl: null,
          syncCursor: Prisma.DbNull,
          lastSyncStatus: 'IDLE',
          lastSyncError: null,
          paused: true,
        },
      });
    }
    return { disconnected: true };
  }
  async updateSettings(
    userId: string,
    provider: IntegrationProvider,
    input: UpdateIntegrationSettingsDto,
  ): Promise<IntegrationDto> {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) throw new NotFoundException('Integration has no synced data or settings');
    const syncSettings = mergeIntegrationSyncSettings(
      provider,
      row.syncSettings,
      input.syncSettings,
    );
    const updated = await this.prisma.userIntegration.update({
      where: { id: row.id },
      data: {
        ...(typeof input.paused === 'boolean' ? { paused: input.paused } : {}),
        syncSettings: syncSettings as unknown as Prisma.InputJsonValue,
        ...(input.syncSettings ? { syncCursor: Prisma.DbNull } : {}),
      },
      include: { _count: { select: { syncedItems: true } } },
    });
    return this.toDto(provider, updated);
  }

  async disableItems(userId: string, provider: IntegrationProvider) {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) throw new NotFoundException('Integration has no synced data');
    if (row.itemsDisabled) {
      return { provider, removed: 0, transferred: 0, preserved: 0, itemsDisabled: true };
    }
    await this.prisma.userIntegration.update({
      where: { id: row.id },
      data: { itemsDisabled: true, syncCursor: Prisma.DbNull },
    });
    return this.integrationData.clear(userId, row.id, provider, false);
  }

  async enableItems(
    userId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationSyncResultDto> {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row?.connectedAt) throw new NotFoundException('Integration is not connected');
    if (row.paused) throw new BadRequestException('Resume sync before enabling items');
    await this.prisma.userIntegration.update({
      where: { id: row.id },
      data: { itemsDisabled: false, syncCursor: Prisma.DbNull },
    });
    return this.sync(userId, provider, { allowDisabled: true, manualOverride: true });
  }

  async deleteSyncedItems(userId: string, provider: IntegrationProvider) {
    const row = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) throw new NotFoundException('Integration has no synced data');
    const result = await this.integrationData.clear(userId, row.id, provider, true);
    await this.prisma.userIntegration.update({
      where: { id: row.id },
      data: {
        itemsDisabled: true,
        syncCursor: Prisma.DbNull,
        lastImportId: null,
      },
    });
    return { ...result, itemsDisabled: true };
  }
}
