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

  // ---------------- confirm + apply (batched) ----------------
  async confirm(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (imp.status !== 'READY_FOR_REVIEW') {
      throw new BadRequestException(`Import is not ready for review (status=${imp.status})`);
    }
    await this.prisma.import.update({ where: { id: importId }, data: { status: 'IMPORTING' } });

    const items = await this.prisma.importItem.findMany({
      where: {
        importId,
        status: 'MATCHED',
        OR: [{ userResolution: null }, { userResolution: { not: 'skip' } }],
      },
    });

    const { created, skipped } = await this.prisma.$transaction(async (tx) => {
      return this.applyBatch(tx, userId, importId, items);
    });

    await this.prisma.import.update({
      where: { id: importId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    await this.rebuildShowStatuses(userId, items);

    this.events.emit('import.applied', { userId });
    try {
      await this.storage.delete(imp.storageKey!);
    } catch {
      // best-effort cleanup
    }
    return { importId, created, skipped };
  }

  private async applyBatch(
    tx: any,
    userId: string,
    importId: string,
    items: any[],
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;
    const appliedItemIds: string[] = [];
    const auditRows: any[] = [];

    // Group items by entity type
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

    // Mark all valid items as APPLIED (invalid ones without mediaId are excluded)
    for (const it of items) {
      if (it.matchedMediaId) appliedItemIds.push(it.id);
    }

    // --- WATCHED EPISODES ---
    if (epItems.length) {
      const episodeIds = epItems.map((it) => it.matchedEpisodeId);

      const [episodeData, existingWatched] = await Promise.all([
        tx.episode.findMany({
          where: { id: { in: episodeIds } },
          select: { id: true, runtimeMinutes: true, season: { select: { number: true } } },
        }),
        tx.userEpisodeStatus.findMany({
          where: { userId, episodeId: { in: episodeIds }, watched: true },
          select: { episodeId: true },
        }),
      ]);

      const runtimeMap = new Map<string, any>(episodeData.map((e: any) => [e.id, e]));
      const watchedSet = new Set(existingWatched.map((e: any) => e.episodeId));

      const epStatusRows: any[] = [];
      const historyRows: any[] = [];

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
        created++;
      }

      for (let i = 0; i < epStatusRows.length; i += BATCH_CHUNK) {
        await tx.userEpisodeStatus.createMany({ data: epStatusRows.slice(i, i + BATCH_CHUNK), skipDuplicates: true });
      }
      for (let i = 0; i < historyRows.length; i += BATCH_CHUNK) {
        await tx.watchHistory.createMany({ data: historyRows.slice(i, i + BATCH_CHUNK) });
      }
    }

    // --- WATCHED MOVIES ---
    if (movieItems.length) {
      const movieMediaIds = movieItems.map((it) => it.matchedMediaId);

      const [movieData, existingWatchedMovies] = await Promise.all([
        tx.movie.findMany({
          where: { mediaId: { in: movieMediaIds } },
          select: { mediaId: true, runtimeMinutes: true },
        }),
        tx.userMovieStatus.findMany({
          where: { userId, mediaId: { in: movieMediaIds }, watched: true },
          select: { mediaId: true },
        }),
      ]);

      const runtimeMap = new Map(movieData.map((m: any) => [m.mediaId, m.runtimeMinutes]));
      const watchedMovieSet = new Set(existingWatchedMovies.map((m: any) => m.mediaId));

      const movieStatusRows: any[] = [];
      const movieHistoryRows: any[] = [];

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
        created++;
      }

      for (let i = 0; i < movieStatusRows.length; i += BATCH_CHUNK) {
        await tx.userMovieStatus.createMany({ data: movieStatusRows.slice(i, i + BATCH_CHUNK), skipDuplicates: true });
      }
      for (let i = 0; i < movieHistoryRows.length; i += BATCH_CHUNK) {
        await tx.watchHistory.createMany({ data: movieHistoryRows.slice(i, i + BATCH_CHUNK) });
      }
    }

    // --- WATCHLIST ---
    if (watchlistItems.length) {
      const mediaIds = [...new Set(watchlistItems.map((it) => it.matchedMediaId))];
      const existing = await tx.watchlistItem.findMany({
        where: { userId, mediaId: { in: mediaIds } },
        select: { mediaId: true },
      });
      const existingSet = new Set(existing.map((w: any) => w.mediaId));

      const rows: any[] = [];
      for (const it of watchlistItems) {
        const mediaId = it.matchedMediaId;
        if (existingSet.has(mediaId)) {
          skipped++;
          continue;
        }
        existingSet.add(mediaId); // prevent dups within the same batch
        const rowId = randomUUID();
        rows.push({ id: rowId, userId, mediaId });
        auditRows.push({ id: randomUUID(), importId, importItemId: it.id, targetTable: 'watchlist_items', targetRecordId: rowId, action: 'created' });
        created++;
      }

      for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
        await tx.watchlistItem.createMany({ data: rows.slice(i, i + BATCH_CHUNK), skipDuplicates: true });
      }
    }

    // --- FAVORITES ---
    if (favoriteItems.length) {
      const mediaIds = [...new Set(favoriteItems.map((it) => it.matchedMediaId))];
      const existing = await tx.favorite.findMany({
        where: { userId, mediaId: { in: mediaIds } },
        select: { mediaId: true },
      });
      const existingSet = new Set(existing.map((f: any) => f.mediaId));

      const rows: any[] = [];
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
        created++;
      }

      for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
        await tx.favorite.createMany({ data: rows.slice(i, i + BATCH_CHUNK), skipDuplicates: true });
      }
    }

    // --- Batch insert audit records ---
    for (let i = 0; i < auditRows.length; i += BATCH_CHUNK) {
      await tx.importAppliedRecord.createMany({ data: auditRows.slice(i, i + BATCH_CHUNK) });
    }

    // --- Batch update all items to APPLIED ---
    if (appliedItemIds.length) {
      await tx.importItem.updateMany({
        where: { id: { in: appliedItemIds } },
        data: { status: 'APPLIED' },
      });
    }

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
      where: { importId, action: 'created' },
    });
    // Reverse created records (best-effort). Group by table for targeted deletes.
    const byTable = new Map<string, string[]>();
    for (const a of applied) {
      if (!byTable.has(a.targetTable)) byTable.set(a.targetTable, []);
      byTable.get(a.targetTable)!.push(a.targetRecordId);
    }
    const tableToModel: Record<string, 'watchHistory' | 'userEpisodeStatus' | 'userMovieStatus' | 'watchlistItem' | 'favorite'> = {
      watch_history: 'watchHistory',
      user_episode_status: 'userEpisodeStatus',
      user_movie_status: 'userMovieStatus',
      watchlist_items: 'watchlistItem',
      favorites: 'favorite',
    };
    for (const [table, ids] of byTable) {
      const model = tableToModel[table];
      if (model) {
        await (this.prisma[model] as any).deleteMany({ where: { id: { in: ids } } });
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
