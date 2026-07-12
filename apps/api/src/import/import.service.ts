import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingService } from '../common/setting.service';
import { IMPORT_LIMITS } from './lib/limits';
import { ImportStorage } from './lib/storage';
import { ImportMatcher } from './lib/matcher';
import { normTitle, splitTitleYear } from './lib/inference';
import { ImportProcessor } from './import.processor';
import { InvalidUploadError } from './errors';
import { randomUUID } from 'crypto';

const EXT_TO_SOURCE: Record<string, 'zip' | 'csv' | 'json'> = {
  zip: 'zip',
  csv: 'csv',
  json: 'json',
};

const BATCH_CHUNK = 5000;
// Interactive transaction limits. The apply stage splits work across multiple short
// transactions (one per section) instead of one giant transaction, but each section still
// needs headroom beyond Prisma's 5s default — that default is what caused the 500 on large
// exports (P2028 timeout).
const TX_TIMEOUT = Number(process.env.IMPORT_TX_TIMEOUT_MS) || 60_000;
const TX_MAXWAIT = Number(process.env.IMPORT_TX_MAXWAIT_MS) || 10_000;

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ImportStorage,
    private readonly processor: ImportProcessor,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly settings: SettingService,
    private readonly matcher: ImportMatcher,
  ) {}

  // ---------------- upload ----------------
  async upload(userId: string, file: { buffer: Buffer; originalname: string; size: number }) {
    if (!file) throw new InvalidUploadError('No file received');
    if (file.size > IMPORT_LIMITS.MAX_UPLOAD_BYTES) {
      throw new InvalidUploadError(`File exceeds ${IMPORT_LIMITS.MAX_UPLOAD_BYTES} bytes`);
    }
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    const sourceType = EXT_TO_SOURCE[ext];
    if (!sourceType) throw new InvalidUploadError('Only .zip, .csv or .json are accepted');

    // Daily limit is admin-controlled (Settings → limits → IMPORT_DAILY_LIMIT); falls back to
    // the env config, then the hardcoded default. Read live so admin changes take effect.
    const dailyLimit = await this.settings.getNumber('IMPORT_DAILY_LIMIT', NaN);
    const effectiveLimit = Number.isFinite(dailyLimit) && dailyLimit > 0
      ? dailyLimit
      : this.config.get<number>('imports.dailyLimit') ?? IMPORT_LIMITS.DAILY_IMPORTS_PER_USER;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayCount = await this.prisma.import.count({
      where: { userId, createdAt: { gte: since } },
    });
    if (todayCount >= effectiveLimit) {
      throw new BadRequestException(`Daily import limit (${effectiveLimit}) reached`);
    }

    const imp = await this.prisma.import.create({
      data: {
        userId,
        sourceType,
        originalFilename: file.originalname,
        status: 'UPLOADED',
      },
    });
    const key = await this.storage.write(imp.id, file.originalname, file.buffer);
    await this.prisma.import.update({ where: { id: imp.id }, data: { storageKey: key, status: 'QUEUED' } });
    await this.processor.enqueue(imp.id);
    return { importId: imp.id, status: 'QUEUED' };
  }

  // ---------------- status / files / items ----------------
  getStatus(userId: string, importId: string) {
    return this.prisma.import.findFirst({ where: { id: importId, userId } });
  }

  getFiles(userId: string, importId: string) {
    return this.prisma.importFile.findMany({ where: { importId, import: { userId } } });
  }

  async getItems(
    userId: string,
    importId: string,
    opts: { status?: string; entity?: string; page?: number; pageSize?: number },
  ) {
    // Verify ownership separately (the `import` relation filter is unreliable due to the reserved word)
    const owned = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!owned) throw new NotFoundException('Import not found');

    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 50, 200);
    const where: any = { importId };
    if (opts.status) where.status = opts.status.toUpperCase();
    if (opts.entity && isNaN(Number(opts.entity))) where.sourceEntityType = opts.entity.toUpperCase();
    const [items, total] = await Promise.all([
      this.prisma.importItem.findMany({
        where,
        orderBy: [{ status: 'asc' }, { confidenceScore: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.importItem.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async patchItem(userId: string, importId: string, itemId: string, dto: { matchedMediaId?: string; userResolution?: string }) {
    const item = await this.prisma.importItem.findFirst({ where: { id: itemId, importId, import: { userId } } });
    if (!item) throw new NotFoundException('Import item not found');
    const data: any = {};
    if (dto.matchedMediaId) {
      data.matchedMediaId = dto.matchedMediaId;
      data.confidenceScore = 1;
      data.status = 'MATCHED';
    }
    if (dto.userResolution) data.userResolution = dto.userResolution;
    if (dto.userResolution === 'skip') data.status = 'SKIPPED';
    const updated = await this.prisma.importItem.update({ where: { id: itemId }, data });
    await this.recountImportStatuses(importId);
    return updated;
  }

  /**
   * Resolve every unresolved item belonging to the same source show (by title) to a single
   * chosen media. Used by the "apply to all episodes" checkbox: the user picks the correct
   * show once and every NEEDS_REVIEW episode/rating/emotion/comment for that source title is
   * matched. Episode entities are resolved to their specific episode by S/E.
   *
   * When `season` is provided, ONLY items in that source season are resolved — this handles
   * anthology imports where one source show's seasons are actually distinct real shows
   * (e.g. "The Haunting" S1 = Hill House, S2 = Bly Manor).
   */
  async resolveAllForShow(
    userId: string,
    importId: string,
    matchedMediaId: string,
    sourceTitle: string,
    season?: number | null,
  ): Promise<{ resolved: number; matched: number; needsReview: number }> {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');

    // Ensure the chosen show has seasons/episodes so episode resolution can work.
    await this.matcher.ensureShowHydrated(matchedMediaId);

    // Core-normalized title (strips " (2023)" year suffixes) so "Silo" and "Silo (2023)" match.
    const coreNorm = (s: string) => normTitle(splitTitleYear(s).title);
    const nt = coreNorm(sourceTitle);
    const items = await this.prisma.importItem.findMany({
      where: { importId, status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] } },
    });

    let resolved = 0;
    let matched = 0;
    let needsReview = 0;
    const EPISODE_ENTITIES = ['WATCHED_EPISODE', 'EPISODE_RATING', 'EPISODE_EMOTION', 'EPISODE_COMMENT'];

    for (const it of items) {
      const norm: any = it.normalizedData ?? {};
      const title = norm.showTitle ?? norm.title;
      if (!title || coreNorm(title) !== nt) continue;
      // Per-season scoping: only resolve items in the chosen source season (anthology support).
      const itemSeason = Number(norm.season ?? norm.seasonNumber);
      if (season != null && Number.isFinite(itemSeason) && itemSeason !== season) continue;

      let status = 'MATCHED';
      let episodeId: string | null = null;
      if (EPISODE_ENTITIES.includes(it.sourceEntityType)) {
        const season = Number(norm.season ?? norm.seasonNumber);
        const episode = Number(norm.episode ?? norm.episodeNumber);
        if (Number.isFinite(season) && Number.isFinite(episode)) {
          // Lenient: the user explicitly mapped this (source) season to a different show, so
          // fall back to the episode number in any season (anthology: source S2 → target S1).
          episodeId = await this.matcher.resolveEpisode(matchedMediaId, season, episode, true);
        }
        status = episodeId ? 'MATCHED' : 'NEEDS_REVIEW';
      }

      await this.prisma.importItem.update({
        where: { id: it.id },
        data: { matchedMediaId, matchedEpisodeId: episodeId, status: status as 'MATCHED' | 'NEEDS_REVIEW', confidenceScore: episodeId ? 1 : 0.7 },
      });
      resolved++;
      if (status === 'MATCHED') matched++;
      else needsReview++;
    }

    // Keep the Import summary counters in sync with the new item statuses.
    await this.recountImportStatuses(importId);
    return { resolved, matched, needsReview };
  }

  /** Recompute the Import row's status counters from the current ImportItem statuses. */
  private async recountImportStatuses(importId: string) {
    const groups = await this.prisma.importItem.groupBy({
      by: ['status'],
      where: { importId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const g of groups) counts[g.status] = g._count._all;
    await this.prisma.import.update({
      where: { id: importId },
      data: {
        matchedCount: counts['MATCHED'] ?? 0,
        unmatchedCount: counts['UNMATCHED'] ?? 0,
        needsReviewCount: counts['NEEDS_REVIEW'] ?? 0,
        duplicateCount: counts['DUPLICATE'] ?? 0,
        invalidCount: counts['INVALID'] ?? 0,
        conflictCount: counts['CONFLICT'] ?? 0,
      },
    });
  }

  // ---------------- confirm + apply (batched, per-section transactions) ----------------
  async confirm(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (imp.status !== 'READY_FOR_REVIEW') {
      throw new BadRequestException(`Import is not ready for review (status=${imp.status})`);
    }
    await this.prisma.import.update({ where: { id: importId }, data: { status: 'IMPORTING' } });

    // Load only not-yet-applied matched items. Each section marks its items APPLIED inside its
    // own transaction, so a retry (BullMQ or manual re-confirm) only reprocesses leftover items
    // and never duplicates already-applied data.
    const items = await this.prisma.importItem.findMany({
      where: {
        importId,
        status: 'MATCHED',
        OR: [{ userResolution: null }, { userResolution: { not: 'skip' } }],
      },
    });

    let created = 0;
    let skipped = 0;
    try {
      const res = await this.applyBatch(userId, importId, items);
      created = res.created;
      skipped = res.skipped;
      await this.prisma.import.update({
        where: { id: importId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await this.rebuildShowStatuses(userId, items);
      this.events.emit('import.applied', { userId });
    } catch (e) {
      this.logger.error(`Apply failed for import ${importId}: ${(e as Error).message}`);
      await this.prisma.import.update({ where: { id: importId }, data: { status: 'FAILED', errorMessage: (e as Error).message?.slice(0, 1000) } }).catch(() => undefined);
      throw e;
    } finally {
      // Guaranteed temp-file cleanup regardless of success or failure.
      try {
        await this.storage.delete(imp.storageKey!);
      } catch {
        // best-effort cleanup
      }
    }
    return { importId, created, skipped };
  }

  /** Summary of the rating/emotion/comment counts for the result/preview UI. */
  async getSummary(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    return {
      ratingsDetected: imp.ratingsDetected,
      ratingsImported: imp.ratingsImported,
      ratingsUpdated: imp.ratingsUpdated,
      ratingsSkippedUnsupported: imp.ratingsSkippedUnsupported,
      ratingsSkippedUnresolved: imp.ratingsSkippedUnresolved,
      ratingDuplicatesIgnored: imp.ratingDuplicatesIgnored,
      emotionsDetected: imp.emotionsDetected,
      emotionsImported: imp.emotionsImported,
      emotionsSkippedUnsupported: imp.emotionsSkippedUnsupported,
      emotionsSkippedUnresolved: imp.emotionsSkippedUnresolved,
      emotionDuplicatesIgnored: imp.emotionDuplicatesIgnored,
      commentRowsDetected: imp.commentRowsDetected,
      topLevelCommentsDetected: imp.topLevelCommentsDetected,
      commentsImported: imp.commentsImported,
      commentRepliesSkipped: imp.commentRepliesSkipped,
      commentActivityRowsSkipped: imp.commentActivityRowsSkipped,
      commentsByOtherUsersSkipped: imp.commentsByOtherUsersSkipped,
      commentsSkippedUnresolved: imp.commentsSkippedUnresolved,
      commentDuplicatesIgnored: imp.commentDuplicatesIgnored,
      commentsSkippedInvalid: imp.commentsSkippedInvalid,
    };
  }

  private chunkedCreateMany(tx: any, model: string, rows: any[], skipDuplicates = false) {
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
      work.push(tx[model].createMany({ data: rows.slice(i, i + BATCH_CHUNK), skipDuplicates }));
    }
    return Promise.all(work);
  }

  /** Apply every section, each in its own raised-timeout transaction (no single giant tx). */
  private async applyBatch(
    userId: string,
    importId: string,
    items: any[],
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    const epItems = items.filter(
      (it) => it.sourceEntityType === 'WATCHED_EPISODE' && it.matchedMediaId && it.matchedEpisodeId,
    );
    const movieItems = items.filter(
      (it) => it.sourceEntityType === 'WATCHED_MOVIE' && it.matchedMediaId,
    );
    const watchlistItems = items.filter(
      (it) => (it.sourceEntityType === 'WATCHLIST_SHOW' || it.sourceEntityType === 'WATCHLIST_MOVIE') && it.matchedMediaId,
    );
    const favoriteItems = items.filter(
      (it) => (it.sourceEntityType === 'FAVORITE_SHOW' || it.sourceEntityType === 'FAVORITE_MOVIE') && it.matchedMediaId,
    );

    // --- WATCHED EPISODES ---
    if (epItems.length) {
      const episodeIds = epItems.map((it) => it.matchedEpisodeId);
      const [episodeData, existingWatched] = await Promise.all([
        this.prisma.episode.findMany({
          where: { id: { in: episodeIds } },
          select: { id: true, runtimeMinutes: true, season: { select: { number: true } } },
        }),
        this.prisma.userEpisodeStatus.findMany({
          where: { userId, episodeId: { in: episodeIds }, watched: true },
          select: { episodeId: true },
        }),
      ]);
      const runtimeMap = new Map<string, any>(episodeData.map((e: any) => [e.id, e]));
      const watchedSet = new Set(existingWatched.map((e: any) => e.episodeId));

      const epStatusRows: any[] = [];
      const historyRows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      let sectionCreated = 0;
      for (const it of epItems) {
        const epId = it.matchedEpisodeId;
        if (watchedSet.has(epId)) {
          skipped++;
          continue;
        }
        const norm: any = it.normalizedData ?? {};
        const epData: any = runtimeMap.get(epId);
        const watchedAt = norm.watchedAt ? new Date(norm.watchedAt) : new Date();
        const statusId = randomUUID();
        epStatusRows.push({ id: statusId, userId, episodeId: epId, watched: true, watchedAt });
        historyRows.push({
          id: randomUUID(),
          userId,
          mediaId: it.matchedMediaId,
          mediaType: MediaType.SHOW,
          episodeId: epId,
          seasonNumber: epData?.season?.number ?? norm.season ?? null,
          episodeNumber: norm.episode ?? null,
          runtimeMinutes: epData?.runtimeMinutes ?? null,
          watchedAt,
        });
        auditRows.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'user_episode_status', targetRecordId: statusId, action: 'created' });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (epStatusRows.length) {
        await this.prisma.$transaction(async (tx) => {
          await this.chunkedCreateMany(tx, 'userEpisodeStatus', epStatusRows, true);
          await this.chunkedCreateMany(tx, 'watchHistory', historyRows);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
          if (appliedIds.length) await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        }, { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT });
      }
      created += sectionCreated;
    }

    // --- WATCHED MOVIES ---
    if (movieItems.length) {
      const movieMediaIds = movieItems.map((it) => it.matchedMediaId);
      const [movieData, existingWatchedMovies] = await Promise.all([
        this.prisma.movie.findMany({
          where: { mediaId: { in: movieMediaIds } },
          select: { mediaId: true, runtimeMinutes: true },
        }),
        this.prisma.userMovieStatus.findMany({
          where: { userId, mediaId: { in: movieMediaIds }, watched: true },
          select: { mediaId: true },
        }),
      ]);
      const runtimeMap = new Map(movieData.map((m: any) => [m.mediaId, m.runtimeMinutes]));
      const watchedMovieSet = new Set(existingWatchedMovies.map((m: any) => m.mediaId));

      const movieStatusRows: any[] = [];
      const movieHistoryRows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      let sectionCreated = 0;
      for (const it of movieItems) {
        const mediaId = it.matchedMediaId;
        if (watchedMovieSet.has(mediaId)) {
          skipped++;
          continue;
        }
        const norm: any = it.normalizedData ?? {};
        const watchedAt = norm.watchedAt ? new Date(norm.watchedAt) : new Date();
        const statusId = randomUUID();
        movieStatusRows.push({ id: statusId, userId, mediaId, watched: true, watchedAt });
        movieHistoryRows.push({
          id: randomUUID(),
          userId,
          mediaId,
          mediaType: MediaType.MOVIE,
          runtimeMinutes: runtimeMap.get(mediaId) ?? null,
          watchedAt,
        });
        auditRows.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'user_movie_status', targetRecordId: statusId, action: 'created' });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (movieStatusRows.length) {
        await this.prisma.$transaction(async (tx) => {
          await this.chunkedCreateMany(tx, 'userMovieStatus', movieStatusRows, true);
          await this.chunkedCreateMany(tx, 'watchHistory', movieHistoryRows);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
          if (appliedIds.length) await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        }, { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT });
      }
      created += sectionCreated;
    }

    // --- WATCHLIST ---
    if (watchlistItems.length) {
      const mediaIds = [...new Set(watchlistItems.map((it) => it.matchedMediaId))];
      const existing = await this.prisma.watchlistItem.findMany({
        where: { userId, mediaId: { in: mediaIds } },
        select: { mediaId: true },
      });
      const existingSet = new Set(existing.map((w: any) => w.mediaId));

      const rows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      let sectionCreated = 0;
      for (const it of watchlistItems) {
        const mediaId = it.matchedMediaId;
        if (existingSet.has(mediaId)) {
          skipped++;
          continue;
        }
        existingSet.add(mediaId);
        const rowId = randomUUID();
        rows.push({ id: rowId, userId, mediaId });
        auditRows.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'watchlist_items', targetRecordId: rowId, action: 'created' });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (rows.length) {
        await this.prisma.$transaction(async (tx) => {
          await this.chunkedCreateMany(tx, 'watchlistItem', rows, true);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
          if (appliedIds.length) await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        }, { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT });
      }
      created += sectionCreated;
    }

    // --- FAVORITES ---
    if (favoriteItems.length) {
      const mediaIds = [...new Set(favoriteItems.map((it) => it.matchedMediaId))];
      const existing = await this.prisma.favorite.findMany({
        where: { userId, mediaId: { in: mediaIds } },
        select: { mediaId: true },
      });
      const existingSet = new Set(existing.map((f: any) => f.mediaId));

      const rows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      let sectionCreated = 0;
      for (const it of favoriteItems) {
        const mediaId = it.matchedMediaId;
        if (existingSet.has(mediaId)) {
          skipped++;
          continue;
        }
        existingSet.add(mediaId);
        const rowId = randomUUID();
        rows.push({ id: rowId, userId, mediaId });
        auditRows.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'favorites', targetRecordId: rowId, action: 'created' });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (rows.length) {
        await this.prisma.$transaction(async (tx) => {
          await this.chunkedCreateMany(tx, 'favorite', rows, true);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
          if (appliedIds.length) await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        }, { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT });
      }
      created += sectionCreated;
    }

    // --- LISTS (TV Time lists-prod-lists.csv) ---
    created += await this.applyLists(userId, importId, items);

    // --- RATINGS / EMOTIONS / COMMENTS ---
    const r = await this.applyRatings(userId, importId, items);
    created += r.created;
    skipped += r.skipped;
    const e = await this.applyEmotions(userId, importId, items);
    created += e.created;
    skipped += e.skipped;
    const c = await this.applyComments(userId, importId, items);
    created += c.created;
    skipped += c.skipped;

    return { created, skipped };
  }

  /** Create/update TV Time lists idempotently (identity = userId + TVTIME + sourceKey). */
  private async applyLists(userId: string, importId: string, items: any[]): Promise<number> {
    const listItems = items.filter((it) => it.sourceEntityType === 'LIST' && it.status === 'MATCHED');
    const listItemItems = items.filter(
      (it) => it.sourceEntityType === 'LIST_ITEM' && it.status === 'MATCHED' && it.matchedMediaId,
    );
    if (!listItems.length) return 0;

    const itemsBySource = new Map<string, any[]>();
    for (const it of listItemItems) {
      const key = it.normalizedData?.sourceKey ?? it.rawData?.sourceKey;
      if (!key) continue;
      if (!itemsBySource.has(key)) itemsBySource.set(key, []);
      itemsBySource.get(key)!.push(it);
    }

    let created = 0;
    for (const it of listItems) {
      const norm: any = it.normalizedData ?? {};
      const sourceKey: string = norm.sourceKey ?? it.rawData?.sourceKey;
      const childItems = (itemsBySource.get(sourceKey) ?? []).filter((x) => x.matchedMediaId);

      // Dedupe media within this source list (keep first occurrence's order).
      const seenMedia = new Set<string>();
      const ordered = new Map<string, number>();
      for (const c of childItems) {
        if (seenMedia.has(c.matchedMediaId)) continue;
        seenMedia.add(c.matchedMediaId);
        ordered.set(c.matchedMediaId, Number(c.normalizedData?.order ?? 0));
      }

      await this.prisma.$transaction(
        async (tx) => {
          // Find existing imported list by stable identity (never match by title).
          let list = await tx.customList.findFirst({
            where: { userId, source: 'TVTIME', sourceKey },
          });
          let listAudit: any[] = [];
          if (!list) {
            const listId = randomUUID();
            list = await tx.customList.create({
              data: {
                id: listId,
                userId,
                title: norm.title ?? 'Imported list',
                description: norm.description ?? null,
                visibility: norm.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
                source: 'TVTIME',
                sourceKey,
                ...(norm.createdAt ? { createdAt: new Date(norm.createdAt) } : {}),
              },
            });
            listAudit.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'custom_lists', targetRecordId: listId, action: 'created' });
          } else {
            const prev = { title: list.title, description: list.description, visibility: list.visibility };
            list = await tx.customList.update({
              where: { id: list.id },
              data: {
                title: norm.title ?? list.title,
                description: norm.description ?? list.description,
                visibility: norm.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
              },
            });
            listAudit.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'custom_lists', targetRecordId: list.id, action: 'updated', previousData: prev as any, newData: { title: list.title, description: list.description, visibility: list.visibility } as any });
          }

          // Add missing items (skipDuplicates respects @@unique([listId, mediaId])).
          const existingItems = await tx.customListItem.findMany({
            where: { listId: list.id, mediaId: { in: [...ordered.keys()] } },
            select: { mediaId: true },
          });
          const have = new Set(existingItems.map((i: any) => i.mediaId));
          const newRows: any[] = [];
          const itemAudit: any[] = [];
          let order = 0;
          for (const [mediaId, srcOrder] of ordered.entries()) {
            if (have.has(mediaId)) continue;
            const rowId = randomUUID();
            newRows.push({ id: rowId, listId: list.id, mediaId, order: srcOrder ?? order });
            itemAudit.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'custom_list_items', targetRecordId: rowId, action: 'created' });
            created++;
            order++;
          }
          if (newRows.length) await this.chunkedCreateMany(tx, 'customListItem', newRows);
          const allAudit = [...listAudit, ...itemAudit];
          if (allAudit.length) await this.chunkedCreateMany(tx, 'importAppliedRecord', allAudit);
          // Mark the LIST + its applied LIST_ITEMs as APPLIED (idempotent retry).
          const appliedIds = [it.id, ...childItems.map((c) => c.id)];
          await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    }
    return created;
  }

  /** Apply ratings with a non-destructive conflict policy (never overwrite manual ratings). */
  private async applyRatings(
    userId: string,
    importId: string,
    items: any[],
  ): Promise<{ created: number; skipped: number }> {
    const ratingItems = items.filter(
      (it) =>
        ['EPISODE_RATING', 'MOVIE_RATING', 'SHOW_RATING'].includes(it.sourceEntityType) &&
        it.status === 'MATCHED',
    );
    if (!ratingItems.length) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;

    const epIds = [...new Set(ratingItems.map((it: any) => it.matchedEpisodeId).filter(Boolean))] as string[];
    const mediaIds = [...new Set(ratingItems.map((it: any) => it.matchedMediaId).filter(Boolean))] as string[];
    const [existingEp, existingMedia] = await Promise.all([
      epIds.length ? this.prisma.rating.findMany({ where: { userId, episodeId: { in: epIds } } }) : [],
      mediaIds.length ? this.prisma.rating.findMany({ where: { userId, mediaId: { in: mediaIds } } }) : [],
    ]);
    const epMap = new Map(existingEp.map((r: any) => [r.episodeId, r]));
    const mediaMap = new Map(existingMedia.map((r: any) => [r.mediaId, r]));

    const toCreate: any[] = [];
    const audit: any[] = [];
    const updates: { id: string; rating: number }[] = [];
    const updateAudit: any[] = [];
    const appliedIds: string[] = [];

    for (const it of ratingItems) {
      const norm: any = it.normalizedData ?? {};
      const rating = Number(norm.normalizedRating);
      if (!Number.isFinite(rating)) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      const sourceKey =
        norm.voteKey ?? (it.matchedEpisodeId ? `episode:${it.matchedEpisodeId}` : `media:${it.matchedMediaId}`);
      const existing: any = it.matchedEpisodeId ? epMap.get(it.matchedEpisodeId) : mediaMap.get(it.matchedMediaId);
      if (!existing) {
        const id = randomUUID();
        // Episode ratings key on episodeId only (mediaId null) so multiple episodes of the
        // same show don't collide on the @@unique([userId, mediaId]) constraint.
        const isEpisode = !!it.matchedEpisodeId;
        toCreate.push({
          id,
          userId,
          episodeId: isEpisode ? it.matchedEpisodeId : null,
          mediaId: isEpisode ? null : it.matchedMediaId ?? null,
          rating,
          source: 'TVTIME',
          sourceKey,
          createdAt: norm.sourceCreatedAt ? new Date(norm.sourceCreatedAt) : new Date(),
          updatedAt: norm.sourceUpdatedAt ? new Date(norm.sourceUpdatedAt) : new Date(),
        });
        audit.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'ratings', targetRecordId: id, action: 'created' });
        appliedIds.push(it.id);
        created++;
      } else if (existing.source === 'TVTIME' && existing.sourceKey === sourceKey) {
        // idempotent update of the same imported record
        updates.push({ id: existing.id, rating });
        updateAudit.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'ratings',
          targetRecordId: existing.id,
          action: 'updated',
          previousData: { rating: existing.rating } as any,
          newData: { rating } as any,
        });
        appliedIds.push(it.id);
        created++;
      } else {
        // conflict: local rating exists (manual or different source) — never overwrite
        skipped++;
        appliedIds.push(it.id);
      }
    }

    if (toCreate.length || updates.length) {
      await this.prisma.$transaction(
        async (tx) => {
          if (toCreate.length) await this.chunkedCreateMany(tx, 'rating', toCreate, true);
          for (const u of updates) {
            await tx.rating.update({ where: { id: u.id }, data: { rating: u.rating, updatedAt: new Date() } });
          }
          await this.chunkedCreateMany(tx, 'importAppliedRecord', [...audit, ...updateAudit]);
          if (appliedIds.length) await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    } else if (appliedIds.length) {
      await this.prisma.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
    }

    await this.prisma.import.update({ where: { id: importId }, data: { ratingsImported: { increment: created }, ratingsUpdated: { increment: updates.length } } });
    return { created, skipped };
  }

  /** Apply emotions additively (never remove existing; idempotent via unique constraints). */
  private async applyEmotions(
    userId: string,
    importId: string,
    items: any[],
  ): Promise<{ created: number; skipped: number }> {
    const emotionItems = items.filter(
      (it) => ['EPISODE_EMOTION', 'MOVIE_EMOTION'].includes(it.sourceEntityType) && it.status === 'MATCHED',
    );
    if (!emotionItems.length) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;

    const epIds = [...new Set(emotionItems.map((it: any) => it.matchedEpisodeId).filter(Boolean))] as string[];
    const mediaIds = [...new Set(emotionItems.map((it: any) => it.matchedMediaId).filter(Boolean))] as string[];
    const [existingEp, existingMedia] = await Promise.all([
      epIds.length ? this.prisma.reaction.findMany({ where: { userId, episodeId: { in: epIds } }, select: { episodeId: true, reaction: true } }) : [],
      mediaIds.length ? this.prisma.reaction.findMany({ where: { userId, mediaId: { in: mediaIds } }, select: { mediaId: true, reaction: true } }) : [],
    ]);
    const haveEp = new Set(existingEp.map((r: any) => `${r.episodeId}|${r.reaction}`));
    const haveMedia = new Set(existingMedia.map((r: any) => `${r.mediaId}|${r.reaction}`));

    const rows: any[] = [];
    const audit: any[] = [];
    const appliedIds: string[] = [];

    for (const it of emotionItems) {
      const norm: any = it.normalizedData ?? {};
      const reaction = norm.normalizedEmotion;
      if (!reaction) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      const isEp = !!it.matchedEpisodeId;
      const key = isEp ? `${it.matchedEpisodeId}|${reaction}` : `${it.matchedMediaId}|${reaction}`;
      const have = isEp ? haveEp.has(key) : haveMedia.has(key);
      if (have) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      if (isEp) haveEp.add(key);
      else haveMedia.add(key);
      const id = randomUUID();
      rows.push({
        id,
        userId,
        episodeId: isEp ? it.matchedEpisodeId : null,
        mediaId: isEp ? null : it.matchedMediaId,
        reaction,
        source: 'TVTIME',
        sourceKey: norm.voteKey ?? key,
        createdAt: norm.sourceCreatedAt ? new Date(norm.sourceCreatedAt) : new Date(),
        updatedAt: norm.sourceUpdatedAt ? new Date(norm.sourceUpdatedAt) : null,
      });
      audit.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'reactions', targetRecordId: id, action: 'created' });
      appliedIds.push(it.id);
      created++;
    }

    if (rows.length) {
      await this.prisma.$transaction(
        async (tx) => {
          await this.chunkedCreateMany(tx, 'reaction', rows, true);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', audit);
          if (appliedIds.length) await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    } else if (appliedIds.length) {
      await this.prisma.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
    }

    await this.prisma.import.update({ where: { id: importId }, data: { emotionsImported: { increment: created } } });
    return { created, skipped };
  }

  /**
   * Apply top-level comments directly via Prisma (bypassing CommentsService) so that NO
   * notifications are sent and the `comment.created` event (badges) is NOT emitted. Only
   * comments not already imported (source=TVTIME + sourceKey) are created; manual comments
   * (source=null) are never touched. Historical createdAt is preserved.
   */
  private async applyComments(
    userId: string,
    importId: string,
    items: any[],
  ): Promise<{ created: number; skipped: number }> {
    const commentItems = items.filter(
      (it) => ['EPISODE_COMMENT', 'MOVIE_COMMENT', 'SHOW_COMMENT'].includes(it.sourceEntityType) && it.status === 'MATCHED',
    );
    if (!commentItems.length) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;

    const keys = [...new Set(commentItems.map((it: any) => it.normalizedData?.sourceKey).filter(Boolean))] as string[];
    const existing = keys.length
      ? await this.prisma.comment.findMany({ where: { userId, source: 'TVTIME', sourceKey: { in: keys } }, select: { sourceKey: true } })
      : [];
    const have = new Set(existing.map((c: any) => c.sourceKey));

    const rows: any[] = [];
    const audit: any[] = [];
    const appliedIds: string[] = [];

    for (const it of commentItems) {
      const norm: any = it.normalizedData ?? {};
      const sourceKey: string | undefined = norm.sourceKey;
      const body: string = norm.text ?? '';
      if (!body.trim()) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      if (sourceKey && have.has(sourceKey)) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      const threadType =
        it.sourceEntityType === 'EPISODE_COMMENT' ? 'EPISODE' : it.sourceEntityType === 'MOVIE_COMMENT' ? 'MOVIE' : 'SHOW';
      const threadId: string | null = threadType === 'EPISODE' ? it.matchedEpisodeId : it.matchedMediaId;
      if (!threadId) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      if (sourceKey) have.add(sourceKey);
      const id = randomUUID();
      rows.push({
        id,
        userId,
        parentId: null,
        threadType,
        threadId,
        body,
        isSpoiler: !!norm.spoiler,
        language: norm.language ?? null,
        source: 'TVTIME',
        sourceKey: sourceKey ?? null,
        createdAt: norm.sourceCreatedAt ? new Date(norm.sourceCreatedAt) : new Date(),
        updatedAt: norm.sourceUpdatedAt ? new Date(norm.sourceUpdatedAt) : new Date(),
      });
      audit.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'comments', targetRecordId: id, action: 'created' });
      appliedIds.push(it.id);
      created++;
    }

    if (rows.length) {
      await this.prisma.$transaction(
        async (tx) => {
          await this.chunkedCreateMany(tx, 'comment', rows);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', audit);
          if (appliedIds.length) await tx.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    } else if (appliedIds.length) {
      await this.prisma.importItem.updateMany({ where: { id: { in: appliedIds } }, data: { status: 'APPLIED' } });
    }

    await this.prisma.import.update({ where: { id: importId }, data: { commentsImported: { increment: created } } });
    return { created, skipped };
  }

  // ---------------- cancel / rollback / delete ----------------
  async cancel(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (!['UPLOADED', 'QUEUED', 'EXTRACTING', 'PARSING', 'NORMALIZING', 'MATCHING', 'READY_FOR_REVIEW'].includes(imp.status)) {
      throw new BadRequestException('Import cannot be cancelled at this stage');
    }
    return this.prisma.import.update({
      where: { id: importId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async rollback(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (!['COMPLETED', 'IMPORTING'].includes(imp.status)) {
      throw new BadRequestException('Only completed imports can be rolled back');
    }
    const applied = await this.prisma.importAppliedRecord.findMany({
      where: { importId, action: { in: ['created', 'updated'] } },
    });
    // Reverse created records (best-effort). Group by table for targeted deletes.
    const byTable = new Map<string, string[]>();
    const updated = applied.filter((a) => a.action === 'updated');
    for (const a of applied.filter((a) => a.action === 'created')) {
      if (!byTable.has(a.targetTable)) byTable.set(a.targetTable, []);
      byTable.get(a.targetTable)!.push(a.targetRecordId);
    }
    const tableToModel: Record<string, 'watchHistory' | 'userEpisodeStatus' | 'userMovieStatus' | 'watchlistItem' | 'favorite' | 'customList' | 'customListItem' | 'rating' | 'reaction' | 'comment'> = {
      watch_history: 'watchHistory',
      user_episode_status: 'userEpisodeStatus',
      user_movie_status: 'userMovieStatus',
      watchlist_items: 'watchlistItem',
      favorites: 'favorite',
      custom_lists: 'customList',
      custom_list_items: 'customListItem',
      ratings: 'rating',
      reactions: 'reaction',
      comments: 'comment',
    };
    // Delete children before parents (cascade-safe ordering); best-effort. Comments are
    // self-referential but imported ones have parentId=null, so their position is safe.
    const order = ['watch_history', 'comments', 'reactions', 'ratings', 'custom_list_items', 'user_episode_status', 'user_movie_status', 'watchlist_items', 'favorites', 'custom_lists'];
    for (const table of order) {
      const ids = byTable.get(table);
      const model = tableToModel[table];
      if (model && ids?.length) {
        await (this.prisma[model] as any).deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
      }
    }
    // Restore pre-existing data for records the import updated (action=updated).
    for (const a of updated) {
      if (a.targetTable === 'custom_lists' && a.previousData) {
        await this.prisma.customList
          .update({ where: { id: a.targetRecordId }, data: { title: (a.previousData as any).title, description: (a.previousData as any).description, visibility: (a.previousData as any).visibility } })
          .catch(() => undefined);
      }
      if (a.targetTable === 'ratings' && a.previousData) {
        await this.prisma.rating
          .update({ where: { id: a.targetRecordId }, data: { rating: (a.previousData as any).rating } })
          .catch(() => undefined);
      }
    }
    return this.prisma.import.update({
      where: { id: importId },
      data: { status: 'ROLLED_BACK', rolledBackAt: new Date() },
    });
  }

  async remove(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (imp.storageKey) await this.storage.delete(imp.storageKey).catch(() => undefined);
    await this.prisma.import.delete({ where: { id: importId } });
    return { ok: true };
  }

  /** After import, rebuild user_show_status for all affected shows (batched). */
  private async rebuildShowStatuses(userId: string, items: any[]) {
    const showIds = [...new Set(
      items
        .filter((it) => it.sourceEntityType === 'WATCHED_EPISODE' && it.matchedMediaId)
        .map((it) => it.matchedMediaId),
    )];
    if (!showIds.length) return;

    // Single query: watched count + last watched per show for this user
    const watchedStats = await this.prisma.$queryRaw<
      Array<{ mediaId: string; watchedCount: number; lastWatchedAt: Date | null }>
    >`
      SELECT sh.media_id AS "mediaId", COUNT(ues.id)::int AS "watchedCount", MAX(ues.watched_at) AS "lastWatchedAt"
      FROM user_episode_status ues
      JOIN episodes e ON ues.episode_id = e.id
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE ues.user_id = ${userId} AND ues.watched = true AND s.is_special = false
      GROUP BY sh.media_id
    `;

    // Single query: total episode count per show (excluding specials)
    const totalStats = await this.prisma.$queryRaw<
      Array<{ mediaId: string; totalCount: number }>
    >`
      SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "totalCount"
      FROM episodes e
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE s.is_special = false AND sh.media_id IN (${Prisma.join(showIds)})
      GROUP BY sh.media_id
    `;

    const watchedMap = new Map(watchedStats.map((r) => [r.mediaId, r]));
    const totalMap = new Map(totalStats.map((r) => [r.mediaId, r.totalCount]));

    // Build upsert rows for all shows that have stats
    const upsertTargets = new Set([...watchedMap.keys(), ...showIds]);
    for (const mediaId of upsertTargets) {
      const w = watchedMap.get(mediaId);
      const totalCount = totalMap.get(mediaId) ?? 0;
      const watchedCount = w?.watchedCount ?? 0;
      const lastWatchedAt = w?.lastWatchedAt ?? null;

      await this.prisma.userShowStatus.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: { userId, mediaId, watchedCount, totalCount, lastWatchedAt },
        update: { watchedCount, totalCount, lastWatchedAt },
      });
    }
  }
}
