import { Injectable, Logger } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaMetadataService } from './media-metadata.service';
import { HydrationQueue } from './hydration/hydration.queue';

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
  /** Items processed per cron run (rate-limited; hourly cron eventually covers everything). */
  private readonly batchSize = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly hydration: HydrationQueue,
  ) {}

  /** Counts of media needing attention — powers the admin "metadata health" view. */
  async getHealthStats() {
    const [total, neverHydrated, showsMissingEpisodes, moviesMissingOverview, tvdbOnly, stale, classification] =
      await Promise.all([
        this.prisma.mediaItem.count(),
        this.prisma.mediaItem.count({ where: { metadataRefreshedAt: null } }),
        this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          WHERE m.type='SHOW' AND NOT EXISTS (SELECT 1 FROM seasons s JOIN episodes e ON e.season_id=s.id WHERE s.show_id IN (SELECT id FROM shows WHERE media_id=m.id))`,
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
      showsMissingEpisodes: toNum(showsMissingEpisodes as any),
      moviesMissingOverview,
      tvdbOnly: toNum(tvdbOnly as any),
      stale,
      byClassification: Object.fromEntries(classification.map((c: { contentClassification: string; _count: { _all: number } }) => [c.contentClassification, c._count._all])),
    };
  }

  /** One batch: hydrate up to `batchSize` media that is GENUINELY incomplete (missing data).
   *  Complete media (has episodes + overview) is NEVER selected — no point re-hydrating it. */
  async backfillBatch(): Promise<{ processed: number; succeeded: number; failed: number; sample: string[] }> {
    const candidates = await this.prisma.mediaItem.findMany({
      where: {
        OR: [
          { metadataRefreshedAt: null }, // never hydrated (stub)
          { type: 'SHOW', show: { seasons: { none: {} } } }, // show with zero seasons
          { overview: null }, // missing overview (show or movie)
        ],
      },
      orderBy: { createdAt: 'asc' }, // oldest first
      take: this.batchSize,
      include: { externalIds: true },
    });

    let succeeded = 0;
    let failed = 0;
    const sample: string[] = [];
    for (const m of candidates) {
      try {
        await this.hydrateOne(m.id, m.externalIds as unknown as { provider: ExternalProvider; value: string }[], m.type);
        succeeded++;
        if (sample.length < 5) sample.push(m.title);
      } catch (e) {
        failed++;
        this.logger.debug(`backfill failed for ${m.title}: ${(e as Error).message}`);
      }
    }
    this.logger.log(`Metadata backfill batch: ${succeeded}/${candidates.length} succeeded, ${failed} failed`);
    return { processed: candidates.length, succeeded, failed, sample };
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
}
