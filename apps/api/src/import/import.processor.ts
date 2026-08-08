import { Injectable, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ImportStatus, ImportEntityType, NotificationCategory } from '@prisma/client';
import { ExternalProvider, ProviderEntityKind, type SupportedLocale } from '@tvwatch/shared';
import { RedisService } from '../common/redis/redis.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { runInLanguage } from '../common/language.context';
import { IMPORT_LIMITS } from './lib/limits';
import { ImportStorage } from './lib/storage';
import { inspectZip, type ZipEntry } from './lib/zip-validator';
import { parseCsv } from './lib/csv';
import {
  detectProfile,
  normalizeNumericExternalId,
  normalizeRow,
  normTitle,
  type NormalizedItem,
} from './lib/inference';
import { ArchiveIdentityIndex, archiveShowPartitionKey } from './lib/archive-identity';
import {
  ImportMatcher,
  needsTvdbRehydration,
  type MovieReclassificationMatch,
  type NumberedMovieGroupMatch,
  numberedMovieCoordinateKey,
} from './lib/matcher';
import { HydrationQueue } from '../media-metadata/hydration/hydration.queue';
import { NotificationService } from '../notifications/notification.service';
import {
  buildMovieUuidNameMap,
  buildSeriesIdNameMap,
  isListsFile,
  normalizeLists,
} from './lib/lists';
import { normalizeRatings, dedupeRatings, type NormalizedImportedRating } from './lib/ratings';
import { normalizeEmotions, dedupeEmotions, type NormalizedImportedEmotion } from './lib/emotions';
import {
  normalizeCharacterVotes,
  dedupeCharacterVotes,
  type NormalizedCharacterVote,
} from './lib/character-votes';
import {
  resolveArchiveOwner,
  resolveArchiveLanguage,
  normalizeComments,
  dedupeComments,
  commentIdentity,
  type NormalizedImportedComment,
} from './lib/comments';
import {
  isTraktArchive,
  classifyTraktFile,
  resolveTraktArchiveLanguage,
  type TraktFileKind,
} from './lib/trakt/detect';
import { normalizeTraktWatched } from './lib/trakt/watched';
import { normalizeTraktRatings } from './lib/trakt/ratings';
import {
  normalizeTraktWatchlist,
  normalizeTraktFavorites,
  normalizeTraktLists,
} from './lib/trakt/lists';
import { normalizeTraktComments } from './lib/trakt/comments';
import type { TraktIds } from './lib/trakt/types';
import {
  isTvTimeJsonArchive,
  isTvTimeJsonStandaloneFile,
  classifyTvTimeJsonFile,
  type TvTimeJsonFileKind,
} from './lib/tvtime-json/detect';
import { normalizeTvTimeJsonShows } from './lib/tvtime-json/shows';
import { normalizeTvTimeJsonMovies } from './lib/tvtime-json/movies';
import { normalizeTvTimeJsonFavorites } from './lib/tvtime-json/favorites';
import { normalizeTvTimeJsonLists } from './lib/tvtime-json/lists';
import { normalizeTvTimeJsonRatings } from './lib/tvtime-json/ratings';
import { normalizeTvTimeWatchlistCsv } from './lib/tvtime-json/activity';
import { mediaKey } from './lib/tvtime-json/types';
import {
  isTvTimeOutArchive,
  isTvTimeOutStandaloneFile,
  classifyTvTimeOutFile,
  type TvTimeOutFileKind,
} from './lib/tvtime-out/detect';
import { normalizeTvTimeOutSeries } from './lib/tvtime-out/series';
import { normalizeTvTimeOutMovies } from './lib/tvtime-out/movies';
import { normalizeTvTimeOutFailed } from './lib/tvtime-out/failed';
import {
  reconcileTvTimeLegacyMainItems,
  shouldSuppressLegacyExtraTitle,
} from './lib/tvtime-legacy';

export const IMPORT_QUEUE = 'imports';

export function canUseEpisodeCoordinateFallback(
  aliasWasEvaluatedForMatchedMedia: boolean,
  season: number | null | undefined,
  episode: number | null | undefined,
): boolean {
  return !aliasWasEvaluatedForMatchedMedia && season != null && episode != null;
}

interface ParsedFile {
  filename: string;
  size: number;
  headers: string[];
  rows: Record<string, string>[];
}

@Injectable()
export class ImportProcessor implements OnModuleInit {
  private readonly logger = new Logger(ImportProcessor.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly storage: ImportStorage,
    private readonly matcher: ImportMatcher,
    private readonly hydrationQueue: HydrationQueue,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  onModuleInit() {
    // bullmq resolves its own ioredis; cast to avoid a duplicate-version type clash.
    const connection = this.redis.client as any;
    this.queue = new Queue(IMPORT_QUEUE, { connection });
    this.worker = new Worker(IMPORT_QUEUE, async (job) => this.run(job.data.importId as string), {
      connection,
      concurrency: IMPORT_LIMITS.WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) =>
      this.logger.error(`Import job ${job?.id} failed: ${err.message}`),
    );
  }

  enqueue(importId: string) {
    return this.queue.add('import', { importId }, { attempts: 1, removeOnComplete: true });
  }

  private async setStatus(
    importId: string,
    status: ImportStatus,
    extra: Record<string, unknown> = {},
  ) {
    // Stamps the processing end time once — drives the "Succeeded in X" review banner.
    const processedAt = status === 'READY_FOR_REVIEW' ? { processedAt: new Date() } : {};
    await this.prisma.import.update({
      where: { id: importId },
      data: { status, ...processedAt, ...extra },
    });
  }

  /** Raw parser errors (malformed CSV quoting etc.) are meaningless to users —
   *  translate the common ones into actionable messages; the rest pass through. */
  private friendlyImportError(e: Error): string {
    const msg = e.message ?? '';
    if (/invalid (closing|opening) quote/i.test(msg)) {
      return 'One of the files in this archive is malformed (broken CSV quoting). Try re-downloading your export and uploading again.';
    }
    return msg.slice(0, 1000);
  }

  /**
   * Final status after processing. An upload that produced ZERO rows AND zero staged
   * items (unrecognized/unsupported content only — e.g. a random JSON upload) used to
   * land on a confusing empty review screen; fail it fast with a clear message instead.
   */
  private async finishProcessing(importId: string, payload: Record<string, any>) {
    const n = (k: string) => Number(payload[k]) || 0;
    const staged =
      n('matchedCount') + n('needsReviewCount') + n('unmatchedCount') + n('duplicateCount');
    const extras =
      n('ratingsDetected') +
      n('emotionsDetected') +
      n('commentRowsDetected') +
      n('characterVotesDetected');
    if (n('totalRows') === 0 && staged === 0 && extras === 0) {
      await this.setStatus(importId, 'FAILED', {
        errorMessage:
          'No recognizable data found in this upload. Check that you exported from a supported service (TV Time / Trakt) and try again.',
      });
      return;
    }
    await this.setStatus(importId, 'READY_FOR_REVIEW', payload);
    await this.notifyImportReady(importId);
  }

  private async notifyImportReady(importId: string) {
    if (!this.notifications) return;
    try {
      const imp = await this.prisma.import.findUnique({
        where: { id: importId },
        select: { userId: true },
      });
      if (!imp) return;
      await this.notifications.createForUser(imp.userId, {
        category: NotificationCategory.SYSTEM,
        title: 'Your import is ready',
        body: 'Processing is complete. Review any items that need attention, then confirm your import.',
        link: `/import?importId=${encodeURIComponent(importId)}`,
        dedupeKey: `import-ready:${importId}`,
        push: true,
      });
    } catch (error) {
      // A notification failure must never turn an otherwise successful import into a failure.
      this.logger.warn(
        `Could not notify the user that import ${importId} is ready: ${(error as Error).message}`,
      );
    }
  }

  /** Row-backed status counters for the review summary (extras included). */
  private async statusCounts(importId: string) {
    const groups = await this.prisma.importItem.groupBy({
      by: ['status'],
      where: { importId },
      _count: { _all: true },
    });
    const c: Record<string, number> = {};
    for (const g of groups) c[g.status] = g._count._all;
    return {
      matchedCount: c['MATCHED'] ?? 0,
      unmatchedCount: c['UNMATCHED'] ?? 0,
      needsReviewCount: c['NEEDS_REVIEW'] ?? 0,
    };
  }

  // Monotonic 0-99 progress per import (100 is set by the terminal stage writes). The guard
  // skips DB writes unless the rounded percent advances, so loops can call this per item.
  private lastProgress = new Map<string, number>();
  private classificationQueued = new Map<string, Set<string>>();

  private async reportProgress(importId: string, pct: number) {
    const p = Math.min(99, Math.round(pct));
    if (p <= (this.lastProgress.get(importId) ?? 0)) return;
    this.lastProgress.set(importId, p);
    await this.prisma.import
      .update({ where: { id: importId }, data: { progress: p } })
      .catch(() => undefined);
  }

  private async enqueueClassificationOnce(importId: string, mediaId: string): Promise<void> {
    const queued = this.classificationQueued.get(importId);
    if (!queued || queued.has(mediaId)) return;
    queued.add(mediaId);
    await this.hydrationQueue.enqueueClassifyCandidate({ mediaId }).catch(() => undefined);
  }

  /** Bounded worker pool for the small set of identities that survive local bulk lookup. */
  private async mapWithMatchConcurrency<T>(
    items: T[],
    work: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        await work(items[index], index);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(IMPORT_LIMITS.MATCH_CONCURRENCY, items.length) }, () =>
        worker(),
      ),
    );
  }

  private externalIdRequests(ids: TraktIds, type: 'SHOW' | 'MOVIE') {
    const kind = type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const requests: Array<{
      provider: ExternalProvider;
      providerEntityKind: ProviderEntityKind;
      value: string;
    }> = [];
    if (ids.tmdb) {
      requests.push({
        provider: ExternalProvider.TMDB,
        providerEntityKind: kind,
        value: String(ids.tmdb),
      });
    }
    if (ids.tvdb) {
      requests.push({
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: kind,
        value: String(ids.tvdb),
      });
    }
    if (ids.imdb) {
      requests.push({ provider: ExternalProvider.IMDB, providerEntityKind: kind, value: ids.imdb });
    }
    return requests;
  }

  async run(importId: string) {
    const imp = await this.prisma.import.findUnique({ where: { id: importId } });
    if (!imp || imp.status === 'CANCELLED') return;
    this.lastProgress.delete(importId);
    this.classificationQueued.set(importId, new Set());
    const locale = (imp.locale as SupportedLocale) || 'en';
    // Wrap the entire import in the user's language so all matching + hydration use it.
    try {
      return await runInLanguage(locale, () => this.runBody(importId, imp));
    } finally {
      this.classificationQueued.delete(importId);
      this.lastProgress.delete(importId);
    }
  }

  private async runBody(importId: string, imp: any) {
    try {
      await this.setStatus(importId, 'EXTRACTING', { progress: 2 });
      const bytes = await this.storage.read(imp.storageKey!);

      // Trakt JSON export? Detect on zip entry names (or the standalone .json filename) BEFORE
      // CSV inference — the CSV profiler would misclassify every Trakt file as unknown.
      const traktEntries = this.traktEntriesFor(imp, bytes);
      if (traktEntries) return await this.runTraktBody(importId, traktEntries);

      // TV Time JSON export? Detect BEFORE CSV inference — the JSON files are
      // authoritative and the bundled CSVs are flattened duplicates (the flat
      // activity_history.csv would otherwise hit the generic CSV profiles and
      // import unwatched rows as watched).
      const tvTimeJsonEntries = this.tvTimeJsonEntriesFor(imp, bytes);
      if (tvTimeJsonEntries) return await this.runTvTimeJsonBody(importId, tvTimeJsonEntries);

      // TV Time Out (browser extension) export? Dated tvtime-*.json files — the
      // markers can't collide with the Trakt or tvtime-json detectors, but this is
      // still checked before CSV inference.
      const tvTimeOutEntries = this.tvTimeOutEntriesFor(imp, bytes);
      if (tvTimeOutEntries) return await this.runTvTimeOutBody(importId, tvTimeOutEntries);

      const files = this.extractAndParse(imp.sourceType, imp.originalFilename ?? 'upload', bytes);
      await this.setStatus(importId, 'PARSING', { totalFiles: files.length, progress: 5 });

      // Per-file normalize → flat item list + ImportFile rows
      const normalizedItems: NormalizedItem[] = [];
      let totalRows = 0;
      for (const f of files) {
        const profile = detectProfile(f.filename, f.headers);
        const fileItems: NormalizedItem[] = [];
        for (const row of f.rows) {
          fileItems.push(...normalizeRow(profile, row));
        }
        totalRows += f.rows.length;
        await this.prisma.importFile.create({
          data: {
            importId,
            filename: f.filename,
            detectedType: 'csv',
            fileSizeBytes: f.size,
            rowCount: f.rows.length,
            headers: f.headers,
            status: profile === 'unknown' ? 'unsupported' : 'parsed',
          },
        });
        normalizedItems.push(...fileItems);
      }

      if (normalizedItems.length > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${normalizedItems.length} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      const legacyReconciliation = reconcileTvTimeLegacyMainItems(normalizedItems);
      const allItems = legacyReconciliation.items;
      if (legacyReconciliation.ignoredCount > 0) {
        this.logger.log(
          `Import ${importId}: ignored/reconciled ${legacyReconciliation.ignoredCount} known legacy TV Time row(s)`,
        );
      }

      // Reconcile identity evidence across the entire archive before matching. Some GDPR files
      // carry the TVDB series id while comments/votes only carry "Title (YEAR)" and episode ids.
      const archiveIdentity = new ArchiveIdentityIndex();
      for (const file of files) {
        for (const row of file.rows) archiveIdentity.addRawRowEvidence(row);
      }
      for (const item of allItems) {
        if (item.rawTvdbSeriesId) {
          archiveIdentity.addShowEvidence(item.title, item.year, item.rawTvdbSeriesId);
        }
      }
      const inferredArchiveEpisodeCoordinates =
        archiveIdentity.inferEpisodeCoordinatesFromArchiveSequence();
      if (inferredArchiveEpisodeCoordinates > 0) {
        this.logger.log(
          `Import ${importId}: recovered ${inferredArchiveEpisodeCoordinates} legacy episode coordinate(s) from archive-only evidence`,
        );
      }

      // Extract the archive's language (from user.csv) for fallback matching.
      const fileInputs = files.map((f) => ({ filename: f.filename, rows: f.rows }));
      const archiveLang = resolveArchiveLanguage(fileInputs);

      // Warm every authoritative identity before partitioning or deduplicating. Secondary TV
      // Time files frequently omit the year, so title/year alone can collapse an original and a
      // same-title remake (One Piece and Avatar are real examples from production exports).
      const allEpisodeIds = [
        ...new Set(
          allItems.flatMap((item) => {
            const value = normalizeNumericExternalId(item.rawTvdbEpisodeId);
            return value ? [value] : [];
          }),
        ),
      ];
      await Promise.all([
        this.matcher.prefetchMediaExternalIds(
          archiveIdentity.allSeriesIds().map((value) => ({
            provider: ExternalProvider.THE_TVDB,
            providerEntityKind: ProviderEntityKind.SERIES,
            value,
          })),
        ),
        this.matcher.prefetchEpisodeParents(
          allEpisodeIds.map((value) => ({ provider: ExternalProvider.THE_TVDB, value })),
        ),
      ]);

      const itemMediaType = (item: NormalizedItem): 'SHOW' | 'MOVIE' =>
        item.entityType === 'WATCHED_MOVIE' ||
        item.entityType === 'WATCHLIST_MOVIE' ||
        item.entityType === 'FAVORITE_MOVIE'
          ? 'MOVIE'
          : 'SHOW';
      const showKeyForItem = (item: NormalizedItem): string => {
        const episodeParent = item.rawTvdbEpisodeId
          ? this.matcher.matchPrefetchedShowByEpisodeIds([item.rawTvdbEpisodeId])
          : null;
        const directSeriesId = normalizeNumericExternalId(item.rawTvdbSeriesId);
        const archiveSeriesIds = directSeriesId
          ? [directSeriesId]
          : archiveIdentity.seriesIdsFor(item.title, item.year);
        return archiveShowPartitionKey(
          item.title,
          item.year,
          archiveSeriesIds.length === 1 ? archiveSeriesIds[0] : null,
          episodeParent?.mediaId,
        );
      };
      const movieIdentityForItem = (item: NormalizedItem) =>
        archiveIdentity.identifyMovie(item.title, item.year, item.rawMovieUuid);
      const seriesIdsForItem = (item: NormalizedItem): string[] => {
        const direct = normalizeNumericExternalId(item.rawTvdbSeriesId);
        return direct ? [direct] : archiveIdentity.seriesIdsFor(item.title, item.year);
      };

      await this.setStatus(importId, 'NORMALIZING', { totalRows, progress: 8 });
      // Dedupe by entity + authoritative show partition + coordinate. The same episode can
      // appear in seen_episode_source (single watch) AND rewatched_episode (total
      // count via cpt); keep the authoritative higher watchCount and the latest
      // watchedAt rather than summing, so the rewatched file's tally is preserved.
      const seen = new Map<string, number>();
      const dedup: NormalizedItem[] = [];
      let duplicates = legacyReconciliation.ignoredCount;
      for (const it of allItems) {
        const archiveCoordinate =
          it.entityType === 'WATCHED_EPISODE'
            ? archiveIdentity.resolveEpisodeCoordinate(it.rawTvdbEpisodeId)
            : null;
        const canonicalItem = archiveCoordinate
          ? {
              ...it,
              season:
                it.season != null && it.season >= 0
                  ? it.season > 0 || archiveCoordinate.season === 0
                    ? it.season
                    : archiveCoordinate.season
                  : archiveCoordinate.season,
              episode:
                it.episode != null && it.episode > 0 ? it.episode : archiveCoordinate.episode,
            }
          : it;
        const identityKey =
          itemMediaType(canonicalItem) === 'SHOW'
            ? showKeyForItem(canonicalItem)
            : movieIdentityForItem(canonicalItem).key;
        const k = `${canonicalItem.entityType}|${identityKey}|${canonicalItem.season ?? ''}|${canonicalItem.episode ?? ''}`;
        if (seen.has(k)) {
          duplicates++;
          const idx = seen.get(k)!;
          dedup[idx].watchCount = Math.max(
            dedup[idx].watchCount ?? 1,
            canonicalItem.watchCount ?? 1,
          );
          if (
            canonicalItem.watchedAt &&
            (!dedup[idx].watchedAt || canonicalItem.watchedAt > (dedup[idx].watchedAt as Date))
          ) {
            dedup[idx].watchedAt = canonicalItem.watchedAt;
          }
          continue;
        }
        seen.set(k, dedup.length);
        dedup.push({ ...canonicalItem, watchCount: canonicalItem.watchCount ?? 1 });
      }

      await this.setStatus(importId, 'MATCHING', { progress: 10 });
      // Season/episode footprint per show in the import — used to disambiguate duplicate titles
      // (e.g. two shows named "Silo"): the candidate must have enough seasons AND enough episodes
      // in each referenced season (import watched S1 up to E10 → S1 must have ≥10 episodes).
      const maxSeasonByNorm = new Map<string, number>();
      const seasonEpisodesByNorm = new Map<string, Map<number, number>>();
      const watchedEpisodesByShowKey = new Map<string, NormalizedItem[]>();
      for (const it of dedup) {
        if (it.entityType === 'WATCHED_EPISODE' && it.season != null) {
          const showKey = showKeyForItem(it);
          const group = watchedEpisodesByShowKey.get(showKey) ?? [];
          group.push(it);
          watchedEpisodesByShowKey.set(showKey, group);
          maxSeasonByNorm.set(showKey, Math.max(maxSeasonByNorm.get(showKey) ?? 0, it.season));
          const m = seasonEpisodesByNorm.get(showKey) ?? new Map<number, number>();
          if (it.episode != null) m.set(it.season, Math.max(m.get(it.season) ?? 0, it.episode));
          seasonEpisodesByNorm.set(showKey, m);
        }
      }
      // Collect ALL distinct TVDB series and episode ids per title across every row
      // (any entity type): TVDB merges leave dead ids in old exports (one sibling id usually
      // still works), and episode rows often carry no series id while a followed/tracking row
      // for the same show does.
      const episodeIdsByShowKey = new Map<string, Set<string>>();
      for (const it of allItems) {
        if (itemMediaType(it) !== 'SHOW') continue;
        const showKey = showKeyForItem(it);
        const episodeId = normalizeNumericExternalId(it.rawTvdbEpisodeId);
        if (episodeId) {
          const ids = episodeIdsByShowKey.get(showKey) ?? new Set<string>();
          ids.add(episodeId);
          episodeIdsByShowKey.set(showKey, ids);
        }
      }
      // For watched episodes, hydrate each distinct show once before resolving episodes.
      const showMediaByNorm = new Map<string, string>();
      const showMediaByKey = new Map<string, string>();
      const reclassifiedMoviesByShowKey = new Map<string, MovieReclassificationMatch>();
      const numberedMovieGroupsByShowKey = new Map<string, NumberedMovieGroupMatch>();
      const rememberMovieGroup = (
        showKey: string,
        item: NormalizedItem,
        match: NumberedMovieGroupMatch,
      ) => {
        const titleKey = archiveIdentity.identifyShow(item.title, item.year).key;
        // Main rows partition by provider identity when available; secondary activity files
        // usually carry only a title. Store both aliases so one archive decision reaches all of
        // its ratings, reactions, comments, and character votes.
        numberedMovieGroupsByShowKey.set(showKey, match);
        numberedMovieGroupsByShowKey.set(titleKey, match);
        numberedMovieGroupsByShowKey.set(`title:${titleKey}`, match);
      };
      const structureGuarded = new Set<string>();
      const hydratedFootprintByMedia = new Map<
        string,
        { maxSeason: number; maxEpisodeBySeason: Map<number, number> }
      >();
      const distinctShowByNorm = new Map<string, NormalizedItem>();
      for (const item of dedup) {
        const showKey = showKeyForItem(item);
        if (item.entityType === 'WATCHED_EPISODE' && !distinctShowByNorm.has(showKey)) {
          distinctShowByNorm.set(showKey, item);
        }
      }
      const distinctShows = [...distinctShowByNorm.values()];
      await this.mapWithMatchConcurrency(distinctShows, async (it, index) => {
        await this.reportProgress(importId, 10 + (30 * index) / Math.max(1, distinctShows.length));
        const showKey = showKeyForItem(it);
        const seMap = seasonEpisodesByNorm.get(showKey);
        const seasonEpisodes = seMap
          ? [...seMap.entries()].map(([season, maxEpisode]) => ({ season, maxEpisode }))
          : null;
        const seriesIds = seriesIdsForItem(it);
        const episodeIds = [...(episodeIdsByShowKey.get(showKey) ?? [])];
        const resolvedShow = await this.matcher.matchShowWithEpisodeParent(episodeIds, () =>
          this.matcher.matchMedia(
            it.normTitle,
            it.title,
            'SHOW',
            it.year,
            {
              maxSeason: maxSeasonByNorm.get(showKey) ?? null,
              seasonEpisodes,
            },
            archiveLang,
            it.rawTvdbSeriesId ?? null,
            seriesIds.length ? seriesIds : undefined,
          ),
        );
        const authoritativeConflict = resolvedShow.conflict;
        const authoritativeIdsDead = resolvedShow.dead === true;
        if (!authoritativeConflict && resolvedShow.reclassifiedMovie) {
          reclassifiedMoviesByShowKey.set(showKey, resolvedShow.reclassifiedMovie);
          archiveIdentity.bindShowAsMovie(
            it.title,
            it.year,
            seriesIds,
            resolvedShow.reclassifiedMovie.mediaId,
          );
          await this.enqueueClassificationOnce(importId, resolvedShow.reclassifiedMovie.mediaId);
          return;
        }
        let m: { mediaId: string | null; confidence: number; matchedTitle: string | null } =
          resolvedShow;

        if (authoritativeConflict) {
          this.logger.warn(
            `Import ${importId}: TVDB episode ids for "${it.title}" point to multiple local shows; refusing title fallback`,
          );
        }
        if (!authoritativeConflict && !(m.mediaId && m.confidence >= 0.7)) {
          // Last resort: identify the show through a TVDB EPISODE id (/find returns the
          // parent show id) — covers translated titles and rows without a series id. Try a
          // bounded spread rather than one arbitrary sample: old exports can contain a dead
          // episode alias beside live siblings after a provider merge.
          const recoveryIds =
            episodeIds.length <= 3
              ? episodeIds
              : [
                  episodeIds[0],
                  episodeIds[Math.floor(episodeIds.length / 2)],
                  episodeIds[episodeIds.length - 1],
                ];
          for (const episodeId of recoveryIds) {
            const recovered = await this.matcher.recoverShowByEpisodeId(
              it.title,
              it.year ?? null,
              episodeId,
            );
            if (recovered.mediaId) {
              m = recovered;
              break;
            }
          }
        }
        if (!authoritativeConflict && authoritativeIdsDead && !(m.mediaId && m.confidence >= 0.7)) {
          const numberedMovies = await this.matcher.matchNumberedMovieGroup(
            it.title,
            (watchedEpisodesByShowKey.get(showKey) ?? []).flatMap((episode) =>
              episode.season != null && episode.episode != null
                ? [{ season: episode.season, episode: episode.episode }]
                : [],
            ),
          );
          if (numberedMovies) {
            rememberMovieGroup(showKey, it, numberedMovies);
            await Promise.all(
              [...numberedMovies.moviesByCoordinate.values()].map((movie) =>
                this.enqueueClassificationOnce(importId, movie.mediaId),
              ),
            );
            return;
          }
        }
        if (!authoritativeConflict && m.mediaId && m.confidence >= 0.7) {
          await this.matcher.ensureShowHydrated(m.mediaId);
          showMediaByKey.set(showKey, m.mediaId);
          archiveIdentity.bindShow(it.title, it.year, m.mediaId);
          if (archiveIdentity.resolveShow(it.title, it.year) === m.mediaId) {
            showMediaByNorm.set(it.normTitle, m.mediaId);
          } else {
            showMediaByNorm.delete(it.normTitle);
          }
          // Import → anime-enrichment hook: deduplicated per local media id; non-blocking.
          await this.enqueueClassificationOnce(importId, m.mediaId);
          await this.guardShowStructure(
            m.mediaId,
            maxSeasonByNorm.get(showKey) ?? null,
            seasonEpisodes,
            structureGuarded,
            hydratedFootprintByMedia,
          );
        }
      });

      const episodeCoordinates = dedup.flatMap((item) => {
        if (reclassifiedMoviesByShowKey.has(showKeyForItem(item))) return [];
        if (
          item.season != null &&
          item.episode != null &&
          numberedMovieGroupsByShowKey
            .get(showKeyForItem(item))
            ?.moviesByCoordinate.has(numberedMovieCoordinateKey(item.season, item.episode))
        ) {
          return [];
        }
        const mediaId = showMediaByKey.get(showKeyForItem(item)) ?? null;
        return item.entityType === 'WATCHED_EPISODE' &&
          mediaId &&
          item.season != null &&
          item.episode != null
          ? [{ mediaId, season: item.season, episode: item.episode }]
          : [];
      });
      const episodeExternalIds = dedup.flatMap((item) => {
        if (reclassifiedMoviesByShowKey.has(showKeyForItem(item))) return [];
        if (
          item.season != null &&
          item.episode != null &&
          numberedMovieGroupsByShowKey
            .get(showKeyForItem(item))
            ?.moviesByCoordinate.has(numberedMovieCoordinateKey(item.season, item.episode))
        ) {
          return [];
        }
        const mediaId = showMediaByKey.get(showKeyForItem(item)) ?? null;
        const value = normalizeNumericExternalId(item.rawTvdbEpisodeId);
        return item.entityType === 'WATCHED_EPISODE' && mediaId && value
          ? [{ mediaId, provider: ExternalProvider.THE_TVDB, value }]
          : [];
      });
      await this.reportProgress(importId, 40);
      await Promise.all([
        this.matcher.prefetchEpisodeCoordinates(episodeCoordinates),
        this.matcher.prefetchEpisodeExternalIds(
          episodeExternalIds,
          (completedMediaGroups, totalMediaGroups) =>
            this.reportProgress(
              importId,
              40 + (8 * completedMediaGroups) / Math.max(1, totalMediaGroups),
            ),
        ),
      ]);
      await this.reportProgress(importId, 48);

      const mediaMatchByKey = new Map<
        string,
        { mediaId: string | null; confidence: number; matchedTitle: string | null }
      >();
      const matchArchiveMovie = async (
        item: NormalizedItem,
        identity: ReturnType<typeof movieIdentityForItem>,
      ) => {
        let best = { mediaId: null, confidence: 0, matchedTitle: null } as {
          mediaId: string | null;
          confidence: number;
          matchedTitle: string | null;
        };
        for (const candidate of identity.titleCandidates) {
          const match = await this.matcher.matchMedia(
            candidate.normTitle,
            candidate.title,
            'MOVIE',
            identity.year,
            undefined,
            archiveLang,
            item.rawTvdbSeriesId ?? null,
          );
          if (match.confidence > best.confidence) best = match;
          if (match.mediaId && match.confidence >= 0.7) return match;
        }
        // A canonical alpha-range title plus year is stronger than a low-confidence fuzzy
        // catalog suggestion. Fail closed and let review/provider hydration retry safely.
        return identity.hasCanonicalRangeTitle
          ? { mediaId: null, confidence: 0, matchedTitle: null }
          : best;
      };
      const distinctMedia = new Map<string, NormalizedItem>();
      for (const item of dedup) {
        if (item.entityType === 'WATCHED_EPISODE') continue;
        const type = itemMediaType(item);
        const identityKey = type === 'SHOW' ? showKeyForItem(item) : movieIdentityForItem(item).key;
        const key = `${type}:${identityKey}`;
        if (!distinctMedia.has(key)) distinctMedia.set(key, item);
      }
      const matchedArchiveMovieIds = new Set<string>();
      await this.mapWithMatchConcurrency([...distinctMedia.entries()], async ([key, item]) => {
        const type = key.startsWith('MOVIE:') ? 'MOVIE' : 'SHOW';
        const resolvedArchiveShow =
          type === 'SHOW' ? archiveIdentity.resolveShow(item.title, item.year) : null;
        const movieIdentity = type === 'MOVIE' ? movieIdentityForItem(item) : null;
        const resolvedArchiveMovie = movieIdentity
          ? archiveIdentity.resolveMovie(item.title, item.year, item.rawMovieUuid)
          : null;
        const resolvedArchiveMedia = resolvedArchiveShow ?? resolvedArchiveMovie;
        if (resolvedArchiveMedia) {
          mediaMatchByKey.set(key, {
            mediaId: resolvedArchiveMedia,
            confidence: 0.95,
            matchedTitle: item.title,
          });
          if (type === 'MOVIE') matchedArchiveMovieIds.add(resolvedArchiveMedia);
          return;
        }
        const archiveSeriesIds = type === 'SHOW' ? seriesIdsForItem(item) : [];
        const match: {
          mediaId: string | null;
          confidence: number;
          matchedTitle: string | null;
          reclassifiedMovie?: MovieReclassificationMatch;
        } = movieIdentity
          ? await matchArchiveMovie(item, movieIdentity)
          : await this.matcher.matchMedia(
              item.normTitle,
              item.title,
              type,
              item.year,
              undefined,
              archiveLang,
              item.rawTvdbSeriesId ?? null,
              archiveSeriesIds.length ? archiveSeriesIds : undefined,
            );
        if (type === 'SHOW' && match.reclassifiedMovie) {
          const showKey = showKeyForItem(item);
          reclassifiedMoviesByShowKey.set(showKey, match.reclassifiedMovie);
          archiveIdentity.bindShowAsMovie(
            item.title,
            item.year,
            archiveSeriesIds,
            match.reclassifiedMovie.mediaId,
          );
          await this.enqueueClassificationOnce(importId, match.reclassifiedMovie.mediaId);
          mediaMatchByKey.set(key, { mediaId: null, confidence: 0, matchedTitle: null });
          return;
        }
        mediaMatchByKey.set(key, match);
        if (type === 'MOVIE' && match.mediaId && match.confidence >= 0.7) {
          archiveIdentity.bindMovie(item.title, item.year, item.rawMovieUuid, match.mediaId);
          matchedArchiveMovieIds.add(match.mediaId);
        }
      });
      await this.reportProgress(importId, 50);

      // A second, archive-aware pass handles unnumbered film cycles after standalone movies
      // have been proven and bound. The is_unitary flag is supporting evidence only; the
      // matcher still requires a complete one-to-one movie mapping.
      await this.mapWithMatchConcurrency(distinctShows, async (it) => {
        const showKey = showKeyForItem(it);
        if (numberedMovieGroupsByShowKey.has(showKey)) return;
        const watched = watchedEpisodesByShowKey.get(showKey) ?? [];
        const hasUnitaryEvidence =
          watched.some((episode) => episode.isUnitary === true) &&
          watched.every((episode) => episode.isUnitary !== false);
        if (!hasUnitaryEvidence) return;
        const coordinates = watched.flatMap((episode) =>
          episode.season != null && episode.episode != null
            ? [{ season: episode.season, episode: episode.episode }]
            : [],
        );
        const movies = await this.matcher.matchUnitaryMovieGroup(
          it.title,
          coordinates,
          [...matchedArchiveMovieIds],
          seriesIdsForItem(it),
          archiveLang,
        );
        if (!movies) return;
        rememberMovieGroup(showKey, it, movies);
        await Promise.all(
          [...movies.moviesByCoordinate.values()].map((movie) =>
            this.enqueueClassificationOnce(importId, movie.mediaId),
          ),
        );
      });
      await this.reportProgress(importId, 52);

      type WatchedEpisodeResolution = {
        mediaId: string | null;
        episodeId: string | null;
        conflict: boolean;
      };
      const watchedEpisodeResolutionKey = (item: NormalizedItem, mediaId: string | null) => {
        const coordinate = archiveIdentity.resolveEpisodeCoordinate(item.rawTvdbEpisodeId);
        const season = item.season != null && item.season > 0 ? item.season : coordinate?.season;
        const episode =
          item.episode != null && item.episode > 0 ? item.episode : coordinate?.episode;
        return `${mediaId ?? 'unmatched'}:${normalizeNumericExternalId(item.rawTvdbEpisodeId) ?? ''}:${season ?? ''}:${episode ?? ''}`;
      };
      const episodeRequests = new Map<string, { item: NormalizedItem; mediaId: string | null }>();
      for (const item of dedup) {
        if (item.entityType !== 'WATCHED_EPISODE') continue;
        if (reclassifiedMoviesByShowKey.has(showKeyForItem(item))) continue;
        if (
          item.season != null &&
          item.episode != null &&
          numberedMovieGroupsByShowKey
            .get(showKeyForItem(item))
            ?.moviesByCoordinate.has(numberedMovieCoordinateKey(item.season, item.episode))
        ) {
          continue;
        }
        const mediaId = showMediaByKey.get(showKeyForItem(item)) ?? null;
        if (!mediaId && !normalizeNumericExternalId(item.rawTvdbEpisodeId)) continue;
        episodeRequests.set(watchedEpisodeResolutionKey(item, mediaId), { item, mediaId });
      }
      const watchedEpisodeResolutions = new Map<string, WatchedEpisodeResolution>();
      const episodeResolutionRequests = [...episodeRequests.entries()];
      let completedEpisodeResolutions = 0;
      await this.mapWithMatchConcurrency(episodeResolutionRequests, async ([key, request]) => {
        const { item, mediaId } = request;
        const rawEpId = normalizeNumericExternalId(item.rawTvdbEpisodeId);
        const coordinate = archiveIdentity.resolveEpisodeCoordinate(rawEpId);
        const season = item.season != null && item.season > 0 ? item.season : coordinate?.season;
        const episode =
          item.episode != null && item.episode > 0 ? item.episode : coordinate?.episode;
        const localParent = rawEpId
          ? this.matcher.matchPrefetchedShowByEpisodeIds([rawEpId])
          : null;
        // An exact episode owner is stronger than the source series owner. This is not a
        // conflict for anthology imports: one TVDB series may intentionally span several TMDB
        // shows, so each episode can have a different canonical local parent.
        let resolvedMediaId = localParent?.mediaId ?? mediaId;
        const aliasWasEvaluatedForMatchedMedia =
          !!resolvedMediaId && this.matcher.hasVerifiedTvdbEpisodeAlias(resolvedMediaId, rawEpId);
        let episodeId = resolvedMediaId
          ? rawEpId
            ? await this.matcher.resolveEpisodeByExternalIds(resolvedMediaId, {
                tvdb: Number(rawEpId) || null,
              })
            : null
          : null;
        // Once the complete TVDB snapshot has proved the identity belongs to this show but the
        // canonical bridge could not place it, the provider S/E coordinate is not interchangeable
        // with TMDB's coordinate. Falling through here silently attached split/combined episodes
        // to the wrong canonical row (Doctor John was the production regression).
        if (
          !episodeId &&
          resolvedMediaId &&
          canUseEpisodeCoordinateFallback(aliasWasEvaluatedForMatchedMedia, season, episode)
        ) {
          episodeId = await this.matcher.resolveEpisode(resolvedMediaId, season!, episode!);
        }
        const hydratedFootprint = resolvedMediaId
          ? hydratedFootprintByMedia.get(resolvedMediaId)
          : null;
        // A complete official-order snapshot already tried to place this id inside the matched
        // TMDB show. Do not fan out to one TMDB /find call per missing episode unless the source
        // season exceeds that show's whole canonical range—the bounded condition that preserves
        // cross-show anthology routing (The Haunting / Monster) without making daily imports such
        // as En famille issue hundreds of redundant provider calls.
        const mayBelongToAnotherTmdbShow =
          !aliasWasEvaluatedForMatchedMedia ||
          !hydratedFootprint ||
          season == null ||
          season > hydratedFootprint.maxSeason;
        if (!episodeId && rawEpId && mayBelongToAnotherTmdbShow) {
          const target = await archiveIdentity.recoverEpisodeTargetOnce(rawEpId, () =>
            this.matcher.recoverEpisodeTargetByTvdbId(item.title, item.year ?? null, rawEpId),
          );
          if (target) {
            resolvedMediaId = target.mediaId;
            episodeId = target.episodeId;
          }
        }
        if (!episodeId && rawEpId && resolvedMediaId) {
          episodeId = await archiveIdentity.recoverEpisodeOnce(rawEpId, resolvedMediaId, () =>
            this.matcher.recoverEpisodeByTvdbId(resolvedMediaId, rawEpId, true),
          );
        }
        if (episodeId && rawEpId && resolvedMediaId) {
          archiveIdentity.bindEpisode(rawEpId, resolvedMediaId, episodeId);
        }
        watchedEpisodeResolutions.set(key, {
          mediaId: resolvedMediaId,
          episodeId,
          conflict: false,
        });
        completedEpisodeResolutions++;
        await this.reportProgress(
          importId,
          52 + (18 * completedEpisodeResolutions) / Math.max(1, episodeResolutionRequests.length),
        );
      });
      await this.reportProgress(importId, 70);

      const reclassifiedEntityType = (entityType: ImportEntityType): ImportEntityType | null => {
        if (entityType === 'WATCHED_EPISODE') return 'WATCHED_MOVIE';
        if (entityType === 'WATCHLIST_SHOW') return 'WATCHLIST_MOVIE';
        if (entityType === 'FAVORITE_SHOW') return 'FAVORITE_MOVIE';
        return null;
      };
      const directMovieItemByTarget = new Map<string, NormalizedItem>();
      for (const item of dedup) {
        if (
          item.entityType !== 'WATCHED_MOVIE' &&
          item.entityType !== 'WATCHLIST_MOVIE' &&
          item.entityType !== 'FAVORITE_MOVIE'
        ) {
          continue;
        }
        const identityKey = movieIdentityForItem(item).key;
        const match = mediaMatchByKey.get(`MOVIE:${identityKey}`);
        if (match?.mediaId && match.confidence >= 0.7) {
          directMovieItemByTarget.set(`${item.entityType}:${match.mediaId}`, item);
        }
      }
      const itemsToStage: Array<{
        item: NormalizedItem;
        effectiveEntityType: ImportEntityType;
        reclassifiedMovie: MovieReclassificationMatch | null;
      }> = [];
      const reclassifiedRepresentatives = new Map<
        string,
        {
          item: NormalizedItem;
          effectiveEntityType: ImportEntityType;
          reclassifiedMovie: MovieReclassificationMatch;
        }
      >();
      for (const item of dedup) {
        const showKey = itemMediaType(item) === 'SHOW' ? showKeyForItem(item) : null;
        const numberedMovieGroup = showKey ? numberedMovieGroupsByShowKey.get(showKey) : null;
        // A synthetic TV Time show watchlist row adds no state once every numbered member film
        // was already imported as watched. Keeping it would leave an unresolvable duplicate
        // group beside the real movies in review.
        if (item.entityType === 'WATCHLIST_SHOW' && numberedMovieGroup) {
          duplicates++;
          continue;
        }
        const numberedMovie =
          showKey &&
          item.entityType === 'WATCHED_EPISODE' &&
          item.season != null &&
          item.episode != null
            ? (numberedMovieGroup?.moviesByCoordinate.get(
                numberedMovieCoordinateKey(item.season, item.episode),
              ) ?? null)
            : null;
        const reclassifiedMovie = showKey
          ? (numberedMovie ?? reclassifiedMoviesByShowKey.get(showKey) ?? null)
          : null;
        const effectiveEntityType = reclassifiedMovie
          ? reclassifiedEntityType(item.entityType)
          : null;
        if (!reclassifiedMovie || !effectiveEntityType) {
          itemsToStage.push({
            item,
            effectiveEntityType: item.entityType,
            reclassifiedMovie: null,
          });
          continue;
        }
        const key = `${effectiveEntityType}:${reclassifiedMovie.mediaId}`;
        const directMovieItem = directMovieItemByTarget.get(key);
        if (directMovieItem) {
          directMovieItem.watchCount = Math.max(
            directMovieItem.watchCount ?? 1,
            item.watchCount ?? 1,
          );
          if (
            item.watchedAt &&
            (!directMovieItem.watchedAt || item.watchedAt > directMovieItem.watchedAt)
          ) {
            directMovieItem.watchedAt = item.watchedAt;
          }
          duplicates++;
          continue;
        }
        const existing = reclassifiedRepresentatives.get(key);
        if (!existing) {
          reclassifiedRepresentatives.set(key, {
            item: { ...item },
            effectiveEntityType,
            reclassifiedMovie,
          });
          continue;
        }
        existing.item.watchCount = Math.max(existing.item.watchCount ?? 1, item.watchCount ?? 1);
        if (
          item.watchedAt &&
          (!existing.item.watchedAt || item.watchedAt > existing.item.watchedAt)
        ) {
          existing.item.watchedAt = item.watchedAt;
        }
      }
      itemsToStage.push(...reclassifiedRepresentatives.values());

      let matched = 0,
        unmatched = 0,
        needsReview = 0,
        invalid = 0;
      const batch: any[] = [];
      const flush = async () => {
        if (!batch.length) return;
        await this.prisma.importItem.createMany({ data: batch.slice() });
        batch.length = 0;
      };

      let matchIdx = 0;
      for (const staged of itemsToStage) {
        const { item: it, effectiveEntityType, reclassifiedMovie } = staged;
        await this.reportProgress(
          importId,
          70 + (14 * matchIdx++) / Math.max(1, itemsToStage.length),
        );
        if (!it.title) {
          invalid++;
          continue;
        }
        const type = reclassifiedMovie ? 'MOVIE' : itemMediaType(it);

        let mediaId: string | null = null;
        let episodeId: string | null = null;
        let confidence = 0;
        let episodeIdentityConflict = false;

        if (reclassifiedMovie) {
          mediaId = reclassifiedMovie.mediaId;
          confidence = reclassifiedMovie.confidence;
        } else if (it.entityType === 'WATCHED_EPISODE') {
          mediaId = showMediaByKey.get(showKeyForItem(it)) ?? null;
          const resolution = watchedEpisodeResolutions.get(
            watchedEpisodeResolutionKey(it, mediaId),
          );
          if (resolution) {
            mediaId = resolution.mediaId;
            episodeId = resolution.episodeId;
            episodeIdentityConflict = resolution.conflict;
          }
          confidence = episodeId ? 0.9 : mediaId || episodeIdentityConflict ? 0.6 : 0;
        } else {
          const identityKey = type === 'SHOW' ? showKeyForItem(it) : movieIdentityForItem(it).key;
          const m = mediaMatchByKey.get(`${type}:${identityKey}`)!;
          mediaId = m.mediaId;
          confidence = m.confidence;
        }

        const cls = this.matcher.classify(confidence);
        if (type === 'SHOW' && mediaId && confidence >= 0.7) {
          archiveIdentity.bindShow(it.title, it.year, mediaId);
          if (archiveIdentity.resolveShow(it.title, it.year) === mediaId) {
            showMediaByNorm.set(it.normTitle, mediaId);
          } else {
            showMediaByNorm.delete(it.normTitle);
          }
        }
        if (type === 'MOVIE' && mediaId && confidence >= 0.7) {
          archiveIdentity.bindMovie(it.title, it.year, it.rawMovieUuid, mediaId);
        }
        if (mediaId && episodeId && it.rawTvdbEpisodeId) {
          archiveIdentity.bindEpisode(it.rawTvdbEpisodeId, mediaId, episodeId);
        }
        if (mediaId && cls === 'matched') {
          // Import → anime-enrichment hook (deduplicated per local media id via stable job id).
          await this.enqueueClassificationOnce(importId, mediaId);
        }
        if (effectiveEntityType === 'WATCHED_EPISODE' && !episodeId && cls === 'matched') {
          // matched show but episode unresolved → needs review
        }
        let status: any;
        if (!mediaId) status = cls === 'unmatched' ? 'UNMATCHED' : 'NEEDS_REVIEW';
        else if (effectiveEntityType === 'WATCHED_EPISODE' && !episodeId) status = 'NEEDS_REVIEW';
        else status = cls === 'matched' ? 'MATCHED' : 'NEEDS_REVIEW';

        // Specials (S0 / E0 placeholders) are kept ONLY if they resolved to a real episode
        // (status MATCHED). An unresolvable special never maps to a real episode, so it's
        // ignored here instead of cluttering the review list.
        if (
          effectiveEntityType === 'WATCHED_EPISODE' &&
          (it.season === 0 || it.episode === 0) &&
          status !== 'MATCHED'
        ) {
          invalid++;
          continue;
        }

        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else if (status === 'NEEDS_REVIEW') needsReview++;

        batch.push({
          importId,
          rowNumber: 0,
          sourceEntityType: effectiveEntityType,
          targetEntityType: effectiveEntityType,
          status,
          rawData: it.raw as any,
          normalizedData: {
            title: reclassifiedMovie?.matchedTitle ?? it.title,
            normTitle: reclassifiedMovie ? normTitle(reclassifiedMovie.matchedTitle) : it.normTitle,
            year: it.year,
            season: reclassifiedMovie ? null : it.season,
            episode: reclassifiedMovie ? null : it.episode,
            watchedAt: it.watchedAt?.toISOString() ?? null,
            watchCount: it.watchCount ?? 1,
            movieUuid: it.rawMovieUuid ?? null,
            reclassifiedFrom: reclassifiedMovie ? it.entityType : null,
            sourceTitle: reclassifiedMovie ? it.title : null,
            sourceSeason: reclassifiedMovie ? (it.season ?? null) : null,
            sourceEpisode: reclassifiedMovie ? (it.episode ?? null) : null,
            sourceTvdbSeriesId: reclassifiedMovie
              ? (normalizeNumericExternalId(it.rawTvdbSeriesId) ?? null)
              : null,
          } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: episodeId,
          confidenceScore: confidence,
        });
        if (batch.length >= 200) await flush();
      }
      await flush();

      // ---- Lists + favorites pass (lists-prod-lists.csv) ----
      // The file carries three row kinds: metadata (collection/count), the favorites
      // pseudo-lists (s_key favorite-series/favorite-movies — the user's favorites, NOT
      // custom lists), and real custom lists (s_key uuid, often unnamed — the collection
      // blob's s_key→name map restores their titles). Custom lists stage as LIST +
      // LIST_ITEM items; favorites stage as FAVORITE_SHOW/FAVORITE_MOVIE items and flow
      // through the shared favorites apply pipeline.
      const listsFile = files.find((f) => isListsFile(f.filename));
      if (listsFile) {
        const seriesMap = buildSeriesIdNameMap(fileInputs);
        const movieUuidMap = buildMovieUuidNameMap(fileInputs);
        const { lists, favorites, errors } = normalizeLists(listsFile.rows);
        await this.matcher.prefetchMediaExternalIds(
          [...lists.flatMap((list) => list.items), ...favorites.series].flatMap((entry) =>
            entry.type === 'series' && entry.seriesId != null
              ? [
                  {
                    provider: ExternalProvider.THE_TVDB,
                    providerEntityKind: ProviderEntityKind.SERIES,
                    value: String(entry.seriesId),
                  },
                ]
              : [],
          ),
        );
        for (const e of errors)
          this.logger.warn(
            `Import ${importId} list parse — row ${e.row} (${e.sourceKey}): ${e.reason}`,
          );
        const listBatch: any[] = [];
        let noIdentityCount = 0;
        // Lists + favorites span 85→87 on the bar (per resolved object).
        const listObjTotal = Math.max(
          1,
          lists.reduce((n, l) => n + l.items.length, 0) +
            favorites.series.length +
            favorites.movies.length,
        );
        let listObjIdx = 0;
        const reportLists = () =>
          this.reportProgress(importId, 85 + (2 * listObjIdx++) / listObjTotal);

        // Resolve one list/favorite object to a media id. Series go through the TVDB-id
        // authority gate (id-authoritative — title search only when a real name exists);
        // movies resolve via the uuid→name map (the uuid is their only export identity).
        const resolveEntry = async (entry: {
          type: string;
          seriesId: number | null;
          uuid: string | null;
        }): Promise<{
          mediaId: string | null;
          title: string | null;
          confidence: number;
          mediaType: 'show' | 'movie';
        }> => {
          if (entry.type === 'series' && entry.seriesId != null) {
            const name = seriesMap.get(entry.seriesId) ?? null;
            if (name) archiveIdentity.addShowEvidence(name, undefined, entry.seriesId);
            const m = await this.matcher.matchMedia(
              normTitle(name ?? `tvdb-${entry.seriesId}`),
              name ?? `TVDB ${entry.seriesId}`,
              'SHOW',
              undefined,
              undefined,
              archiveLang,
              String(entry.seriesId),
              undefined,
              !!name, // no name → id-only; never title-match a placeholder
            );
            if (name && m.mediaId && m.confidence >= 0.7) {
              archiveIdentity.bindShow(name, undefined, m.mediaId);
            }
            if (name && m.reclassifiedMovie) {
              archiveIdentity.bindShowAsMovie(
                name,
                undefined,
                [entry.seriesId],
                m.reclassifiedMovie.mediaId,
              );
              return {
                mediaId: m.reclassifiedMovie.mediaId,
                title: name,
                confidence: m.reclassifiedMovie.confidence,
                mediaType: 'movie',
              };
            }
            return {
              mediaId: m.mediaId,
              title: name ?? m.matchedTitle,
              confidence: m.confidence,
              mediaType: 'show',
            };
          }
          if (entry.type === 'movie' && entry.uuid) {
            const name = movieUuidMap.get(entry.uuid) ?? null;
            if (!name) return { mediaId: null, title: null, confidence: 0, mediaType: 'movie' };
            const m = await this.matcher.matchMedia(
              normTitle(name),
              name,
              'MOVIE',
              undefined,
              undefined,
              archiveLang,
            );
            return {
              mediaId: m.mediaId,
              title: name,
              confidence: m.confidence,
              mediaType: 'movie',
            };
          }
          return {
            mediaId: null,
            title: null,
            confidence: 0,
            mediaType: entry.type === 'movie' ? 'movie' : 'show',
          };
        };

        const distinctListEntries = new Map<
          string,
          { type: string; seriesId: number | null; uuid: string | null }
        >();
        for (const entry of [
          ...lists.flatMap((list) => list.items),
          ...favorites.series,
          ...favorites.movies,
        ]) {
          const key =
            entry.type === 'series'
              ? `series:${entry.seriesId ?? ''}`
              : `movie:${entry.uuid ?? ''}`;
          if (!distinctListEntries.has(key)) distinctListEntries.set(key, entry);
        }
        await this.mapWithMatchConcurrency([...distinctListEntries.values()], async (entry) => {
          await resolveEntry(entry);
        });

        for (const list of lists) {
          let resolved = 0;
          let unresolved = 0;
          const itemRows: any[] = [];
          for (const it of list.items) {
            await reportLists();
            const r = await resolveEntry(it);
            // Objects with no recoverable identity (movie uuid unknown to the export,
            // dead series id without a name) are counted on the list but not staged —
            // a title-less row can never be reviewed or matched anyway.
            if (!r.title) {
              unresolved++;
              noIdentityCount++;
              continue;
            }
            if (r.mediaId && r.confidence >= 0.7) resolved++;
            else unresolved++;
            itemRows.push({
              importId,
              rowNumber: it.order,
              sourceEntityType: 'LIST_ITEM',
              targetEntityType: 'LIST_ITEM',
              status: r.mediaId && r.confidence >= 0.7 ? 'MATCHED' : 'NEEDS_REVIEW',
              rawData: { sourceKey: list.sourceKey, order: it.order } as any,
              normalizedData: {
                sourceKey: list.sourceKey,
                order: it.order,
                title: r.title,
                mediaType: r.mediaType,
                createdAt: it.createdAt?.toISOString() ?? null,
              } as any,
              matchedMediaId: r.mediaId,
              confidenceScore: r.mediaId ? r.confidence : 0,
            });
          }
          listBatch.push({
            importId,
            sourceEntityType: 'LIST',
            targetEntityType: 'LIST',
            status: 'MATCHED',
            rawData: { sourceKey: list.sourceKey } as any,
            normalizedData: {
              sourceKey: list.sourceKey,
              title: list.title,
              description: list.description,
              visibility: list.visibility,
              createdAt: list.createdAt?.toISOString() ?? null,
              itemCount: list.items.length,
              resolvedCount: resolved,
              unresolvedCount: unresolved,
            } as any,
            confidenceScore: 1,
          });
          listBatch.push(...itemRows);
        }

        // Favorites pseudo-lists → staged as regular favorite items (shared apply path,
        // deduped by mediaId against favorites from user_tv_show_data/v1 follows).
        let favoritesStaged = 0;
        const stageFavorite = async (
          entry: {
            type: string;
            seriesId: number | null;
            uuid: string | null;
            createdAt: Date | null;
            order: number;
          },
          entityType: 'FAVORITE_SHOW' | 'FAVORITE_MOVIE',
        ) => {
          await reportLists();
          const r = await resolveEntry(entry);
          if (!r.title) {
            noIdentityCount++;
            return;
          }
          const effectiveEntityType = r.mediaType === 'movie' ? 'FAVORITE_MOVIE' : entityType;
          listBatch.push({
            importId,
            rowNumber: entry.order,
            sourceEntityType: effectiveEntityType,
            targetEntityType: effectiveEntityType,
            status: r.mediaId && r.confidence >= 0.7 ? 'MATCHED' : 'NEEDS_REVIEW',
            rawData: {
              sourceKey: entityType === 'FAVORITE_SHOW' ? 'favorite-series' : 'favorite-movies',
            } as any,
            normalizedData: {
              title: r.title,
              mediaType: r.mediaType,
              createdAt: entry.createdAt?.toISOString() ?? null,
            } as any,
            matchedMediaId: r.mediaId,
            confidenceScore: r.mediaId ? r.confidence : 0,
          });
          favoritesStaged++;
        };
        for (const f of favorites.series) await stageFavorite(f, 'FAVORITE_SHOW');
        for (const f of favorites.movies) await stageFavorite(f, 'FAVORITE_MOVIE');

        for (let i = 0; i < listBatch.length; i += 200) {
          await this.prisma.importItem.createMany({ data: listBatch.slice(i, i + 200) });
        }
        this.logger.log(
          `Import ${importId} staged ${lists.length} list(s) + ${favoritesStaged} favorite(s) from ${listsFile.filename} (${noIdentityCount} no-identity object(s) counted only)`,
        );
      }

      // ---- Ratings / Emotions / Comments pass ----
      const extraCounts = await this.stageExtraEntities(
        importId,
        files,
        showMediaByNorm,
        archiveLang,
        archiveIdentity,
        numberedMovieGroupsByShowKey,
        legacyReconciliation.suppressedExtraShowNorms,
      );
      await this.reportProgress(importId, 95);

      // Status counters come from the staged ROWS (main loop + lists + all extras) —
      // not from the main match loop alone, or the first recount would "jump" by the
      // extras count. duplicates/invalid stay processing counters (no row equivalent).
      await this.finishProcessing(importId, {
        totalFiles: files.length,
        totalRows,
        progress: 100,
        ...(await this.statusCounts(importId)),
        duplicateCount: duplicates,
        conflictCount: 0,
        invalidCount: invalid,
        ...extraCounts,
      });
    } catch (e) {
      this.logger.error(`Import ${importId} failed: ${(e as Error).message}`);
      await this.setStatus(importId, 'FAILED', {
        errorMessage: this.friendlyImportError(e as Error),
      });
    }
  }

  /**
   * Structural diagnostic: a footprint mismatch never rewrites global structure inline.
   * It queues the same strict authority evaluation used by Metadata Health; unresolved
   * rows remain reviewable while the deduplicated background migration is evaluated.
   */
  private async guardShowStructure(
    mediaId: string,
    maxSeason: number | null,
    seasonEpisodes: { season: number; maxEpisode: number }[] | null,
    guarded: Set<string>,
    footprints?: Map<string, { maxSeason: number; maxEpisodeBySeason: Map<number, number> }>,
  ) {
    if (guarded.has(mediaId)) return;
    guarded.add(mediaId);
    if (maxSeason == null && !seasonEpisodes?.length) return;
    try {
      const hydrated = await this.matcher.hydratedFootprint(mediaId);
      footprints?.set(mediaId, hydrated);
      if (needsTvdbRehydration({ maxSeason, seasonEpisodes }, hydrated)) {
        this.logger.warn(
          `Structural guard: media ${mediaId} hydrated structure too small for the import footprint ` +
            `(hydrated maxSeason=${hydrated.maxSeason}, need S${maxSeason ?? '?'}) — queued authority evaluation`,
        );
        await this.hydrationQueue
          .enqueueStructureEvaluation(mediaId)
          .catch((error) =>
            this.logger.debug(
              `Structure evaluation enqueue skipped for ${mediaId}: ${(error as Error).message}`,
            ),
          );
      }
    } catch (e) {
      this.logger.debug(`Structural guard skipped for ${mediaId}: ${(e as Error).message}`);
    }
  }

  /** Zip entries (or a synthetic single-file entry) when the upload is a Trakt JSON export; else null. */
  private traktEntriesFor(imp: any, bytes: Buffer): ZipEntry[] | null {
    if (imp.sourceType === 'zip') {
      const { entries } = inspectZip(bytes);
      return isTraktArchive(entries.map((e) => e.filename)) ? entries : null;
    }
    const name = imp.originalFilename ?? '';
    if (imp.sourceType === 'json' && isTraktArchive([name])) {
      return [{ filename: name, size: bytes.length, isSupported: true, getData: () => bytes }];
    }
    return null;
  }

  /**
   * Trakt JSON export pipeline. Mirrors runBody's stages but parses JSON natively and matches
   * external-ID-first (TMDB → TVDB → IMDB → title). Staged ImportItems reuse the SAME entity
   * types + normalizedData shapes as the CSV path, so the review UI, apply, and rollback all
   * work unchanged. `Import.format = 'trakt'` makes the apply stage tag records source=TRAKT.
   */
  private async runTraktBody(importId: string, entries: ZipEntry[]) {
    try {
      await this.prisma.import.update({ where: { id: importId }, data: { format: 'trakt' } });
      await this.setStatus(importId, 'PARSING', { totalFiles: entries.length, progress: 10 });

      // ---- PARSING: JSON.parse each supported file; classify per Trakt filename conventions.
      const parsed: {
        filename: string;
        kind: TraktFileKind;
        data: unknown;
        size: number;
        failed: boolean;
      }[] = [];
      for (const e of entries) {
        const kind = e.isSupported ? classifyTraktFile(e.filename) : 'unsupported';
        if (kind === 'unsupported') {
          parsed.push({ filename: e.filename, kind, data: null, size: e.size, failed: false });
          continue;
        }
        try {
          parsed.push({
            filename: e.filename,
            kind,
            data: JSON.parse(e.getData().toString('utf8')),
            size: e.size,
            failed: false,
          });
        } catch {
          this.logger.warn(`Import ${importId}: invalid JSON in ${e.filename} — file skipped`);
          parsed.push({ filename: e.filename, kind, data: null, size: e.size, failed: true });
        }
      }
      // watched-history is authoritative: when present, the watched-shows/movies aggregate
      // files are superseded (kept visible as ImportFile rows but marked unsupported).
      const hasHistory = parsed.some(
        (f) => f.kind === 'watched_history' && !f.failed && Array.isArray(f.data),
      );
      let totalRows = 0;
      for (const f of parsed) {
        const superseded =
          hasHistory && (f.kind === 'watched_shows' || f.kind === 'watched_movies');
        const status = f.failed
          ? 'failed'
          : f.kind === 'unsupported' || superseded
            ? 'unsupported'
            : 'parsed';
        const rowCount = Array.isArray(f.data) ? f.data.length : f.data ? 1 : 0;
        if (status === 'parsed') totalRows += rowCount;
        await this.prisma.importFile.create({
          data: {
            importId,
            filename: f.filename,
            detectedType: 'json',
            fileSizeBytes: f.size,
            rowCount,
            headers: [],
            status,
          },
        });
      }
      if (totalRows > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalRows} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- NORMALIZING ----
      await this.setStatus(importId, 'NORMALIZING', { totalRows, progress: 15 });
      const ok = parsed.filter((f) => !f.failed);
      const dataOf = (kind: TraktFileKind) => ok.filter((f) => f.kind === kind).map((f) => f.data);
      const archiveLang = resolveTraktArchiveLanguage(
        ok.find((f) => f.kind === 'user_settings')?.data,
      );

      const watched = normalizeTraktWatched({
        history: dataOf('watched_history'),
        watchedMovies: hasHistory ? [] : dataOf('watched_movies'),
        watchedShows: hasHistory ? [] : dataOf('watched_shows'),
      });
      if (watched.skippedNoEpisodeData) {
        this.logger.log(
          `Import ${importId}: ${watched.skippedNoEpisodeData} show(s) have only aggregate watched data (no per-episode history) — skipped`,
        );
      }
      const watchlistResults = dataOf('watchlist').map((d) => normalizeTraktWatchlist(d));
      const watchlist = watchlistResults.flatMap((r) => r.candidates);
      const watchlistSkipped = watchlistResults.reduce((n, r) => n + r.skipped, 0);
      const favoritesResults = dataOf('favorites').map((d) => normalizeTraktFavorites(d));
      const favorites = favoritesResults.flatMap((r) => r.candidates);
      const favoritesSkipped = favoritesResults.reduce((n, r) => n + r.skipped, 0);
      const listsResults = dataOf('lists').map((d) => normalizeTraktLists(d));
      const lists = listsResults.flatMap((r) => r.lists);
      const listsSkipped = listsResults.reduce(
        (n, r) => n + r.skippedLists + r.lists.reduce((m, l) => m + l.skippedItems, 0),
        0,
      );
      const fileInputs = ok.map((f) => ({ filename: f.filename, kind: f.kind, data: f.data }));
      const ratingsRes = normalizeTraktRatings(fileInputs);
      const commentsRes = normalizeTraktComments(fileInputs);

      const totalCandidates =
        watched.episodes.length +
        watched.movies.length +
        watchlist.length +
        favorites.length +
        ratingsRes.candidates.length +
        commentsRes.candidates.length +
        lists.length;
      if (totalCandidates > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalCandidates} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- MATCHING ----
      await this.setStatus(importId, 'MATCHING', { progress: 25 });
      const mediaExternalIds = [
        ...watched.episodes.flatMap((candidate) =>
          this.externalIdRequests(candidate.showIds, 'SHOW'),
        ),
        ...watched.movies.flatMap((candidate) =>
          this.externalIdRequests(candidate.movieIds, 'MOVIE'),
        ),
        ...watchlist.flatMap((candidate) =>
          this.externalIdRequests(candidate.ids, candidate.type === 'movie' ? 'MOVIE' : 'SHOW'),
        ),
        ...favorites.flatMap((candidate) =>
          this.externalIdRequests(candidate.ids, candidate.type === 'movie' ? 'MOVIE' : 'SHOW'),
        ),
        ...lists.flatMap((list) =>
          list.items.flatMap((candidate) =>
            this.externalIdRequests(
              candidate.ids,
              candidate.mediaType === 'movie' ? 'MOVIE' : 'SHOW',
            ),
          ),
        ),
        ...ratingsRes.candidates.flatMap((candidate) => [
          ...this.externalIdRequests(candidate.showIds ?? {}, 'SHOW'),
          ...this.externalIdRequests(candidate.movieIds ?? {}, 'MOVIE'),
        ]),
        ...commentsRes.candidates.flatMap((candidate) => [
          ...this.externalIdRequests(candidate.showIds ?? {}, 'SHOW'),
          ...this.externalIdRequests(candidate.movieIds ?? {}, 'MOVIE'),
        ]),
      ];
      await this.matcher.prefetchMediaExternalIds(mediaExternalIds);
      // Distinct shows keyed by strongest external id — one provider lookup per unique show.
      const showKey = (ids: TraktIds, title: string) =>
        ids.tmdb ? `tmdb:${ids.tmdb}` : ids.tvdb ? `tvdb:${ids.tvdb}` : `norm:${normTitle(title)}`;
      const showMediaByKey = new Map<string, string>();
      const hydrated = new Set<string>();
      const matchShowIds = async (
        ids: TraktIds,
        title: string,
        year: number | null,
        hydrate: boolean,
      ) => {
        const k = showKey(ids, title);
        let m: { mediaId: string | null; confidence: number };
        const cached = showMediaByKey.get(k);
        if (cached) {
          m = { mediaId: cached, confidence: 0.95 };
        } else {
          m = await this.matcher.matchByExternalIds(
            ids,
            'SHOW',
            title,
            normTitle(title),
            year,
            archiveLang,
          );
          if (m.mediaId && m.confidence >= 0.7) showMediaByKey.set(k, m.mediaId);
        }
        if (m.mediaId && m.confidence >= 0.7) {
          await this.enqueueClassificationOnce(importId, m.mediaId);
          if (hydrate && !hydrated.has(m.mediaId)) {
            hydrated.add(m.mediaId);
            await this.matcher.ensureShowHydrated(m.mediaId);
          }
          return m;
        }
        return { mediaId: null, confidence: m.confidence };
      };

      const traktEpisodeCandidates = [
        ...watched.episodes.map((candidate) => ({
          showIds: candidate.showIds,
          showTitle: candidate.showTitle,
          year: candidate.year,
          season: candidate.season,
          episode: candidate.episode,
          episodeIds: candidate.episodeIds,
        })),
        ...ratingsRes.candidates.flatMap((candidate) =>
          candidate.rating.targetType === 'episode' &&
          candidate.rating.showTitle &&
          candidate.rating.seasonNumber != null &&
          candidate.rating.episodeNumber != null
            ? [
                {
                  showIds: candidate.showIds ?? {},
                  showTitle: candidate.rating.showTitle,
                  year: null,
                  season: candidate.rating.seasonNumber,
                  episode: candidate.rating.episodeNumber,
                  episodeIds: candidate.episodeIds ?? {},
                },
              ]
            : [],
        ),
        ...commentsRes.candidates.flatMap((candidate) =>
          candidate.comment.targetType === 'episode' &&
          candidate.comment.showTitle &&
          candidate.comment.seasonNumber != null &&
          candidate.comment.episodeNumber != null
            ? [
                {
                  showIds: candidate.showIds ?? {},
                  showTitle: candidate.comment.showTitle,
                  year: null,
                  season: candidate.comment.seasonNumber,
                  episode: candidate.comment.episodeNumber,
                  episodeIds: candidate.episodeIds ?? {},
                },
              ]
            : [],
        ),
      ];
      const distinctWatchedShows = new Map<string, (typeof traktEpisodeCandidates)[number]>();
      for (const candidate of traktEpisodeCandidates) {
        const key = showKey(candidate.showIds, candidate.showTitle);
        if (!distinctWatchedShows.has(key)) distinctWatchedShows.set(key, candidate);
      }
      await this.mapWithMatchConcurrency([...distinctWatchedShows.values()], async (candidate) => {
        await matchShowIds(candidate.showIds, candidate.showTitle, candidate.year, true);
      });

      await Promise.all([
        this.matcher.prefetchEpisodeCoordinates(
          traktEpisodeCandidates.flatMap((candidate) => {
            const mediaId = showMediaByKey.get(showKey(candidate.showIds, candidate.showTitle));
            return mediaId
              ? [
                  {
                    mediaId,
                    season: candidate.season,
                    episode: candidate.episode,
                  },
                ]
              : [];
          }),
        ),
        this.matcher.prefetchEpisodeExternalIds(
          traktEpisodeCandidates.flatMap((candidate) => {
            const mediaId = showMediaByKey.get(showKey(candidate.showIds, candidate.showTitle));
            if (!mediaId) return [];
            const requests: Array<{
              mediaId: string;
              provider: ExternalProvider;
              value: string;
            }> = [];
            if (candidate.episodeIds.tmdb) {
              requests.push({
                mediaId,
                provider: ExternalProvider.TMDB,
                value: String(candidate.episodeIds.tmdb),
              });
            }
            const tvdbId = normalizeNumericExternalId(candidate.episodeIds.tvdb);
            if (tvdbId) {
              requests.push({
                mediaId,
                provider: ExternalProvider.THE_TVDB,
                value: tvdbId,
              });
            }
            return requests;
          }),
        ),
      ]);

      const warmCandidates: Array<{
        ids: TraktIds;
        type: 'SHOW' | 'MOVIE';
        title: string;
        year: number | null;
      }> = [
        ...watched.movies.map((candidate) => ({
          ids: candidate.movieIds,
          type: 'MOVIE' as const,
          title: candidate.movieTitle,
          year: candidate.year,
        })),
        ...watchlist.map((candidate) => ({
          ids: candidate.ids,
          type: candidate.type === 'movie' ? ('MOVIE' as const) : ('SHOW' as const),
          title: candidate.title,
          year: candidate.year,
        })),
        ...favorites.map((candidate) => ({
          ids: candidate.ids,
          type: candidate.type === 'movie' ? ('MOVIE' as const) : ('SHOW' as const),
          title: candidate.title,
          year: candidate.year,
        })),
        ...lists.flatMap((list) =>
          list.items.map((candidate) => ({
            ids: candidate.ids,
            type: candidate.mediaType === 'movie' ? ('MOVIE' as const) : ('SHOW' as const),
            title: candidate.title,
            year: candidate.year,
          })),
        ),
        ...ratingsRes.candidates.flatMap((candidate) => {
          const movie = candidate.rating.targetType === 'movie';
          const title = movie ? candidate.rating.movieTitle : candidate.rating.showTitle;
          return title
            ? [
                {
                  ids: (movie ? candidate.movieIds : candidate.showIds) ?? {},
                  type: movie ? ('MOVIE' as const) : ('SHOW' as const),
                  title,
                  year: null,
                },
              ]
            : [];
        }),
        ...commentsRes.candidates.flatMap((candidate) => {
          const movie = candidate.comment.targetType === 'movie';
          const title = movie ? candidate.comment.movieTitle : candidate.comment.showTitle;
          return title
            ? [
                {
                  ids: (movie ? candidate.movieIds : candidate.showIds) ?? {},
                  type: movie ? ('MOVIE' as const) : ('SHOW' as const),
                  title,
                  year: null,
                },
              ]
            : [];
        }),
      ];
      const distinctWarmCandidates = new Map<string, (typeof warmCandidates)[number]>();
      for (const candidate of warmCandidates) {
        const key = `${candidate.type}:${candidate.ids.tmdb ?? ''}:${candidate.ids.tvdb ?? ''}:${candidate.ids.imdb ?? ''}:${normTitle(candidate.title)}`;
        if (!distinctWarmCandidates.has(key)) distinctWarmCandidates.set(key, candidate);
      }
      await this.mapWithMatchConcurrency(
        [...distinctWarmCandidates.values()],
        async (candidate) => {
          await this.matcher.matchByExternalIds(
            candidate.ids,
            candidate.type,
            candidate.title,
            normTitle(candidate.title),
            candidate.year,
            archiveLang,
          );
        },
      );

      let matched = 0,
        unmatched = 0,
        needsReview = 0,
        invalid = 0;
      const batch: any[] = [];
      const flush = async () => {
        if (!batch.length) return;
        await this.prisma.importItem.createMany({ data: batch.slice() });
        batch.length = 0;
      };
      const pushItem = async (row: any) => {
        batch.push(row);
        if (batch.length >= 200) await flush();
      };

      // ---- Watched episodes ----
      let epIdx = 0;
      for (const c of watched.episodes) {
        await this.reportProgress(
          importId,
          25 + (20 * epIdx++) / Math.max(1, watched.episodes.length),
        );
        const { mediaId } = await matchShowIds(c.showIds, c.showTitle, c.year, true);
        let episodeId: string | null = null;
        let confidence = 0;
        if (mediaId) {
          episodeId = await this.matcher.resolveEpisodeByExternalIds(mediaId, c.episodeIds);
          confidence = episodeId ? 0.95 : 0;
          if (!episodeId) {
            episodeId = await this.matcher.resolveEpisode(mediaId, c.season, c.episode);
            confidence = episodeId ? 0.9 : 0.6;
          }
        }
        let status: string;
        if (!mediaId) status = 'UNMATCHED';
        else if (!episodeId) status = 'NEEDS_REVIEW';
        else status = 'MATCHED';
        // Specials rule (same as CSV): S0/E0 kept ONLY when resolved to a real episode.
        if ((c.season === 0 || c.episode === 0) && status !== 'MATCHED') {
          invalid++;
          continue;
        }
        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else needsReview++;
        await pushItem({
          importId,
          rowNumber: 0,
          sourceEntityType: 'WATCHED_EPISODE' as ImportEntityType,
          targetEntityType: 'WATCHED_EPISODE' as ImportEntityType,
          status,
          rawData: {
            title: c.showTitle,
            year: c.year,
            season: c.season,
            episode: c.episode,
            showIds: c.showIds,
            episodeIds: c.episodeIds,
          } as any,
          normalizedData: {
            title: c.showTitle,
            normTitle: normTitle(c.showTitle),
            year: c.year,
            season: c.season,
            episode: c.episode,
            watchedAt: c.watchedAt?.toISOString() ?? null,
            watchCount: c.watchCount,
          } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: episodeId,
          confidenceScore: confidence,
        });
      }

      // ---- Watched movies + watchlist + favorites (shared single-media staging) ----
      const stageMediaItem = async (
        entityType:
          | 'WATCHED_MOVIE'
          | 'WATCHLIST_SHOW'
          | 'WATCHLIST_MOVIE'
          | 'FAVORITE_SHOW'
          | 'FAVORITE_MOVIE',
        ids: TraktIds,
        title: string,
        year: number | null,
        watchedAt: Date | null,
        watchCount: number,
      ) => {
        const type = entityType.endsWith('_SHOW') ? 'SHOW' : 'MOVIE';
        const m = await this.matcher.matchByExternalIds(
          ids,
          type,
          title,
          normTitle(title),
          year,
          archiveLang,
        );
        const cls = this.matcher.classify(m.confidence);
        if (m.mediaId && cls === 'matched') {
          await this.enqueueClassificationOnce(importId, m.mediaId);
        }
        const status = !m.mediaId
          ? cls === 'unmatched'
            ? 'UNMATCHED'
            : 'NEEDS_REVIEW'
          : cls === 'matched'
            ? 'MATCHED'
            : 'NEEDS_REVIEW';
        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else needsReview++;
        await pushItem({
          importId,
          rowNumber: 0,
          sourceEntityType: entityType as ImportEntityType,
          targetEntityType: entityType as ImportEntityType,
          status,
          rawData: { title, year, ids } as any,
          normalizedData: {
            title,
            normTitle: normTitle(title),
            year,
            season: null,
            episode: null,
            watchedAt: watchedAt?.toISOString() ?? null,
            watchCount,
          } as any,
          matchedMediaId: m.mediaId,
          matchedEpisodeId: null,
          confidenceScore: m.confidence,
        });
      };
      const mediaStageTotal = Math.max(
        1,
        watched.movies.length + watchlist.length + favorites.length,
      );
      let mediaStageIdx = 0;
      for (const c of watched.movies) {
        await this.reportProgress(importId, 45 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem(
          'WATCHED_MOVIE',
          c.movieIds,
          c.movieTitle,
          c.year,
          c.watchedAt,
          c.watchCount,
        );
      }
      for (const c of watchlist) {
        await this.reportProgress(importId, 45 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem(
          c.type === 'movie' ? 'WATCHLIST_MOVIE' : 'WATCHLIST_SHOW',
          c.ids,
          c.title,
          c.year,
          c.listedAt,
          1,
        );
      }
      for (const c of favorites) {
        await this.reportProgress(importId, 45 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem(
          c.type === 'movie' ? 'FAVORITE_MOVIE' : 'FAVORITE_SHOW',
          c.ids,
          c.title,
          c.year,
          c.listedAt,
          1,
        );
      }
      await flush();

      // ---- Custom lists (lists-lists.json) → LIST + LIST_ITEM items (same shapes as CSV) ----
      const listBatch: any[] = [];
      const listItemTotal = Math.max(
        1,
        lists.reduce((n, l) => n + l.items.length, 0),
      );
      let listItemIdx = 0;
      for (const list of lists) {
        let resolved = 0;
        let unresolved = 0;
        const itemRows: any[] = [];
        for (const it of list.items) {
          await this.reportProgress(importId, 60 + (10 * listItemIdx++) / listItemTotal);
          const m = await this.matcher.matchByExternalIds(
            it.ids,
            it.mediaType === 'movie' ? 'MOVIE' : 'SHOW',
            it.title,
            normTitle(it.title),
            it.year,
            archiveLang,
          );
          if (m.mediaId) resolved++;
          else unresolved++;
          itemRows.push({
            importId,
            rowNumber: it.order,
            sourceEntityType: 'LIST_ITEM' as ImportEntityType,
            targetEntityType: 'LIST_ITEM' as ImportEntityType,
            status: m.mediaId ? 'MATCHED' : 'NEEDS_REVIEW',
            rawData: { sourceKey: list.sourceKey, order: it.order } as any,
            normalizedData: {
              sourceKey: list.sourceKey,
              order: it.order,
              title: it.title,
              mediaType: it.mediaType === 'movie' ? 'movie' : 'series',
              createdAt: it.createdAt?.toISOString() ?? null,
            } as any,
            matchedMediaId: m.mediaId,
            confidenceScore: m.mediaId ? 0.9 : 0,
          });
        }
        listBatch.push({
          importId,
          sourceEntityType: 'LIST' as ImportEntityType,
          targetEntityType: 'LIST' as ImportEntityType,
          status: 'MATCHED',
          rawData: { sourceKey: list.sourceKey } as any,
          normalizedData: {
            sourceKey: list.sourceKey,
            title: list.title,
            description: list.description,
            visibility: list.visibility,
            createdAt: list.createdAt?.toISOString() ?? null,
            itemCount: list.items.length,
            resolvedCount: resolved,
            unresolvedCount: unresolved,
          } as any,
          confidenceScore: 1,
        });
        listBatch.push(...itemRows);
      }
      for (let i = 0; i < listBatch.length; i += 200) {
        await this.prisma.importItem.createMany({ data: listBatch.slice(i, i + 200) });
      }

      // ---- Ratings + comments: resolve targets external-ID-first, stage with CSV shapes ----
      const resolveTarget = async (
        input: {
          targetType: 'show' | 'movie' | 'episode';
          showTitle?: string | null;
          movieTitle?: string | null;
          season?: number | null;
          episode?: number | null;
          showIds?: TraktIds;
          movieIds?: TraktIds;
          episodeIds?: TraktIds;
        },
        fallbackToMedia: boolean,
      ): Promise<{
        mediaId: string | null;
        episodeId: string | null;
        confidence: number;
        status: string;
      }> => {
        if (input.targetType === 'movie') {
          const title = input.movieTitle ?? '';
          if (!title) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
          const m = await this.matcher.matchByExternalIds(
            input.movieIds ?? {},
            'MOVIE',
            title,
            normTitle(title),
            null,
            archiveLang,
          );
          const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
          return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
        }
        if (input.targetType === 'show') {
          const title = input.showTitle ?? '';
          if (!title) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
          const m = await this.matcher.matchByExternalIds(
            input.showIds ?? {},
            'SHOW',
            title,
            normTitle(title),
            null,
            archiveLang,
          );
          const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
          if (m.mediaId && m.confidence >= 0.7) {
            showMediaByKey.set(showKey(input.showIds ?? {}, title), m.mediaId);
            await this.enqueueClassificationOnce(importId, m.mediaId);
          }
          return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
        }
        // Episode target: match the show (hydrate), then resolve by external episode id → S/E.
        const title = input.showTitle ?? '';
        if (!title) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
        const { mediaId } = await matchShowIds(input.showIds ?? {}, title, null, true);
        if (!mediaId) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
        if (input.season != null && input.episode != null) {
          let episodeId = await this.matcher.resolveEpisodeByExternalIds(
            mediaId,
            input.episodeIds ?? {},
          );
          if (!episodeId)
            episodeId = await this.matcher.resolveEpisode(mediaId, input.season, input.episode);
          if (episodeId) return { mediaId, episodeId, confidence: 0.9, status: 'MATCHED' };
          // Episode not found: fall back to a show-level match (ratings) or flag for review.
          if (fallbackToMedia)
            return { mediaId, episodeId: null, confidence: 0.75, status: 'MATCHED' };
          return { mediaId, episodeId: null, confidence: 0.6, status: 'NEEDS_REVIEW' };
        }
        return { mediaId, episodeId: null, confidence: 0.85, status: 'MATCHED' };
      };

      let ratingsUnresolved = 0;
      const ratingItems: any[] = [];
      let ratingIdx = 0;
      for (const c of ratingsRes.candidates) {
        await this.reportProgress(
          importId,
          70 + (20 * ratingIdx++) / Math.max(1, ratingsRes.candidates.length),
        );
        const r = await resolveTarget(
          {
            targetType: c.rating.targetType,
            showTitle: c.rating.showTitle,
            movieTitle: c.rating.movieTitle,
            season: c.rating.seasonNumber,
            episode: c.rating.episodeNumber,
            showIds: c.showIds,
            movieIds: c.movieIds,
            episodeIds: c.episodeIds,
          },
          true, // ratings fall back to a show-level record when the episode can't be resolved
        );
        if (r.status === 'UNMATCHED') ratingsUnresolved++;
        ratingItems.push(
          this.buildExtraItem(importId, c.rating, r.mediaId, r.episodeId, r.confidence, r.status),
        );
      }
      await this.flushItems(importId, ratingItems);

      let commentsUnresolved = 0;
      const commentItems: any[] = [];
      let commentIdx = 0;
      for (const c of commentsRes.candidates) {
        await this.reportProgress(
          importId,
          90 + (5 * commentIdx++) / Math.max(1, commentsRes.candidates.length),
        );
        const r = await resolveTarget(
          {
            targetType: c.comment.targetType,
            showTitle: c.comment.showTitle,
            movieTitle: c.comment.movieTitle,
            season: c.comment.seasonNumber,
            episode: c.comment.episodeNumber,
            showIds: c.showIds,
            movieIds: c.movieIds,
            episodeIds: c.episodeIds,
          },
          false,
        );
        if (r.status === 'UNMATCHED') commentsUnresolved++;
        const sourceKey = `trakt:comment:${c.comment.sourceCommentId}`;
        commentItems.push(
          this.buildCommentItem(
            importId,
            c.comment,
            r.mediaId,
            r.episodeId,
            r.confidence,
            r.status,
            sourceKey,
          ),
        );
      }
      await this.flushItems(importId, commentItems);

      await this.finishProcessing(importId, {
        totalFiles: parsed.length,
        totalRows,
        progress: 100,
        ...(await this.statusCounts(importId)),
        duplicateCount: 0,
        conflictCount: 0,
        invalidCount:
          invalid +
          watched.invalid +
          watched.skippedNoEpisodeData +
          watchlistSkipped +
          favoritesSkipped +
          listsSkipped,
        ratingsDetected: ratingsRes.detected,
        ratingsSkippedUnsupported: ratingsRes.unsupported,
        ratingsSkippedUnresolved: ratingsUnresolved,
        commentRowsDetected: commentsRes.rowsDetected,
        topLevelCommentsDetected: commentsRes.candidates.length,
        commentRepliesSkipped: commentsRes.repliesSkipped,
        commentsSkippedInvalid: commentsRes.invalid,
        commentsSkippedUnresolved: commentsUnresolved,
      });
      this.logger.log(
        `Import ${importId} (trakt): staged episodes=${watched.episodes.length} movies=${watched.movies.length} watchlist=${watchlist.length} favorites=${favorites.length} ratings=${ratingsRes.candidates.length} comments=${commentsRes.candidates.length} lists=${lists.length}`,
      );
    } catch (e) {
      this.logger.error(`Import ${importId} failed: ${(e as Error).message}`);
      await this.setStatus(importId, 'FAILED', {
        errorMessage: this.friendlyImportError(e as Error),
      });
    }
  }

  /** Zip entries (or a synthetic single-file entry) when the upload is a TV Time JSON export; else null. */
  private tvTimeJsonEntriesFor(imp: any, bytes: Buffer): ZipEntry[] | null {
    if (imp.sourceType === 'zip') {
      const { entries } = inspectZip(bytes);
      return isTvTimeJsonArchive(entries.map((e) => e.filename)) ? entries : null;
    }
    const name = imp.originalFilename ?? '';
    if (imp.sourceType === 'json' && isTvTimeJsonStandaloneFile(name)) {
      return [{ filename: name, size: bytes.length, isSupported: true, getData: () => bytes }];
    }
    return null;
  }

  /**
   * TV Time JSON GDPR export pipeline. Mirrors runTraktBody's stages but parses the
   * TV Time JSON files natively (shows.json / movies.json / favorites.json / lists.json)
   * and matches external-ID-first (TVDB → IMDB → title). The bundled CSVs are flattened
   * duplicates and ignored — EXCEPT activity_history.csv, parsed only for its show
   * `is_watchlisted` flag (absent from the JSON). `Import.format` stays 'tvtime'
   * (default) so the apply stage tags records source=TVTIME, sharing the conflict
   * domain with legacy TV Time CSV imports.
   */
  private async runTvTimeJsonBody(importId: string, entries: ZipEntry[]) {
    try {
      await this.setStatus(importId, 'PARSING', { totalFiles: entries.length, progress: 10 });

      // ---- PARSING: JSON.parse each supported file; parseCsv for activity_history.csv.
      const parsed: {
        filename: string;
        kind: TvTimeJsonFileKind;
        data: unknown;
        csvRows: Record<string, string>[] | null;
        size: number;
        failed: boolean;
      }[] = [];
      for (const e of entries) {
        const kind = e.isSupported ? classifyTvTimeJsonFile(e.filename) : 'unsupported';
        if (kind === 'unsupported' || kind === 'ignored_csv') {
          parsed.push({
            filename: e.filename,
            kind,
            data: null,
            csvRows: null,
            size: e.size,
            failed: false,
          });
          continue;
        }
        try {
          if (kind === 'activity_csv') {
            const csv = parseCsv(e.getData());
            parsed.push({
              filename: e.filename,
              kind,
              data: null,
              csvRows: csv.rows,
              size: e.size,
              failed: false,
            });
          } else {
            parsed.push({
              filename: e.filename,
              kind,
              data: JSON.parse(e.getData().toString('utf8')),
              csvRows: null,
              size: e.size,
              failed: false,
            });
          }
        } catch {
          this.logger.warn(`Import ${importId}: unparseable ${e.filename} — file skipped`);
          parsed.push({
            filename: e.filename,
            kind,
            data: null,
            csvRows: null,
            size: e.size,
            failed: true,
          });
        }
      }
      let totalRows = 0;
      for (const f of parsed) {
        const status = f.failed
          ? 'failed'
          : f.kind === 'unsupported' || f.kind === 'ignored_csv'
            ? 'unsupported'
            : 'parsed';
        const rowCount = f.csvRows
          ? f.csvRows.length
          : Array.isArray(f.data)
            ? f.data.length
            : f.data
              ? 1
              : 0;
        if (status === 'parsed') totalRows += rowCount;
        await this.prisma.importFile.create({
          data: {
            importId,
            filename: f.filename,
            detectedType: f.kind === 'activity_csv' ? 'csv' : 'json',
            fileSizeBytes: f.size,
            rowCount,
            headers: [],
            status,
          },
        });
      }
      if (totalRows > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalRows} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- NORMALIZING ----
      await this.setStatus(importId, 'NORMALIZING', { totalRows, progress: 15 });
      const ok = parsed.filter((f) => !f.failed);
      const dataOf = (kind: TvTimeJsonFileKind) =>
        ok.filter((f) => f.kind === kind).map((f) => f.data);

      const showsRes = normalizeTvTimeJsonShows(
        dataOf('shows').find((d) => Array.isArray(d)) ?? [],
      );
      const moviesRes = normalizeTvTimeJsonMovies(
        dataOf('movies').find((d) => Array.isArray(d)) ?? [],
      );
      const favoritesResults = dataOf('favorites').map((d) => normalizeTvTimeJsonFavorites(d));
      const favorites = favoritesResults.flatMap((r) => r.candidates);
      const favoritesSkipped = favoritesResults.reduce((n, r) => n + r.skipped, 0);
      const listsResults = dataOf('lists').map((d) => normalizeTvTimeJsonLists(d));
      const lists = listsResults.flatMap((r) => r.lists);
      const listsSkipped = listsResults.reduce(
        (n, r) => n + r.skippedLists + r.lists.reduce((m, l) => m + l.skippedItems, 0),
        0,
      );
      const ratingsRes = normalizeTvTimeJsonRatings({
        shows: dataOf('shows'),
        movies: dataOf('movies'),
        collections: [...dataOf('favorites'), ...dataOf('lists')],
      });
      const watchlistCsvResults = ok
        .filter((f) => f.kind === 'activity_csv' && f.csvRows)
        .map((f) => normalizeTvTimeWatchlistCsv(f.csvRows!));
      const watchlistShows = watchlistCsvResults.flatMap((r) => r.candidates);
      const watchlistCsvSkipped = watchlistCsvResults.reduce((n, r) => n + r.skipped, 0);

      const totalCandidates =
        showsRes.episodes.length +
        moviesRes.watched.length +
        moviesRes.watchlist.length +
        watchlistShows.length +
        favorites.length +
        lists.length +
        ratingsRes.candidates.length;
      if (totalCandidates > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalCandidates} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- MATCHING ----
      await this.setStatus(importId, 'MATCHING', { progress: 25 });
      await this.matcher.prefetchMediaExternalIds([
        ...showsRes.episodes.flatMap((candidate) =>
          this.externalIdRequests(candidate.showIds, 'SHOW'),
        ),
        ...moviesRes.watched.flatMap((candidate) =>
          this.externalIdRequests(candidate.movieIds, 'MOVIE'),
        ),
        ...moviesRes.watchlist.flatMap((candidate) =>
          this.externalIdRequests(candidate.ids, 'MOVIE'),
        ),
        ...watchlistShows.flatMap((candidate) => this.externalIdRequests(candidate.ids, 'SHOW')),
        ...favorites.flatMap((candidate) =>
          this.externalIdRequests(candidate.ids, candidate.type === 'movie' ? 'MOVIE' : 'SHOW'),
        ),
        ...lists.flatMap((list) =>
          list.items.flatMap((candidate) =>
            this.externalIdRequests(
              candidate.ids,
              candidate.mediaType === 'movie' ? 'MOVIE' : 'SHOW',
            ),
          ),
        ),
        ...ratingsRes.candidates.flatMap((candidate) => [
          ...this.externalIdRequests(candidate.showIds ?? {}, 'SHOW'),
          ...this.externalIdRequests(candidate.movieIds ?? {}, 'MOVIE'),
        ]),
      ]);
      // Distinct shows keyed by strongest external id — one provider lookup per unique show.
      const showMediaByKey = new Map<string, string>();
      const reclassifiedMovieByKey = new Map<string, MovieReclassificationMatch>();
      const numberedMovieGroupsByKey = new Map<string, NumberedMovieGroupMatch>();
      const episodeGroupsByKey = new Map<string, typeof showsRes.episodes>();
      for (const episode of showsRes.episodes) {
        if (episode.special) continue;
        const key = mediaKey(episode.showIds, normTitle(episode.showTitle));
        const group = episodeGroupsByKey.get(key) ?? [];
        group.push(episode);
        episodeGroupsByKey.set(key, group);
      }
      const hydrated = new Set<string>();
      const structureGuarded = new Set<string>();
      const matchShowIds = async (
        ids: TraktIds,
        title: string,
        year: number | null,
        hydrate: boolean,
      ) => {
        const k = mediaKey(ids, normTitle(title));
        let m: {
          mediaId: string | null;
          confidence: number;
          dead?: boolean;
          reclassifiedMovie?: MovieReclassificationMatch;
        };
        if (numberedMovieGroupsByKey.has(k)) {
          return { mediaId: null, confidence: 0 };
        }
        const cached = showMediaByKey.get(k);
        const cachedMovie = reclassifiedMovieByKey.get(k);
        if (cachedMovie) {
          m = { mediaId: null, confidence: 0, reclassifiedMovie: cachedMovie };
        } else if (cached) {
          m = { mediaId: cached, confidence: 0.95 };
        } else {
          const footprint = showsRes.footprints.get(k);
          m = await this.matcher.matchByExternalIds(
            ids,
            'SHOW',
            title,
            normTitle(title),
            year,
            null,
            footprint
              ? {
                  maxSeason: footprint.maxSeason,
                  seasonEpisodes: footprint.seasonEpisodes,
                }
              : null,
          );
          if (m.reclassifiedMovie) reclassifiedMovieByKey.set(k, m.reclassifiedMovie);
          if (m.mediaId && m.confidence >= 0.7) showMediaByKey.set(k, m.mediaId);
          if (!m.mediaId && !m.reclassifiedMovie && m.dead) {
            const numberedMovies = await this.matcher.matchNumberedMovieGroup(
              title,
              (episodeGroupsByKey.get(k) ?? []).map((episode) => ({
                season: episode.season,
                episode: episode.episode,
              })),
            );
            if (numberedMovies) {
              numberedMovieGroupsByKey.set(k, numberedMovies);
              await Promise.all(
                [...numberedMovies.moviesByCoordinate.values()].map((movie) =>
                  this.enqueueClassificationOnce(importId, movie.mediaId),
                ),
              );
              return { mediaId: null, confidence: 0 };
            }
          }
        }
        if (m.reclassifiedMovie) return m;
        if (m.mediaId && m.confidence >= 0.7) {
          await this.enqueueClassificationOnce(importId, m.mediaId);
          if (hydrate && !hydrated.has(m.mediaId)) {
            hydrated.add(m.mediaId);
            await this.matcher.ensureShowHydrated(m.mediaId);
            const fp = showsRes.footprints.get(k);
            if (fp)
              await this.guardShowStructure(
                m.mediaId,
                fp.maxSeason,
                fp.seasonEpisodes,
                structureGuarded,
              );
          }
          return m;
        }
        return { mediaId: null, confidence: m.confidence };
      };

      const jsonEpisodeCandidates = [
        ...showsRes.episodes.map((candidate) => ({
          showIds: candidate.showIds,
          showTitle: candidate.showTitle,
          year: candidate.year,
          season: candidate.season,
          episode: candidate.episode,
          episodeIds: candidate.episodeIds,
        })),
        ...ratingsRes.candidates.flatMap((candidate) =>
          candidate.rating.targetType === 'episode' &&
          candidate.rating.showTitle &&
          candidate.rating.seasonNumber != null &&
          candidate.rating.episodeNumber != null
            ? [
                {
                  showIds: candidate.showIds ?? {},
                  showTitle: candidate.rating.showTitle,
                  year: null,
                  season: candidate.rating.seasonNumber,
                  episode: candidate.rating.episodeNumber,
                  episodeIds: candidate.episodeIds ?? {},
                },
              ]
            : [],
        ),
      ];
      const distinctEpisodeShows = new Map<string, (typeof jsonEpisodeCandidates)[number]>();
      for (const candidate of jsonEpisodeCandidates) {
        const key = mediaKey(candidate.showIds, normTitle(candidate.showTitle));
        if (!distinctEpisodeShows.has(key)) distinctEpisodeShows.set(key, candidate);
      }
      await this.mapWithMatchConcurrency([...distinctEpisodeShows.values()], async (candidate) => {
        await matchShowIds(candidate.showIds, candidate.showTitle, candidate.year, true);
      });
      await Promise.all([
        this.matcher.prefetchEpisodeCoordinates(
          jsonEpisodeCandidates.flatMap((candidate) => {
            const key = mediaKey(candidate.showIds, normTitle(candidate.showTitle));
            if (numberedMovieGroupsByKey.has(key)) return [];
            const mediaId = showMediaByKey.get(key);
            return mediaId
              ? [{ mediaId, season: candidate.season, episode: candidate.episode }]
              : [];
          }),
        ),
        this.matcher.prefetchEpisodeExternalIds(
          jsonEpisodeCandidates.flatMap((candidate) => {
            const key = mediaKey(candidate.showIds, normTitle(candidate.showTitle));
            if (numberedMovieGroupsByKey.has(key)) return [];
            const mediaId = showMediaByKey.get(key);
            if (!mediaId) return [];
            const requests: Array<{
              mediaId: string;
              provider: ExternalProvider;
              value: string;
            }> = [];
            if (candidate.episodeIds.tmdb) {
              requests.push({
                mediaId,
                provider: ExternalProvider.TMDB,
                value: String(candidate.episodeIds.tmdb),
              });
            }
            const tvdbId = normalizeNumericExternalId(candidate.episodeIds.tvdb);
            if (tvdbId) {
              requests.push({
                mediaId,
                provider: ExternalProvider.THE_TVDB,
                value: tvdbId,
              });
            }
            return requests;
          }),
        ),
      ]);

      const tvTimeWarmCandidates: Array<{
        ids: TraktIds;
        type: 'SHOW' | 'MOVIE';
        title: string;
        year: number | null;
      }> = [
        ...moviesRes.watched.map((candidate) => ({
          ids: candidate.movieIds,
          type: 'MOVIE' as const,
          title: candidate.movieTitle,
          year: candidate.year,
        })),
        ...[...moviesRes.watchlist, ...watchlistShows, ...favorites].map((candidate) => ({
          ids: candidate.ids,
          type: candidate.type === 'movie' ? ('MOVIE' as const) : ('SHOW' as const),
          title: candidate.title,
          year: candidate.year,
        })),
        ...lists.flatMap((list) =>
          list.items.map((candidate) => ({
            ids: candidate.ids,
            type: candidate.mediaType === 'movie' ? ('MOVIE' as const) : ('SHOW' as const),
            title: candidate.title,
            year: candidate.year,
          })),
        ),
        ...ratingsRes.candidates.flatMap((candidate) => {
          const movie = candidate.rating.targetType === 'movie';
          const title = movie ? candidate.rating.movieTitle : candidate.rating.showTitle;
          return title
            ? [
                {
                  ids: (movie ? candidate.movieIds : candidate.showIds) ?? {},
                  type: movie ? ('MOVIE' as const) : ('SHOW' as const),
                  title,
                  year: null,
                },
              ]
            : [];
        }),
      ];
      const distinctTvTimeWarm = new Map<string, (typeof tvTimeWarmCandidates)[number]>();
      for (const candidate of tvTimeWarmCandidates) {
        const key = `${candidate.type}:${candidate.ids.tvdb ?? ''}:${candidate.ids.imdb ?? ''}:${normTitle(candidate.title)}`;
        if (!distinctTvTimeWarm.has(key)) distinctTvTimeWarm.set(key, candidate);
      }
      await this.mapWithMatchConcurrency([...distinctTvTimeWarm.values()], async (candidate) => {
        await this.matcher.matchByExternalIds(
          candidate.ids,
          candidate.type,
          candidate.title,
          normTitle(candidate.title),
          candidate.year,
          null,
        );
      });

      let matched = 0,
        unmatched = 0,
        needsReview = 0,
        invalid = 0;
      const batch: any[] = [];
      const flush = async () => {
        if (!batch.length) return;
        await this.prisma.importItem.createMany({ data: batch.slice() });
        batch.length = 0;
      };
      const pushItem = async (row: any) => {
        batch.push(row);
        if (batch.length >= 200) await flush();
      };

      // ---- Watched episodes ----
      // Resolution chain: TVDB episode external id → S/E → TMDB /find recovery.
      // `special: true` episodes resolve ONLY via the external-id path: their S/E
      // numbers live in a separate numbering space and would corrupt into regular
      // episodes; an unresolved special is skipped, never staged.
      let epIdx = 0;
      const reclassifiedEpisodeRepresentatives = new Map<
        string,
        { candidate: (typeof showsRes.episodes)[number]; watchedAt: Date | null }
      >();
      for (const candidate of showsRes.episodes) {
        const reclassifiedMovie = reclassifiedMovieByKey.get(
          mediaKey(candidate.showIds, normTitle(candidate.showTitle)),
        );
        if (!reclassifiedMovie) continue;
        const existing = reclassifiedEpisodeRepresentatives.get(reclassifiedMovie.mediaId);
        if (
          !existing ||
          (candidate.watchedAt && (!existing.watchedAt || candidate.watchedAt > existing.watchedAt))
        ) {
          reclassifiedEpisodeRepresentatives.set(reclassifiedMovie.mediaId, {
            candidate,
            watchedAt: candidate.watchedAt,
          });
        }
      }
      for (const c of showsRes.episodes) {
        await this.reportProgress(
          importId,
          25 + (45 * epIdx++) / Math.max(1, showsRes.episodes.length),
        );
        const showKey = mediaKey(c.showIds, normTitle(c.showTitle));
        const numberedMovie = numberedMovieGroupsByKey
          .get(showKey)
          ?.moviesByCoordinate.get(numberedMovieCoordinateKey(c.season, c.episode));
        if (numberedMovie) {
          matched++;
          await pushItem({
            importId,
            rowNumber: 0,
            sourceEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            targetEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            status: 'MATCHED',
            rawData: {
              title: c.showTitle,
              year: c.year,
              season: c.season,
              episode: c.episode,
              showIds: c.showIds,
            } as any,
            normalizedData: {
              title: numberedMovie.matchedTitle,
              normTitle: normTitle(numberedMovie.matchedTitle),
              year: c.year,
              season: null,
              episode: null,
              watchedAt: c.watchedAt?.toISOString() ?? null,
              watchCount: 1,
              reclassifiedFrom: 'WATCHED_EPISODE',
              sourceTitle: c.showTitle,
              sourceSeason: c.season,
              sourceEpisode: c.episode,
              sourceTvdbSeriesId: normalizeNumericExternalId(c.showIds.tvdb),
            } as any,
            matchedMediaId: numberedMovie.mediaId,
            matchedEpisodeId: null,
            confidenceScore: numberedMovie.confidence,
          });
          continue;
        }
        const showMatch = await matchShowIds(c.showIds, c.showTitle, c.year, true);
        if (showMatch.reclassifiedMovie) {
          const representative = reclassifiedEpisodeRepresentatives.get(
            showMatch.reclassifiedMovie.mediaId,
          );
          if (representative?.candidate !== c) continue;
          matched++;
          await pushItem({
            importId,
            rowNumber: 0,
            sourceEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            targetEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            status: 'MATCHED',
            rawData: {
              title: c.showTitle,
              year: c.year,
              season: c.season,
              episode: c.episode,
              showIds: c.showIds,
            } as any,
            normalizedData: {
              title: showMatch.reclassifiedMovie.matchedTitle,
              normTitle: normTitle(showMatch.reclassifiedMovie.matchedTitle),
              year: c.year,
              season: null,
              episode: null,
              watchedAt: representative.watchedAt?.toISOString() ?? null,
              watchCount: 1,
              reclassifiedFrom: 'WATCHED_EPISODE',
              sourceTitle: c.showTitle,
              sourceSeason: c.season,
              sourceEpisode: c.episode,
              sourceTvdbSeriesId: normalizeNumericExternalId(c.showIds.tvdb),
            } as any,
            matchedMediaId: showMatch.reclassifiedMovie.mediaId,
            matchedEpisodeId: null,
            confidenceScore: showMatch.reclassifiedMovie.confidence,
          });
          continue;
        }
        const mediaId = showMatch.mediaId;
        let episodeId: string | null = null;
        let confidence = 0;
        if (mediaId) {
          episodeId = await this.matcher.resolveEpisodeByExternalIds(mediaId, c.episodeIds);
          if (!episodeId && !c.special) {
            episodeId = await this.matcher.resolveEpisode(mediaId, c.season, c.episode);
            confidence = episodeId ? 0.9 : 0.6;
            if (!episodeId && c.episodeIds.tvdb != null) {
              episodeId = await this.matcher.recoverEpisodeByTvdbId(mediaId, c.episodeIds.tvdb);
            }
          }
          confidence = episodeId ? 0.95 : 0;
        }
        if (c.special && !episodeId) {
          invalid++;
          continue;
        }
        let status: string;
        if (!mediaId) status = 'UNMATCHED';
        else if (!episodeId) status = 'NEEDS_REVIEW';
        else status = 'MATCHED';
        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else needsReview++;
        await pushItem({
          importId,
          rowNumber: 0,
          sourceEntityType: 'WATCHED_EPISODE' as ImportEntityType,
          targetEntityType: 'WATCHED_EPISODE' as ImportEntityType,
          status,
          rawData: {
            title: c.showTitle,
            year: c.year,
            season: c.season,
            episode: c.episode,
            special: c.special,
            showIds: c.showIds,
            episodeIds: c.episodeIds,
          } as any,
          normalizedData: {
            title: c.showTitle,
            normTitle: normTitle(c.showTitle),
            year: c.year,
            season: c.season,
            episode: c.episode,
            watchedAt: c.watchedAt?.toISOString() ?? null,
            watchCount: 1,
          } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: episodeId,
          confidenceScore: confidence,
        });
      }

      // ---- Watched movies + watchlist + favorites (shared single-media staging) ----
      let redundantNumberedMovieWatchlists = 0;
      const stageMediaItem = async (
        entityType:
          | 'WATCHED_MOVIE'
          | 'WATCHLIST_SHOW'
          | 'WATCHLIST_MOVIE'
          | 'FAVORITE_SHOW'
          | 'FAVORITE_MOVIE',
        ids: TraktIds,
        title: string,
        year: number | null,
        watchedAt: Date | null,
        watchCount: number,
      ) => {
        if (
          entityType === 'WATCHLIST_SHOW' &&
          numberedMovieGroupsByKey.has(mediaKey(ids, normTitle(title)))
        ) {
          redundantNumberedMovieWatchlists++;
          return;
        }
        const type = entityType.endsWith('_SHOW') ? 'SHOW' : 'MOVIE';
        const m = await this.matcher.matchByExternalIds(
          ids,
          type,
          title,
          normTitle(title),
          year,
          null,
        );
        const reclassifiedMovie = type === 'SHOW' ? m.reclassifiedMovie : null;
        const effectiveEntityType = reclassifiedMovie
          ? entityType === 'WATCHLIST_SHOW'
            ? 'WATCHLIST_MOVIE'
            : 'FAVORITE_MOVIE'
          : entityType;
        const mediaId = reclassifiedMovie?.mediaId ?? m.mediaId;
        const confidence = reclassifiedMovie?.confidence ?? m.confidence;
        const cls = this.matcher.classify(confidence);
        if (mediaId && cls === 'matched') {
          await this.enqueueClassificationOnce(importId, mediaId);
        }
        const status = !mediaId
          ? cls === 'unmatched'
            ? 'UNMATCHED'
            : 'NEEDS_REVIEW'
          : cls === 'matched'
            ? 'MATCHED'
            : 'NEEDS_REVIEW';
        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else needsReview++;
        await pushItem({
          importId,
          rowNumber: 0,
          sourceEntityType: effectiveEntityType as ImportEntityType,
          targetEntityType: effectiveEntityType as ImportEntityType,
          status,
          rawData: { title, year, ids } as any,
          normalizedData: {
            title,
            normTitle: normTitle(title),
            year,
            season: null,
            episode: null,
            watchedAt: watchedAt?.toISOString() ?? null,
            watchCount,
            reclassifiedFrom: reclassifiedMovie ? entityType : null,
            sourceTvdbSeriesId: reclassifiedMovie ? normalizeNumericExternalId(ids.tvdb) : null,
          } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: null,
          confidenceScore: confidence,
        });
      };
      const mediaStageTotal = Math.max(
        1,
        moviesRes.watched.length +
          moviesRes.watchlist.length +
          watchlistShows.length +
          favorites.length,
      );
      let mediaStageIdx = 0;
      for (const c of moviesRes.watched) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem('WATCHED_MOVIE', c.movieIds, c.movieTitle, c.year, c.watchedAt, 1);
      }
      for (const c of moviesRes.watchlist) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem('WATCHLIST_MOVIE', c.ids, c.title, c.year, c.listedAt, 1);
      }
      for (const c of watchlistShows) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem('WATCHLIST_SHOW', c.ids, c.title, c.year, c.listedAt, 1);
      }
      for (const c of favorites) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem(
          c.type === 'movie' ? 'FAVORITE_MOVIE' : 'FAVORITE_SHOW',
          c.ids,
          c.title,
          c.year,
          c.listedAt,
          1,
        );
      }
      await flush();

      // ---- Custom lists (lists.json) → LIST + LIST_ITEM items (same shapes as Trakt) ----
      const listBatch: any[] = [];
      const listItemTotal = Math.max(
        1,
        lists.reduce((n, l) => n + l.items.length, 0),
      );
      let listItemIdx = 0;
      for (const list of lists) {
        let resolved = 0;
        let unresolved = 0;
        const itemRows: any[] = [];
        for (const it of list.items) {
          await this.reportProgress(importId, 85 + (10 * listItemIdx++) / listItemTotal);
          const m = await this.matcher.matchByExternalIds(
            it.ids,
            it.mediaType === 'movie' ? 'MOVIE' : 'SHOW',
            it.title,
            normTitle(it.title),
            it.year,
            null,
          );
          const reclassifiedMovie = it.mediaType === 'show' ? (m.reclassifiedMovie ?? null) : null;
          const mediaId = reclassifiedMovie?.mediaId ?? m.mediaId;
          if (mediaId) resolved++;
          else unresolved++;
          itemRows.push({
            importId,
            rowNumber: it.order,
            sourceEntityType: 'LIST_ITEM' as ImportEntityType,
            targetEntityType: 'LIST_ITEM' as ImportEntityType,
            status: mediaId ? 'MATCHED' : 'NEEDS_REVIEW',
            rawData: { sourceKey: list.sourceKey, order: it.order } as any,
            normalizedData: {
              sourceKey: list.sourceKey,
              order: it.order,
              title: it.title,
              mediaType: reclassifiedMovie
                ? 'movie'
                : it.mediaType === 'movie'
                  ? 'movie'
                  : 'series',
              createdAt: it.createdAt?.toISOString() ?? null,
            } as any,
            matchedMediaId: mediaId,
            confidenceScore: mediaId ? (reclassifiedMovie?.confidence ?? 0.9) : 0,
          });
        }
        listBatch.push({
          importId,
          sourceEntityType: 'LIST' as ImportEntityType,
          targetEntityType: 'LIST' as ImportEntityType,
          status: 'MATCHED',
          rawData: { sourceKey: list.sourceKey } as any,
          normalizedData: {
            sourceKey: list.sourceKey,
            title: list.title,
            description: list.description,
            visibility: list.visibility,
            createdAt: list.createdAt?.toISOString() ?? null,
            itemCount: list.items.length,
            resolvedCount: resolved,
            unresolvedCount: unresolved,
          } as any,
          confidenceScore: 1,
        });
        listBatch.push(...itemRows);
      }
      for (let i = 0; i < listBatch.length; i += 200) {
        await this.prisma.importItem.createMany({ data: listBatch.slice(i, i + 200) });
      }

      // ---- Ratings: resolve targets external-ID-first, stage with the shared shapes ----
      let ratingsUnresolved = 0;
      const ratingItems: any[] = [];
      let ratingIdx = 0;
      for (const c of ratingsRes.candidates) {
        await this.reportProgress(
          importId,
          95 + (5 * ratingIdx++) / Math.max(1, ratingsRes.candidates.length),
        );
        let mediaId: string | null = null;
        let episodeId: string | null = null;
        let confidence = 0;
        let ratingForStage = c.rating;
        let status = 'UNMATCHED';
        if (c.rating.targetType === 'movie') {
          const title = c.rating.movieTitle ?? '';
          if (!title) {
            status = 'UNMATCHED';
          } else {
            const m = await this.matcher.matchByExternalIds(
              c.movieIds ?? {},
              'MOVIE',
              title,
              normTitle(title),
              null,
              null,
            );
            mediaId = m.mediaId;
            confidence = m.confidence;
            status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
          }
        } else {
          const title = c.rating.showTitle ?? '';
          if (!title) {
            status = 'UNMATCHED';
          } else {
            const sm = await matchShowIds(c.showIds ?? {}, title, null, true);
            if (sm.reclassifiedMovie) {
              mediaId = sm.reclassifiedMovie.mediaId;
              confidence = sm.reclassifiedMovie.confidence;
              status = 'MATCHED';
              ratingForStage = {
                ...c.rating,
                targetType: 'movie',
                movieTitle: title,
              };
            } else {
              mediaId = sm.mediaId;
            }
            if (
              !sm.reclassifiedMovie &&
              mediaId &&
              c.rating.seasonNumber != null &&
              c.rating.episodeNumber != null
            ) {
              episodeId =
                (await this.matcher.resolveEpisodeByExternalIds(mediaId, c.episodeIds ?? {})) ??
                (await this.matcher.resolveEpisode(
                  mediaId,
                  c.rating.seasonNumber,
                  c.rating.episodeNumber,
                )) ??
                (c.episodeIds?.tvdb != null
                  ? await this.matcher.recoverEpisodeByTvdbId(mediaId, c.episodeIds.tvdb)
                  : null);
              if (episodeId) {
                confidence = 0.9;
                status = 'MATCHED';
              } else {
                // Ratings fall back to a show-level record when the episode can't be resolved.
                confidence = 0.75;
                status = 'MATCHED';
              }
            } else if (!sm.reclassifiedMovie) {
              confidence = mediaId ? 0.85 : 0;
              status = mediaId ? 'MATCHED' : 'UNMATCHED';
            }
          }
        }
        if (status === 'UNMATCHED') ratingsUnresolved++;
        ratingItems.push(
          this.buildExtraItem(importId, ratingForStage, mediaId, episodeId, confidence, status),
        );
      }
      await this.flushItems(importId, ratingItems);

      await this.finishProcessing(importId, {
        totalFiles: parsed.length,
        totalRows,
        progress: 100,
        ...(await this.statusCounts(importId)),
        duplicateCount: redundantNumberedMovieWatchlists,
        conflictCount: 0,
        invalidCount:
          invalid +
          showsRes.invalid +
          moviesRes.invalid +
          favoritesSkipped +
          listsSkipped +
          watchlistCsvSkipped,
        ratingsDetected: ratingsRes.detected,
        ratingsSkippedUnsupported: ratingsRes.unsupported,
        ratingsSkippedUnresolved: ratingsUnresolved,
        commentRowsDetected: 0,
        topLevelCommentsDetected: 0,
        commentRepliesSkipped: 0,
        commentsSkippedInvalid: 0,
        commentsSkippedUnresolved: 0,
      });
      this.logger.log(
        `Import ${importId} (tvtime-json): staged episodes=${showsRes.episodes.length} movies=${moviesRes.watched.length} watchlist=${moviesRes.watchlist.length + watchlistShows.length} favorites=${favorites.length} ratings=${ratingsRes.candidates.length} lists=${lists.length}`,
      );
    } catch (e) {
      this.logger.error(`Import ${importId} failed: ${(e as Error).message}`);
      await this.setStatus(importId, 'FAILED', {
        errorMessage: this.friendlyImportError(e as Error),
      });
    }
  }

  /** Zip entries (or a synthetic single-file entry) when the upload is a TV Time Out export; else null. */
  private tvTimeOutEntriesFor(imp: any, bytes: Buffer): ZipEntry[] | null {
    if (imp.sourceType === 'zip') {
      const { entries } = inspectZip(bytes);
      return isTvTimeOutArchive(entries.map((e) => e.filename)) ? entries : null;
    }
    const name = imp.originalFilename ?? '';
    if (imp.sourceType === 'json' && isTvTimeOutStandaloneFile(name)) {
      return [{ filename: name, size: bytes.length, isSupported: true, getData: () => bytes }];
    }
    return null;
  }

  /**
   * TV Time Out (browser extension) export pipeline. Mirrors runTvTimeJsonBody but parses the
   * dated tvtime-series/tvtime-movies JSON files; tvtime-failed is logged for reporting
   * only and the tvtime-summary HTML file is unsupported. No ratings/emotions/comments/lists exist in
   * this format. `Import.format` stays 'tvtime' (default) so the apply stage tags records
   * source=TVTIME, sharing the conflict domain with legacy TV Time CSV + JSON imports (same
   * underlying TV Time account data).
   */
  private async runTvTimeOutBody(importId: string, entries: ZipEntry[]) {
    try {
      await this.setStatus(importId, 'PARSING', { totalFiles: entries.length, progress: 10 });

      // ---- PARSING ----
      const parsed: {
        filename: string;
        kind: TvTimeOutFileKind;
        data: unknown;
        size: number;
        failed: boolean;
      }[] = [];
      for (const e of entries) {
        const kind = e.isSupported ? classifyTvTimeOutFile(e.filename) : 'unsupported';
        if (kind === 'unsupported' || kind === 'summary') {
          parsed.push({ filename: e.filename, kind, data: null, size: e.size, failed: false });
          continue;
        }
        try {
          parsed.push({
            filename: e.filename,
            kind,
            data: JSON.parse(e.getData().toString('utf8')),
            size: e.size,
            failed: false,
          });
        } catch {
          this.logger.warn(`Import ${importId}: unparseable ${e.filename} — file skipped`);
          parsed.push({ filename: e.filename, kind, data: null, size: e.size, failed: true });
        }
      }
      let totalRows = 0;
      for (const f of parsed) {
        const status =
          f.failed || f.kind === 'unsupported' || f.kind === 'summary' ? 'unsupported' : 'parsed';
        const rowCount = f.failed ? 0 : Array.isArray(f.data) ? f.data.length : f.data ? 1 : 0;
        if (status === 'parsed') totalRows += rowCount;
        await this.prisma.importFile.create({
          data: {
            importId,
            filename: f.filename,
            detectedType: f.kind === 'summary' ? 'html' : 'json',
            fileSizeBytes: f.size,
            rowCount,
            headers: [],
            status,
          },
        });
      }
      if (totalRows > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalRows} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- NORMALIZING ----
      await this.setStatus(importId, 'NORMALIZING', { totalRows, progress: 15 });
      const ok = parsed.filter((f) => !f.failed);
      const dataOf = (kind: TvTimeOutFileKind) =>
        ok.filter((f) => f.kind === kind).map((f) => f.data);

      const seriesResults = dataOf('series').map((d) => normalizeTvTimeOutSeries(d));
      const episodes = seriesResults.flatMap((r) => r.episodes);
      const footprints = new Map(seriesResults.flatMap((r) => [...r.footprints.entries()]));
      const watchlistShows = seriesResults.flatMap((r) => r.watchlist);
      const showFavorites = seriesResults.flatMap((r) => r.favorites);
      const seriesInvalid = seriesResults.reduce((n, r) => n + r.invalid, 0);

      const moviesResults = dataOf('movies').map((d) => normalizeTvTimeOutMovies(d));
      const watchedMovies = moviesResults.flatMap((r) => r.watched);
      const watchlistMovies = moviesResults.flatMap((r) => r.watchlist);
      const movieFavorites = moviesResults.flatMap((r) => r.favorites);
      const moviesInvalid = moviesResults.reduce((n, r) => n + r.invalid, 0);

      const failedReports = dataOf('failed').map((d) => normalizeTvTimeOutFailed(d));
      const failedShows = failedReports.reduce((n, r) => n + r.total, 0);
      if (failedShows > 0) {
        this.logger.warn(
          `Import ${importId} (tvtime-out): ${failedShows} show(s) could not be exported by TV Time Out ` +
            `(server timeout) — missing from this archive: ${failedReports
              .flatMap((r) => r.shows.map((s) => s.title ?? `tvdb:${s.tvdbId}`))
              .slice(0, 20)
              .join(', ')}`,
        );
      }

      const totalCandidates =
        episodes.length +
        watchedMovies.length +
        watchlistShows.length +
        watchlistMovies.length +
        showFavorites.length +
        movieFavorites.length;
      if (totalCandidates > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalCandidates} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- MATCHING ----
      await this.setStatus(importId, 'MATCHING', { progress: 25 });
      await this.matcher.prefetchMediaExternalIds([
        ...episodes.flatMap((candidate) => this.externalIdRequests(candidate.showIds, 'SHOW')),
        ...watchedMovies.flatMap((candidate) =>
          this.externalIdRequests(candidate.movieIds, 'MOVIE'),
        ),
        ...watchlistShows.flatMap((candidate) => this.externalIdRequests(candidate.ids, 'SHOW')),
        ...watchlistMovies.flatMap((candidate) => this.externalIdRequests(candidate.ids, 'MOVIE')),
        ...showFavorites.flatMap((candidate) => this.externalIdRequests(candidate.ids, 'SHOW')),
        ...movieFavorites.flatMap((candidate) => this.externalIdRequests(candidate.ids, 'MOVIE')),
      ]);
      // Distinct shows keyed by strongest external id — one provider lookup per unique show.
      const showMediaByKey = new Map<string, string>();
      const reclassifiedMovieByKey = new Map<string, MovieReclassificationMatch>();
      const numberedMovieGroupsByKey = new Map<string, NumberedMovieGroupMatch>();
      const episodeGroupsByKey = new Map<string, typeof episodes>();
      for (const episode of episodes) {
        if (episode.special) continue;
        const key = mediaKey(episode.showIds, normTitle(episode.showTitle));
        const group = episodeGroupsByKey.get(key) ?? [];
        group.push(episode);
        episodeGroupsByKey.set(key, group);
      }
      const hydrated = new Set<string>();
      const structureGuarded = new Set<string>();
      const matchShowIds = async (
        ids: TraktIds,
        title: string,
        year: number | null,
        hydrate: boolean,
      ) => {
        const k = mediaKey(ids, normTitle(title));
        let m: {
          mediaId: string | null;
          confidence: number;
          dead?: boolean;
          reclassifiedMovie?: MovieReclassificationMatch;
        };
        if (numberedMovieGroupsByKey.has(k)) {
          return { mediaId: null, confidence: 0 };
        }
        const cached = showMediaByKey.get(k);
        const cachedMovie = reclassifiedMovieByKey.get(k);
        if (cachedMovie) {
          m = { mediaId: null, confidence: 0, reclassifiedMovie: cachedMovie };
        } else if (cached) {
          m = { mediaId: cached, confidence: 0.95 };
        } else {
          const footprint = footprints.get(k);
          m = await this.matcher.matchByExternalIds(
            ids,
            'SHOW',
            title,
            normTitle(title),
            year,
            null,
            footprint
              ? {
                  maxSeason: footprint.maxSeason,
                  seasonEpisodes: footprint.seasonEpisodes,
                }
              : null,
          );
          if (m.reclassifiedMovie) reclassifiedMovieByKey.set(k, m.reclassifiedMovie);
          if (m.mediaId && m.confidence >= 0.7) showMediaByKey.set(k, m.mediaId);
          if (!m.mediaId && !m.reclassifiedMovie && m.dead) {
            const numberedMovies = await this.matcher.matchNumberedMovieGroup(
              title,
              (episodeGroupsByKey.get(k) ?? []).map((episode) => ({
                season: episode.season,
                episode: episode.episode,
              })),
            );
            if (numberedMovies) {
              numberedMovieGroupsByKey.set(k, numberedMovies);
              await Promise.all(
                [...numberedMovies.moviesByCoordinate.values()].map((movie) =>
                  this.enqueueClassificationOnce(importId, movie.mediaId),
                ),
              );
              return { mediaId: null, confidence: 0 };
            }
          }
        }
        if (m.reclassifiedMovie) return m;
        if (m.mediaId && m.confidence >= 0.7) {
          await this.enqueueClassificationOnce(importId, m.mediaId);
          if (hydrate && !hydrated.has(m.mediaId)) {
            hydrated.add(m.mediaId);
            await this.matcher.ensureShowHydrated(m.mediaId);
            const fp = footprints.get(k);
            if (fp)
              await this.guardShowStructure(
                m.mediaId,
                fp.maxSeason,
                fp.seasonEpisodes,
                structureGuarded,
              );
          }
          return m;
        }
        return { mediaId: null, confidence: m.confidence };
      };

      const distinctOutShows = new Map<string, (typeof episodes)[number]>();
      for (const candidate of episodes) {
        const key = mediaKey(candidate.showIds, normTitle(candidate.showTitle));
        if (!distinctOutShows.has(key)) distinctOutShows.set(key, candidate);
      }
      await this.mapWithMatchConcurrency([...distinctOutShows.values()], async (candidate) => {
        await matchShowIds(candidate.showIds, candidate.showTitle, candidate.year, true);
      });
      await Promise.all([
        this.matcher.prefetchEpisodeCoordinates(
          episodes.flatMap((candidate) => {
            const key = mediaKey(candidate.showIds, normTitle(candidate.showTitle));
            if (numberedMovieGroupsByKey.has(key)) return [];
            const mediaId = showMediaByKey.get(key);
            return mediaId
              ? [{ mediaId, season: candidate.season, episode: candidate.episode }]
              : [];
          }),
        ),
        this.matcher.prefetchEpisodeExternalIds(
          episodes.flatMap((candidate) => {
            const key = mediaKey(candidate.showIds, normTitle(candidate.showTitle));
            if (numberedMovieGroupsByKey.has(key)) return [];
            const mediaId = showMediaByKey.get(key);
            if (!mediaId) return [];
            const requests: Array<{
              mediaId: string;
              provider: ExternalProvider;
              value: string;
            }> = [];
            if (candidate.episodeIds.tmdb) {
              requests.push({
                mediaId,
                provider: ExternalProvider.TMDB,
                value: String(candidate.episodeIds.tmdb),
              });
            }
            const tvdbId = normalizeNumericExternalId(candidate.episodeIds.tvdb);
            if (tvdbId) {
              requests.push({
                mediaId,
                provider: ExternalProvider.THE_TVDB,
                value: tvdbId,
              });
            }
            return requests;
          }),
        ),
      ]);

      const outWarmCandidates: Array<{
        ids: TraktIds;
        type: 'SHOW' | 'MOVIE';
        title: string;
        year: number | null;
      }> = [
        ...watchedMovies.map((candidate) => ({
          ids: candidate.movieIds,
          type: 'MOVIE' as const,
          title: candidate.movieTitle,
          year: candidate.year,
        })),
        ...[...watchlistShows, ...watchlistMovies, ...showFavorites, ...movieFavorites].map(
          (candidate) => ({
            ids: candidate.ids,
            type: candidate.type === 'movie' ? ('MOVIE' as const) : ('SHOW' as const),
            title: candidate.title,
            year: candidate.year,
          }),
        ),
      ];
      const distinctOutWarm = new Map<string, (typeof outWarmCandidates)[number]>();
      for (const candidate of outWarmCandidates) {
        const key = `${candidate.type}:${candidate.ids.tvdb ?? ''}:${candidate.ids.imdb ?? ''}:${normTitle(candidate.title)}`;
        if (!distinctOutWarm.has(key)) distinctOutWarm.set(key, candidate);
      }
      await this.mapWithMatchConcurrency([...distinctOutWarm.values()], async (candidate) => {
        await this.matcher.matchByExternalIds(
          candidate.ids,
          candidate.type,
          candidate.title,
          normTitle(candidate.title),
          candidate.year,
          null,
        );
      });

      let matched = 0,
        unmatched = 0,
        needsReview = 0,
        invalid = 0;
      const batch: any[] = [];
      const flush = async () => {
        if (!batch.length) return;
        await this.prisma.importItem.createMany({ data: batch.slice() });
        batch.length = 0;
      };
      const pushItem = async (row: any) => {
        batch.push(row);
        if (batch.length >= 200) await flush();
      };

      // ---- Watched episodes ----
      // Resolution chain: TVDB episode external id → S/E → TMDB /find recovery.
      // Special episodes resolve ONLY via the external-id path: their S/E numbers
      // live in a separate numbering space and would corrupt into regular episodes;
      // an unresolved special is skipped, never staged.
      let epIdx = 0;
      const reclassifiedEpisodeRepresentatives = new Map<
        string,
        {
          candidate: (typeof episodes)[number];
          watchedAt: Date | null;
          watchCount: number;
        }
      >();
      for (const candidate of episodes) {
        const reclassifiedMovie = reclassifiedMovieByKey.get(
          mediaKey(candidate.showIds, normTitle(candidate.showTitle)),
        );
        if (!reclassifiedMovie) continue;
        const existing = reclassifiedEpisodeRepresentatives.get(reclassifiedMovie.mediaId);
        if (!existing) {
          reclassifiedEpisodeRepresentatives.set(reclassifiedMovie.mediaId, {
            candidate,
            watchedAt: candidate.watchedAt,
            watchCount: candidate.watchCount,
          });
          continue;
        }
        existing.watchCount = Math.max(existing.watchCount, candidate.watchCount);
        if (
          candidate.watchedAt &&
          (!existing.watchedAt || candidate.watchedAt > existing.watchedAt)
        ) {
          existing.candidate = candidate;
          existing.watchedAt = candidate.watchedAt;
        }
      }
      for (const c of episodes) {
        await this.reportProgress(importId, 25 + (45 * epIdx++) / Math.max(1, episodes.length));
        const showKey = mediaKey(c.showIds, normTitle(c.showTitle));
        const numberedMovie = numberedMovieGroupsByKey
          .get(showKey)
          ?.moviesByCoordinate.get(numberedMovieCoordinateKey(c.season, c.episode));
        if (numberedMovie) {
          matched++;
          await pushItem({
            importId,
            rowNumber: 0,
            sourceEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            targetEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            status: 'MATCHED',
            rawData: {
              title: c.showTitle,
              year: c.year,
              season: c.season,
              episode: c.episode,
              showIds: c.showIds,
            } as any,
            normalizedData: {
              title: numberedMovie.matchedTitle,
              normTitle: normTitle(numberedMovie.matchedTitle),
              year: c.year,
              season: null,
              episode: null,
              watchedAt: c.watchedAt?.toISOString() ?? null,
              watchCount: c.watchCount,
              reclassifiedFrom: 'WATCHED_EPISODE',
              sourceTitle: c.showTitle,
              sourceSeason: c.season,
              sourceEpisode: c.episode,
              sourceTvdbSeriesId: normalizeNumericExternalId(c.showIds.tvdb),
            } as any,
            matchedMediaId: numberedMovie.mediaId,
            matchedEpisodeId: null,
            confidenceScore: numberedMovie.confidence,
          });
          continue;
        }
        const showMatch = await matchShowIds(c.showIds, c.showTitle, c.year, true);
        if (showMatch.reclassifiedMovie) {
          const representative = reclassifiedEpisodeRepresentatives.get(
            showMatch.reclassifiedMovie.mediaId,
          );
          if (representative?.candidate !== c) continue;
          matched++;
          await pushItem({
            importId,
            rowNumber: 0,
            sourceEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            targetEntityType: 'WATCHED_MOVIE' as ImportEntityType,
            status: 'MATCHED',
            rawData: {
              title: c.showTitle,
              year: c.year,
              season: c.season,
              episode: c.episode,
              showIds: c.showIds,
            } as any,
            normalizedData: {
              title: showMatch.reclassifiedMovie.matchedTitle,
              normTitle: normTitle(showMatch.reclassifiedMovie.matchedTitle),
              year: c.year,
              season: null,
              episode: null,
              watchedAt: representative.watchedAt?.toISOString() ?? null,
              watchCount: representative.watchCount,
              reclassifiedFrom: 'WATCHED_EPISODE',
              sourceTitle: c.showTitle,
              sourceSeason: c.season,
              sourceEpisode: c.episode,
              sourceTvdbSeriesId: normalizeNumericExternalId(c.showIds.tvdb),
            } as any,
            matchedMediaId: showMatch.reclassifiedMovie.mediaId,
            matchedEpisodeId: null,
            confidenceScore: showMatch.reclassifiedMovie.confidence,
          });
          continue;
        }
        const mediaId = showMatch.mediaId;
        let episodeId: string | null = null;
        let confidence = 0;
        if (mediaId) {
          episodeId = await this.matcher.resolveEpisodeByExternalIds(mediaId, c.episodeIds);
          if (!episodeId && !c.special) {
            episodeId = await this.matcher.resolveEpisode(mediaId, c.season, c.episode);
            confidence = episodeId ? 0.9 : 0.6;
            if (!episodeId && c.episodeIds.tvdb != null) {
              episodeId = await this.matcher.recoverEpisodeByTvdbId(mediaId, c.episodeIds.tvdb);
            }
          }
          confidence = episodeId ? 0.95 : 0;
        }
        if (c.special && !episodeId) {
          invalid++;
          continue;
        }
        let status: string;
        if (!mediaId) status = 'UNMATCHED';
        else if (!episodeId) status = 'NEEDS_REVIEW';
        else status = 'MATCHED';
        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else needsReview++;
        await pushItem({
          importId,
          rowNumber: 0,
          sourceEntityType: 'WATCHED_EPISODE' as ImportEntityType,
          targetEntityType: 'WATCHED_EPISODE' as ImportEntityType,
          status,
          rawData: {
            title: c.showTitle,
            year: c.year,
            season: c.season,
            episode: c.episode,
            special: c.special,
            showIds: c.showIds,
            episodeIds: c.episodeIds,
          } as any,
          normalizedData: {
            title: c.showTitle,
            normTitle: normTitle(c.showTitle),
            year: c.year,
            season: c.season,
            episode: c.episode,
            watchedAt: c.watchedAt?.toISOString() ?? null,
            watchCount: c.watchCount,
          } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: episodeId,
          confidenceScore: confidence,
        });
      }

      // ---- Watched movies + watchlist + favorites (shared single-media staging) ----
      let redundantNumberedMovieWatchlists = 0;
      const stageMediaItem = async (
        entityType:
          | 'WATCHED_MOVIE'
          | 'WATCHLIST_SHOW'
          | 'WATCHLIST_MOVIE'
          | 'FAVORITE_SHOW'
          | 'FAVORITE_MOVIE',
        ids: TraktIds,
        title: string,
        year: number | null,
        watchedAt: Date | null,
        watchCount: number,
      ) => {
        if (
          entityType === 'WATCHLIST_SHOW' &&
          numberedMovieGroupsByKey.has(mediaKey(ids, normTitle(title)))
        ) {
          redundantNumberedMovieWatchlists++;
          return;
        }
        const type = entityType.endsWith('_SHOW') ? 'SHOW' : 'MOVIE';
        const m = await this.matcher.matchByExternalIds(
          ids,
          type,
          title,
          normTitle(title),
          year,
          null,
        );
        const reclassifiedMovie = type === 'SHOW' ? m.reclassifiedMovie : null;
        const effectiveEntityType = reclassifiedMovie
          ? entityType === 'WATCHLIST_SHOW'
            ? 'WATCHLIST_MOVIE'
            : 'FAVORITE_MOVIE'
          : entityType;
        const mediaId = reclassifiedMovie?.mediaId ?? m.mediaId;
        const confidence = reclassifiedMovie?.confidence ?? m.confidence;
        const cls = this.matcher.classify(confidence);
        if (mediaId && cls === 'matched') {
          await this.enqueueClassificationOnce(importId, mediaId);
        }
        const status = !mediaId
          ? cls === 'unmatched'
            ? 'UNMATCHED'
            : 'NEEDS_REVIEW'
          : cls === 'matched'
            ? 'MATCHED'
            : 'NEEDS_REVIEW';
        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else needsReview++;
        await pushItem({
          importId,
          rowNumber: 0,
          sourceEntityType: effectiveEntityType as ImportEntityType,
          targetEntityType: effectiveEntityType as ImportEntityType,
          status,
          rawData: { title, year, ids } as any,
          normalizedData: {
            title,
            normTitle: normTitle(title),
            year,
            season: null,
            episode: null,
            watchedAt: watchedAt?.toISOString() ?? null,
            watchCount,
            reclassifiedFrom: reclassifiedMovie ? entityType : null,
            sourceTvdbSeriesId: reclassifiedMovie ? normalizeNumericExternalId(ids.tvdb) : null,
          } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: null,
          confidenceScore: confidence,
        });
      };
      const mediaStageTotal = Math.max(
        1,
        watchedMovies.length +
          watchlistMovies.length +
          watchlistShows.length +
          showFavorites.length +
          movieFavorites.length,
      );
      let mediaStageIdx = 0;
      for (const c of watchedMovies) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem(
          'WATCHED_MOVIE',
          c.movieIds,
          c.movieTitle,
          c.year,
          c.watchedAt,
          c.watchCount,
        );
      }
      for (const c of watchlistMovies) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem('WATCHLIST_MOVIE', c.ids, c.title, c.year, c.listedAt, 1);
      }
      for (const c of watchlistShows) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem('WATCHLIST_SHOW', c.ids, c.title, c.year, c.listedAt, 1);
      }
      for (const c of [...showFavorites, ...movieFavorites]) {
        await this.reportProgress(importId, 70 + (15 * mediaStageIdx++) / mediaStageTotal);
        await stageMediaItem(
          c.type === 'movie' ? 'FAVORITE_MOVIE' : 'FAVORITE_SHOW',
          c.ids,
          c.title,
          c.year,
          c.listedAt,
          1,
        );
      }
      await flush();

      await this.finishProcessing(importId, {
        totalFiles: parsed.length,
        totalRows,
        progress: 100,
        ...(await this.statusCounts(importId)),
        duplicateCount: redundantNumberedMovieWatchlists,
        conflictCount: 0,
        invalidCount: invalid + seriesInvalid + moviesInvalid,
        ratingsDetected: 0,
        ratingsSkippedUnsupported: 0,
        ratingsSkippedUnresolved: 0,
        commentRowsDetected: 0,
        topLevelCommentsDetected: 0,
        commentRepliesSkipped: 0,
        commentsSkippedInvalid: 0,
        commentsSkippedUnresolved: 0,
      });
      this.logger.log(
        `Import ${importId} (tvtime-out): staged episodes=${episodes.length} movies=${watchedMovies.length} watchlist=${watchlistShows.length + watchlistMovies.length} favorites=${showFavorites.length + movieFavorites.length} failedShows=${failedShows}`,
      );
    } catch (e) {
      this.logger.error(`Import ${importId} failed: ${(e as Error).message}`);
      await this.setStatus(importId, 'FAILED', {
        errorMessage: this.friendlyImportError(e as Error),
      });
    }
  }

  private movieGroupMatchForExtra(
    candidate: {
      showTitle?: string | null;
      seasonNumber?: number | null;
      episodeNumber?: number | null;
    },
    archiveIdentity: ArchiveIdentityIndex,
    movieGroupsByShowKey: Map<string, NumberedMovieGroupMatch>,
  ): MovieReclassificationMatch | null {
    if (!candidate.showTitle || candidate.seasonNumber == null || candidate.episodeNumber == null) {
      return null;
    }
    const identity = archiveIdentity.identifyShow(candidate.showTitle);
    const seriesIds = archiveIdentity.seriesIdsFor(candidate.showTitle, identity.year);
    const keys = [
      identity.key,
      `title:${identity.key}`,
      ...(seriesIds.length === 1 ? [`tvdb:${seriesIds[0]}`] : []),
    ];
    for (const key of keys) {
      const movie = movieGroupsByShowKey
        .get(key)
        ?.moviesByCoordinate.get(
          numberedMovieCoordinateKey(candidate.seasonNumber, candidate.episodeNumber),
        );
      if (movie) return movie;
    }
    return null;
  }

  /**
   * Stage ratings, emotions, and top-level comments. Reuses the matcher caches warmed by the
   * watched-episode pass (and hydrates any additional shows on demand). Only supported, owner
   * candidates are staged as ImportItems; unsupported/duplicate/activity rows are counted in
   * the returned summary (written to the Import row by the caller).
   *
   * Privacy: comment text is stored only in the staged item's normalizedData (never logged).
   */
  private async stageExtraEntities(
    importId: string,
    files: ParsedFile[],
    showMediaByNorm: Map<string, string>,
    archiveLang: SupportedLocale | null,
    archiveIdentity: ArchiveIdentityIndex,
    numberedMovieGroupsByShowKey: Map<string, NumberedMovieGroupMatch> = new Map(),
    suppressedExtraShowNorms: Set<string> = new Set(),
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {
      ratingsDetected: 0,
      ratingsSkippedUnsupported: 0,
      ratingsSkippedUnresolved: 0,
      ratingDuplicatesIgnored: 0,
      emotionsDetected: 0,
      emotionsSkippedUnsupported: 0,
      emotionsSkippedUnresolved: 0,
      emotionDuplicatesIgnored: 0,
      commentRowsDetected: 0,
      topLevelCommentsDetected: 0,
      commentRepliesSkipped: 0,
      commentActivityRowsSkipped: 0,
      commentsByOtherUsersSkipped: 0,
      commentsSkippedUnresolved: 0,
      commentDuplicatesIgnored: 0,
      commentsSkippedInvalid: 0,
      characterVotesDetected: 0,
      characterVotesSkippedUnresolved: 0,
      characterVoteDuplicatesIgnored: 0,
      characterVotesSkippedInvalid: 0,
    };

    const fileInputs = files.map((f) => ({ filename: f.filename, rows: f.rows }));
    const ownerId = resolveArchiveOwner(fileInputs);
    // Persist for shadow-account claiming at apply time (ImportService.claimShadowAccount).
    await this.prisma.import
      .update({ where: { id: importId }, data: { ownerExternalId: ownerId } })
      .catch(() => undefined);

    // ----- Ratings -----
    const allRatings: NormalizedImportedRating[] = [];
    for (const f of files) {
      const res = normalizeRatings(f.filename, f.rows);
      counts.ratingsDetected += res.detected;
      counts.ratingsSkippedUnsupported += res.unsupported;
      for (const candidate of res.candidates.filter((c) => c.supported)) {
        if (shouldSuppressLegacyExtraTitle(candidate.showTitle, suppressedExtraShowNorms)) {
          counts.ratingDuplicatesIgnored++;
          continue;
        }
        allRatings.push(candidate);
      }
    }
    const ratingDedup = dedupeRatings(allRatings);
    counts.ratingDuplicatesIgnored += ratingDedup.duplicates;
    // ----- Emotions -----
    const allEmotions: NormalizedImportedEmotion[] = [];
    for (const f of files) {
      const res = normalizeEmotions(f.filename, f.rows);
      counts.emotionsDetected += res.detected;
      counts.emotionsSkippedUnsupported += res.unsupported;
      for (const candidate of res.candidates.filter((c) => c.supported)) {
        if (shouldSuppressLegacyExtraTitle(candidate.showTitle, suppressedExtraShowNorms)) {
          counts.emotionDuplicatesIgnored++;
          continue;
        }
        allEmotions.push(candidate);
      }
    }
    const emotionDedup = dedupeEmotions(allEmotions);
    counts.emotionDuplicatesIgnored += emotionDedup.duplicates;
    // ----- Comments -----
    const allComments: NormalizedImportedComment[] = [];
    for (const f of files) {
      const res = normalizeComments(f.filename, f.rows, ownerId);
      counts.commentRowsDetected += res.rowsDetected;
      counts.topLevelCommentsDetected += res.topLevelDetected;
      counts.commentRepliesSkipped += res.repliesSkipped;
      counts.commentActivityRowsSkipped += res.activityRowsSkipped;
      counts.commentsByOtherUsersSkipped += res.otherUsersSkipped;
      counts.commentsSkippedInvalid += res.invalid;
      for (const candidate of res.candidates) {
        if (shouldSuppressLegacyExtraTitle(candidate.showTitle, suppressedExtraShowNorms)) {
          counts.commentDuplicatesIgnored++;
          continue;
        }
        allComments.push(candidate);
      }
    }
    const commentDedup = dedupeComments(allComments);
    counts.commentDuplicatesIgnored += commentDedup.duplicates;
    // ----- Character votes (show_character_episode_vote.csv) -----
    // Episodes resolve via TVDB episode external ids (local), characters resolve at apply
    // time via media_cast.characterExternalId (local) — no provider calls per vote.
    const allCharVotes: NormalizedCharacterVote[] = [];
    for (const f of files) {
      const res = normalizeCharacterVotes(f.filename, f.rows);
      counts.characterVotesDetected += res.detected;
      counts.characterVotesSkippedInvalid += res.invalid;
      for (const candidate of res.candidates) {
        if (shouldSuppressLegacyExtraTitle(candidate.showTitle, suppressedExtraShowNorms)) {
          counts.characterVoteDuplicatesIgnored++;
          continue;
        }
        allCharVotes.push(candidate);
      }
    }
    const charVoteUnique = dedupeCharacterVotes(allCharVotes);
    counts.characterVoteDuplicatesIgnored += allCharVotes.length - charVoteUnique.length;

    const extraEpisodeTargets = [
      ...ratingDedup.unique.flatMap((candidate) =>
        candidate.targetType === 'episode' ? [candidate] : [],
      ),
      ...emotionDedup.unique.flatMap((candidate) =>
        candidate.targetType === 'episode' ? [candidate] : [],
      ),
      ...commentDedup.unique.flatMap((candidate) =>
        candidate.targetType === 'episode' ? [candidate] : [],
      ),
      ...charVoteUnique,
    ];
    await this.matcher.prefetchEpisodeParents(
      extraEpisodeTargets.flatMap((candidate) => {
        const value = normalizeNumericExternalId(candidate.externalEpisodeId);
        return value ? [{ provider: ExternalProvider.THE_TVDB, value }] : [];
      }),
    );
    const mediaForExtra = (candidate: (typeof extraEpisodeTargets)[number]): string | null => {
      const exactParent = candidate.externalEpisodeId
        ? this.matcher.matchPrefetchedShowByEpisodeIds([candidate.externalEpisodeId])
        : null;
      if (exactParent?.mediaId) return exactParent.mediaId;
      const titleMediaId = candidate.showTitle
        ? archiveIdentity.resolveShow(candidate.showTitle)
        : null;
      const episodeMatch = archiveIdentity.resolveEpisode(
        candidate.externalEpisodeId,
        titleMediaId,
      );
      if (episodeMatch) return episodeMatch.mediaId;
      return titleMediaId;
    };
    const numberedMovieForExtra = (candidate: {
      showTitle?: string | null;
      seasonNumber?: number | null;
      episodeNumber?: number | null;
    }): MovieReclassificationMatch | null =>
      this.movieGroupMatchForExtra(candidate, archiveIdentity, numberedMovieGroupsByShowKey);
    const distinctExtraShows = new Map<string, (typeof extraEpisodeTargets)[number]>();
    for (const candidate of extraEpisodeTargets) {
      if (!candidate.showTitle) continue;
      const identity = archiveIdentity.identifyShow(candidate.showTitle);
      if (archiveIdentity.resolveShowAsMovie(candidate.showTitle, identity.year)) continue;
      if (numberedMovieForExtra(candidate)) continue;
      if (!mediaForExtra(candidate) && !distinctExtraShows.has(identity.key)) {
        distinctExtraShows.set(identity.key, candidate);
      }
    }
    await this.mapWithMatchConcurrency([...distinctExtraShows.values()], async (candidate) => {
      const identity = archiveIdentity.identifyShow(candidate.showTitle!);
      const archiveSeriesIds = archiveIdentity.seriesIdsFor(candidate.showTitle!);
      const match = await this.matcher.matchMedia(
        identity.normTitle,
        identity.title,
        'SHOW',
        identity.year,
        {
          maxSeason: candidate.seasonNumber ?? null,
          seasonEpisodes:
            candidate.seasonNumber != null && candidate.episodeNumber != null
              ? [{ season: candidate.seasonNumber, maxEpisode: candidate.episodeNumber }]
              : null,
        },
        archiveLang,
        archiveSeriesIds[0] ?? null,
        archiveSeriesIds.length ? archiveSeriesIds : undefined,
      );
      if (match.reclassifiedMovie) {
        archiveIdentity.bindShowAsMovie(
          candidate.showTitle!,
          identity.year,
          archiveSeriesIds,
          match.reclassifiedMovie.mediaId,
        );
        await this.enqueueClassificationOnce(importId, match.reclassifiedMovie.mediaId);
        return;
      }
      if (match.mediaId && match.confidence >= 0.7) {
        await this.matcher.ensureShowHydrated(match.mediaId);
        archiveIdentity.bindShow(candidate.showTitle!, identity.year, match.mediaId);
        showMediaByNorm.set(identity.normTitle, match.mediaId);
        await this.enqueueClassificationOnce(importId, match.mediaId);
      }
    });

    const extraMovies = [
      ...ratingDedup.unique,
      ...emotionDedup.unique,
      ...commentDedup.unique,
    ].filter(
      (candidate): candidate is typeof candidate & { movieTitle: string } =>
        candidate.targetType === 'movie' && !!candidate.movieTitle,
    );
    const distinctExtraMovies = new Map<string, (typeof extraMovies)[number]>();
    for (const candidate of extraMovies) {
      const key = archiveIdentity.identifyMovie(
        candidate.movieTitle,
        undefined,
        candidate.movieUuid,
      ).key;
      if (!distinctExtraMovies.has(key)) distinctExtraMovies.set(key, candidate);
    }
    await this.mapWithMatchConcurrency([...distinctExtraMovies.values()], async (candidate) => {
      await this.resolveMovieTarget(
        candidate.movieTitle,
        candidate.movieUuid,
        archiveLang,
        archiveIdentity,
      );
    });

    await Promise.all([
      this.matcher.prefetchEpisodeCoordinates(
        extraEpisodeTargets.flatMap((candidate) => {
          const mediaId = mediaForExtra(candidate);
          return mediaId && candidate.seasonNumber != null && candidate.episodeNumber != null
            ? [
                {
                  mediaId,
                  season: candidate.seasonNumber,
                  episode: candidate.episodeNumber,
                },
              ]
            : [];
        }),
      ),
      this.matcher.prefetchEpisodeExternalIds(
        extraEpisodeTargets.flatMap((candidate) => {
          const mediaId = mediaForExtra(candidate);
          const value = normalizeNumericExternalId(candidate.externalEpisodeId);
          return mediaId && value ? [{ mediaId, provider: ExternalProvider.THE_TVDB, value }] : [];
        }),
      ),
    ]);

    // Progress spans 87→95 across ALL extras sections (shared counter, weighted by
    // candidate count) — the extras staging was previously invisible on the bar.
    const extrasTotal = Math.max(
      1,
      ratingDedup.unique.length +
        emotionDedup.unique.length +
        commentDedup.unique.length +
        charVoteUnique.length,
    );
    let extrasIdx = 0;
    const reportExtras = () => this.reportProgress(importId, 87 + (8 * extrasIdx++) / extrasTotal);
    const movieVersionOf = <
      T extends {
        targetType: string;
        showTitle?: string | null;
        movieTitle?: string | null;
      },
    >(
      candidate: T,
    ): T =>
      ({
        ...candidate,
        targetType: 'movie',
        movieTitle: candidate.showTitle ?? candidate.movieTitle ?? null,
      }) as T;
    const reclassifiedMovieIdFor = (candidate: {
      targetType: string;
      showTitle?: string | null;
      seasonNumber?: number | null;
      episodeNumber?: number | null;
    }): string | null =>
      candidate.targetType !== 'movie' && candidate.showTitle
        ? (numberedMovieForExtra(candidate)?.mediaId ??
          archiveIdentity.resolveShowAsMovie(candidate.showTitle))
        : null;

    const ratingItems: any[] = [];
    const resolvedRatings: any[] = new Array(ratingDedup.unique.length);
    await this.mapWithMatchConcurrency(ratingDedup.unique, async (c, index) => {
      await reportExtras();
      const reclassifiedMediaId = reclassifiedMovieIdFor(c);
      const candidate = reclassifiedMediaId ? movieVersionOf(c) : c;
      resolvedRatings[index] = {
        candidate,
        match: reclassifiedMediaId
          ? {
              mediaId: reclassifiedMediaId,
              episodeId: null,
              confidence: 0.95,
              status: 'MATCHED',
            }
          : await this.resolveRatingTarget(c, showMediaByNorm, archiveLang, archiveIdentity),
      };
    });
    for (const { candidate: c, match } of resolvedRatings) {
      const { mediaId, episodeId, confidence, status } = match;
      if (status === 'UNMATCHED') {
        counts.ratingsSkippedUnresolved++;
        // No title AND unresolvable identity: the user can't even search for it —
        // never surface it in the review list.
        if (!c.showTitle && !c.movieTitle) continue;
      }
      ratingItems.push(this.buildExtraItem(importId, c, mediaId, episodeId, confidence, status));
    }
    await this.flushItems(importId, ratingItems);

    const emotionItems: any[] = [];
    const resolvedEmotions: any[] = new Array(emotionDedup.unique.length);
    await this.mapWithMatchConcurrency(emotionDedup.unique, async (c, index) => {
      await reportExtras();
      const reclassifiedMediaId = reclassifiedMovieIdFor(c);
      const candidate = reclassifiedMediaId ? movieVersionOf(c) : c;
      resolvedEmotions[index] = {
        candidate,
        match: reclassifiedMediaId
          ? {
              mediaId: reclassifiedMediaId,
              episodeId: null,
              confidence: 0.95,
              status: 'MATCHED',
            }
          : await this.resolveEmotionTarget(c, showMediaByNorm, archiveLang, archiveIdentity),
      };
    });
    for (const { candidate: c, match } of resolvedEmotions) {
      const { mediaId, episodeId, confidence, status } = match;
      if (status === 'UNMATCHED') {
        counts.emotionsSkippedUnresolved++;
        // No title AND unresolvable identity: unsearchable even manually — skip silently.
        if (!c.showTitle && !c.movieTitle) continue;
      }
      emotionItems.push(this.buildExtraItem(importId, c, mediaId, episodeId, confidence, status));
    }
    await this.flushItems(importId, emotionItems);

    const commentItems: any[] = [];
    const resolvedComments: any[] = new Array(commentDedup.unique.length);
    await this.mapWithMatchConcurrency(commentDedup.unique, async (c, index) => {
      await reportExtras();
      const reclassifiedMediaId = reclassifiedMovieIdFor(c);
      let candidate: NormalizedImportedComment = reclassifiedMediaId
        ? (movieVersionOf(c) as NormalizedImportedComment)
        : c;
      let match = reclassifiedMediaId
        ? {
            mediaId: reclassifiedMediaId,
            episodeId: null,
            confidence: 0.95,
            status: 'MATCHED',
          }
        : await this.resolveCommentTarget(c, showMediaByNorm, archiveLang, archiveIdentity);

      // Some TV Time replies target a deleted season placeholder exported as SxE0. There is no
      // real episode to attach to, but once the show identity is certain we can preserve the
      // user's text honestly as a show comment instead of leaving it permanently unresolved.
      if (
        candidate.targetType === 'episode' &&
        candidate.episodeNumber === 0 &&
        match.mediaId &&
        !match.episodeId &&
        match.status === 'UNMATCHED'
      ) {
        candidate = {
          ...candidate,
          targetType: 'show',
          sourceTargetType: 'episode',
        } as NormalizedImportedComment;
        match = { ...match, confidence: 0.75, status: 'MATCHED' };
      }
      resolvedComments[index] = {
        candidate,
        match,
      };
    });
    for (const { candidate: c, match } of resolvedComments) {
      const { mediaId, episodeId, confidence, status } = match;
      if (status === 'UNMATCHED') {
        counts.commentsSkippedUnresolved++;
        // No title AND unresolvable identity: unsearchable even manually — skip silently.
        if (!c.showTitle && !c.movieTitle) continue;
      }
      commentItems.push(this.buildCommentItem(importId, c, mediaId, episodeId, confidence, status));
    }
    await this.flushItems(importId, commentItems);

    const charVoteItems: any[] = [];
    const resolvedCharacterVotes: any[] = new Array(charVoteUnique.length);
    await this.mapWithMatchConcurrency(charVoteUnique, async (c, index) => {
      await reportExtras();
      const showIdentity = c.showTitle ? archiveIdentity.identifyShow(c.showTitle) : null;
      const numberedMovie = numberedMovieForExtra(c);
      const singleMovieId = c.showTitle
        ? archiveIdentity.resolveShowAsMovie(c.showTitle, showIdentity?.year)
        : null;
      const movieMediaId = numberedMovie?.mediaId ?? singleMovieId;
      resolvedCharacterVotes[index] = {
        candidate: c,
        entityType: movieMediaId ? 'MOVIE_CHARACTER_VOTE' : 'EPISODE_CHARACTER_VOTE',
        match: movieMediaId
          ? {
              mediaId: movieMediaId,
              episodeId: null,
              confidence: 0.95,
              status: 'MATCHED',
            }
          : await this.resolveShowEpisode(
              c.showTitle,
              c.seasonNumber,
              c.episodeNumber,
              showMediaByNorm,
              false,
              archiveLang,
              c.externalEpisodeId,
              archiveIdentity,
            ),
      };
    });
    for (const { candidate: c, match, entityType } of resolvedCharacterVotes) {
      const { mediaId, episodeId, confidence, status } = match;
      if (status !== 'MATCHED') {
        counts.characterVotesSkippedUnresolved++;
        // No title AND unresolvable identity: unsearchable even manually — skip silently.
        if (status === 'UNMATCHED' && !c.showTitle) continue;
      }
      charVoteItems.push(
        this.buildCharacterVoteItem(
          importId,
          c,
          mediaId,
          episodeId,
          confidence,
          status,
          entityType,
        ),
      );
    }
    await this.flushItems(importId, charVoteItems);

    this.logger.log(
      `Import ${importId} staged ratings=${ratingDedup.unique.length} emotions=${emotionDedup.unique.length} comments=${commentDedup.unique.length} characterVotes=${charVoteUnique.length}` +
        (ownerId ? '' : ' (comment owner unknown — no comments imported)'),
    );

    return counts;
  }

  /** Resolve show by title, hydrating on demand; then resolve episode by S/E. Reuses caches.
   *  When `fallbackToMedia` is set (ratings/emotions), an unresolvable episode still counts as
   *  MATCHED at the show level instead of NEEDS_REVIEW — the apply creates a show-level record.
   *  `externalEpisodeId` (TVDB episode id from TV Time rows) enables the external-id fast path
   *  and the /find recovery for episodes whose numbering differs between TVDB and TMDB. */
  private async resolveShowEpisode(
    showTitle: string | null | undefined,
    season: number | null | undefined,
    episode: number | null | undefined,
    showMediaByNorm: Map<string, string>,
    fallbackToMedia = false,
    archiveLang: SupportedLocale | null = null,
    externalEpisodeId?: string | number | null,
    archiveIdentity?: ArchiveIdentityIndex,
  ): Promise<{
    mediaId: string | null;
    episodeId: string | null;
    confidence: number;
    status: string;
  }> {
    const archiveCoordinate = archiveIdentity?.resolveEpisodeCoordinate(externalEpisodeId) ?? null;
    const resolvedShowTitle = showTitle || archiveCoordinate?.showTitle || null;
    const resolvedSeason = season != null && season >= 0 ? season : archiveCoordinate?.season;
    const resolvedEpisode = episode != null && episode > 0 ? episode : archiveCoordinate?.episode;
    const hasUsableCoordinate =
      resolvedSeason != null &&
      resolvedSeason >= 0 &&
      resolvedEpisode != null &&
      resolvedEpisode > 0;
    const exactEpisodeParent = externalEpisodeId
      ? this.matcher.matchPrefetchedShowByEpisodeIds([externalEpisodeId])
      : null;
    const archivedMediaId =
      exactEpisodeParent?.mediaId ??
      (resolvedShowTitle ? archiveIdentity?.resolveShow(resolvedShowTitle) : null);
    const archivedEpisode = archiveIdentity?.resolveEpisode(externalEpisodeId, archivedMediaId);
    if (archivedEpisode) {
      return {
        mediaId: archivedEpisode.mediaId,
        episodeId: archivedEpisode.episodeId,
        confidence: 0.95,
        status: 'MATCHED',
      };
    }
    const recoverExactTarget = (
      targetTitle: string,
      targetYear: number | null,
    ): Promise<{ mediaId: string; episodeId: string } | null> => {
      if (externalEpisodeId == null) return Promise.resolve(null);
      const recover = () =>
        this.matcher.recoverEpisodeTargetByTvdbId(targetTitle, targetYear, externalEpisodeId);
      return archiveIdentity
        ? archiveIdentity.recoverEpisodeTargetOnce(externalEpisodeId, recover)
        : recover();
    };

    if (!resolvedShowTitle) {
      // Title-less rows (some vote files omit series_name): identify the show through the
      // TVDB EPISODE id — local external ids → TMDB /find → TVDB episode→series.
      if (externalEpisodeId != null) {
        const exactTarget = await recoverExactTarget('', null);
        if (exactTarget) {
          return { ...exactTarget, confidence: 0.9, status: 'MATCHED' };
        }
        const r = await this.matcher.recoverShowByEpisodeId('', null, externalEpisodeId);
        if (r.mediaId) {
          const recoveredMediaId = r.mediaId;
          await this.matcher.ensureShowHydrated(recoveredMediaId);
          const episodeId =
            (await this.matcher.resolveEpisodeByExternalIds(recoveredMediaId, {
              tvdb: Number(externalEpisodeId) || null,
            })) ??
            (resolvedSeason != null && resolvedEpisode != null
              ? await this.matcher.resolveEpisode(recoveredMediaId, resolvedSeason, resolvedEpisode)
              : null) ??
            (archiveIdentity
              ? await archiveIdentity.recoverEpisodeOnce(externalEpisodeId, recoveredMediaId, () =>
                  this.matcher.recoverEpisodeByTvdbId(recoveredMediaId, externalEpisodeId, true),
                )
              : await this.matcher.recoverEpisodeByTvdbId(
                  recoveredMediaId,
                  externalEpisodeId,
                  true,
                ));
          if (episodeId) {
            archiveIdentity?.bindEpisode(externalEpisodeId, recoveredMediaId, episodeId);
            return { mediaId: recoveredMediaId, episodeId, confidence: 0.9, status: 'MATCHED' };
          }
          // Episode not found inside the recovered show: show-level match (ratings/emotions)
          // or flag for review — never silently drop the item.
          if (fallbackToMedia) {
            return {
              mediaId: recoveredMediaId,
              episodeId: null,
              confidence: 0.75,
              status: 'MATCHED',
            };
          }
          // A deleted provider id plus SxE0 gives the reviewer no episode to verify. Keep the
          // row as a terminal diagnostic instead of presenting a misleading manual-review item.
          if (!hasUsableCoordinate) {
            return {
              mediaId: recoveredMediaId,
              episodeId: null,
              confidence: 0,
              status: 'UNMATCHED',
            };
          }
          return {
            mediaId: recoveredMediaId,
            episodeId: null,
            confidence: 0.6,
            status: 'NEEDS_REVIEW',
          };
        }
      }
      return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
    }
    const identity = archiveIdentity?.identifyShow(resolvedShowTitle) ?? {
      title: resolvedShowTitle,
      normTitle: normTitle(resolvedShowTitle),
      rawNormTitle: normTitle(resolvedShowTitle),
      year: null,
      key: '',
    };
    let mediaId =
      archivedMediaId ??
      (!archiveIdentity ? showMediaByNorm.get(identity.normTitle) : null) ??
      null;
    if (!mediaId) {
      const archiveSeriesIds = archiveIdentity?.seriesIdsFor(resolvedShowTitle) ?? [];
      const m = await this.matcher.matchMedia(
        identity.normTitle,
        identity.title,
        'SHOW',
        identity.year,
        {
          maxSeason: resolvedSeason ?? null,
          seasonEpisodes:
            resolvedSeason != null && resolvedEpisode != null
              ? [{ season: resolvedSeason, maxEpisode: resolvedEpisode }]
              : null,
        },
        archiveLang,
        archiveSeriesIds[0] ?? null,
        archiveSeriesIds.length ? archiveSeriesIds : undefined,
      );
      if (m.mediaId && m.confidence >= 0.7) {
        await this.matcher.ensureShowHydrated(m.mediaId);
        mediaId = m.mediaId;
        showMediaByNorm.set(identity.normTitle, mediaId);
        archiveIdentity?.bindShow(resolvedShowTitle, identity.year, mediaId);
      }
    }
    if (!mediaId && externalEpisodeId != null) {
      const exactTarget = await recoverExactTarget(identity.title, identity.year);
      if (exactTarget) {
        return { ...exactTarget, confidence: 0.9, status: 'MATCHED' };
      }
    }
    const confidence = mediaId ? 0.85 : 0;
    if (!mediaId)
      return {
        mediaId: null,
        episodeId: null,
        confidence,
        status: this.classifyStatus(confidence),
      };
    const requiresEpisode =
      externalEpisodeId != null || (resolvedSeason != null && resolvedEpisode != null);
    if (requiresEpisode) {
      let episodeId =
        (externalEpisodeId != null
          ? await this.matcher.resolveEpisodeByExternalIds(mediaId, {
              tvdb: Number(externalEpisodeId) || null,
            })
          : null) ??
        (resolvedSeason != null && resolvedEpisode != null
          ? await this.matcher.resolveEpisode(mediaId, resolvedSeason, resolvedEpisode)
          : null);
      if (!episodeId && externalEpisodeId != null) {
        const exactTarget = await recoverExactTarget(identity.title, identity.year);
        if (exactTarget) {
          return { ...exactTarget, confidence: 0.9, status: 'MATCHED' };
        }
        episodeId = archiveIdentity
          ? await archiveIdentity.recoverEpisodeOnce(externalEpisodeId, mediaId, () =>
              this.matcher.recoverEpisodeByTvdbId(mediaId, externalEpisodeId, true),
            )
          : await this.matcher.recoverEpisodeByTvdbId(mediaId, externalEpisodeId, true);
      }
      if (episodeId) {
        archiveIdentity?.bindEpisode(externalEpisodeId, mediaId, episodeId);
        return { mediaId, episodeId, confidence: 0.9, status: 'MATCHED' };
      }
      // Episode not found: fall back to a show-level match (ratings/emotions) or flag for review.
      if (fallbackToMedia) return { mediaId, episodeId: null, confidence: 0.75, status: 'MATCHED' };
      if (!hasUsableCoordinate) {
        return { mediaId, episodeId: null, confidence: 0, status: 'UNMATCHED' };
      }
      return { mediaId, episodeId: null, confidence: 0.6, status: 'NEEDS_REVIEW' };
    }
    return { mediaId, episodeId: null, confidence, status: this.classifyStatus(confidence) };
  }

  private classifyStatus(confidence: number): string {
    const cls = this.matcher.classify(confidence);
    if (cls === 'matched') return 'MATCHED';
    if (cls === 'needs_review') return 'NEEDS_REVIEW';
    return 'UNMATCHED';
  }

  private async resolveMovieTarget(
    title: string,
    movieUuid: string | null | undefined,
    archiveLang: SupportedLocale | null,
    archiveIdentity?: ArchiveIdentityIndex,
  ): Promise<{
    mediaId: string | null;
    episodeId: null;
    confidence: number;
    status: string;
  }> {
    const identity = archiveIdentity?.identifyMovie(title, undefined, movieUuid) ?? {
      title,
      normTitle: normTitle(title),
      titleCandidates: [{ title, normTitle: normTitle(title) }],
      hasCanonicalRangeTitle: false,
      year: null,
      uuid: null,
      key: '',
    };
    const archived = archiveIdentity?.resolveMovie(title, undefined, movieUuid) ?? null;
    if (archived) {
      return {
        mediaId: archived,
        episodeId: null,
        confidence: 0.95,
        status: 'MATCHED',
      };
    }

    let match = { mediaId: null, confidence: 0, matchedTitle: null } as {
      mediaId: string | null;
      confidence: number;
      matchedTitle: string | null;
    };
    for (const candidate of identity.titleCandidates) {
      const candidateMatch = await this.matcher.matchMedia(
        candidate.normTitle,
        candidate.title,
        'MOVIE',
        identity.year,
        undefined,
        archiveLang,
      );
      if (candidateMatch.confidence > match.confidence) match = candidateMatch;
      if (candidateMatch.mediaId && candidateMatch.confidence >= 0.7) {
        match = candidateMatch;
        break;
      }
    }
    if (identity.hasCanonicalRangeTitle && match.confidence < 0.7) {
      match = { mediaId: null, confidence: 0, matchedTitle: null };
    }
    if (match.mediaId && match.confidence >= 0.7) {
      archiveIdentity?.bindMovie(title, identity.year, movieUuid, match.mediaId);
    }
    return {
      mediaId: match.mediaId,
      episodeId: null,
      confidence: match.confidence,
      status: match.mediaId ? this.classifyStatus(match.confidence) : 'UNMATCHED',
    };
  }

  private async resolveRatingTarget(
    c: NormalizedImportedRating,
    showMediaByNorm: Map<string, string>,
    archiveLang: SupportedLocale | null = null,
    archiveIdentity?: ArchiveIdentityIndex,
  ): Promise<{
    mediaId: string | null;
    episodeId: string | null;
    confidence: number;
    status: string;
  }> {
    if (c.targetType === 'movie') {
      return this.resolveMovieTarget(c.movieTitle ?? '', c.movieUuid, archiveLang, archiveIdentity);
    }
    if (c.targetType === 'show') {
      return this.resolveShowEpisode(
        c.showTitle,
        null,
        null,
        showMediaByNorm,
        true,
        archiveLang,
        null,
        archiveIdentity,
      );
    }
    // episode rating: fall back to a show-level match if the specific episode can't be resolved.
    return this.resolveShowEpisode(
      c.showTitle,
      c.seasonNumber,
      c.episodeNumber,
      showMediaByNorm,
      true,
      archiveLang,
      c.externalEpisodeId,
      archiveIdentity,
    );
  }

  private async resolveEmotionTarget(
    c: NormalizedImportedEmotion,
    showMediaByNorm: Map<string, string>,
    archiveLang: SupportedLocale | null = null,
    archiveIdentity?: ArchiveIdentityIndex,
  ): Promise<{
    mediaId: string | null;
    episodeId: string | null;
    confidence: number;
    status: string;
  }> {
    if (c.targetType === 'movie') {
      return this.resolveMovieTarget(c.movieTitle ?? '', c.movieUuid, archiveLang, archiveIdentity);
    }
    // episode emotion: fall back to a show-level match if the specific episode can't be resolved.
    return this.resolveShowEpisode(
      c.showTitle,
      c.seasonNumber,
      c.episodeNumber,
      showMediaByNorm,
      true,
      archiveLang,
      c.externalEpisodeId,
      archiveIdentity,
    );
  }

  private async resolveCommentTarget(
    c: NormalizedImportedComment,
    showMediaByNorm: Map<string, string>,
    archiveLang: SupportedLocale | null = null,
    archiveIdentity?: ArchiveIdentityIndex,
  ): Promise<{
    mediaId: string | null;
    episodeId: string | null;
    confidence: number;
    status: string;
  }> {
    if (c.targetType === 'movie') {
      return this.resolveMovieTarget(c.movieTitle ?? '', c.movieUuid, archiveLang, archiveIdentity);
    }
    if (c.targetType === 'show') {
      return this.resolveShowEpisode(
        c.showTitle,
        null,
        null,
        showMediaByNorm,
        true,
        archiveLang,
        null,
        archiveIdentity,
      );
    }
    return this.resolveShowEpisode(
      c.showTitle,
      c.seasonNumber,
      c.episodeNumber,
      showMediaByNorm,
      false,
      archiveLang,
      c.externalEpisodeId,
      archiveIdentity,
    );
  }

  /** Build a staged ImportItem for a rating or emotion candidate. */
  private buildExtraItem(
    importId: string,
    c: NormalizedImportedRating | NormalizedImportedEmotion,
    mediaId: string | null,
    episodeId: string | null,
    confidence: number,
    status: string,
  ): any {
    const isRating = 'normalizedRating' in c;
    const entityType = isRating
      ? (c as NormalizedImportedRating).targetType === 'movie'
        ? 'MOVIE_RATING'
        : (c as NormalizedImportedRating).targetType === 'show'
          ? 'SHOW_RATING'
          : 'EPISODE_RATING'
      : (c as NormalizedImportedEmotion).targetType === 'movie'
        ? 'MOVIE_EMOTION'
        : 'EPISODE_EMOTION';
    return {
      importId,
      rowNumber: c.sourceRow,
      sourceEntityType: entityType as ImportEntityType,
      targetEntityType: entityType as ImportEntityType,
      status,
      rawData: { sourceFile: c.sourceFile, sourceRow: c.sourceRow } as any,
      normalizedData: {
        ...(isRating
          ? {
              normalizedRating: (c as NormalizedImportedRating).normalizedRating,
              sourceSet: c.sourceSet,
              sourceRatingId: c.sourceRatingId,
              voteKey: c.voteKey,
            }
          : {
              normalizedEmotion: (c as NormalizedImportedEmotion).normalizedEmotion,
              sourceSet: c.sourceSet,
              sourceEmotionId: c.sourceEmotionId,
              voteKey: c.voteKey,
            }),
        targetType: c.targetType,
        showTitle: (c as any).showTitle ?? null,
        movieTitle: (c as any).movieTitle ?? null,
        movieUuid: (c as any).movieUuid ?? null,
        seasonNumber: (c as any).seasonNumber ?? null,
        episodeNumber: (c as any).episodeNumber ?? null,
        externalEpisodeId: (c as any).externalEpisodeId ?? null,
        sourceCreatedAt: c.sourceCreatedAt?.toISOString() ?? null,
        sourceUpdatedAt: c.sourceUpdatedAt?.toISOString() ?? null,
      } as any,
      matchedMediaId: mediaId,
      matchedEpisodeId: episodeId,
      confidenceScore: confidence,
    };
  }

  /** Build a staged ImportItem for a character-vote candidate. */
  private buildCharacterVoteItem(
    importId: string,
    c: NormalizedCharacterVote,
    mediaId: string | null,
    episodeId: string | null,
    confidence: number,
    status: string,
    entityType: ImportEntityType = 'EPISODE_CHARACTER_VOTE',
  ): any {
    return {
      importId,
      rowNumber: c.sourceRow,
      sourceEntityType: entityType,
      targetEntityType: entityType,
      status,
      rawData: { sourceRow: c.sourceRow } as any,
      normalizedData: {
        showTitle: c.showTitle,
        seasonNumber: c.seasonNumber,
        episodeNumber: c.episodeNumber,
        externalEpisodeId: c.externalEpisodeId,
        showCharacterId: c.showCharacterId,
        voteKey: c.voteKey,
        sourceCreatedAt: c.sourceCreatedAt?.toISOString() ?? null,
        sourceUpdatedAt: c.sourceUpdatedAt?.toISOString() ?? null,
      } as any,
      matchedMediaId: mediaId,
      matchedEpisodeId: episodeId,
      confidenceScore: confidence,
    };
  }

  /** Build a staged ImportItem for a comment candidate. Text is kept in normalizedData only. */
  private buildCommentItem(
    importId: string,
    c: NormalizedImportedComment,
    mediaId: string | null,
    episodeId: string | null,
    confidence: number,
    status: string,
    // Stable id for idempotent apply / re-import. Defaults to the TV Time identity; the Trakt
    // path passes `trakt:comment:{id}` (commentIdentity's tvtime| prefix stays CSV-only).
    sourceKey: string = commentIdentity(c),
  ): any {
    const entityType =
      c.targetType === 'movie'
        ? 'MOVIE_COMMENT'
        : c.targetType === 'show'
          ? 'SHOW_COMMENT'
          : 'EPISODE_COMMENT';
    return {
      importId,
      rowNumber: c.sourceRow,
      sourceEntityType: entityType as ImportEntityType,
      targetEntityType: entityType as ImportEntityType,
      status,
      rawData: {
        sourceFile: c.sourceFile,
        sourceRow: c.sourceRow,
        sourceCommentId: c.sourceCommentId,
      } as any,
      normalizedData: {
        text: c.text, // stored for apply; never logged
        textLength: c.textLength,
        spoiler: c.spoiler,
        spoilerCount: c.spoilerCount ?? null,
        language: c.language,
        sourceCommentId: c.sourceCommentId,
        sourceKey,
        sourceAuthorId: c.sourceAuthorId,
        authorIsOwner: c.authorIsOwner,
        isReply: c.isReply,
        parentSourceCommentId: c.parentSourceCommentId,
        depth: c.depth,
        image: c.image ?? null, // { url, format } — gif stored by URL, png downloaded at apply
        targetType: c.targetType,
        sourceTargetType: (c as NormalizedImportedComment & { sourceTargetType?: string })
          .sourceTargetType,
        showTitle: c.showTitle ?? null,
        movieTitle: c.movieTitle ?? null,
        movieUuid: c.movieUuid ?? null,
        seasonNumber: c.seasonNumber ?? null,
        episodeNumber: c.episodeNumber ?? null,
        externalEpisodeId: c.externalEpisodeId ?? null,
        sourceCreatedAt: c.sourceCreatedAt?.toISOString() ?? null,
        sourceUpdatedAt: c.sourceUpdatedAt?.toISOString() ?? null,
      } as any,
      matchedMediaId: mediaId,
      matchedEpisodeId: episodeId,
      confidenceScore: confidence,
    };
  }

  /** Batch-write staged ImportItems in chunks of 200. */
  private async flushItems(importId: string, items: any[]) {
    for (let i = 0; i < items.length; i += 200) {
      const slice = items.slice(i, i + 200);
      if (slice.length) await this.prisma.importItem.createMany({ data: slice });
    }
  }

  private extractAndParse(sourceType: string, filename: string, bytes: Buffer): ParsedFile[] {
    const ext = filename.split('.').pop()!.toLowerCase();
    if (sourceType === 'zip' || ext === 'zip') {
      const { entries } = inspectZip(bytes);
      const out: ParsedFile[] = [];
      for (const e of entries) {
        if (!e.isSupported) continue; // csv only
        const data = e.getData();
        const parsed = parseCsv(data);
        out.push({
          filename: e.filename,
          size: e.size,
          headers: parsed.headers,
          rows: parsed.rows,
        });
      }
      return out;
    }
    if (ext === 'csv' || sourceType === 'csv') {
      const parsed = parseCsv(bytes);
      return [{ filename, size: bytes.length, headers: parsed.headers, rows: parsed.rows }];
    }
    if (ext === 'json' || sourceType === 'json') {
      const arr = this.jsonToArray(bytes);
      const headers = arr.length ? Object.keys(arr[0]) : [];
      return [{ filename, size: bytes.length, headers, rows: arr }];
    }
    throw new Error('Unsupported file type');
  }

  private jsonToArray(bytes: Buffer): Record<string, string>[] {
    const data = JSON.parse(bytes.toString('utf8'));
    const arr = Array.isArray(data)
      ? data
      : (['episodes', 'shows', 'movies', 'history', 'watched', 'watchlist', 'items', 'data']
          .map((k) => (data as any)?.[k])
          .find((x) => Array.isArray(x)) ?? []);
    return (arr as any[]).map((o) => {
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(o ?? {})) row[k] = String(v as any);
      return row;
    });
  }
}
