import { Injectable, Logger } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MediaMetadataService } from './media-metadata.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { TmdbClient } from './providers/tmdb.client';

/**
 * Metadata health stats + background backfill.
 *
 * Backfill hydrates incomplete media in small, rate-limited batches:
 *   - TMDB-first when a TMDB id exists; TVDB-only fallback when it doesn't.
 *   - After hydration it enqueues classification, which applies the anime priority
 *     Kitsu > Jikan/MyAnimeList > TVDB > TMDB (field-by-field) via the enrichment worker.
 *   - Each item is best-effort (one failure never aborts the batch) and the global
 *     provider rate limiter bounds TVDB/TMDB/Kitsu/Jikan load.
 */
@Injectable()
export class MetadataBackfillService {
  private readonly logger = new Logger(MetadataBackfillService.name);
  /** Items processed per cron run (default). Override per-call with backfillBatch(count). */
  private readonly defaultBatchSize = 1000;
  /** Prevents concurrent batches from picking the same items. */
  private backfillRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly hydration: HydrationQueue,
    private readonly redis: RedisService,
    private readonly tmdb: TmdbClient,
  ) {}

  /** Counts of media needing attention — powers the admin "metadata health" view. */
  async getHealthStats() {
    // Optimized queries: avoid NOT EXISTS on episodes (573k rows); check at the season level.
    const [total, neverHydrated, showsNoSeasons, moviesMissingOverview, tvdbOnly, stale, classification] =
      await Promise.all([
        this.prisma.mediaItem.count(),
        this.prisma.mediaItem.count({ where: { metadataRefreshedAt: null } }),
        this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE m.type='SHOW' AND NOT EXISTS (SELECT 1 FROM seasons s WHERE s.show_id = sh.id)`,
        this.prisma.mediaItem.count({ where: { type: 'MOVIE', overview: null } }),
        this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          WHERE EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=m.id AND e.provider='THE_TVDB')
            AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=m.id AND e.provider='TMDB')`,
        this.prisma.mediaItem.count({
          where: { metadataRefreshedAt: { lt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) } },
        }),
        this.prisma.mediaItem.groupBy({
          by: ['contentClassification'],
          _count: { _all: true },
        }),
      ]);
    const toNum = (r: { c: bigint }[] | undefined) => Number(r?.[0]?.c ?? 0);
    return {
      total,
      neverHydrated,
      showsMissingEpisodes: toNum(showsNoSeasons as any),
      moviesMissingOverview,
      tvdbOnly: toNum(tvdbOnly as any),
      stale,
      byClassification: Object.fromEntries(
        classification.map((c: { contentClassification: string; _count: { _all: number } }) => [
          c.contentClassification,
          c._count._all,
        ]),
      ),
    };
  }

  /** One batch: hydrate up to `count` media that is GENUINELY incomplete (missing data).
   *  Complete media (has episodes + overview) is NEVER selected — no point re-hydrating it. */
  async backfillBatch(count?: number, maxRps?: number): Promise<{ processed: number; succeeded: number; failed: number; sample: string[] }> {
    if (this.backfillRunning) {
      this.logger.log('Backfill already running — skipping');
      return { processed: 0, succeeded: 0, failed: 0, sample: [] };
    }
    this.backfillRunning = true;
    const limit = Math.max(1, Math.min(count ?? this.defaultBatchSize, 100000));
    const delayMs = maxRps && maxRps > 0 ? Math.round(60000 / maxRps) : 0;
    if (delayMs > 0) this.logger.log(`Backfill throttled to ~${maxRps} items/min (${delayMs}ms delay between items)`);
    try {
    const candidates = await this.prisma.mediaItem.findMany({
      where: {
        OR: [
          { metadataRefreshedAt: null }, // never hydrated (stub)
          { type: 'SHOW', show: { seasons: { none: {} } } }, // show with zero seasons
          { overview: null }, // missing overview (show or movie)
        ],
      },
      orderBy: { createdAt: 'asc' }, // oldest first
      take: limit,
      include: { externalIds: true },
    });

    let succeeded = 0;
    let failed = 0;
    const sample: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i];
      try {
        await this.hydrateOne(m.id, m.externalIds as unknown as { provider: ExternalProvider; value: string }[], m.type);
        succeeded++;
        if (sample.length < 5) sample.push(m.title);
      } catch (e) {
        failed++;
        this.logger.debug(`backfill failed for ${m.title}: ${(e as Error).message}`);
      }
      // Progress log every 50 items so the admin can see it's working.
      if ((i + 1) % 50 === 0) {
        this.logger.log(`Backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`);
      }
      // Throttle: wait between items so normal user requests aren't starved.
      if (delayMs > 0 && i < candidates.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    this.logger.log(`Metadata backfill batch: ${succeeded}/${candidates.length} succeeded, ${failed} failed`);
    return { processed: candidates.length, succeeded, failed, sample };
    } finally {
      this.backfillRunning = false;
    }
  }

  /**
   * Hydrate a single media item by its best available provider, then enqueue anime classification.
   *
   * CRITICAL: if the media ALREADY has episodes/structure AND has a TVDB id, it was hydrated
   * from TVDB — re-hydrate from TVDB (NEVER switch to TMDB). This preserves the existing
   * season/episode structure that the user's watch history is built on. TMDB is only used for:
   *   - media with no existing structure (never-hydrated stubs)
   *   - media with no TVDB id (TMDB is the only source)
   */
  private async hydrateOne(mediaId: string, externals: { provider: ExternalProvider; value: string }[], type: string) {
    const tmdb = externals.find((e) => e.provider === ExternalProvider.TMDB);
    const tvdb = externals.find((e) => e.provider === ExternalProvider.THE_TVDB);
    const isShow = type === 'SHOW';

    // Detect existing structure: shows with ≥1 episode, movies with overview.
    const hasStructure = isShow
      ? (await this.prisma.episode.count({ where: { season: { show: { mediaId } } }, take: 1 })) > 0
      : (await this.prisma.mediaItem.count({ where: { id: mediaId, type: 'MOVIE', overview: { not: null } } })) > 0;

    if (hasStructure && tvdb) {
      // Already has TVDB-sourced structure → keep TVDB. NEVER override with TMDB.
      if (isShow) await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
      else await this.meta.ensureMovieFullTvdb(Number(tvdb.value)).catch(() => undefined);
    } else if (tmdb) {
      // No existing structure (stub), or no TVDB id → TMDB primary.
      if (isShow) await this.meta.ensureShowFull(Number(tmdb.value));
      else await this.meta.ensureMovieFull(Number(tmdb.value));
    } else if (tvdb) {
      // TVDB-only fallback.
      if (isShow) await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
      else await this.meta.ensureMovieFullTvdb(Number(tvdb.value)).catch(() => undefined);
    } else {
      return; // no provider id to hydrate from
    }
    // Enqueue classification — the worker applies anime priority Kitsu > Jikan > TVDB > TMDB.
    await this.meta.scheduleClassification(mediaId).catch(() => undefined);
  }

  // ---- TMDB Changes sync (daily cron) ----

  /**
   * Call TMDB's /tv/changes and /movie/changes to detect media whose TMDB data changed
   * since the last run. For each changed ID that exists in our DB: clear the TMDB provider
   * cache, then ACTUALLY re-hydrate (ensureShowFull/ensureMovieFull) so the data is updated
   * immediately — not just marked stale.
   *
   * First run goes back 14 days; subsequent runs use the date stored in Redis.
   * Fully paginated (no arbitrary cap).
   */
  async syncTmdbChanges(): Promise<{ tvChanged: number; movieChanged: number; matched: number; hydrated: number; failed: number }> {
    if (!this.tmdb.enabled) {
      this.logger.warn('TMDB not configured — skipping changes sync');
      return { tvChanged: 0, movieChanged: 0, matched: 0, hydrated: 0, failed: 0 };
    }

    // Start date: since last sync (Redis), or 14 days ago on first run.
    const lastRunStr = await this.redis.get<string>('TMDB_CHANGES_LAST_RUN');
    const startDate = lastRunStr ? new Date(lastRunStr) : new Date(Date.now() - 1000 * 60 * 60 * 24 * 14);
    const endDate = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    this.logger.log(`TMDB changes sync: ${fmt(startDate)} → ${fmt(endDate)}`);

    // Fetch ALL changed IDs from TMDB (fully paginated).
    const tvIds = await this.fetchChangedIds('tv', fmt(startDate), fmt(endDate));
    const movieIds = await this.fetchChangedIds('movie', fmt(startDate), fmt(endDate));
    const allIds = [...tvIds, ...movieIds];
    this.logger.log(`TMDB changes: ${tvIds.length} TV + ${movieIds.length} movie = ${allIds.length} total changed IDs`);

    // Store the end date so the next run starts from here.
    await this.redis.set('TMDB_CHANGES_LAST_RUN', endDate.toISOString(), 86400 * 30);

    if (allIds.length === 0) return { tvChanged: 0, movieChanged: 0, matched: 0, hydrated: 0, failed: 0 };

    // Match against our DB in chunks (PostgreSQL has a 32767 bind-variable limit).
    const matched: { mediaId: string; value: string; media: { type: string; externalIds: any[] } }[] = [];
    const CHUNK = 5000;
    for (let i = 0; i < allIds.length; i += CHUNK) {
      const chunk = allIds.slice(i, i + CHUNK).map(String);
      const rows = await this.prisma.externalId.findMany({
        where: { provider: ExternalProvider.TMDB, value: { in: chunk } },
        select: { mediaId: true, value: true, media: { select: { type: true, externalIds: true } } },
      });
      matched.push(...(rows as any[]));
    }
    this.logger.log(`TMDB changes: ${matched.length} changed IDs match media in our DB`);

    // Clear ALL TMDB caches in ONE bulk scan (much faster than per-item KEYS).
    // The caches re-populate on next access; this ensures re-hydration gets fresh TMDB data.
    await this.bulkClearTmdbCache();

    // Actually re-hydrate each matched media from TMDB (rate-limited by the gateway).
    let hydrated = 0;
    let failed = 0;
    for (let i = 0; i < matched.length; i++) {
      const m = matched[i];
      try {
        if (m.media.type === 'SHOW') {
          await this.meta.ensureShowFull(Number(m.value));
        } else {
          await this.meta.ensureMovieFull(Number(m.value));
        }
        await this.meta.scheduleClassification(m.mediaId).catch(() => undefined);
        hydrated++;
      } catch (e) {
        failed++;
        this.logger.debug(`TMDB changes re-hydration failed for ${m.value}: ${(e as Error).message}`);
      }
      // Progress log every 500 items so the admin can see it's working.
      if ((i + 1) % 500 === 0) {
        this.logger.log(`TMDB changes sync progress: ${i + 1}/${matched.length} processed (${hydrated} ok, ${failed} fail)`);
      }
    }

    this.logger.log(`TMDB changes sync complete: ${hydrated} re-hydrated, ${failed} failed`);
    return { tvChanged: tvIds.length, movieChanged: movieIds.length, matched: matched.length, hydrated, failed };
  }

  /** Bulk-clear all cached TMDB responses (one SCAN pass, non-blocking). */
  private async bulkClearTmdbCache(): Promise<void> {
    try {
      const c = this.redis.client as unknown as {
        scan: (cursor: number, opts: any) => Promise<[string, string[]]>;
        del: (...keys: string[]) => Promise<number>;
      };
      let cursor = 0;
      let cleared = 0;
      do {
        const [next, keys] = await c.scan(cursor, { MATCH: 'PC:tmdb:*', COUNT: 500 });
        if (keys.length > 0) {
          await c.del(...keys);
          cleared += keys.length;
        }
        cursor = Number(next);
      } while (cursor !== 0);
      this.logger.log(`Bulk-cleared ${cleared} TMDB cache entries`);
    } catch (e) {
      this.logger.debug(`TMDB bulk cache clear failed (non-fatal): ${(e as Error).message}`);
    }
  }

  /** Fetch ALL changed TMDB IDs for a media type (fully paginated, no arbitrary cap). */
  private async fetchChangedIds(type: 'tv' | 'movie', startDate: string, endDate: string): Promise<number[]> {
    const ids: number[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      try {
        const res = await this.tmdb.get<any>(`/${type}/changes`, { start_date: startDate, end_date: endDate, page });
        const results = Array.isArray(res?.results) ? res.results : [];
        if (results.length === 0) break;
        ids.push(...results.map((r: any) => Number(r.id)).filter(Number.isFinite));
        totalPages = res?.total_pages ?? 1;
        page++;
      } catch (e) {
        this.logger.debug(`TMDB changes fetch failed (page ${page}, ${type}): ${(e as Error).message}`);
        break;
      }
    }
    return ids;
  }

}
