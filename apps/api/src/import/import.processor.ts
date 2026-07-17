import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ImportStatus, ImportEntityType } from '@prisma/client';
import { type SupportedLocale } from '@tvwatch/shared';
import { RedisService } from '../common/redis/redis.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { runInLanguage } from '../common/language.context';
import { IMPORT_LIMITS } from './lib/limits';
import { ImportStorage } from './lib/storage';
import { inspectZip, type ZipEntry } from './lib/zip-validator';
import { parseCsv } from './lib/csv';
import { detectProfile, normalizeRow, normTitle, type NormalizedItem } from './lib/inference';
import { ImportMatcher, needsTvdbRehydration } from './lib/matcher';
import { HydrationQueue } from '../media-metadata/hydration/hydration.queue';
import { buildSeriesIdNameMap, isListsFile, normalizeLists } from './lib/lists';
import { normalizeRatings, dedupeRatings, type NormalizedImportedRating } from './lib/ratings';
import { normalizeEmotions, dedupeEmotions, type NormalizedImportedEmotion } from './lib/emotions';
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
import { normalizeTraktWatchlist, normalizeTraktFavorites, normalizeTraktLists } from './lib/trakt/lists';
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

export const IMPORT_QUEUE = 'imports';

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
  ) {}

  onModuleInit() {
    // bullmq resolves its own ioredis; cast to avoid a duplicate-version type clash.
    const connection = this.redis.client as any;
    this.queue = new Queue(IMPORT_QUEUE, { connection });
    this.worker = new Worker(
      IMPORT_QUEUE,
      async (job) => this.run(job.data.importId as string),
      { connection, concurrency: IMPORT_LIMITS.WORKER_CONCURRENCY },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Import job ${job?.id} failed: ${err.message}`));
  }

  enqueue(importId: string) {
    return this.queue.add('import', { importId }, { attempts: 1, removeOnComplete: true });
  }

  private async setStatus(importId: string, status: ImportStatus, extra: Record<string, unknown> = {}) {
    await this.prisma.import.update({ where: { id: importId }, data: { status, ...extra } });
  }

  async run(importId: string) {
    const imp = await this.prisma.import.findUnique({ where: { id: importId } });
    if (!imp || imp.status === 'CANCELLED') return;
    const locale = (imp.locale as SupportedLocale) || 'en';
    // Wrap the entire import in the user's language so all matching + hydration use it.
    return runInLanguage(locale, () => this.runBody(importId, imp));
  }

  private async runBody(importId: string, imp: any) {
    try {
      await this.setStatus(importId, 'EXTRACTING');
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

      const files = this.extractAndParse(imp.sourceType, imp.originalFilename ?? 'upload', bytes);
      await this.setStatus(importId, 'PARSING', { totalFiles: files.length });

      // Per-file normalize → flat item list + ImportFile rows
      const allItems: NormalizedItem[] = [];
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
        allItems.push(...fileItems);
      }

      if (allItems.length > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${allItems.length} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // Extract the archive's language (from user.csv) for fallback matching.
      const fileInputs = files.map((f) => ({ filename: f.filename, rows: f.rows }));
      const archiveLang = resolveArchiveLanguage(fileInputs);

      await this.setStatus(importId, 'NORMALIZING', { totalRows });
      // Dedupe by entity|normTitle|season|episode (keep one). The same episode can
      // appear in seen_episode_source (single watch) AND rewatched_episode (total
      // count via cpt); keep the authoritative higher watchCount and the latest
      // watchedAt rather than summing, so the rewatched file's tally is preserved.
      const seen = new Map<string, number>();
      const dedup: NormalizedItem[] = [];
      let duplicates = 0;
      for (const it of allItems) {
        const k = `${it.entityType}|${it.normTitle}|${it.season ?? ''}|${it.episode ?? ''}`;
        if (seen.has(k)) {
          duplicates++;
          const idx = seen.get(k)!;
          dedup[idx].watchCount = Math.max(dedup[idx].watchCount ?? 1, it.watchCount ?? 1);
          if (it.watchedAt && (!dedup[idx].watchedAt || it.watchedAt > (dedup[idx].watchedAt as Date))) {
            dedup[idx].watchedAt = it.watchedAt;
          }
          continue;
        }
        seen.set(k, dedup.length);
        dedup.push({ ...it, watchCount: it.watchCount ?? 1 });
      }

      await this.setStatus(importId, 'MATCHING');
      // Season/episode footprint per show in the import — used to disambiguate duplicate titles
      // (e.g. two shows named "Silo"): the candidate must have enough seasons AND enough episodes
      // in each referenced season (import watched S1 up to E10 → S1 must have ≥10 episodes).
      const maxSeasonByNorm = new Map<string, number>();
      const seasonEpisodesByNorm = new Map<string, Map<number, number>>();
      for (const it of dedup) {
        if (it.entityType === 'WATCHED_EPISODE' && it.season != null) {
          maxSeasonByNorm.set(it.normTitle, Math.max(maxSeasonByNorm.get(it.normTitle) ?? 0, it.season));
          const m = seasonEpisodesByNorm.get(it.normTitle) ?? new Map<number, number>();
          if (it.episode != null) m.set(it.season, Math.max(m.get(it.season) ?? 0, it.episode));
          seasonEpisodesByNorm.set(it.normTitle, m);
        }
      }
      // Collect ALL distinct TVDB series ids + a sample episode id per title across every row
      // (any entity type): TVDB merges leave dead ids in old exports (one sibling id usually
      // still works), and episode rows often carry no series id while a followed/tracking row
      // for the same show does.
      const tvdbIdsByNorm = new Map<string, string[]>();
      const sampleEpIdByNorm = new Map<string, string>();
      for (const it of dedup) {
        if (it.rawTvdbSeriesId) {
          const list = tvdbIdsByNorm.get(it.normTitle) ?? [];
          if (!list.includes(it.rawTvdbSeriesId)) list.push(it.rawTvdbSeriesId);
          tvdbIdsByNorm.set(it.normTitle, list);
        }
        if (it.rawTvdbEpisodeId && !sampleEpIdByNorm.has(it.normTitle)) {
          sampleEpIdByNorm.set(it.normTitle, it.rawTvdbEpisodeId);
        }
      }
      // For watched episodes, hydrate each distinct show once before resolving episodes.
      const showKeys = new Set<string>();
      for (const it of dedup) {
        if (it.entityType === 'WATCHED_EPISODE') showKeys.add(it.normTitle);
      }
      const showMediaByNorm = new Map<string, string>();
      const structureGuarded = new Set<string>();
      for (const it of dedup) {
        if (it.entityType !== 'WATCHED_EPISODE') continue;
        if (showMediaByNorm.has(it.normTitle)) continue;
        const seMap = seasonEpisodesByNorm.get(it.normTitle);
        const seasonEpisodes = seMap
          ? [...seMap.entries()].map(([season, maxEpisode]) => ({ season, maxEpisode }))
          : null;
        let m = await this.matcher.matchMedia(it.normTitle, it.title, 'SHOW', it.year, {
          maxSeason: maxSeasonByNorm.get(it.normTitle) ?? null,
          seasonEpisodes,
        }, archiveLang, it.rawTvdbSeriesId ?? null, tvdbIdsByNorm.get(it.normTitle));
        if (!(m.mediaId && m.confidence >= 0.7)) {
          // Last resort: identify the show through a TVDB EPISODE id (/find returns the
          // parent show id) — covers translated titles and rows without a series id.
          const r = await this.matcher.recoverShowByEpisodeId(
            it.title,
            it.year ?? null,
            sampleEpIdByNorm.get(it.normTitle) ?? null,
          );
          if (r.mediaId) m = r;
        }
        if (m.mediaId && m.confidence >= 0.7) {
          await this.matcher.ensureShowHydrated(m.mediaId);
          showMediaByNorm.set(it.normTitle, m.mediaId);
          // Import → anime-enrichment hook: deduplicated per local media id; non-blocking.
          await this.hydrationQueue.enqueueClassifyCandidate({ mediaId: m.mediaId }).catch(() => undefined);
          await this.guardShowStructure(
            m.mediaId,
            maxSeasonByNorm.get(it.normTitle) ?? null,
            seasonEpisodes,
            structureGuarded,
          );
        }
      }

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

      for (const it of dedup) {
        if (!it.title) {
          invalid++;
          continue;
        }
        const type =
          it.entityType === 'WATCHED_MOVIE' || it.entityType === 'WATCHLIST_MOVIE' || it.entityType === 'FAVORITE_MOVIE'
            ? 'MOVIE'
            : 'SHOW';

        let mediaId: string | null = null;
        let episodeId: string | null = null;
        let confidence = 0;

        if (it.entityType === 'WATCHED_EPISODE') {
          mediaId = showMediaByNorm.get(it.normTitle) ?? null;
          if (mediaId && it.season != null && it.episode != null) {
            // External-id fast path (TVDB-hydrated shows) → S/E → TMDB /find recovery
            // (recovery is bounded to failures; /find returns TMDB's own numbering).
            const rawEpId = it.rawTvdbEpisodeId ?? null;
            episodeId =
              (rawEpId ? await this.matcher.resolveEpisodeByExternalIds(mediaId, { tvdb: Number(rawEpId) || null }) : null) ??
              (await this.matcher.resolveEpisode(mediaId, it.season, it.episode)) ??
              (rawEpId ? await this.matcher.recoverEpisodeByTvdbId(mediaId, rawEpId) : null);
          }
          confidence = episodeId ? 0.9 : mediaId ? 0.6 : 0;
        } else {
          const m = await this.matcher.matchMedia(it.normTitle, it.title, type as 'SHOW' | 'MOVIE', it.year, undefined, archiveLang, it.rawTvdbSeriesId ?? null, tvdbIdsByNorm.get(it.normTitle));
          mediaId = m.mediaId;
          confidence = m.confidence;
        }

        const cls = this.matcher.classify(confidence);
        if (mediaId && cls === 'matched') {
          // Import → anime-enrichment hook (deduplicated per local media id via stable job id).
          await this.hydrationQueue.enqueueClassifyCandidate({ mediaId }).catch(() => undefined);
        }
        if (it.entityType === 'WATCHED_EPISODE' && !episodeId && cls === 'matched') {
          // matched show but episode unresolved → needs review
        }
        let status: any;
        if (!mediaId) status = cls === 'unmatched' ? 'UNMATCHED' : 'NEEDS_REVIEW';
        else if (it.entityType === 'WATCHED_EPISODE' && !episodeId) status = 'NEEDS_REVIEW';
        else status = cls === 'matched' ? 'MATCHED' : 'NEEDS_REVIEW';

        // Specials (S0 / E0 placeholders) are kept ONLY if they resolved to a real episode
        // (status MATCHED). An unresolvable special never maps to a real episode, so it's
        // ignored here instead of cluttering the review list.
        if (it.entityType === 'WATCHED_EPISODE' && (it.season === 0 || it.episode === 0) && status !== 'MATCHED') {
          invalid++;
          continue;
        }

        if (status === 'MATCHED') matched++;
        else if (status === 'UNMATCHED') unmatched++;
        else if (status === 'NEEDS_REVIEW') needsReview++;

        batch.push({
          importId,
          rowNumber: 0,
          sourceEntityType: it.entityType as ImportEntityType,
          targetEntityType: it.entityType as ImportEntityType,
          status,
          rawData: it.raw as any,
          normalizedData: { title: it.title, normTitle: it.normTitle, year: it.year, season: it.season, episode: it.episode, watchedAt: it.watchedAt?.toISOString() ?? null, watchCount: it.watchCount ?? 1 } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: episodeId,
          confidenceScore: confidence,
        });
        if (batch.length >= 200) await flush();
      }
      await flush();

      // ---- Lists pass (lists-prod-lists.csv) ----
      // Lists are staged as LIST + LIST_ITEM items (resolved here, applied on confirm).
      const listsFile = files.find((f) => isListsFile(f.filename));
      if (listsFile) {
        const seriesMap = buildSeriesIdNameMap(files.map((f) => ({ filename: f.filename, rows: f.rows })));
        const { lists, errors } = normalizeLists(listsFile.rows);
        for (const e of errors) this.logger.warn(`Import ${importId} list parse — row ${e.row} (${e.sourceKey}): ${e.reason}`);
        const listBatch: any[] = [];
        for (const list of lists) {
          let resolved = 0;
          let unresolved = 0;
          const itemRows: any[] = [];
          for (const it of list.items) {
            let mediaId: string | null = null;
            let title: string | null = null;
            if (it.type === 'series' && it.seriesId != null) {
              const name = seriesMap.get(it.seriesId);
              if (name) {
                const m = await this.matcher.matchMedia(normTitle(name), name, 'SHOW', undefined, undefined, archiveLang);
                mediaId = m.mediaId;
                title = name;
              }
            }
            // movie objects carry only a uuid (no name source in the export) → unresolved
            if (mediaId) resolved++;
            else unresolved++;
            itemRows.push({
              importId,
              rowNumber: it.order,
              sourceEntityType: 'LIST_ITEM',
              targetEntityType: 'LIST_ITEM',
              status: mediaId ? 'MATCHED' : 'NEEDS_REVIEW',
              rawData: { sourceKey: list.sourceKey, order: it.order } as any,
              normalizedData: { sourceKey: list.sourceKey, order: it.order, title, mediaType: it.type, createdAt: it.createdAt?.toISOString() ?? null } as any,
              matchedMediaId: mediaId,
              confidenceScore: mediaId ? 0.8 : 0,
            });
          }
          listBatch.push({
            importId,
            sourceEntityType: 'LIST',
            targetEntityType: 'LIST',
            status: 'MATCHED',
            rawData: { sourceKey: list.sourceKey } as any,
            normalizedData: { sourceKey: list.sourceKey, title: list.title, description: list.description, visibility: list.visibility, createdAt: list.createdAt?.toISOString() ?? null, itemCount: list.items.length, resolvedCount: resolved, unresolvedCount: unresolved } as any,
            confidenceScore: 1,
          });
          listBatch.push(...itemRows);
        }
        for (let i = 0; i < listBatch.length; i += 200) {
          await this.prisma.importItem.createMany({ data: listBatch.slice(i, i + 200) });
        }
        this.logger.log(`Import ${importId} staged ${lists.length} list(s) from ${listsFile.filename}`);
      }

      // ---- Ratings / Emotions / Comments pass ----
      const extraCounts = await this.stageExtraEntities(importId, files, showMediaByNorm, archiveLang);

      await this.setStatus(importId, 'READY_FOR_REVIEW', {
        totalFiles: files.length,
        totalRows,
        matchedCount: matched,
        unmatchedCount: unmatched,
        duplicateCount: duplicates,
        conflictCount: 0,
        invalidCount: invalid,
        needsReviewCount: needsReview,
        ...extraCounts,
      });
    } catch (e) {
      this.logger.error(`Import ${importId} failed: ${(e as Error).message}`);
      await this.setStatus(importId, 'FAILED', { errorMessage: (e as Error).message?.slice(0, 1000) });
    }
  }

  /**
   * Structural guard: when the import's footprint exceeds the matched show's hydrated
   * structure (wrong-provider structure — anthologies/reboots/split hour-longs — or a
   * poisoned partial hydration), re-hydrate from TVDB. The re-hydration is a union upsert
   * (existing rows are never deleted), so the episode space becomes the union of both
   * providers' structures. Runs once per show per import, before episode resolution.
   */
  private async guardShowStructure(
    mediaId: string,
    maxSeason: number | null,
    seasonEpisodes: { season: number; maxEpisode: number }[] | null,
    guarded: Set<string>,
  ) {
    if (guarded.has(mediaId)) return;
    guarded.add(mediaId);
    if (maxSeason == null && !seasonEpisodes?.length) return;
    try {
      const hydrated = await this.matcher.hydratedFootprint(mediaId);
      if (needsTvdbRehydration({ maxSeason, seasonEpisodes }, hydrated)) {
        this.logger.log(
          `Structural guard: media ${mediaId} hydrated structure too small for the import footprint ` +
            `(hydrated maxSeason=${hydrated.maxSeason}, need S${maxSeason ?? '?'}) — re-hydrating from TVDB`,
        );
        await this.matcher.rehydrateWithTvdb(mediaId);
      }
    } catch (e) {
      this.logger.debug(`Structural guard skipped for ${mediaId}: ${(e as Error).message}`);
    }
  }

  /** Zip entries (or a synthetic single-file entry) when the upload is a Trakt JSON export; else null. */
  private traktEntriesFor(imp: any, bytes: Buffer): ZipEntry[] | null {    if (imp.sourceType === 'zip') {
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
      await this.setStatus(importId, 'PARSING', { totalFiles: entries.length });

      // ---- PARSING: JSON.parse each supported file; classify per Trakt filename conventions.
      const parsed: { filename: string; kind: TraktFileKind; data: unknown; size: number; failed: boolean }[] = [];
      for (const e of entries) {
        const kind = e.isSupported ? classifyTraktFile(e.filename) : 'unsupported';
        if (kind === 'unsupported') {
          parsed.push({ filename: e.filename, kind, data: null, size: e.size, failed: false });
          continue;
        }
        try {
          parsed.push({ filename: e.filename, kind, data: JSON.parse(e.getData().toString('utf8')), size: e.size, failed: false });
        } catch {
          this.logger.warn(`Import ${importId}: invalid JSON in ${e.filename} — file skipped`);
          parsed.push({ filename: e.filename, kind, data: null, size: e.size, failed: true });
        }
      }
      // watched-history is authoritative: when present, the watched-shows/movies aggregate
      // files are superseded (kept visible as ImportFile rows but marked unsupported).
      const hasHistory = parsed.some((f) => f.kind === 'watched_history' && !f.failed && Array.isArray(f.data));
      let totalRows = 0;
      for (const f of parsed) {
        const superseded = hasHistory && (f.kind === 'watched_shows' || f.kind === 'watched_movies');
        const status = f.failed ? 'failed' : f.kind === 'unsupported' || superseded ? 'unsupported' : 'parsed';
        const rowCount = Array.isArray(f.data) ? f.data.length : f.data ? 1 : 0;
        if (status === 'parsed') totalRows += rowCount;
        await this.prisma.importFile.create({
          data: { importId, filename: f.filename, detectedType: 'json', fileSizeBytes: f.size, rowCount, headers: [], status },
        });
      }
      if (totalRows > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalRows} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- NORMALIZING ----
      await this.setStatus(importId, 'NORMALIZING', { totalRows });
      const ok = parsed.filter((f) => !f.failed);
      const dataOf = (kind: TraktFileKind) => ok.filter((f) => f.kind === kind).map((f) => f.data);
      const archiveLang = resolveTraktArchiveLanguage(ok.find((f) => f.kind === 'user_settings')?.data);

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
        watched.episodes.length + watched.movies.length + watchlist.length + favorites.length +
        ratingsRes.candidates.length + commentsRes.candidates.length + lists.length;
      if (totalCandidates > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalCandidates} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- MATCHING ----
      await this.setStatus(importId, 'MATCHING');
      // Distinct shows keyed by strongest external id — one provider lookup per unique show.
      const showKey = (ids: TraktIds, title: string) =>
        ids.tmdb ? `tmdb:${ids.tmdb}` : ids.tvdb ? `tvdb:${ids.tvdb}` : `norm:${normTitle(title)}`;
      const showMediaByKey = new Map<string, string>();
      const hydrated = new Set<string>();
      const matchShowIds = async (ids: TraktIds, title: string, year: number | null, hydrate: boolean) => {
        const k = showKey(ids, title);
        let m: { mediaId: string | null; confidence: number };
        const cached = showMediaByKey.get(k);
        if (cached) {
          m = { mediaId: cached, confidence: 0.95 };
        } else {
          m = await this.matcher.matchByExternalIds(ids, 'SHOW', title, normTitle(title), year, archiveLang);
          if (m.mediaId && m.confidence >= 0.7) showMediaByKey.set(k, m.mediaId);
        }
        if (m.mediaId && m.confidence >= 0.7) {
          await this.hydrationQueue.enqueueClassifyCandidate({ mediaId: m.mediaId }).catch(() => undefined);
          if (hydrate && !hydrated.has(m.mediaId)) {
            hydrated.add(m.mediaId);
            await this.matcher.ensureShowHydrated(m.mediaId);
          }
          return m;
        }
        return { mediaId: null, confidence: m.confidence };
      };

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
      for (const c of watched.episodes) {
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
          rawData: { title: c.showTitle, year: c.year, season: c.season, episode: c.episode, showIds: c.showIds, episodeIds: c.episodeIds } as any,
          normalizedData: { title: c.showTitle, normTitle: normTitle(c.showTitle), year: c.year, season: c.season, episode: c.episode, watchedAt: c.watchedAt?.toISOString() ?? null, watchCount: c.watchCount } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: episodeId,
          confidenceScore: confidence,
        });
      }

      // ---- Watched movies + watchlist + favorites (shared single-media staging) ----
      const stageMediaItem = async (
        entityType: 'WATCHED_MOVIE' | 'WATCHLIST_SHOW' | 'WATCHLIST_MOVIE' | 'FAVORITE_SHOW' | 'FAVORITE_MOVIE',
        ids: TraktIds,
        title: string,
        year: number | null,
        watchedAt: Date | null,
        watchCount: number,
      ) => {
        const type = entityType.endsWith('_SHOW') ? 'SHOW' : 'MOVIE';
        const m = await this.matcher.matchByExternalIds(ids, type, title, normTitle(title), year, archiveLang);
        const cls = this.matcher.classify(m.confidence);
        if (m.mediaId && cls === 'matched') {
          await this.hydrationQueue.enqueueClassifyCandidate({ mediaId: m.mediaId }).catch(() => undefined);
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
          normalizedData: { title, normTitle: normTitle(title), year, season: null, episode: null, watchedAt: watchedAt?.toISOString() ?? null, watchCount } as any,
          matchedMediaId: m.mediaId,
          matchedEpisodeId: null,
          confidenceScore: m.confidence,
        });
      };
      for (const c of watched.movies) {
        await stageMediaItem('WATCHED_MOVIE', c.movieIds, c.movieTitle, c.year, c.watchedAt, c.watchCount);
      }
      for (const c of watchlist) {
        await stageMediaItem(c.type === 'movie' ? 'WATCHLIST_MOVIE' : 'WATCHLIST_SHOW', c.ids, c.title, c.year, c.listedAt, 1);
      }
      for (const c of favorites) {
        await stageMediaItem(c.type === 'movie' ? 'FAVORITE_MOVIE' : 'FAVORITE_SHOW', c.ids, c.title, c.year, c.listedAt, 1);
      }
      await flush();

      // ---- Custom lists (lists-lists.json) → LIST + LIST_ITEM items (same shapes as CSV) ----
      const listBatch: any[] = [];
      for (const list of lists) {
        let resolved = 0;
        let unresolved = 0;
        const itemRows: any[] = [];
        for (const it of list.items) {
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
            normalizedData: { sourceKey: list.sourceKey, order: it.order, title: it.title, mediaType: it.mediaType === 'movie' ? 'movie' : 'series', createdAt: it.createdAt?.toISOString() ?? null } as any,
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
          normalizedData: { sourceKey: list.sourceKey, title: list.title, description: list.description, visibility: list.visibility, createdAt: list.createdAt?.toISOString() ?? null, itemCount: list.items.length, resolvedCount: resolved, unresolvedCount: unresolved } as any,
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
      ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> => {
        if (input.targetType === 'movie') {
          const title = input.movieTitle ?? '';
          if (!title) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
          const m = await this.matcher.matchByExternalIds(input.movieIds ?? {}, 'MOVIE', title, normTitle(title), null, archiveLang);
          const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
          return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
        }
        if (input.targetType === 'show') {
          const title = input.showTitle ?? '';
          if (!title) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
          const m = await this.matcher.matchByExternalIds(input.showIds ?? {}, 'SHOW', title, normTitle(title), null, archiveLang);
          const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
          if (m.mediaId && m.confidence >= 0.7) {
            showMediaByKey.set(showKey(input.showIds ?? {}, title), m.mediaId);
            await this.hydrationQueue.enqueueClassifyCandidate({ mediaId: m.mediaId }).catch(() => undefined);
          }
          return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
        }
        // Episode target: match the show (hydrate), then resolve by external episode id → S/E.
        const title = input.showTitle ?? '';
        if (!title) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
        const { mediaId } = await matchShowIds(input.showIds ?? {}, title, null, true);
        if (!mediaId) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
        if (input.season != null && input.episode != null) {
          let episodeId = await this.matcher.resolveEpisodeByExternalIds(mediaId, input.episodeIds ?? {});
          if (!episodeId) episodeId = await this.matcher.resolveEpisode(mediaId, input.season, input.episode);
          if (episodeId) return { mediaId, episodeId, confidence: 0.9, status: 'MATCHED' };
          // Episode not found: fall back to a show-level match (ratings) or flag for review.
          if (fallbackToMedia) return { mediaId, episodeId: null, confidence: 0.75, status: 'MATCHED' };
          return { mediaId, episodeId: null, confidence: 0.6, status: 'NEEDS_REVIEW' };
        }
        return { mediaId, episodeId: null, confidence: 0.85, status: 'MATCHED' };
      };

      let ratingsUnresolved = 0;
      const ratingItems: any[] = [];
      for (const c of ratingsRes.candidates) {
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
        ratingItems.push(this.buildExtraItem(importId, c.rating, r.mediaId, r.episodeId, r.confidence, r.status));
      }
      await this.flushItems(importId, ratingItems);

      let commentsUnresolved = 0;
      const commentItems: any[] = [];
      for (const c of commentsRes.candidates) {
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
        commentItems.push(this.buildCommentItem(importId, c.comment, r.mediaId, r.episodeId, r.confidence, r.status, sourceKey));
      }
      await this.flushItems(importId, commentItems);

      await this.setStatus(importId, 'READY_FOR_REVIEW', {
        totalFiles: parsed.length,
        totalRows,
        matchedCount: matched,
        unmatchedCount: unmatched,
        duplicateCount: 0,
        conflictCount: 0,
        invalidCount: invalid + watched.invalid + watched.skippedNoEpisodeData + watchlistSkipped + favoritesSkipped + listsSkipped,
        needsReviewCount: needsReview,
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
      await this.setStatus(importId, 'FAILED', { errorMessage: (e as Error).message?.slice(0, 1000) });
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
      await this.setStatus(importId, 'PARSING', { totalFiles: entries.length });

      // ---- PARSING: JSON.parse each supported file; parseCsv for activity_history.csv.
      const parsed: { filename: string; kind: TvTimeJsonFileKind; data: unknown; csvRows: Record<string, string>[] | null; size: number; failed: boolean }[] = [];
      for (const e of entries) {
        const kind = e.isSupported ? classifyTvTimeJsonFile(e.filename) : 'unsupported';
        if (kind === 'unsupported' || kind === 'ignored_csv') {
          parsed.push({ filename: e.filename, kind, data: null, csvRows: null, size: e.size, failed: false });
          continue;
        }
        try {
          if (kind === 'activity_csv') {
            const csv = parseCsv(e.getData());
            parsed.push({ filename: e.filename, kind, data: null, csvRows: csv.rows, size: e.size, failed: false });
          } else {
            parsed.push({ filename: e.filename, kind, data: JSON.parse(e.getData().toString('utf8')), csvRows: null, size: e.size, failed: false });
          }
        } catch {
          this.logger.warn(`Import ${importId}: unparseable ${e.filename} — file skipped`);
          parsed.push({ filename: e.filename, kind, data: null, csvRows: null, size: e.size, failed: true });
        }
      }
      let totalRows = 0;
      for (const f of parsed) {
        const status = f.failed ? 'failed' : f.kind === 'unsupported' || f.kind === 'ignored_csv' ? 'unsupported' : 'parsed';
        const rowCount = f.csvRows ? f.csvRows.length : Array.isArray(f.data) ? f.data.length : f.data ? 1 : 0;
        if (status === 'parsed') totalRows += rowCount;
        await this.prisma.importFile.create({
          data: { importId, filename: f.filename, detectedType: f.kind === 'activity_csv' ? 'csv' : 'json', fileSizeBytes: f.size, rowCount, headers: [], status },
        });
      }
      if (totalRows > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalRows} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- NORMALIZING ----
      await this.setStatus(importId, 'NORMALIZING', { totalRows });
      const ok = parsed.filter((f) => !f.failed);
      const dataOf = (kind: TvTimeJsonFileKind) => ok.filter((f) => f.kind === kind).map((f) => f.data);

      const showsRes = normalizeTvTimeJsonShows(dataOf('shows').find((d) => Array.isArray(d)) ?? []);
      const moviesRes = normalizeTvTimeJsonMovies(dataOf('movies').find((d) => Array.isArray(d)) ?? []);
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
        showsRes.episodes.length + moviesRes.watched.length + moviesRes.watchlist.length +
        watchlistShows.length + favorites.length + lists.length + ratingsRes.candidates.length;
      if (totalCandidates > IMPORT_LIMITS.MAX_ROWS) {
        throw new Error(`Too many rows (${totalCandidates} > ${IMPORT_LIMITS.MAX_ROWS})`);
      }

      // ---- MATCHING ----
      await this.setStatus(importId, 'MATCHING');
      // Distinct shows keyed by strongest external id — one provider lookup per unique show.
      const showMediaByKey = new Map<string, string>();
      const hydrated = new Set<string>();
      const structureGuarded = new Set<string>();
      const matchShowIds = async (ids: TraktIds, title: string, year: number | null, hydrate: boolean) => {
        const k = mediaKey(ids, normTitle(title));
        let m: { mediaId: string | null; confidence: number };
        const cached = showMediaByKey.get(k);
        if (cached) {
          m = { mediaId: cached, confidence: 0.95 };
        } else {
          m = await this.matcher.matchByExternalIds(ids, 'SHOW', title, normTitle(title), year, null);
          if (m.mediaId && m.confidence >= 0.7) showMediaByKey.set(k, m.mediaId);
        }
        if (m.mediaId && m.confidence >= 0.7) {
          await this.hydrationQueue.enqueueClassifyCandidate({ mediaId: m.mediaId }).catch(() => undefined);
          if (hydrate && !hydrated.has(m.mediaId)) {
            hydrated.add(m.mediaId);
            await this.matcher.ensureShowHydrated(m.mediaId);
            const fp = showsRes.footprints.get(k);
            if (fp) await this.guardShowStructure(m.mediaId, fp.maxSeason, fp.seasonEpisodes, structureGuarded);
          }
          return m;
        }
        return { mediaId: null, confidence: m.confidence };
      };

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
      for (const c of showsRes.episodes) {
        const { mediaId } = await matchShowIds(c.showIds, c.showTitle, c.year, true);
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
          rawData: { title: c.showTitle, year: c.year, season: c.season, episode: c.episode, special: c.special, showIds: c.showIds, episodeIds: c.episodeIds } as any,
          normalizedData: { title: c.showTitle, normTitle: normTitle(c.showTitle), year: c.year, season: c.season, episode: c.episode, watchedAt: c.watchedAt?.toISOString() ?? null, watchCount: 1 } as any,
          matchedMediaId: mediaId,
          matchedEpisodeId: episodeId,
          confidenceScore: confidence,
        });
      }

      // ---- Watched movies + watchlist + favorites (shared single-media staging) ----
      const stageMediaItem = async (
        entityType: 'WATCHED_MOVIE' | 'WATCHLIST_SHOW' | 'WATCHLIST_MOVIE' | 'FAVORITE_SHOW' | 'FAVORITE_MOVIE',
        ids: TraktIds,
        title: string,
        year: number | null,
        watchedAt: Date | null,
        watchCount: number,
      ) => {
        const type = entityType.endsWith('_SHOW') ? 'SHOW' : 'MOVIE';
        const m = await this.matcher.matchByExternalIds(ids, type, title, normTitle(title), year, null);
        const cls = this.matcher.classify(m.confidence);
        if (m.mediaId && cls === 'matched') {
          await this.hydrationQueue.enqueueClassifyCandidate({ mediaId: m.mediaId }).catch(() => undefined);
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
          normalizedData: { title, normTitle: normTitle(title), year, season: null, episode: null, watchedAt: watchedAt?.toISOString() ?? null, watchCount } as any,
          matchedMediaId: m.mediaId,
          matchedEpisodeId: null,
          confidenceScore: m.confidence,
        });
      };
      for (const c of moviesRes.watched) {
        await stageMediaItem('WATCHED_MOVIE', c.movieIds, c.movieTitle, c.year, c.watchedAt, 1);
      }
      for (const c of moviesRes.watchlist) {
        await stageMediaItem('WATCHLIST_MOVIE', c.ids, c.title, c.year, c.listedAt, 1);
      }
      for (const c of watchlistShows) {
        await stageMediaItem('WATCHLIST_SHOW', c.ids, c.title, c.year, c.listedAt, 1);
      }
      for (const c of favorites) {
        await stageMediaItem(c.type === 'movie' ? 'FAVORITE_MOVIE' : 'FAVORITE_SHOW', c.ids, c.title, c.year, c.listedAt, 1);
      }
      await flush();

      // ---- Custom lists (lists.json) → LIST + LIST_ITEM items (same shapes as Trakt) ----
      const listBatch: any[] = [];
      for (const list of lists) {
        let resolved = 0;
        let unresolved = 0;
        const itemRows: any[] = [];
        for (const it of list.items) {
          const m = await this.matcher.matchByExternalIds(
            it.ids,
            it.mediaType === 'movie' ? 'MOVIE' : 'SHOW',
            it.title,
            normTitle(it.title),
            it.year,
            null,
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
            normalizedData: { sourceKey: list.sourceKey, order: it.order, title: it.title, mediaType: it.mediaType === 'movie' ? 'movie' : 'series', createdAt: it.createdAt?.toISOString() ?? null } as any,
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
          normalizedData: { sourceKey: list.sourceKey, title: list.title, description: list.description, visibility: list.visibility, createdAt: list.createdAt?.toISOString() ?? null, itemCount: list.items.length, resolvedCount: resolved, unresolvedCount: unresolved } as any,
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
      for (const c of ratingsRes.candidates) {
        let mediaId: string | null = null;
        let episodeId: string | null = null;
        let confidence = 0;
        let status: string;
        if (c.rating.targetType === 'movie') {
          const title = c.rating.movieTitle ?? '';
          if (!title) {
            status = 'UNMATCHED';
          } else {
            const m = await this.matcher.matchByExternalIds(c.movieIds ?? {}, 'MOVIE', title, normTitle(title), null, null);
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
            mediaId = sm.mediaId;
            if (mediaId && c.rating.seasonNumber != null && c.rating.episodeNumber != null) {
              episodeId =
                (await this.matcher.resolveEpisodeByExternalIds(mediaId, c.episodeIds ?? {})) ??
                (await this.matcher.resolveEpisode(mediaId, c.rating.seasonNumber, c.rating.episodeNumber)) ??
                (c.episodeIds?.tvdb != null ? await this.matcher.recoverEpisodeByTvdbId(mediaId, c.episodeIds.tvdb) : null);
              if (episodeId) {
                confidence = 0.9;
                status = 'MATCHED';
              } else {
                // Ratings fall back to a show-level record when the episode can't be resolved.
                confidence = 0.75;
                status = 'MATCHED';
              }
            } else {
              confidence = mediaId ? 0.85 : 0;
              status = mediaId ? 'MATCHED' : 'UNMATCHED';
            }
          }
        }
        if (status === 'UNMATCHED') ratingsUnresolved++;
        ratingItems.push(this.buildExtraItem(importId, c.rating, mediaId, episodeId, confidence, status));
      }
      await this.flushItems(importId, ratingItems);

      await this.setStatus(importId, 'READY_FOR_REVIEW', {
        totalFiles: parsed.length,
        totalRows,
        matchedCount: matched,
        unmatchedCount: unmatched,
        duplicateCount: 0,
        conflictCount: 0,
        invalidCount: invalid + showsRes.invalid + moviesRes.invalid + favoritesSkipped + listsSkipped + watchlistCsvSkipped,
        needsReviewCount: needsReview,
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
      await this.setStatus(importId, 'FAILED', { errorMessage: (e as Error).message?.slice(0, 1000) });
    }
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
    };

    const fileInputs = files.map((f) => ({ filename: f.filename, rows: f.rows }));
    const ownerId = resolveArchiveOwner(fileInputs);

    // ----- Ratings -----
    const allRatings: NormalizedImportedRating[] = [];
    for (const f of files) {
      const res = normalizeRatings(f.filename, f.rows);
      counts.ratingsDetected += res.detected;
      counts.ratingsSkippedUnsupported += res.unsupported;
      allRatings.push(...res.candidates.filter((c) => c.supported));
    }
    const ratingDedup = dedupeRatings(allRatings);
    counts.ratingDuplicatesIgnored += ratingDedup.duplicates;
    const ratingItems: any[] = [];
    for (const c of ratingDedup.unique) {
      const { mediaId, episodeId, confidence, status } = await this.resolveRatingTarget(c, showMediaByNorm, archiveLang);
      if (status === 'UNMATCHED') counts.ratingsSkippedUnresolved++;
      ratingItems.push(this.buildExtraItem(importId, c, mediaId, episodeId, confidence, status));
    }
    await this.flushItems(importId, ratingItems);

    // ----- Emotions -----
    const allEmotions: NormalizedImportedEmotion[] = [];
    for (const f of files) {
      const res = normalizeEmotions(f.filename, f.rows);
      counts.emotionsDetected += res.detected;
      counts.emotionsSkippedUnsupported += res.unsupported;
      allEmotions.push(...res.candidates.filter((c) => c.supported));
    }
    const emotionDedup = dedupeEmotions(allEmotions);
    counts.emotionDuplicatesIgnored += emotionDedup.duplicates;
    const emotionItems: any[] = [];
    for (const c of emotionDedup.unique) {
      const { mediaId, episodeId, confidence, status } = await this.resolveEmotionTarget(c, showMediaByNorm, archiveLang);
      if (status === 'UNMATCHED') counts.emotionsSkippedUnresolved++;
      emotionItems.push(this.buildExtraItem(importId, c, mediaId, episodeId, confidence, status));
    }
    await this.flushItems(importId, emotionItems);

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
      allComments.push(...res.candidates);
    }
    const commentDedup = dedupeComments(allComments);
    counts.commentDuplicatesIgnored += commentDedup.duplicates;
    const commentItems: any[] = [];
    for (const c of commentDedup.unique) {
      const { mediaId, episodeId, confidence, status } = await this.resolveCommentTarget(c, showMediaByNorm, archiveLang);
      if (status === 'UNMATCHED') counts.commentsSkippedUnresolved++;
      commentItems.push(this.buildCommentItem(importId, c, mediaId, episodeId, confidence, status));
    }
    await this.flushItems(importId, commentItems);

    this.logger.log(
      `Import ${importId} staged ratings=${ratingDedup.unique.length} emotions=${emotionDedup.unique.length} comments=${commentDedup.unique.length}` +
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
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (!showTitle) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
    const nt = normTitle(showTitle);
    let mediaId = showMediaByNorm.get(nt) ?? null;
    if (!mediaId) {
      const m = await this.matcher.matchMedia(nt, showTitle, 'SHOW', undefined, {
        maxSeason: season ?? null,
        seasonEpisodes:
          season != null && episode != null ? [{ season, maxEpisode: episode }] : null,
      }, archiveLang);
      if (m.mediaId && m.confidence >= 0.7) {
        await this.matcher.ensureShowHydrated(m.mediaId);
        mediaId = m.mediaId;
        showMediaByNorm.set(nt, mediaId);
      }
    }
    const confidence = mediaId ? 0.85 : 0;
    if (!mediaId) return { mediaId: null, episodeId: null, confidence, status: this.classifyStatus(confidence) };
    if (season != null && episode != null) {
      const episodeId =
        (externalEpisodeId != null
          ? await this.matcher.resolveEpisodeByExternalIds(mediaId, { tvdb: Number(externalEpisodeId) || null })
          : null) ??
        (await this.matcher.resolveEpisode(mediaId, season, episode)) ??
        (externalEpisodeId != null ? await this.matcher.recoverEpisodeByTvdbId(mediaId, externalEpisodeId) : null);
      if (episodeId) return { mediaId, episodeId, confidence: 0.9, status: 'MATCHED' };
      // Episode not found: fall back to a show-level match (ratings/emotions) or flag for review.
      if (fallbackToMedia) return { mediaId, episodeId: null, confidence: 0.75, status: 'MATCHED' };
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

  private async resolveRatingTarget(
    c: NormalizedImportedRating,
    showMediaByNorm: Map<string, string>,
    archiveLang: SupportedLocale | null = null,
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (c.targetType === 'movie') {
      const title = c.movieTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'MOVIE', undefined, undefined, archiveLang);
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    if (c.targetType === 'show') {
      const title = c.showTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'SHOW', undefined, undefined, archiveLang);
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    // episode rating: fall back to a show-level match if the specific episode can't be resolved.
    return this.resolveShowEpisode(c.showTitle, c.seasonNumber, c.episodeNumber, showMediaByNorm, true, archiveLang, c.externalEpisodeId);
  }

  private async resolveEmotionTarget(
    c: NormalizedImportedEmotion,
    showMediaByNorm: Map<string, string>,
    archiveLang: SupportedLocale | null = null,
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (c.targetType === 'movie') {
      const title = c.movieTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'MOVIE', undefined, undefined, archiveLang);
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    // episode emotion: fall back to a show-level match if the specific episode can't be resolved.
    return this.resolveShowEpisode(c.showTitle, c.seasonNumber, c.episodeNumber, showMediaByNorm, true, archiveLang, c.externalEpisodeId);
  }

  private async resolveCommentTarget(
    c: NormalizedImportedComment,
    showMediaByNorm: Map<string, string>,
    archiveLang: SupportedLocale | null = null,
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (c.targetType === 'movie') {
      const title = c.movieTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'MOVIE', undefined, undefined, archiveLang);
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    if (c.targetType === 'show') {
      const title = c.showTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'SHOW', undefined, undefined, archiveLang);
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    return this.resolveShowEpisode(c.showTitle, c.seasonNumber, c.episodeNumber, showMediaByNorm, false, archiveLang, c.externalEpisodeId);
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
        ...(isRating ? { normalizedRating: (c as NormalizedImportedRating).normalizedRating, sourceSet: c.sourceSet, sourceRatingId: c.sourceRatingId, voteKey: c.voteKey } : { normalizedEmotion: (c as NormalizedImportedEmotion).normalizedEmotion, sourceSet: c.sourceSet, sourceEmotionId: c.sourceEmotionId, voteKey: c.voteKey }),
        targetType: c.targetType,
        showTitle: (c as any).showTitle ?? null,
        movieTitle: (c as any).movieTitle ?? null,
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
      c.targetType === 'movie' ? 'MOVIE_COMMENT' : c.targetType === 'show' ? 'SHOW_COMMENT' : 'EPISODE_COMMENT';
    return {
      importId,
      rowNumber: c.sourceRow,
      sourceEntityType: entityType as ImportEntityType,
      targetEntityType: entityType as ImportEntityType,
      status,
      rawData: { sourceFile: c.sourceFile, sourceRow: c.sourceRow, sourceCommentId: c.sourceCommentId } as any,
      normalizedData: {
        text: c.text, // stored for apply; never logged
        textLength: c.textLength,
        spoiler: c.spoiler,
        language: c.language,
        sourceCommentId: c.sourceCommentId,
        sourceKey,
        sourceAuthorId: c.sourceAuthorId,
        image: c.image ?? null, // { url, format } — gif stored by URL, png downloaded at apply
        targetType: c.targetType,
        showTitle: c.showTitle ?? null,
        movieTitle: c.movieTitle ?? null,
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
        out.push({ filename: e.filename, size: e.size, headers: parsed.headers, rows: parsed.rows });
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
