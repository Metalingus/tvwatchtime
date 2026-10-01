import { OnEvent } from '@nestjs/event-emitter';
import { IDENTITY_PENDING_ERROR } from '../import/lib/structure-pending';
import { fenceIdentityWrite } from '../media-metadata/util/identity-write-fence';
import { Injectable } from '@nestjs/common';
import {
  ExternalProvider,
  ImportEntityType,
  IntegrationProvider,
  ProviderEntityKind,
} from '@prisma/client';
import { canonicalMediaId } from '../media-metadata/util/canonical-media';
import { PrismaService } from '../common/prisma/prisma.service';
import { ImportService } from '../import/import.service';
import { ImportMatcher } from '../import/lib/matcher';
import { IMPORT_LIMITS } from '../import/lib/limits';
import {
  type ProviderUsage,
  runWithProviderUsage,
} from '../media-metadata/providers/shared/provider-usage.context';
import type { TraktIds } from '../import/lib/trakt/types';
import { IntegrationDataService } from './integration-data.service';
import type {
  InboundEntityType,
  InboundShowTrackingState,
  InboundSyncItem,
  ProviderSnapshotScope,
} from './providers/types';
import { hasTrustedExternalId } from './providers/types';

/** Generic names ("Episode 3") prove nothing about which episode is meant. */
const GENERIC_EPISODE_TITLE = /^(episode|ep|chapter|part|capitulo|episodio|folge|épisode)s*d+$/i;

interface EpisodeGraph {
  /** TMDB/TVDB numbering agree (evaluated equivalent) or only one numbering exists. */
  unambiguousNumbering: boolean;
  /** Regular-season coordinate → episode id (null when the coordinate is duplicated). */
  byCoordinate: Map<string, string | null>;
  byTitle: Map<string, string[]>;
}

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

/** An id-less item may only match when the title match is near-certain. */
export const ID_LESS_MIN_CONFIDENCE = 0.9;

function externalRefs(item: InboundSyncItem): Array<{ provider: ExternalProvider; value: string }> {
  const refs: Array<{ provider: ExternalProvider; value: string }> = [];
  const numeric = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : null;
  const tmdb = numeric(item.ids?.tmdb);
  const tvdb = numeric(item.ids?.tvdb);
  const imdb = typeof item.ids?.imdb === 'string' ? item.ids.imdb.trim().toLowerCase() : '';
  if (tmdb) refs.push({ provider: ExternalProvider.TMDB, value: tmdb });
  if (tvdb) refs.push({ provider: ExternalProvider.THE_TVDB, value: tvdb });
  if (/^tt\d+$/.test(imdb)) refs.push({ provider: ExternalProvider.IMDB, value: imdb });
  return refs;
}

@Injectable()
export class IntegrationImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly matcher: ImportMatcher,
    private readonly imports: ImportService,
    private readonly integrationData: IntegrationDataService,
  ) {}

  @OnEvent('import.identity-applied', { async: true })
  async recordReconciledIdentity(payload: { importId: string; userId: string }) {
    const context = await this.prisma.importLog.findFirst({
      where: { importId: payload.importId, message: 'integration-source' },
      select: { metadata: true },
    });
    const integrationId = (context?.metadata as any)?.integrationId;
    if (typeof integrationId !== 'string') return;
    const integration = await this.prisma.userIntegration.findFirst({
      where: {
        id: integrationId,
        userId: payload.userId,
        connectedAt: { not: null },
        itemsDisabled: false,
      },
    });
    if (integration)
      await this.integrationData.recordSync(
        integration.id,
        payload.userId,
        integration.provider,
        payload.importId,
      );
  }

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
      await this.prisma.$transaction(async (tx) => {
        await fenceIdentityWrite(tx, { mediaIds: batch.map(([id]) => id), type: 'SHOW', userId });
        const operations: any[] = [
          tx.userShowStatus.createMany({
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
            tx.userShowStatus.updateMany({
              where: { userId, mediaId: { in: droppedIds } },
              data: { dropped: true, pausedAt: null },
            }),
          );
        }
        if (pausedIds.length) {
          operations.push(
            tx.userShowStatus.updateMany({
              where: { userId, mediaId: { in: pausedIds } },
              data: { dropped: false, pausedAt },
            }),
          );
        }
        if (activeIds.length) {
          operations.push(
            tx.userShowStatus.updateMany({
              where: { userId, mediaId: { in: activeIds } },
              data: { dropped: false, pausedAt: null },
            }),
          );
        }
        await Promise.all(operations);
      });
    }
  }

  /**
   * Match keys whose result is trustworthy enough to write into a user's library. An item that
   * carries external ids is trusted only when the matched (canonical) row owns one of them.
   * Title fallbacks that contradict or ignore the item's ids are rejected. An id-less item needs
   * a near-certain title match.
   */
  private async trustedMatchKeys(
    items: InboundSyncItem[],
    matches: Map<string, { mediaId: string | null; confidence: number }>,
  ): Promise<Set<string>> {
    const trusted = new Set<string>();
    const refs: Array<{
      key: string;
      mediaId: string;
      provider: ExternalProvider;
      kind: ProviderEntityKind;
      value: string;
    }> = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (item.entityType === 'LIST' || item.entityType === 'SHOW_STATE') continue;
      const key = mediaMatchKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const match = matches.get(key);
      if (!match?.mediaId) continue;
      const ids = externalRefs(item);
      if (!ids.length) {
        if (match.confidence >= ID_LESS_MIN_CONFIDENCE) trusted.add(key);
        continue;
      }
      const kind = item.mediaType === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
      for (const id of ids) refs.push({ key, mediaId: match.mediaId, kind, ...id });
    }
    const owners = new Map<string, string>();
    for (let i = 0; i < refs.length; i += 500) {
      const rows = await this.prisma.externalId.findMany({
        where: {
          OR: refs.slice(i, i + 500).map((ref) => ({
            provider: ref.provider,
            providerEntityKind: ref.kind,
            value: ref.value,
          })),
        },
        select: { mediaId: true, provider: true, providerEntityKind: true, value: true },
      });
      for (const row of rows)
        owners.set([row.provider, row.providerEntityKind, row.value].join('|'), row.mediaId);
    }
    const canonical = new Map<string, string>();
    for (const ref of refs) {
      if (trusted.has(ref.key)) continue;
      const owner = owners.get([ref.provider, ref.kind, ref.value].join('|'));
      if (!owner) continue;
      if (owner === ref.mediaId) {
        trusted.add(ref.key);
        continue;
      }
      if (!canonical.has(owner)) canonical.set(owner, await canonicalMediaId(this.prisma, owner));
      if (canonical.get(owner) === ref.mediaId) trusted.add(ref.key);
    }
    return trusted;
  }

  /**
   * Episode for a synced item whose episode ids did not resolve. Media servers number
   * episodes with whatever agent the user configured, so coordinates are trusted only where
   * TMDB/TVDB numbering cannot disagree. Elsewhere (anime, divergent or unknown structure):
   *   1. a unique, non-generic episode title on the show identifies the episode;
   *   2. otherwise the season/episode numbers count only when every synced episode of that
   *      show exists at its numbers locally (a numbering mismatch leaves gaps somewhere).
   * Anything else stays unmatched and is retried on the next sync.
   */
  private async fallbackEpisode(
    mediaId: string,
    item: InboundSyncItem,
    graphs: Map<string, Promise<EpisodeGraph>>,
    footprints: Map<string, Array<[number, number]>>,
  ): Promise<string | null> {
    const season = Number(item.season);
    const episode = Number(item.episode);
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode) || episode <= 0)
      return null;
    if (!graphs.has(mediaId)) graphs.set(mediaId, this.episodeGraph(mediaId));
    const graph = await graphs.get(mediaId)!;
    const title = item.episodeTitle?.trim();
    if (title && !GENERIC_EPISODE_TITLE.test(title)) {
      const hits = graph.byTitle.get(normalizedTitle(title)) ?? [];
      if (hits.length === 1) return hits[0];
    }
    const coordinate = graph.byCoordinate.get(`${season}:${episode}`) ?? null;
    if (!coordinate || graph.unambiguousNumbering) return coordinate;
    const footprint = footprints.get(mediaId) ?? [];
    return footprint.every(([s, e]) => !!graph.byCoordinate.get(`${s}:${e}`)) ? coordinate : null;
  }

  private async episodeGraph(mediaId: string): Promise<EpisodeGraph> {
    const show = await this.prisma.show.findUnique({
      where: { mediaId },
      select: { structureProvider: true, structureReason: true, structureRuleVersion: true },
    });
    const episodes = await this.prisma.episode.findMany({
      where: { structureState: 'ACTIVE', season: { show: { mediaId }, number: { gt: 0 } } },
      select: { id: true, number: true, title: true, season: { select: { number: true } } },
    });
    const byCoordinate = new Map<string, string | null>();
    const byTitle = new Map<string, string[]>();
    for (const ep of episodes) {
      if (ep.number <= 0) continue;
      const key = `${ep.season.number}:${ep.number}`;
      byCoordinate.set(key, byCoordinate.has(key) ? null : ep.id);
      const title = ep.title ? normalizedTitle(ep.title) : '';
      if (title) byTitle.set(title, [...(byTitle.get(title) ?? []), ep.id]);
    }
    return {
      unambiguousNumbering:
        show?.structureReason === 'TVDB_ONLY_FALLBACK' ||
        (show?.structureProvider === 'TMDB' &&
          show.structureReason === 'GENERAL_TMDB' &&
          (show.structureRuleVersion ?? 0) >= 1),
      byCoordinate,
      byTitle,
    };
  }

  async stageAndApply(
    integrationId: string,
    userId: string,
    provider: IntegrationProvider,
    items: InboundSyncItem[],
    snapshotEntityTypes?: InboundEntityType[],
    snapshotScopes?: ProviderSnapshotScope[],
  ) {
    const rejectedPlexItems =
      provider === 'PLEX'
        ? items.filter((item) => item.entityType !== 'LIST' && !hasTrustedExternalId(item.ids))
        : [];
    const rejectedPlexSourceKeys = new Set(rejectedPlexItems.map((item) => item.sourceKey));
    const acceptedItems = items.filter((item) => !rejectedPlexSourceKeys.has(item.sourceKey));
    const showStateItems = acceptedItems.filter(
      (
        item,
      ): item is InboundSyncItem & {
        entityType: 'SHOW_STATE';
        showState: InboundShowTrackingState;
      } => item.entityType === 'SHOW_STATE' && Boolean(item.showState),
    );
    const stagedItems = acceptedItems.filter((item) => item.entityType !== 'SHOW_STATE');
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

    await this.prisma.importLog.create({
      data: { importId: imp.id, message: 'integration-source', metadata: { integrationId } },
    });
    const mediaMatches = new Map<
      string,
      {
        mediaId: string | null;
        confidence: number;
        matchedTitle: string | null;
        identityPending?: boolean;
      }
    >();
    // Distinct identities match through the same bounded worker pool as file imports; provider
    // rate limiters stay authoritative, so this only removes idle waiting between items.
    const distinct = new Map<string, InboundSyncItem>();
    for (const item of acceptedItems) {
      if (item.entityType === 'LIST') continue;
      const key = mediaMatchKey(item);
      if (!distinct.has(key)) distinct.set(key, item);
    }
    const queue = [...distinct.entries()];
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const [key, item] = queue[next++];
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
    };
    const usage: ProviderUsage = {};
    const matchStartedAt = Date.now();
    await runWithProviderUsage(usage, async () => {
      await Promise.all(
        Array.from({ length: Math.min(IMPORT_LIMITS.MATCH_CONCURRENCY, queue.length) }, worker),
      );
    });
    // Accounting is best-effort: it must never fail or delay the import itself.
    try {
      await this.prisma.importLog.create({
        data: {
          importId: imp.id,
          message: 'provider-usage',
          metadata: { durationMs: Date.now() - matchStartedAt, providers: usage } as any,
        },
      });
    } catch {
      /* ignore */
    }
    const trusted = await this.trustedMatchKeys(acceptedItems, mediaMatches);

    // Synced episode footprint per trusted show: the "counts" evidence for ambiguous numbering.
    const footprints = new Map<string, Array<[number, number]>>();
    for (const item of stagedItems) {
      if (item.entityType !== 'WATCHED_EPISODE' && item.entityType !== 'EPISODE_RATING') continue;
      const key = mediaMatchKey(item);
      const mediaId = trusted.has(key) ? mediaMatches.get(key)?.mediaId : null;
      if (!mediaId || !(Number(item.season) > 0) || !(Number(item.episode) > 0)) continue;
      const list = footprints.get(mediaId) ?? [];
      list.push([Number(item.season), Number(item.episode)]);
      footprints.set(mediaId, list);
    }
    const graphs = new Map<string, Promise<EpisodeGraph>>();

    let matched = 0;
    let unmatched = 0;
    const rows: any[] = [];
    for (let index = 0; index < stagedItems.length; index++) {
      const item = stagedItems[index];
      const listMetadata = item.entityType === 'LIST';
      const key = listMetadata ? null : mediaMatchKey(item);
      const match = key ? mediaMatches.get(key) : undefined;
      // Never write a title guess into a library: untrusted matches stay unmatched and are
      // retried on the next sync, once the catalog knows the item's ids.
      // Identity-pending rows keep their target: they are never applied before repair.
      let mediaId =
        key && (trusted.has(key) || match?.identityPending) ? (match?.mediaId ?? null) : null;
      let episodeId: string | null = null;
      const episodeScoped =
        item.entityType === 'WATCHED_EPISODE' || item.entityType === 'EPISODE_RATING';
      if (mediaId && episodeScoped) {
        episodeId = item.episodeIds
          ? await this.matcher.resolveEpisodeByExternalIds(mediaId, item.episodeIds as TraktIds)
          : null;
        if (!episodeId) episodeId = await this.fallbackEpisode(mediaId, item, graphs, footprints);
      }
      const identityPending = match?.identityPending === true;
      const isMatched =
        listMetadata || (!identityPending && Boolean(mediaId && (!episodeScoped || episodeId)));
      if (isMatched) matched++;
      else unmatched++;
      if (!isMatched && episodeScoped && key && trusted.has(key)) mediaId = match?.mediaId ?? null;

      rows.push({
        importId: imp.id,
        rowNumber: index + 1,
        sourceEntityType: item.entityType as ImportEntityType,
        targetEntityType: item.entityType as ImportEntityType,
        status: identityPending ? 'PENDING_MATCH' : isMatched ? 'MATCHED' : 'UNMATCHED',
        rawData: jsonValue(item),
        normalizedData: jsonValue({
          episodeIds: item.episodeIds,
          title: item.title,
          showTitle: item.mediaType === 'SHOW' ? item.title : undefined,
          movieTitle: item.mediaType === 'MOVIE' ? item.title : undefined,
          year: item.year ?? null,
          season: item.season ?? null,
          episode: item.episode ?? null,
          episodeTitle: item.episodeTitle ?? null,
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
        errorMessage: identityPending
          ? IDENTITY_PENDING_ERROR
          : isMatched
            ? null
            : 'No trusted media or episode match',
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
      return mediaId && !this.matcher.isIdentityRepairPending?.(mediaId)
        ? [{ mediaId, state: item.showState }]
        : [];
    });
    if (matchedShowStates.length) {
      // SIMKL show state is deliberately authoritative, including over manual state. It is not
      // contribution-owned, so disabling or disconnecting SIMKL does not revert these flags.
      await this.applyShowTrackingStates(userId, matchedShowStates);
      await this.imports.invalidateImportedLibrary(
        userId,
        provider,
        matchedShowStates.map((item) => item.mediaId),
      );
    }
    await this.integrationData.recordSync(
      integrationId,
      userId,
      provider,
      imp.id,
      snapshotEntityTypes,
      snapshotScopes,
      [...rejectedPlexSourceKeys],
    );
    return { ...applied, received: stagedItems.length, matched, unmatched };
  }
}
