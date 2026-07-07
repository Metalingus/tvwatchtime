import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { IMPORT_LIMITS } from './lib/limits';
import { ImportStorage } from './lib/storage';
import { ImportProcessor } from './import.processor';
import { InvalidUploadError } from './errors';

const EXT_TO_SOURCE: Record<string, 'zip' | 'csv' | 'json'> = {
  zip: 'zip',
  csv: 'csv',
  json: 'json',
};

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
    if (opts.entity) where.sourceEntityType = opts.entity.toUpperCase();
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

  // ---------------- confirm + apply ----------------
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
        OR: [
          { userResolution: null },
          { userResolution: { not: 'skip' } },
        ],
      },
    });

    let created = 0;
    let skipped = 0;
    for (const it of items) {
      const res = await this.applyItem(userId, importId, it);
      if (res) created++;
      else skipped++;
      await this.prisma.importItem.update({ where: { id: it.id }, data: { status: 'APPLIED' } });
    }

    await this.prisma.import.update({
      where: { id: importId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    // Rebuild user_show_status for all affected shows (import doesn't use TrackingService which normally does this)
    await this.rebuildShowStatuses(userId, items);

    // refresh stats / badges
    this.events.emit('import.applied', { userId });
    try {
      await this.storage.delete(imp.storageKey!);
    } catch {
      // best-effort cleanup
    }
    return { importId, created, skipped };
  }

  private async applyItem(userId: string, importId: string, it: any): Promise<boolean> {
    const mediaId = it.matchedMediaId;
    const log = (targetTable: string, targetRecordId: string, action: 'created' | 'skipped') =>
      this.prisma.importAppliedRecord.create({
        data: { importId, importItemId: it.id, targetTable, targetRecordId, action },
      });

    if (it.sourceEntityType === 'WATCHED_EPISODE') {
      const episodeId = it.matchedEpisodeId;
      if (!mediaId || !episodeId) return false;
      const existing = await this.prisma.userEpisodeStatus.findUnique({
        where: { userId_episodeId: { userId, episodeId } },
      });
      if (existing?.watched) {
        await log('user_episode_status', existing.id, 'skipped');
        return false;
      }
      const norm: any = it.normalizedData ?? {};
      // Fetch the episode's runtime for accurate stats
      const episodeData = await this.prisma.episode.findUnique({ where: { id: episodeId }, select: { runtimeMinutes: true, season: { select: { number: true } } } });
      const status = await this.prisma.userEpisodeStatus.upsert({
        where: { userId_episodeId: { userId, episodeId } },
        create: { userId, episodeId, watched: true, watchedAt: norm.watchedAt ? new Date(norm.watchedAt) : new Date() },
        update: { watched: true, watchedAt: norm.watchedAt ? new Date(norm.watchedAt) : new Date() },
      });
      await this.prisma.watchHistory.create({
        data: {
          userId,
          mediaId,
          mediaType: MediaType.SHOW,
          episodeId,
          seasonNumber: episodeData?.season?.number ?? norm.season ?? null,
          episodeNumber: norm.episode ?? null,
          runtimeMinutes: episodeData?.runtimeMinutes ?? null,
          watchedAt: norm.watchedAt ? new Date(norm.watchedAt) : new Date(),
        },
      });
      await log('user_episode_status', status.id, 'created');
      return true;
    }

    if (it.sourceEntityType === 'WATCHED_MOVIE') {
      if (!mediaId) return false;
      const existing = await this.prisma.userMovieStatus.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
      });
      if (existing?.watched) {
        await log('user_movie_status', existing.id, 'skipped');
        return false;
      }
      const norm: any = it.normalizedData ?? {};
      // Fetch movie runtime for accurate stats
      const movieData = await this.prisma.movie.findUnique({ where: { mediaId }, select: { runtimeMinutes: true } });
      const status = await this.prisma.userMovieStatus.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: { userId, mediaId, watched: true, watchedAt: norm.watchedAt ? new Date(norm.watchedAt) : new Date() },
        update: { watched: true, watchedAt: norm.watchedAt ? new Date(norm.watchedAt) : new Date() },
      });
      await this.prisma.watchHistory.create({
        data: {
          userId,
          mediaId,
          mediaType: MediaType.MOVIE,
          runtimeMinutes: movieData?.runtimeMinutes ?? null,
          watchedAt: norm.watchedAt ? new Date(norm.watchedAt) : new Date(),
        },
      });
      await log('user_movie_status', status.id, 'created');
      return true;
    }

    if (it.sourceEntityType === 'WATCHLIST_SHOW' || it.sourceEntityType === 'WATCHLIST_MOVIE') {
      if (!mediaId) return false;
      const exists = await this.prisma.watchlistItem.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
      });
      if (exists) {
        await log('watchlist_items', exists.id, 'skipped');
        return false;
      }
      const created = await this.prisma.watchlistItem.create({ data: { userId, mediaId } });
      await log('watchlist_items', created.id, 'created');
      return true;
    }

    if (it.sourceEntityType === 'FAVORITE_SHOW' || it.sourceEntityType === 'FAVORITE_MOVIE') {
      if (!mediaId) return false;
      const exists = await this.prisma.favorite.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
      });
      if (exists) {
        await log('favorites', exists.id, 'skipped');
        return false;
      }
      const created = await this.prisma.favorite.create({ data: { userId, mediaId } });
      await log('favorites', created.id, 'created');
      return true;
    }

    return false;
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

  /** After import, rebuild user_show_status so watch-next, progress, and My Shows work. */
  private async rebuildShowStatuses(userId: string, items: any[]) {
    // Collect distinct show mediaIds from WATCHED_EPISODE items
    const showIds = new Set<string>();
    for (const it of items) {
      if (it.sourceEntityType === 'WATCHED_EPISODE' && it.matchedMediaId) {
        showIds.add(it.matchedMediaId);
      }
    }

    for (const mediaId of showIds) {
      const watchedCount = await this.prisma.userEpisodeStatus.count({
        where: { userId, watched: true, episode: { season: { show: { mediaId }, isSpecial: false } } },
      });
      const totalCount = await this.prisma.episode.count({
        where: { season: { show: { mediaId }, isSpecial: false } },
      });
      const lastWatched = await this.prisma.userEpisodeStatus.findFirst({
        where: { userId, watched: true, episode: { season: { show: { mediaId }, isSpecial: false } } },
        orderBy: { watchedAt: 'desc' },
        select: { watchedAt: true },
      });

      await this.prisma.userShowStatus.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: { userId, mediaId, watchedCount, totalCount, lastWatchedAt: lastWatched?.watchedAt ?? null },
        update: { watchedCount, totalCount, lastWatchedAt: lastWatched?.watchedAt ?? null },
      });
    }
  }
}
