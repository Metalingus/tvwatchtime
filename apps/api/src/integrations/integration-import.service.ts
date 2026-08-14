import { Injectable } from '@nestjs/common';
import { ImportEntityType, IntegrationProvider } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ImportService } from '../import/import.service';
import { ImportMatcher } from '../import/lib/matcher';
import type { TraktIds } from '../import/lib/trakt/types';
import { IntegrationDataService } from './integration-data.service';
import type { InboundShowTrackingState, InboundSyncItem } from './providers/types';

function normalizedTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function jsonValue(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function mediaMatchKey(item: InboundSyncItem): string {
  return JSON.stringify([item.mediaType, item.ids, item.title, item.year ?? null]);
}

@Injectable()
export class IntegrationImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matcher: ImportMatcher,
    private readonly imports: ImportService,
    private readonly integrationData: IntegrationDataService,
  ) {}

  private async applyShowTrackingStates(
    userId: string,
    states: Array<{ mediaId: string; state: InboundShowTrackingState }>,
  ): Promise<void> {
    const byMedia = new Map(states.map((item) => [item.mediaId, item.state]));
    if (!byMedia.size) return;
    const pausedAt = new Date();
    const entries = [...byMedia.entries()];
    for (let start = 0; start < entries.length; start += 5000) {
      const batch = entries.slice(start, start + 5000);
      const idsFor = (state: InboundShowTrackingState) =>
        batch.filter(([, value]) => value === state).map(([mediaId]) => mediaId);
      const droppedIds = idsFor('DROPPED');
      const pausedIds = idsFor('PAUSED');
      const activeIds = idsFor('ACTIVE');
      const operations: any[] = [
        this.prisma.userShowStatus.createMany({
          data: batch.map(([mediaId, state]) => ({
            userId,
            mediaId,
            dropped: state === 'DROPPED',
            pausedAt: state === 'PAUSED' ? pausedAt : null,
          })),
          skipDuplicates: true,
        }),
      ];
      if (droppedIds.length) {
        operations.push(
          this.prisma.userShowStatus.updateMany({
            where: { userId, mediaId: { in: droppedIds } },
            data: { dropped: true, pausedAt: null },
          }),
        );
      }
      if (pausedIds.length) {
        operations.push(
          this.prisma.userShowStatus.updateMany({
            where: { userId, mediaId: { in: pausedIds } },
            data: { dropped: false, pausedAt },
          }),
        );
      }
      if (activeIds.length) {
        operations.push(
          this.prisma.userShowStatus.updateMany({
            where: { userId, mediaId: { in: activeIds } },
            data: { dropped: false, pausedAt: null },
          }),
        );
      }
      await this.prisma.$transaction(operations);
    }
  }

  async stageAndApply(
    integrationId: string,
    userId: string,
    provider: IntegrationProvider,
    items: InboundSyncItem[],
  ) {
    const showStateItems = items.filter(
      (
        item,
      ): item is InboundSyncItem & {
        entityType: 'SHOW_STATE';
        showState: InboundShowTrackingState;
      } => item.entityType === 'SHOW_STATE' && Boolean(item.showState),
    );
    const stagedItems = items.filter((item) => item.entityType !== 'SHOW_STATE');
    const format = provider.toLowerCase();
    const imp = await this.prisma.import.create({
      data: {
        userId,
        sourceType: 'json',
        format,
        originalFilename: `${format}-sync.json`,
        status: 'MATCHING',
        totalFiles: 1,
        totalRows: stagedItems.length,
        ratingsDetected: stagedItems.filter((item) => item.entityType.endsWith('_RATING')).length,
      },
    });

    const mediaMatches = new Map<
      string,
      { mediaId: string | null; confidence: number; matchedTitle: string | null }
    >();
    for (const item of items) {
      if (item.entityType === 'LIST') continue;
      const key = mediaMatchKey(item);
      if (mediaMatches.has(key)) continue;
      const match = await this.matcher.matchByExternalIds(
        item.ids as TraktIds,
        item.mediaType,
        item.title,
        normalizedTitle(item.title),
        item.year ?? null,
        null,
      );
      mediaMatches.set(key, match);
    }

    let matched = 0;
    let unmatched = 0;
    const rows: any[] = [];
    for (let index = 0; index < stagedItems.length; index++) {
      const item = stagedItems[index];
      const listMetadata = item.entityType === 'LIST';
      const key = listMetadata ? null : mediaMatchKey(item);
      const match = key ? mediaMatches.get(key) : undefined;
      let mediaId = match?.mediaId ?? null;
      let episodeId: string | null = null;
      const episodeScoped =
        item.entityType === 'WATCHED_EPISODE' || item.entityType === 'EPISODE_RATING';
      if (mediaId && episodeScoped) {
        episodeId = item.episodeIds
          ? await this.matcher.resolveEpisodeByExternalIds(mediaId, item.episodeIds as TraktIds)
          : null;
        if (
          !episodeId &&
          Number.isInteger(item.season) &&
          Number(item.season) > 0 &&
          Number.isInteger(item.episode) &&
          Number(item.episode) > 0
        ) {
          episodeId = await this.matcher.resolveEpisode(
            mediaId,
            Number(item.season),
            Number(item.episode),
          );
        }
      }
      const isMatched = listMetadata || Boolean(mediaId && (!episodeScoped || episodeId));
      if (isMatched) matched++;
      else unmatched++;
      if (!isMatched && episodeScoped) mediaId = match?.mediaId ?? null;

      rows.push({
        importId: imp.id,
        rowNumber: index + 1,
        sourceEntityType: item.entityType as ImportEntityType,
        targetEntityType: item.entityType as ImportEntityType,
        status: isMatched ? 'MATCHED' : 'UNMATCHED',
        rawData: jsonValue(item),
        normalizedData: jsonValue({
          title: item.title,
          showTitle: item.mediaType === 'SHOW' ? item.title : undefined,
          movieTitle: item.mediaType === 'MOVIE' ? item.title : undefined,
          year: item.year ?? null,
          season: item.season ?? null,
          episode: item.episode ?? null,
          watchedAt: item.watchedAt ?? null,
          watchCount: item.watchCount ?? 1,
          normalizedRating: item.rating ?? null,
          sourceCreatedAt: item.watchedAt ?? null,
          sourceUpdatedAt: item.watchedAt ?? null,
          voteKey: item.sourceKey,
          ...(item.entityType === 'LIST'
            ? {
                sourceKey: item.listKey ?? item.sourceKey,
                title: item.listTitle ?? item.title,
                description: null,
                visibility: 'PRIVATE',
              }
            : {}),
          ...(item.entityType === 'LIST_ITEM'
            ? {
                sourceKey: item.listKey ?? item.sourceKey,
                order: item.listOrder ?? index,
                mediaType: item.mediaType === 'MOVIE' ? 'movie' : 'series',
                createdAt: null,
              }
            : {}),
        }),
        matchedMediaId: mediaId,
        matchedEpisodeId: episodeId,
        confidenceScore: isMatched ? (listMetadata ? 1 : (match?.confidence ?? 1)) : 0,
        errorMessage: isMatched ? null : 'No trusted media or episode match',
      });
    }

    for (let start = 0; start < rows.length; start += 500) {
      await this.prisma.importItem.createMany({ data: rows.slice(start, start + 500) });
    }
    await this.prisma.import.update({
      where: { id: imp.id },
      data: {
        status: 'READY_FOR_REVIEW',
        progress: 100,
        matchedCount: matched,
        unmatchedCount: unmatched,
        processedAt: new Date(),
      },
    });
    const applied = await this.imports.confirm(userId, imp.id);
    const matchedShowStates = showStateItems.flatMap((item) => {
      const mediaId = mediaMatches.get(mediaMatchKey(item))?.mediaId;
      return mediaId ? [{ mediaId, state: item.showState }] : [];
    });
    if (matchedShowStates.length) {
      // SIMKL show state is deliberately authoritative, including over manual state. It is not
      // contribution-owned, so disabling or disconnecting SIMKL does not revert these flags.
      await this.applyShowTrackingStates(userId, matchedShowStates);
      await this.imports.invalidateImportedLibrary(userId);
    }
    await this.integrationData.recordSync(integrationId, userId, imp.id);
    return { ...applied, received: stagedItems.length, matched, unmatched };
  }
}
