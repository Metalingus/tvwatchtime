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

      await this.setStatus(importId, 'READY_FOR_REVIEW', {
        totalFiles: files.length,
        totalRows,
        matchedCount: matched,
        unmatchedCount: unmatched,
        duplicateCount: duplicates,
        conflictCount: 0,
        invalidCount: invalid,
        needsReviewCount: needsReview,
      });
    } catch (e) {
      this.logger.error(`Import ${importId} failed: ${(e as Error).message}`);
      await this.setStatus(importId, 'FAILED', { errorMessage: (e as Error).message?.slice(0, 1000) });
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
