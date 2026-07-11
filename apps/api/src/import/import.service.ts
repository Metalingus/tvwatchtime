import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { IMPORT_LIMITS } from './lib/limits';
import { ImportStorage } from './lib/storage';
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

    const dailyLimit = this.config.get<number>('imports.dailyLimit') ?? IMPORT_LIMITS.DAILY_IMPORTS_PER_USER;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayCount = await this.prisma.import.count({
      where: { userId, createdAt: { gte: since } },
    });
    if (todayCount >= dailyLimit) {
      throw new BadRequestException(`Daily import limit (${dailyLimit}) reached`);
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
    return this.prisma.importItem.update({ where: { id: itemId }, data });
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
    const tableToModel: Record<string, 'watchHistory' | 'userEpisodeStatus' | 'userMovieStatus' | 'watchlistItem' | 'favorite' | 'customList' | 'customListItem'> = {
      watch_history: 'watchHistory',
      user_episode_status: 'userEpisodeStatus',
      user_movie_status: 'userMovieStatus',
      watchlist_items: 'watchlistItem',
      favorites: 'favorite',
      custom_lists: 'customList',
      custom_list_items: 'customListItem',
    };
    // Delete items before their parent list (cascade-safe ordering); best-effort.
    const order = ['watch_history', 'custom_list_items', 'user_episode_status', 'user_movie_status', 'watchlist_items', 'favorites', 'custom_lists'];
    for (const table of order) {
      const ids = byTable.get(table);
      const model = tableToModel[table];
      if (model && ids?.length) {
        await (this.prisma[model] as any).deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
      }
    }
    // Restore metadata for lists that existed before this import (action=updated).
    for (const a of updated) {
      if (a.targetTable === 'custom_lists' && a.previousData) {
        await this.prisma.customList
          .update({ where: { id: a.targetRecordId }, data: { title: (a.previousData as any).title, description: (a.previousData as any).description, visibility: (a.previousData as any).visibility } })
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
