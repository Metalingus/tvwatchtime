import { Injectable } from '@nestjs/common';
import { ImportEntityType, IntegrationProvider, ListSource } from '@prisma/client';
import type { IntegrationDataActionResultDto } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { ImportService } from '../import/import.service';
import type { InboundEntityType, ProviderSnapshotScope } from './providers/types';

type Contribution = {
  sourceKey: string;
  entityType: ImportEntityType;
  mediaId: string | null;
  episodeId: string | null;
  targetRecordId: string | null;
};

const WATCHLIST_TYPES = new Set<ImportEntityType>(['WATCHLIST_SHOW', 'WATCHLIST_MOVIE']);
const FAVORITE_TYPES = new Set<ImportEntityType>(['FAVORITE_SHOW', 'FAVORITE_MOVIE']);
const RATING_TYPES = new Set<ImportEntityType>(['SHOW_RATING', 'MOVIE_RATING', 'EPISODE_RATING']);

function contributionKey(
  item: Pick<Contribution, 'entityType' | 'mediaId' | 'episodeId'> &
    Partial<Pick<Contribution, 'sourceKey' | 'targetRecordId'>>,
): string {
  if (item.entityType === 'LIST' || item.entityType === 'LIST_ITEM') {
    return `${item.entityType}:${item.targetRecordId ?? item.sourceKey ?? 'missing'}`;
  }
  return `${item.entityType}:${item.episodeId ?? item.mediaId ?? 'missing'}`;
}

function jsonSourceKey(rawData: unknown, normalizedData?: unknown): string | null {
  const raw = rawData && typeof rawData === 'object' ? (rawData as Record<string, unknown>) : {};
  const normalized =
    normalizedData && typeof normalizedData === 'object'
      ? (normalizedData as Record<string, unknown>)
      : {};
  const value = raw.sourceKey ?? normalized.voteKey;
  return typeof value === 'string' && value ? value : null;
}

@Injectable()
export class IntegrationDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportService,
  ) {}

  /**
   * Record matched contributions and, for explicitly complete entity scopes, retract only
   * provider contributions that were absent from the successful snapshot.
   */
  async recordSync(
    integrationId: string,
    userId: string,
    provider: IntegrationProvider,
    importId: string,
    snapshotEntityTypes: InboundEntityType[] = [],
    snapshotScopes: ProviderSnapshotScope[] = [],
    rejectedSourceKeys: string[] = [],
  ): Promise<void> {
    const items = await this.prisma.importItem.findMany({
      where: { importId },
      select: {
        sourceEntityType: true,
        rawData: true,
        normalizedData: true,
        matchedMediaId: true,
        matchedEpisodeId: true,
      },
    });

    const episodeIds = [
      ...new Set(items.map((item) => item.matchedEpisodeId).filter(Boolean)),
    ] as string[];
    const mediaIds = [
      ...new Set(items.map((item) => item.matchedMediaId).filter(Boolean)),
    ] as string[];
    const listSourceKeys = [
      ...new Set(
        items
          .filter((item) => ['LIST', 'LIST_ITEM'].includes(item.sourceEntityType))
          .map((item) => {
            const normalized =
              item.normalizedData && typeof item.normalizedData === 'object'
                ? (item.normalizedData as Record<string, unknown>)
                : {};
            return typeof normalized.sourceKey === 'string' ? normalized.sourceKey : null;
          })
          .filter(Boolean),
      ),
    ] as string[];
    const [episodes, movies, watchlist, favorites, episodeRatings, mediaRatings, lists] =
      await Promise.all([
        episodeIds.length
          ? this.prisma.userEpisodeStatus.findMany({
              where: { userId, episodeId: { in: episodeIds } },
              select: { id: true, episodeId: true },
            })
          : [],
        mediaIds.length
          ? this.prisma.userMovieStatus.findMany({
              where: { userId, mediaId: { in: mediaIds } },
              select: { id: true, mediaId: true },
            })
          : [],
        mediaIds.length
          ? this.prisma.watchlistItem.findMany({
              where: { userId, mediaId: { in: mediaIds } },
              select: { id: true, mediaId: true },
            })
          : [],
        mediaIds.length
          ? this.prisma.favorite.findMany({
              where: { userId, mediaId: { in: mediaIds } },
              select: { id: true, mediaId: true },
            })
          : [],
        episodeIds.length
          ? this.prisma.rating.findMany({
              where: { userId, episodeId: { in: episodeIds } },
              select: { id: true, episodeId: true },
            })
          : [],
        mediaIds.length
          ? this.prisma.rating.findMany({
              where: { userId, mediaId: { in: mediaIds } },
              select: { id: true, mediaId: true },
            })
          : [],
        listSourceKeys.length
          ? this.prisma.customList.findMany({
              where: {
                userId,
                source: provider as ListSource,
                sourceKey: { in: listSourceKeys },
              },
              select: {
                id: true,
                sourceKey: true,
                items: { select: { id: true, mediaId: true } },
              },
            })
          : [],
      ]);

    const episodeMap = new Map(episodes.map((row) => [row.episodeId, row.id]));
    const movieMap = new Map(movies.map((row) => [row.mediaId, row.id]));
    const watchlistMap = new Map(watchlist.map((row) => [row.mediaId, row.id]));
    const favoriteMap = new Map(favorites.map((row) => [row.mediaId, row.id]));
    const episodeRatingMap = new Map(episodeRatings.map((row) => [row.episodeId, row.id]));
    const mediaRatingMap = new Map(mediaRatings.map((row) => [row.mediaId, row.id]));
    const listMap = new Map(lists.map((row) => [row.sourceKey, row]));
    const listItemMap = new Map(
      lists.flatMap((list) =>
        list.items.map((item) => [`${list.sourceKey}:${item.mediaId}`, item.id] as const),
      ),
    );
    const now = new Date();
    const rows = new Map<string, any>();
    const seenSourceKeys = new Set<string>();

    for (const item of items) {
      const sourceKey = jsonSourceKey(item.rawData, item.normalizedData);
      if (!sourceKey) continue;
      const entityType = item.sourceEntityType;
      seenSourceKeys.add(sourceKey);
      let targetRecordId: string | null = null;
      if (entityType === 'WATCHED_EPISODE' && item.matchedEpisodeId) {
        targetRecordId = episodeMap.get(item.matchedEpisodeId) ?? null;
      } else if (entityType === 'WATCHED_MOVIE' && item.matchedMediaId) {
        targetRecordId = movieMap.get(item.matchedMediaId) ?? null;
      } else if (WATCHLIST_TYPES.has(entityType) && item.matchedMediaId) {
        targetRecordId = watchlistMap.get(item.matchedMediaId) ?? null;
      } else if (FAVORITE_TYPES.has(entityType) && item.matchedMediaId) {
        targetRecordId = favoriteMap.get(item.matchedMediaId) ?? null;
      } else if (RATING_TYPES.has(entityType)) {
        targetRecordId = item.matchedEpisodeId
          ? (episodeRatingMap.get(item.matchedEpisodeId) ?? null)
          : (mediaRatingMap.get(item.matchedMediaId!) ?? null);
      } else if (entityType === 'LIST') {
        const normalized = item.normalizedData as Record<string, unknown> | null;
        const listKey = typeof normalized?.sourceKey === 'string' ? normalized.sourceKey : null;
        targetRecordId = listKey ? (listMap.get(listKey)?.id ?? null) : null;
      } else if (entityType === 'LIST_ITEM' && item.matchedMediaId) {
        const normalized = item.normalizedData as Record<string, unknown> | null;
        const listKey = typeof normalized?.sourceKey === 'string' ? normalized.sourceKey : null;
        targetRecordId = listKey
          ? (listItemMap.get(`${listKey}:${item.matchedMediaId}`) ?? null)
          : null;
      }
      const recordable =
        entityType === 'LIST'
          ? Boolean(targetRecordId)
          : Boolean(item.matchedMediaId && targetRecordId);
      if (!recordable) continue;
      rows.set(sourceKey, {
        integrationId,
        sourceKey,
        entityType,
        mediaId: item.matchedMediaId,
        episodeId: item.matchedEpisodeId,
        targetRecordId,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }

    const sourceKeys = [...rows.keys()];
    const snapshotTypes = snapshotEntityTypes as ImportEntityType[];
    const rejectedKeys = [...new Set(rejectedSourceKeys.filter(Boolean))];
    const scopedSnapshots = snapshotScopes.map((scope) => ({
      entityType: scope.entityType as ImportEntityType,
      sourceKeyPrefix: scope.sourceKeyPrefix,
    }));
    const inCompleteSnapshot = (item: { entityType: ImportEntityType; sourceKey: string }) =>
      snapshotTypes.includes(item.entityType) ||
      scopedSnapshots.some(
        (scope) =>
          scope.entityType === item.entityType && item.sourceKey.startsWith(scope.sourceKeyPrefix),
      );
    const snapshotFilters = [
      ...(snapshotTypes.length ? [{ entityType: { in: snapshotTypes } }] : []),
      ...scopedSnapshots.map((scope) => ({
        entityType: scope.entityType,
        sourceKey: { startsWith: scope.sourceKeyPrefix },
      })),
      ...(rejectedKeys.length ? [{ sourceKey: { in: rejectedKeys } }] : []),
    ];
    if (snapshotFilters.length) {
      const previous = await this.prisma.integrationSyncedItem.findMany({
        where: { integrationId, OR: snapshotFilters },
        select: {
          sourceKey: true,
          entityType: true,
          mediaId: true,
          episodeId: true,
          targetRecordId: true,
        },
      });
      const currentContributionKeys = new Set(
        [...rows.values()]
          .filter((row) => inCompleteSnapshot(row))
          .map((row) => contributionKey(row)),
      );
      const stale = previous.filter((item) => !seenSourceKeys.has(item.sourceKey));
      const replaced = stale.filter((item) => currentContributionKeys.has(contributionKey(item)));
      const removed = stale.filter((item) => !currentContributionKeys.has(contributionKey(item)));
      if (replaced.length) {
        await this.prisma.integrationSyncedItem.deleteMany({
          where: { integrationId, sourceKey: { in: replaced.map((item) => item.sourceKey) } },
        });
      }
      if (removed.length) {
        await this.clearBySourceKeys(
          userId,
          integrationId,
          provider,
          removed.map((item) => item.sourceKey),
        );
      }
    }
    if (!sourceKeys.length) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.integrationSyncedItem.deleteMany({
        where: { integrationId, sourceKey: { in: sourceKeys } },
      });
      await tx.integrationSyncedItem.createMany({ data: [...rows.values()] });
    });
    const unmatchedSeen = [...seenSourceKeys].filter((sourceKey) => !rows.has(sourceKey));
    for (let start = 0; start < unmatchedSeen.length; start += 1000) {
      await this.prisma.integrationSyncedItem.updateMany({
        where: { integrationId, sourceKey: { in: unmatchedSeen.slice(start, start + 1000) } },
        data: { lastSeenAt: now },
      });
    }
  }

  private clearBySourceKeys(
    userId: string,
    integrationId: string,
    provider: IntegrationProvider,
    sourceKeys: string[],
  ) {
    return this.clear(userId, integrationId, provider, true, undefined, sourceKeys);
  }

  /**
   * Remove one provider's active contribution. MANUAL/TVTIME records are preserved. When
   * another enabled integration supplies the same item, ownership is transferred instead.
   */
  async clear(
    userId: string,
    integrationId: string,
    provider: IntegrationProvider,
    forget: boolean,
    entityTypes?: ImportEntityType[],
    sourceKeys?: string[],
  ): Promise<IntegrationDataActionResultDto> {
    const entityTypeFilter = entityTypes?.length ? { entityType: { in: entityTypes } } : {};
    const sourceKeyFilter = sourceKeys?.length ? { sourceKey: { in: sourceKeys } } : {};
    const current = await this.prisma.integrationSyncedItem.findMany({
      where: { integrationId, ...entityTypeFilter, ...sourceKeyFilter },
      select: {
        sourceKey: true,
        entityType: true,
        mediaId: true,
        episodeId: true,
        targetRecordId: true,
      },
    });
    const others = await this.prisma.integrationSyncedItem.findMany({
      where: {
        integrationId: { not: integrationId },
        ...entityTypeFilter,
        integration: { userId, itemsDisabled: false, connectedAt: { not: null } },
      },
      select: {
        sourceKey: true,
        entityType: true,
        mediaId: true,
        episodeId: true,
        targetRecordId: true,
        integration: { select: { provider: true } },
      },
    });
    const fallbackByKey = new Map<string, { provider: ListSource; sourceKey: string | null }>();
    for (const item of others) {
      const key = contributionKey(item);
      if (!fallbackByKey.has(key)) {
        fallbackByKey.set(key, {
          provider: item.integration.provider as ListSource,
          sourceKey: item.sourceKey,
        });
      }
    }

    // A completed TV Time import is authoritative even if its matched row was skipped
    // because this provider had already created the target record.
    const watchedEpisodeIds = [
      ...new Set(
        current
          .filter((item) => item.entityType === 'WATCHED_EPISODE')
          .map((item) => item.episodeId)
          .filter(Boolean),
      ),
    ] as string[];
    const watchedMovieIds = [
      ...new Set(
        current
          .filter((item) => item.entityType === 'WATCHED_MOVIE')
          .map((item) => item.mediaId)
          .filter(Boolean),
      ),
    ] as string[];
    const tvTimeItems =
      watchedEpisodeIds.length || watchedMovieIds.length
        ? await this.prisma.importItem.findMany({
            where: {
              import: { userId, format: 'tvtime', status: 'COMPLETED' },
              OR: [
                ...(watchedEpisodeIds.length
                  ? [
                      {
                        sourceEntityType: 'WATCHED_EPISODE' as ImportEntityType,
                        matchedEpisodeId: { in: watchedEpisodeIds },
                      },
                    ]
                  : []),
                ...(watchedMovieIds.length
                  ? [
                      {
                        sourceEntityType: 'WATCHED_MOVIE' as ImportEntityType,
                        matchedMediaId: { in: watchedMovieIds },
                      },
                    ]
                  : []),
              ],
            },
            select: {
              sourceEntityType: true,
              matchedMediaId: true,
              matchedEpisodeId: true,
              rawData: true,
              normalizedData: true,
            },
          })
        : [];
    for (const item of tvTimeItems) {
      fallbackByKey.set(
        contributionKey({
          entityType: item.sourceEntityType,
          mediaId: item.matchedMediaId,
          episodeId: item.matchedEpisodeId,
        }),
        { provider: 'TVTIME', sourceKey: jsonSourceKey(item.rawData, item.normalizedData) },
      );
    }

    let removed = 0;
    let transferred = 0;
    let preserved = 0;
    const affectedShowIds = new Set<string>();
    const processed = new Set<string>();
    const providerSource = provider as ListSource;
    current.sort((a, b) => {
      const rank = (entityType: ImportEntityType) =>
        entityType === 'LIST_ITEM' ? 0 : entityType === 'LIST' ? 2 : 1;
      return rank(a.entityType) - rank(b.entityType);
    });

    for (const item of current) {
      const key = contributionKey(item);
      if (processed.has(key)) continue;
      processed.add(key);
      const fallback = fallbackByKey.get(key);
      const transfer = fallback
        ? { source: fallback.provider, sourceKey: fallback.sourceKey }
        : null;

      if (item.entityType === 'LIST_ITEM' && item.targetRecordId) {
        const target = await this.prisma.customListItem.findUnique({
          where: { id: item.targetRecordId },
          select: { id: true, list: { select: { userId: true, source: true } } },
        });
        if (!target || target.list.userId !== userId || target.list.source !== providerSource) {
          preserved++;
          continue;
        }
        await this.prisma.customListItem.delete({ where: { id: target.id } });
        removed++;
        continue;
      }

      if (item.entityType === 'LIST' && item.targetRecordId) {
        const target = await this.prisma.customList.findUnique({
          where: { id: item.targetRecordId },
          select: { id: true, userId: true, source: true },
        });
        if (!target || target.userId !== userId || target.source !== providerSource) {
          preserved++;
          continue;
        }
        await this.prisma.customList.delete({ where: { id: target.id } });
        removed++;
        continue;
      }

      if (item.entityType === 'WATCHED_EPISODE' && item.episodeId) {
        const target = await this.prisma.userEpisodeStatus.findUnique({
          where: { userId_episodeId: { userId, episodeId: item.episodeId } },
          select: { id: true, source: true },
        });
        if (!target || target.source !== providerSource) {
          preserved++;
          continue;
        }
        if (item.mediaId) affectedShowIds.add(item.mediaId);
        if (transfer) {
          await this.prisma.$transaction([
            this.prisma.userEpisodeStatus.update({ where: { id: target.id }, data: transfer }),
            this.prisma.watchHistory.updateMany({
              where: { userId, source: providerSource, sourceKey: item.sourceKey },
              data: transfer,
            }),
          ]);
          transferred++;
        } else {
          await this.prisma.$transaction([
            this.prisma.watchHistory.deleteMany({
              where: { userId, source: providerSource, sourceKey: item.sourceKey },
            }),
            this.prisma.userEpisodeStatus.delete({ where: { id: target.id } }),
          ]);
          removed++;
        }
        continue;
      }

      if (item.entityType === 'WATCHED_MOVIE' && item.mediaId) {
        const target = await this.prisma.userMovieStatus.findUnique({
          where: { userId_mediaId: { userId, mediaId: item.mediaId } },
          select: { id: true, source: true },
        });
        if (!target || target.source !== providerSource) {
          preserved++;
          continue;
        }
        if (transfer) {
          await this.prisma.$transaction([
            this.prisma.userMovieStatus.update({ where: { id: target.id }, data: transfer }),
            this.prisma.watchHistory.updateMany({
              where: { userId, source: providerSource, sourceKey: item.sourceKey },
              data: transfer,
            }),
          ]);
          transferred++;
        } else {
          await this.prisma.$transaction([
            this.prisma.watchHistory.deleteMany({
              where: { userId, source: providerSource, sourceKey: item.sourceKey },
            }),
            this.prisma.userMovieStatus.delete({ where: { id: target.id } }),
          ]);
          removed++;
        }
        continue;
      }

      const target = await this.targetFor(userId, item);
      if (!target || target.source !== providerSource) {
        preserved++;
        continue;
      }
      if (WATCHLIST_TYPES.has(item.entityType)) {
        if (transfer)
          await this.prisma.watchlistItem.update({ where: { id: target.id }, data: transfer });
        else await this.prisma.watchlistItem.delete({ where: { id: target.id } });
      } else if (FAVORITE_TYPES.has(item.entityType)) {
        if (transfer)
          await this.prisma.favorite.update({ where: { id: target.id }, data: transfer });
        else await this.prisma.favorite.delete({ where: { id: target.id } });
      } else if (RATING_TYPES.has(item.entityType)) {
        if (transfer) await this.prisma.rating.update({ where: { id: target.id }, data: transfer });
        else await this.prisma.rating.delete({ where: { id: target.id } });
      } else {
        preserved++;
        continue;
      }
      if (transfer) transferred++;
      else removed++;
    }

    if (forget) {
      await this.prisma.integrationSyncedItem.deleteMany({
        where: { integrationId, ...entityTypeFilter, ...sourceKeyFilter },
      });
    }
    if (affectedShowIds.size) {
      await this.imports.rebuildShowStatusesForMediaIds(userId, [...affectedShowIds]);
    }
    await this.imports.invalidateImportedLibrary(userId);
    return { provider, removed, transferred, preserved, itemsDisabled: !forget };
  }

  private async targetFor(userId: string, item: Contribution) {
    if (WATCHLIST_TYPES.has(item.entityType) && item.mediaId) {
      return this.prisma.watchlistItem.findUnique({
        where: { userId_mediaId: { userId, mediaId: item.mediaId } },
        select: { id: true, source: true },
      });
    }
    if (FAVORITE_TYPES.has(item.entityType) && item.mediaId) {
      return this.prisma.favorite.findUnique({
        where: { userId_mediaId: { userId, mediaId: item.mediaId } },
        select: { id: true, source: true },
      });
    }
    if (RATING_TYPES.has(item.entityType)) {
      if (item.episodeId) {
        return this.prisma.rating.findUnique({
          where: { userId_episodeId: { userId, episodeId: item.episodeId } },
          select: { id: true, source: true },
        });
      }
      if (item.mediaId) {
        return this.prisma.rating.findUnique({
          where: { userId_mediaId: { userId, mediaId: item.mediaId } },
          select: { id: true, source: true },
        });
      }
    }
    return null;
  }
}
