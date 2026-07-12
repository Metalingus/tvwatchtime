import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ImportStatus, ImportEntityType } from '@prisma/client';
import { RedisService } from '../common/redis/redis.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { IMPORT_LIMITS } from './lib/limits';
import { ImportStorage } from './lib/storage';
import { inspectZip } from './lib/zip-validator';
import { parseCsv } from './lib/csv';
import { detectProfile, normalizeRow, normTitle, type NormalizedItem } from './lib/inference';
import { ImportMatcher } from './lib/matcher';
import { buildSeriesIdNameMap, isListsFile, normalizeLists } from './lib/lists';
import { normalizeRatings, dedupeRatings, type NormalizedImportedRating } from './lib/ratings';
import { normalizeEmotions, dedupeEmotions, type NormalizedImportedEmotion } from './lib/emotions';
import {
  resolveArchiveOwner,
  normalizeComments,
  dedupeComments,
  commentIdentity,
  type NormalizedImportedComment,
} from './lib/comments';

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

    try {
      await this.setStatus(importId, 'EXTRACTING');
      const bytes = await this.storage.read(imp.storageKey!);

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

      await this.setStatus(importId, 'NORMALIZING', { totalRows });
      // Dedupe by entity|normTitle|season|episode (count duplicates, keep one)
      const seen = new Set<string>();
      const dedup: NormalizedItem[] = [];
      let duplicates = 0;
      for (const it of allItems) {
        const k = `${it.entityType}|${it.normTitle}|${it.season ?? ''}|${it.episode ?? ''}`;
        if (seen.has(k)) {
          duplicates++;
          continue;
        }
        seen.add(k);
        dedup.push(it);
      }

      await this.setStatus(importId, 'MATCHING');
      // For watched episodes, hydrate each distinct show once before resolving episodes.
      const showKeys = new Set<string>();
      for (const it of dedup) {
        if (it.entityType === 'WATCHED_EPISODE') showKeys.add(it.normTitle);
      }
      const showMediaByNorm = new Map<string, string>();
      for (const it of dedup) {
        if (it.entityType !== 'WATCHED_EPISODE') continue;
        if (showMediaByNorm.has(it.normTitle)) continue;
        const m = await this.matcher.matchMedia(it.normTitle, it.title, 'SHOW', it.year);
        if (m.mediaId && m.confidence >= 0.7) {
          await this.matcher.ensureShowHydrated(m.mediaId);
          showMediaByNorm.set(it.normTitle, m.mediaId);
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
            episodeId = await this.matcher.resolveEpisode(mediaId, it.season, it.episode);
          }
          confidence = episodeId ? 0.9 : mediaId ? 0.6 : 0;
        } else {
          const m = await this.matcher.matchMedia(it.normTitle, it.title, type as 'SHOW' | 'MOVIE', it.year);
          mediaId = m.mediaId;
          confidence = m.confidence;
        }

        const cls = this.matcher.classify(confidence);
        if (it.entityType === 'WATCHED_EPISODE' && !episodeId && cls === 'matched') {
          // matched show but episode unresolved → needs review
        }
        let status: any;
        if (!mediaId) status = cls === 'unmatched' ? 'UNMATCHED' : 'NEEDS_REVIEW';
        else if (it.entityType === 'WATCHED_EPISODE' && !episodeId) status = 'NEEDS_REVIEW';
        else status = cls === 'matched' ? 'MATCHED' : 'NEEDS_REVIEW';

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
          normalizedData: { title: it.title, normTitle: it.normTitle, year: it.year, season: it.season, episode: it.episode, watchedAt: it.watchedAt?.toISOString() ?? null } as any,
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
                const m = await this.matcher.matchMedia(normTitle(name), name, 'SHOW');
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
      const extraCounts = await this.stageExtraEntities(importId, files, showMediaByNorm);

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
      const { mediaId, episodeId, confidence, status } = await this.resolveRatingTarget(c, showMediaByNorm);
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
      const { mediaId, episodeId, confidence, status } = await this.resolveEmotionTarget(c, showMediaByNorm);
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
      const { mediaId, episodeId, confidence, status } = await this.resolveCommentTarget(c, showMediaByNorm);
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

  /** Resolve show by title, hydrating on demand; then resolve episode by S/E. Reuses caches. */
  private async resolveShowEpisode(
    showTitle: string | null | undefined,
    season: number | null | undefined,
    episode: number | null | undefined,
    showMediaByNorm: Map<string, string>,
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (!showTitle) return { mediaId: null, episodeId: null, confidence: 0, status: 'UNMATCHED' };
    const nt = normTitle(showTitle);
    let mediaId = showMediaByNorm.get(nt) ?? null;
    if (!mediaId) {
      const m = await this.matcher.matchMedia(nt, showTitle, 'SHOW');
      if (m.mediaId && m.confidence >= 0.7) {
        await this.matcher.ensureShowHydrated(m.mediaId);
        mediaId = m.mediaId;
        showMediaByNorm.set(nt, mediaId);
      }
    }
    const confidence = mediaId ? 0.85 : 0;
    if (!mediaId) return { mediaId: null, episodeId: null, confidence, status: this.classifyStatus(confidence) };
    if (season != null && episode != null) {
      const episodeId = await this.matcher.resolveEpisode(mediaId, season, episode);
      if (episodeId) return { mediaId, episodeId, confidence: 0.9, status: 'MATCHED' };
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
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (c.targetType === 'movie') {
      const title = c.movieTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'MOVIE');
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    if (c.targetType === 'show') {
      const title = c.showTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'SHOW');
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    // episode
    return this.resolveShowEpisode(c.showTitle, c.seasonNumber, c.episodeNumber, showMediaByNorm);
  }

  private async resolveEmotionTarget(
    c: NormalizedImportedEmotion,
    showMediaByNorm: Map<string, string>,
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (c.targetType === 'movie') {
      const title = c.movieTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'MOVIE');
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    return this.resolveShowEpisode(c.showTitle, c.seasonNumber, c.episodeNumber, showMediaByNorm);
  }

  private async resolveCommentTarget(
    c: NormalizedImportedComment,
    showMediaByNorm: Map<string, string>,
  ): Promise<{ mediaId: string | null; episodeId: string | null; confidence: number; status: string }> {
    if (c.targetType === 'movie') {
      const title = c.movieTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'MOVIE');
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    if (c.targetType === 'show') {
      const title = c.showTitle ?? '';
      const nt = normTitle(title);
      const m = await this.matcher.matchMedia(nt, title, 'SHOW');
      const status = m.mediaId ? this.classifyStatus(m.confidence) : 'UNMATCHED';
      return { mediaId: m.mediaId, episodeId: null, confidence: m.confidence, status };
    }
    return this.resolveShowEpisode(c.showTitle, c.seasonNumber, c.episodeNumber, showMediaByNorm);
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
        sourceKey: commentIdentity(c), // stable id for idempotent apply / re-import
        sourceAuthorId: c.sourceAuthorId,
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
