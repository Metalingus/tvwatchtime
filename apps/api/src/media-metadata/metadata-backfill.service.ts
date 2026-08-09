import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  MediaCanonicalRelation,
  MediaCanonicalStatus,
  Prisma,
  StructureProvider,
  StructureReason,
} from '@prisma/client';
import { ExternalProvider, MediaType, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MediaMetadataService } from './media-metadata.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { TmdbClient } from './providers/tmdb.client';
import { RecommendationItem, TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { isProviderError } from './providers/shared/provider-errors';
import { ProviderThrottled } from './providers/shared/provider-http';
import { RemapStats, StructureRemapService } from './structure-remap.service';
import { CastDedupService } from './cast-dedup.service';
import { slugify } from './util/slugify';
import { EN_CONTENT_VERIFIER_VERSION } from './util/en-content-verifier';
import { STRUCTURE_RULE_VERSION } from './structure-authority.service';
import {
  mergeCanonicalRecommendations,
  recommendationItems,
} from './util/canonical-recommendations';

const EN_CONTENT_DEEP_CURSOR_KEY = 'EN_CONTENT_DEEP_CURSOR';
const REPAIR_STALL_MS = 30 * 60 * 1000;
const HEALTH_CACHE_FRESH_TTL_SECONDS = 60;
const HEALTH_CACHE_SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
const HEALTH_REFRESH_LOCK_TTL_MS = 10 * 60 * 1000;
const VISIBLE_MEDIA_WHERE = {
  canonicalSource: { is: null },
} satisfies Prisma.MediaItemWhereInput;
const VISIBLE_MEDIA_SQL = Prisma.sql`
  NOT EXISTS (
    SELECT 1
    FROM media_canonical_links canonical_link
    WHERE canonical_link.source_media_id = m.id
      AND canonical_link.status::text = 'ACTIVE'
  )
`;
const VISIBLE_MEDIA_MI_SQL = Prisma.sql`
  NOT EXISTS (
    SELECT 1
    FROM media_canonical_links canonical_link
    WHERE canonical_link.source_media_id = mi.id
      AND canonical_link.status::text = 'ACTIVE'
  )
`;

type HealthSnapshot = {
  computedAt: string;
  stats: Record<string, unknown>;
};

type LocalHealthSnapshot = HealthSnapshot & {
  freshUntil: number;
  expiresAt: number;
};

/**
 * Metadata health stats + background backfill.
 *
 * Backfill hydrates incomplete media in small, rate-limited batches:
 *   - TMDB-first when a TMDB id exists; TVDB-only fallback when it doesn't.
 *   - After hydration it enqueues strict TMDB classification plus optional
 *     Kitsu/Jikan enrichment. Enrichment cannot select structural ownership.
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
  /** Start time of the in-flight anime→TVDB batch (null = idle). A guard older
   *  than 3h means the run's promise HUNG and never settled — auto-released. */
  private animeFixStartedAt: number | null = null;
  private providerDuplicateRepairRunning = false;

  // ---- Live repair progress (admin Metadata Health page) ----
  private readonly repairProgress = new Map<
    string,
    {
      running: boolean;
      processed: number;
      total: number;
      succeeded: number;
      failed: number;
      remapped?: number;
      legacyQuarantined?: number;
      episodesRemoved?: number;
      transferred?: number;
      current?: string;
      finishedAt?: Date;
      updatedAt?: Date;
    }
  >();

  private trackRepair(
    job: string,
    patch: Partial<{
      running: boolean;
      processed: number;
      total: number;
      succeeded: number;
      failed: number;
      remapped: number;
      legacyQuarantined: number;
      episodesRemoved: number;
      transferred: number;
      current: string;
      finishedAt: Date | null;
    }>,
  ) {
    const prev = this.repairProgress.get(job) ?? {
      running: false,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
    };
    this.repairProgress.set(job, {
      ...prev,
      ...patch,
      ...(patch.finishedAt === null ? { finishedAt: undefined } : {}),
      updatedAt: new Date(),
    } as any);
  }

  /** Live progress snapshot for every repair job (running or recently finished). */
  getRepairProgress() {
    const now = Date.now();
    const out: Record<string, any> = {};
    for (const [job, p] of this.repairProgress) {
      // A "running" job with no progress update for 30+ min is a HUNG promise
      // (its run never resolved — no cron history row is ever written for those).
      // Report it as stalled so the admin panel doesn't show a phantom run forever.
      const stalled = p.running && p.updatedAt && now - p.updatedAt.getTime() > REPAIR_STALL_MS;
      // A stalled run stays reported for 24h (admin should notice it), then drops.
      const stalledVisible =
        stalled && p.updatedAt && now - p.updatedAt.getTime() < 24 * 60 * 60 * 1000;
      const shown = stalled ? { ...p, running: false, stalled: true } : p;
      // Recently-finished jobs stay visible for 60s so the UI shows the completion.
      if (
        shown.running ||
        stalledVisible ||
        (!stalled && (!p.finishedAt || now - p.finishedAt.getTime() < 60_000))
      )
        out[job] = shown;
    }
    return out;
  }
  /** Prevents concurrent type-mismatch repair batches. */
  private typeRepairRunning = false;
  /** Prevents concurrent cast character-id backfills. */
  private charIdFixRunning = false;
  /** Prevents concurrent cast-dedup batches. */
  private castDedupRunning = false;
  /** In-flight per-show repairs — concurrent callers (detail + episodes requests arriving
   *  together, or a view racing the cron) share ONE repair instead of double-hydrating. */
  private readonly animeFixInflight = new Map<
    string,
    Promise<{ fixed: boolean; remapped: number; report?: RemapStats }>
  >();
  /** Whole-catalog health scans never run twice in one API process. Redis also guards
   *  the same refresh across API/worker instances. */
  private readonly healthStatsInflight = new Map<string, Promise<void>>();
  /** Redis is preferred, but a disconnected cache must not leave the Admin page polling
   *  forever after this process successfully computed a snapshot. */
  private readonly localHealthSnapshots = new Map<string, LocalHealthSnapshot>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly hydration: HydrationQueue,
    private readonly redis: RedisService,
    private readonly tmdb: TmdbClient,
    private readonly tvdb: TvdbProvider,
    private readonly tmdbProvider: TmdbProvider,
    private readonly structureRemap: StructureRemapService,
    private readonly castDedup: CastDedupService,
  ) {}

  private getEnglishContentHealthStats(deepCursor: string, includeDeep: boolean) {
    type EnglishContentHealthRow = {
      nonEnglishContent: bigint;
      nonEnglishContentParked: bigint;
      totalEligible: bigint;
      unverified: bigint;
      remainingInPass: bigint;
      cursorPosition: bigint;
    };

    if (!includeDeep) {
      return this.prisma.$queryRaw<EnglishContentHealthRow[]>`
        WITH external_media AS (
          SELECT DISTINCT media_id FROM external_ids
        ),
        health AS (
          SELECT m.id,
                 x.media_id IS NOT NULL AS has_external,
                 (m.metadata_provenance->>'enContentRepairFailedAt' IS NOT NULL
                  AND (m.metadata_provenance->>'enContentRepairFailedAt')::timestamptz >= NOW() - INTERVAL '24 hours') AS parked,
                 (
                   COALESCE(NULLIF(m.titles->>'en',''), m.title) ~ '[^ -~]'
                   OR COALESCE(NULLIF(m.overviews->>'en',''), m.overview, '') ~ '[^ -~]'
                 ) AS is_suspect,
                 (
                   COALESCE(NULLIF(m.titles->>'en',''), m.title)
                         IS DISTINCT FROM m.metadata_provenance->>'enContentVerifiedTitle'
                   OR COALESCE(NULLIF(m.overviews->>'en',''), m.overview, '')
                         IS DISTINCT FROM COALESCE(m.metadata_provenance->>'enContentVerifiedOverview', '')
                   OR COALESCE(
                        CASE WHEN (m.metadata_provenance->>'enContentVerifiedVersion') ~ '^\\d+$'
                             THEN (m.metadata_provenance->>'enContentVerifiedVersion')::int
                             ELSE 0 END,
                        0) < ${EN_CONTENT_VERIFIER_VERSION}
                 ) AS needs_verification
          FROM media_items m
          LEFT JOIN external_media x ON x.media_id = m.id
          WHERE ${VISIBLE_MEDIA_SQL}
        )
        SELECT count(*) FILTER (WHERE has_external AND is_suspect AND NOT parked AND needs_verification)::bigint AS "nonEnglishContent",
               count(*) FILTER (WHERE parked)::bigint AS "nonEnglishContentParked",
               0::bigint AS "totalEligible",
               0::bigint AS "unverified",
               0::bigint AS "remainingInPass",
               0::bigint AS "cursorPosition"
        FROM health`;
    }

    // Deep stats are exact but intentionally opt-in: they must know whether each show's
    // current episode fingerprint differs from the verified one, so they scan episode text.
    return this.prisma.$queryRaw<EnglishContentHealthRow[]>`
      WITH external_media AS (
        SELECT DISTINCT media_id FROM external_ids
      ),
      episode_en AS (
        SELECT sh.media_id,
               count(e.id)::text || ':' || md5(COALESCE(string_agg(
                 e.id || ':' || COALESCE(NULLIF(e.titles->>'en',''), e.title) || ':' || COALESCE(NULLIF(e.overviews->>'en',''), e.overview, ''),
                 '|' ORDER BY e.id), '')) AS fingerprint,
               bool_or(
                 length(regexp_replace(COALESCE(NULLIF(e.titles->>'en',''), e.title), '[[:space:] -~‘’“”„‟‚‛‹›«»‐‑‒–—―…·•°©®™]', '', 'g')) >= 3
                 OR length(regexp_replace(COALESCE(NULLIF(e.overviews->>'en',''), e.overview, ''), '[[:space:] -~‘’“”„‟‚‛‹›«»‐‑‒–—―…·•°©®™]', '', 'g')) >= 3
               ) AS has_suspect
        FROM shows sh
        JOIN seasons s ON s.show_id = sh.id
        JOIN episodes e ON e.season_id = s.id
        GROUP BY sh.media_id
      ),
      health AS (
        SELECT m.id,
               x.media_id IS NOT NULL AS has_external,
               (m.metadata_provenance->>'enContentRepairFailedAt' IS NOT NULL
                AND (m.metadata_provenance->>'enContentRepairFailedAt')::timestamptz >= NOW() - INTERVAL '24 hours') AS parked,
               (
                 COALESCE(NULLIF(m.titles->>'en',''), m.title) ~ '[^ -~]'
                 OR COALESCE(NULLIF(m.overviews->>'en',''), m.overview, '') ~ '[^ -~]'
                 OR COALESCE(ep.has_suspect, false)
               ) AS is_suspect,
               (
                 COALESCE(NULLIF(m.titles->>'en',''), m.title)
                       IS DISTINCT FROM m.metadata_provenance->>'enContentVerifiedTitle'
                 OR COALESCE(NULLIF(m.overviews->>'en',''), m.overview, '')
                       IS DISTINCT FROM COALESCE(m.metadata_provenance->>'enContentVerifiedOverview', '')
                 OR COALESCE(
                      CASE WHEN (m.metadata_provenance->>'enContentVerifiedVersion') ~ '^\\d+$'
                           THEN (m.metadata_provenance->>'enContentVerifiedVersion')::int
                           ELSE 0 END,
                      0) < ${EN_CONTENT_VERIFIER_VERSION}
                 OR (
                   m.type = 'SHOW'
                   AND ep.media_id IS NOT NULL
                   AND COALESCE(m.metadata_provenance->>'enContentVerifiedEpisodeFingerprint', '')
                         IS DISTINCT FROM COALESCE(ep.fingerprint, '')
                 )
               ) AS needs_verification
        FROM media_items m
        LEFT JOIN external_media x ON x.media_id = m.id
        LEFT JOIN episode_en ep ON ep.media_id = m.id
        WHERE ${VISIBLE_MEDIA_SQL}
      )
      SELECT count(*) FILTER (WHERE has_external AND is_suspect AND NOT parked AND needs_verification)::bigint AS "nonEnglishContent",
             count(*) FILTER (WHERE parked)::bigint AS "nonEnglishContentParked",
             count(*) FILTER (WHERE has_external)::bigint AS "totalEligible",
             count(*) FILTER (WHERE has_external AND NOT parked AND needs_verification)::bigint AS "unverified",
             count(*) FILTER (WHERE (${deepCursor} = '' OR id > ${deepCursor}) AND has_external AND NOT parked AND needs_verification)::bigint AS "remainingInPass",
             count(*) FILTER (WHERE ${deepCursor} != '' AND id <= ${deepCursor} AND has_external)::bigint AS "cursorPosition"
      FROM health`;
  }

  private async readHealthCache<T>(key: string): Promise<T | null> {
    if (typeof this.redis.get !== 'function') return null;
    const cached = await this.redis.get<unknown>(key).catch(() => null);
    if (cached === null || cached === undefined) return null;
    // Compatibility with the old cache writer, which explicitly JSON-stringified before
    // RedisService stringified it a second time.
    if (typeof cached === 'string') {
      try {
        return JSON.parse(cached) as T;
      } catch {
        return null;
      }
    }
    return cached as T;
  }

  private async computeAndCacheHealthStats(
    cacheKey: string,
    includeContentStats: boolean,
    includeDeepContentStats: boolean,
  ) {
    const stats = await this.computeHealthStats(includeContentStats, includeDeepContentStats);
    const computedAt = new Date().toISOString();
    this.localHealthSnapshots.set(cacheKey, {
      computedAt,
      stats,
      freshUntil: Date.now() + HEALTH_CACHE_FRESH_TTL_SECONDS * 1000,
      expiresAt: Date.now() + HEALTH_CACHE_SNAPSHOT_TTL_SECONDS * 1000,
    });
    if (typeof this.redis.set === 'function') {
      const snapshot: HealthSnapshot = { computedAt, stats };
      await Promise.all([
        this.redis.set(cacheKey, stats, HEALTH_CACHE_FRESH_TTL_SECONDS).catch(() => undefined),
        this.redis
          .set(`${cacheKey}:snapshot`, snapshot, HEALTH_CACHE_SNAPSHOT_TTL_SECONDS)
          .catch(() => undefined),
      ]);
    }
    return stats;
  }

  private startHealthStatsRefresh(
    cacheKey: string,
    includeContentStats: boolean,
    includeDeepContentStats: boolean,
  ) {
    if (this.healthStatsInflight.has(cacheKey)) return;

    const refresh = (async () => {
      const client = (this.redis as any)?.client;
      const lockKey = `LOCK:${cacheKey}:refresh`;
      const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const release = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
      let ownsDistributedLock = false;
      if (client?.set) {
        try {
          const acquired = await client.set(lockKey, token, 'PX', HEALTH_REFRESH_LOCK_TTL_MS, 'NX');
          if (acquired !== 'OK') return;
          ownsDistributedLock = true;
        } catch {
          // Redis degraded: the local in-flight map still prevents duplicate work in this
          // process, and the local snapshot below keeps this instance usable.
        }
      }

      try {
        await this.computeAndCacheHealthStats(
          cacheKey,
          includeContentStats,
          includeDeepContentStats,
        );
      } finally {
        if (ownsDistributedLock && client?.eval) {
          await client.eval(release, 1, lockKey, token).catch(() => undefined);
        }
      }
    })()
      .catch((error) => {
        this.logger.error(`Metadata health refresh failed: ${(error as Error).message}`);
      })
      .finally(() => {
        this.healthStatsInflight.delete(cacheKey);
      });

    this.healthStatsInflight.set(cacheKey, refresh);
  }

  /** Counts of media needing attention — powers the admin "metadata health" view.
   *
   * Browser requests use backgroundOnMiss: a fresh snapshot returns immediately; a stale
   * snapshot returns while one distributed refresh runs; a first-ever cold load returns a
   * small refreshing marker for the page to poll. Internal callers/tests may omit the option
   * and await an exact computation as before. */
  async getHealthStats(
    includeContentStats = false,
    includeDeepContentStats = false,
    options?: { backgroundOnMiss?: boolean },
  ) {
    const cacheKey = `admin:metadata-health:v3:${includeContentStats ? 1 : 0}:${includeDeepContentStats ? 1 : 0}`;
    const local = this.localHealthSnapshots.get(cacheKey);
    if (local && local.freshUntil > Date.now()) return local.stats;

    const cached = await this.readHealthCache<Record<string, unknown>>(cacheKey);
    if (cached) return cached;

    if (options?.backgroundOnMiss) {
      const redisSnapshot = await this.readHealthCache<HealthSnapshot>(`${cacheKey}:snapshot`);
      const snapshot = redisSnapshot ?? (local && local.expiresAt > Date.now() ? local : undefined);
      this.startHealthStatsRefresh(cacheKey, includeContentStats, includeDeepContentStats);
      if (snapshot?.stats) {
        return {
          ...snapshot.stats,
          _health: {
            status: 'refreshing',
            stale: true,
            computedAt: snapshot.computedAt,
          },
        };
      }
      return {
        _health: { status: 'refreshing', stale: false, computedAt: null },
      };
    }

    return this.computeAndCacheHealthStats(cacheKey, includeContentStats, includeDeepContentStats);
  }

  private async computeHealthStats(includeContentStats: boolean, includeDeepContentStats: boolean) {
    const deepCursor =
      (await this.redis.get<string>(EN_CONTENT_DEEP_CURSOR_KEY).catch(() => null)) ?? '';
    // Optimized queries: avoid NOT EXISTS on episodes (573k rows); check at the season level.
    const [
      total,
      neverHydrated,
      showsNoSeasons,
      moviesMissingOverview,
      tvdbOnly,
      stale,
      classification,
      animeStructure,
      structuralTypeMismatch,
      castMissingCharacterIds,
      movieDataOnShows,
      multiTvdbIds,
      providerDuplicateMovies,
      nonEnglishBase,
      englishContentHealth,
      bannerAsPoster,
      missingRating,
      animeTvdbUnresolvable,
      recommendationsMissing,
      moviesMissingCountry,
      castDuplicates,
      dualStructure,
    ] = await Promise.all([
      this.prisma.mediaItem.count({ where: VISIBLE_MEDIA_WHERE }),
      this.prisma.mediaItem.count({
        where: { ...VISIBLE_MEDIA_WHERE, metadataRefreshedAt: null },
      }),
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE ${VISIBLE_MEDIA_SQL}
            AND m.type='SHOW' AND NOT EXISTS (
            SELECT 1 FROM seasons s JOIN episodes e ON e.season_id=s.id
            WHERE s.show_id=sh.id AND e.structure_state='ACTIVE'::"EpisodeStructureState")`,
      this.prisma.mediaItem.count({
        where: { ...VISIBLE_MEDIA_WHERE, type: 'MOVIE', overview: null },
      }),
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          WHERE ${VISIBLE_MEDIA_SQL}
            AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=m.id AND e.provider='THE_TVDB'
              AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")
            AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=m.id AND e.provider='TMDB'
              AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")`,
      this.prisma.mediaItem.count({
        where: {
          ...VISIBLE_MEDIA_WHERE,
          metadataRefreshedAt: { lt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30) },
        },
      }),
      this.prisma.mediaItem.groupBy({
        by: ['contentClassification'],
        where: VISIBLE_MEDIA_WHERE,
        _count: { _all: true },
      }),
      // Strict-anime shows whose typed TVDB authority still has active TMDB-only rows.
      // Canonical episodes may carry both provider aliases; only rows lacking the
      // canonical TVDB alias are mismatches.
      // Rows whose TVDB id recently proved UNRESOLVABLE (animeTvdbNoId stamp < 30d) are
      // excluded — they are parked, not actionable. Ambiguous user-data rows become
      // LEGACY_UNMAPPED and disappear from this active-structure metric.
      this.prisma.$queryRaw<{ c: bigint; withoutTvdb: bigint }[]>`
        WITH contaminated AS MATERIALIZED (
          SELECT m.id,
            NOT EXISTS (
              SELECT 1 FROM external_ids x
              WHERE x.media_id = m.id
                AND x.provider = 'THE_TVDB'
                AND x.provider_entity_kind = 'SERIES'
            ) AS missing_tvdb
          FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE ${VISIBLE_MEDIA_SQL}
            AND m.type = 'SHOW'
            AND sh.structure_provider = 'TVDB'::"StructureProvider"
            AND sh.structure_reason = 'ANIME_TVDB'::"StructureReason"
            AND EXISTS (
              SELECT 1
              FROM seasons s
              JOIN episodes e ON e.season_id = s.id
              JOIN episode_external_ids tmdb
                ON tmdb.episode_id = e.id AND tmdb.provider = 'TMDB'
              WHERE s.show_id = sh.id
                AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
                AND NOT EXISTS (
                  SELECT 1 FROM episode_external_ids tvdb
                  WHERE tvdb.episode_id = e.id AND tvdb.provider = 'THE_TVDB'
                )
            )
            AND COALESCE(m.metadata_provenance #>> '{animeTvdbNoId,at}', '1970-01-01')::timestamptz < NOW() - INTERVAL '30 days'
        )
        SELECT count(*)::bigint AS c,
               count(*) FILTER (WHERE missing_tvdb)::bigint AS "withoutTvdb"
        FROM contaminated`,
      // Cross-type contamination: a MOVIE row carrying a shows row (or the reverse) —
      // two entities merged into one record by a cross-namespace id confusion.
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          WHERE ${VISIBLE_MEDIA_SQL}
            AND (
              (m.type='MOVIE' AND EXISTS (SELECT 1 FROM shows sh WHERE sh.media_id = m.id))
              OR (m.type='SHOW' AND EXISTS (SELECT 1 FROM movies mv WHERE mv.media_id = m.id))
            )`,
      // Shows with a cast but NO TVDB character ids yet (cast predates the
      // characterExternalId field — a TVDB rehydration fills the whole cast at once),
      // PLUS shows hydrated with the OLD top-20 cast slice (exactly 20 cast rows with
      // ids, not yet re-widened): rehydration widens them to TVDB_CAST_LIMIT and
      // supplements that slice with every staged import character id.
      this.prisma.$queryRaw<{ c: bigint }[]>`SELECT count(*)::bigint AS c FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE ${VISIBLE_MEDIA_SQL}
            AND m.type='SHOW'
            AND EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = m.id
                        AND x.provider = 'THE_TVDB' AND x.provider_entity_kind = 'SERIES')
            AND (
              EXISTS (
                SELECT 1 FROM import_items ii
                JOIN imports i ON i.id = ii.import_id
                WHERE ii.matched_media_id = m.id
                  AND ii.source_entity_type = 'EPISODE_CHARACTER_VOTE'
                  AND ii.status = 'PENDING_MATCH'
                  AND i.status = 'COMPLETED'
              )
              OR (
                sh.structure_provider = 'TVDB'::"StructureProvider"
                AND EXISTS (SELECT 1 FROM media_cast mc WHERE mc.media_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM media_cast mc WHERE mc.media_id = m.id AND mc.character_external_id IS NOT NULL)
              )
              OR (
                (SELECT count(*) FROM media_cast mc WHERE mc.media_id = m.id) = 20
                AND m.metadata_provenance->>'castWidenedAt' IS NULL
              )
            )
            AND COALESCE(m.metadata_provenance->>'charIdsCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'`,
      // User-data type mismatch: movie statuses/history written onto SHOW rows (never
      // legitimate — purged by the type-mismatch repair).
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT (SELECT count(*)::bigint FROM user_movie_status u JOIN media_items m ON m.id = u.media_id WHERE ${VISIBLE_MEDIA_SQL} AND m.type='SHOW')
             + (SELECT count(*)::bigint FROM watch_history h JOIN media_items m ON m.id = h.media_id WHERE ${VISIBLE_MEDIA_SQL} AND m.type='SHOW' AND h.media_type='MOVIE') AS c`,
      // Rows carrying MORE THAN ONE TVDB id (same entity kind): merge leftovers (benign)
      // or id-poisoning (one id belongs to a different show — the old title-attach bug).
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM (
          SELECT e.media_id FROM external_ids e
          JOIN media_items m ON m.id = e.media_id
          WHERE ${VISIBLE_MEDIA_SQL}
            AND e.provider='THE_TVDB'
          GROUP BY e.media_id, e.provider_entity_kind
          HAVING count(*) > 1
        ) x`,
      // Same real movie split across provider rows: a TVDB/IMDB-only movie row can resolve
      // through TMDB /find to a separate TMDB movie row. The repair verifies via provider IDs
      // only (no title guessing), moves user data/external IDs to the TMDB row, then deletes
      // the duplicate source row. Rows that definitively have no TMDB counterpart (parked
      // via providerDupNoMatch) are excluded for 180 days so the stat stays actionable.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.type='MOVIE'
          AND NOT EXISTS (SELECT 1 FROM external_ids tm WHERE tm.media_id = m.id AND tm.provider = 'TMDB' AND tm.provider_entity_kind = 'MOVIE')
          AND EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = m.id AND x.provider IN ('THE_TVDB','IMDB') AND x.provider_entity_kind = 'MOVIE')
          AND COALESCE(m.metadata_provenance #>> '{providerDupNoMatch,at}', '1970-01-01')::timestamptz < NOW() - INTERVAL '180 days'`,
      // Rows EXPLICITLY marked as non-English base (title_locale set and != 'en') — the
      // only cheap SQL signal for wrong-language bases. Rows with an UNSET marker are
      // not counted (most have a fine English base title and just predate the overrides
      // structure). Rows marked 'en' with wrong content can't be counted here — see the
      // content-based suspect stat below.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.title_locale IS NOT NULL AND m.title_locale != 'en'
          AND (m.metadata_provenance->>'enBaseRepairFailedAt' IS NULL
               OR (m.metadata_provenance->>'enBaseRepairFailedAt')::timestamptz < NOW() - INTERVAL '24 hours')`,
      includeContentStats
        ? this.getEnglishContentHealthStats(deepCursor, includeDeepContentStats)
        : Promise.resolve(undefined),
      // Rows whose POSTER is a TVDB banner (wide artwork in a poster slot) — legacy of
      // the swapped TVDB series artwork mapping (type 1=banner was taken as poster).
      // URL shape: artworks.thetvdb.com/banners/v4/{kind}/{id}/banners/<file>.
      // Fixed by a TVDB rehydration (the corrected mapper re-picks poster=type 2).
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND (
            m.poster_url ~ '/banners/[^/]+$'
            OR m.poster_url LIKE 'https://artworks.thetvdb.com/banners/https://artworks.thetvdb.com/banners/%'
            OR m.poster_url LIKE 'http://artworks.thetvdb.com/banners/http://artworks.thetvdb.com/banners/%'
            OR EXISTS (
              SELECT 1 FROM jsonb_each_text(COALESCE(m.poster_urls, '{}'::jsonb)) p
              WHERE p.value ~ '/banners/[^/]+$'
                 OR p.value LIKE 'https://artworks.thetvdb.com/banners/https://artworks.thetvdb.com/banners/%'
                 OR p.value LIKE 'http://artworks.thetvdb.com/banners/http://artworks.thetvdb.com/banners/%'
            )
          )
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id
              AND e.provider IN ('TMDB','THE_TVDB')
              AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")
          AND COALESCE(m.metadata_provenance->>'bannerCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'`,
      // Actionable rating backlog: no rating stored, has a provider id to resolve
      // one from, and not already checked (and found unrated at the source) in the
      // last 90 days. Mostly TVDB-hydrated rows — TVDB has no public 0–10 rating,
      // so those are born unrated and reach TMDB's vote_average via cross-ids.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND (
            (
              m.rating IS NULL
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id
              AND e.provider IN ('TMDB','THE_TVDB')
              AND e.provider_entity_kind = (CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")
              AND (m.metadata_provenance->>'ratingCheckedAt' IS NULL
                   OR (m.metadata_provenance->>'ratingCheckedAt')::timestamptz < NOW() - INTERVAL '90 days')
            )
            OR (
              m.type = 'SHOW'
              AND EXISTS (
                SELECT 1 FROM shows sh
                WHERE sh.media_id = m.id AND sh.structure_provider::text = 'TVDB'
              )
              AND EXISTS (
                SELECT 1 FROM external_ids e
                WHERE e.media_id = m.id
                  AND e.provider = 'TMDB'
                  AND e.provider_entity_kind::text = 'SERIES'
              )
              AND (
                m.metadata_provenance->>'ratingProvider' IS DISTINCT FROM 'TMDB'
                OR COALESCE(
                  m.metadata_provenance->>'ratingRefreshedAt',
                  '1970-01-01'
                )::timestamptz < NOW() - INTERVAL '30 days'
              )
            )
          )`,
      // Animation rows PARKED as unresolvable (no trustworthy TVDB id) in the last
      // 30 days — informational; excluded from animeOnTmdb so it stays actionable.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND COALESCE(m.metadata_provenance #>> '{animeTvdbNoId,at}', '1970-01-01')::timestamptz >= NOW() - INTERVAL '30 days'`,
      // TMDB-linked rows or verified canonical show families whose recommendations
      // snapshot was never synced. Direct rows use one light call; bridged TVDB roots
      // merge the recommendation lists of their active TMDB component sources.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.recommendations_synced_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB'
                AND e.provider_entity_kind = (CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")
            OR (
              m.type = 'SHOW'
              AND EXISTS (
                SELECT 1
                FROM media_canonical_links l
                JOIN external_ids e ON e.media_id = l.source_media_id
                WHERE l.target_media_id = m.id
                  AND l.status = 'ACTIVE'::"MediaCanonicalStatus"
                  AND l.relation IN (
                    'EXACT_DUPLICATE'::"MediaCanonicalRelation",
                    'SEASON_COMPONENT'::"MediaCanonicalRelation"
                  )
                  AND e.provider = 'TMDB'
                  AND e.provider_entity_kind = 'SERIES'::"ProviderEntityKind"
              )
            )
          )
          AND COALESCE(m.metadata_provenance->>'recsCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'`,
      // TMDB-linked MOVIE rows with no production country (powers the explore country
      // filter). Filled by the movie-countries backfill; 90-day recheck like ratings.
      this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c FROM media_items m
        JOIN movies mv ON mv.media_id = m.id
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.type = 'MOVIE'
          AND mv.country IS NULL
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB' AND e.provider_entity_kind = 'MOVIE')
          AND COALESCE(m.metadata_provenance->>'countryCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'`,
      // Duplicate-cast + dual-structure stats. The dashboard count calls the exact
      // repair selector so observation and mutation can never drift to different sets.
      this.getCastDuplicateStats().catch(() => ({
        castDuplicateMedia: 0,
        castDuplicateRows: 0,
        castDuplicateVotes: 0,
      })),
      this.countDualStructureShows()
        .then((count) => [{ c: BigInt(count) }])
        .catch(() => [{ c: BigInt(0) }]),
    ]);
    // One compact integrity query covers typed authority, import replay, alias-kind,
    // legacy quarantine, and audited TVDB-alias state without adding more concurrent
    // catalog scans to the Promise.all above.
    const [integrity] = await this.prisma.$queryRaw<
      {
        tvdbFallbackShows: bigint;
        pendingCharacterVoteItems: bigint;
        pendingCharacterVoteShows: bigint;
        pendingCharacterVoteMovies: bigint;
        pendingCharacterVoteShowsWithoutTvdb: bigint;
        wrongKindExternalIdAliases: bigint;
        wrongKindExternalIdMedia: bigint;
        authorityMissing: bigint;
        authorityInvalid: bigint;
        authorityOutdated: bigint;
        legacyUnmappedEpisodes: bigint;
        legacyUnmappedShows: bigint;
        legacyUnmappedWithUserData: bigint;
        multiTvdbIdsActionable: bigint;
        multiTvdbIdsAmbiguous: bigint;
      }[]
    >`
      WITH visible_media AS MATERIALIZED (
        SELECT m.* FROM media_items m WHERE ${VISIBLE_MEDIA_SQL}
      ),
      multi_tvdb AS (
        SELECT e.media_id, e.provider_entity_kind,
               md5(string_agg(e.value, '|' ORDER BY e.value)) AS fingerprint
        FROM external_ids e
        JOIN visible_media vm ON vm.id = e.media_id
        WHERE e.provider = 'THE_TVDB'
        GROUP BY e.media_id, e.provider_entity_kind
        HAVING count(*) > 1
      )
      SELECT
        (SELECT count(*) FROM shows sh
          JOIN visible_media m ON m.id = sh.media_id
          WHERE sh.structure_provider = 'TVDB'::"StructureProvider"
            AND sh.structure_reason = 'TVDB_ONLY_FALLBACK'::"StructureReason"
            AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=m.id
                        AND e.provider='THE_TVDB' AND e.provider_entity_kind='SERIES'))::bigint AS "tvdbFallbackShows",
        (SELECT count(*) FROM import_items ii JOIN imports i ON i.id=ii.import_id
          WHERE ii.source_entity_type IN ('EPISODE_CHARACTER_VOTE', 'MOVIE_CHARACTER_VOTE') AND ii.status='PENDING_MATCH'
            AND i.status='COMPLETED'
            AND EXISTS (SELECT 1 FROM visible_media vm WHERE vm.id=ii.matched_media_id))::bigint AS "pendingCharacterVoteItems",
        (SELECT count(DISTINCT ii.matched_media_id) FROM import_items ii JOIN imports i ON i.id=ii.import_id
          WHERE ii.source_entity_type='EPISODE_CHARACTER_VOTE' AND ii.status='PENDING_MATCH'
            AND i.status='COMPLETED'
            AND EXISTS (SELECT 1 FROM visible_media vm WHERE vm.id=ii.matched_media_id))::bigint AS "pendingCharacterVoteShows",
        (SELECT count(DISTINCT ii.matched_media_id) FROM import_items ii JOIN imports i ON i.id=ii.import_id
          WHERE ii.source_entity_type='MOVIE_CHARACTER_VOTE' AND ii.status='PENDING_MATCH'
            AND i.status='COMPLETED'
            AND EXISTS (SELECT 1 FROM visible_media vm WHERE vm.id=ii.matched_media_id))::bigint AS "pendingCharacterVoteMovies",
        (SELECT count(DISTINCT ii.matched_media_id) FROM import_items ii JOIN imports i ON i.id=ii.import_id
          WHERE ii.source_entity_type='EPISODE_CHARACTER_VOTE' AND ii.status='PENDING_MATCH'
            AND i.status='COMPLETED'
            AND EXISTS (SELECT 1 FROM visible_media vm WHERE vm.id=ii.matched_media_id)
            AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id=ii.matched_media_id
                            AND e.provider='THE_TVDB' AND e.provider_entity_kind='SERIES'))::bigint AS "pendingCharacterVoteShowsWithoutTvdb",
        (SELECT count(*) FROM external_ids e JOIN visible_media m ON m.id=e.media_id
          WHERE e.provider_entity_kind != (CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")::bigint AS "wrongKindExternalIdAliases",
        (SELECT count(DISTINCT e.media_id) FROM external_ids e JOIN visible_media m ON m.id=e.media_id
          WHERE e.provider_entity_kind != (CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")::bigint AS "wrongKindExternalIdMedia",
        (SELECT count(*) FROM shows sh JOIN visible_media m ON m.id=sh.media_id
          WHERE sh.structure_provider IS NULL OR sh.structure_reason IS NULL)::bigint AS "authorityMissing",
        (SELECT count(*) FROM shows sh JOIN visible_media m ON m.id=sh.media_id WHERE
          (sh.structure_provider='TMDB'::"StructureProvider" AND sh.structure_reason NOT IN ('GENERAL_TMDB','MANUAL_OVERRIDE'))
          OR (sh.structure_provider='TVDB'::"StructureProvider" AND sh.structure_reason NOT IN ('ANIME_TVDB','TVDB_ONLY_FALLBACK','MANUAL_OVERRIDE')))::bigint AS "authorityInvalid",
        (SELECT count(*) FROM shows sh JOIN visible_media m ON m.id=sh.media_id
          WHERE COALESCE(sh.structure_rule_version, 0) < ${STRUCTURE_RULE_VERSION})::bigint AS "authorityOutdated",
        (SELECT count(*) FROM episodes e
          JOIN seasons s ON s.id=e.season_id
          JOIN shows sh ON sh.id=s.show_id
          JOIN visible_media m ON m.id=sh.media_id
          WHERE e.structure_state='LEGACY_UNMAPPED'::"EpisodeStructureState")::bigint AS "legacyUnmappedEpisodes",
        (SELECT count(DISTINCT s.show_id) FROM episodes e JOIN seasons s ON s.id=e.season_id
          JOIN shows sh ON sh.id=s.show_id
          JOIN visible_media m ON m.id=sh.media_id
          WHERE e.structure_state='LEGACY_UNMAPPED'::"EpisodeStructureState")::bigint AS "legacyUnmappedShows",
        (SELECT count(*) FROM episodes e
          JOIN seasons s ON s.id=e.season_id
          JOIN shows sh ON sh.id=s.show_id
          JOIN visible_media m ON m.id=sh.media_id
          WHERE e.structure_state='LEGACY_UNMAPPED'::"EpisodeStructureState"
          AND (EXISTS (SELECT 1 FROM user_episode_status u WHERE u.episode_id=e.id
                       AND (u.watched=true OR u.watched_at IS NOT NULL OR u.watch_count > 0 OR u.device IS NOT NULL))
            OR EXISTS (SELECT 1 FROM watch_history h WHERE h.episode_id=e.id)
            OR EXISTS (SELECT 1 FROM ratings r WHERE r.episode_id=e.id)
            OR EXISTS (SELECT 1 FROM reactions r WHERE r.episode_id=e.id)
            OR EXISTS (SELECT 1 FROM character_votes v WHERE v.episode_id=e.id)
            OR EXISTS (SELECT 1 FROM comments c WHERE c.thread_type='EPISODE' AND c.thread_id=e.id)
            OR EXISTS (SELECT 1 FROM external_reviews er WHERE er.episode_id=e.id)))::bigint AS "legacyUnmappedWithUserData",
        (SELECT count(*) FROM multi_tvdb mt JOIN visible_media m ON m.id=mt.media_id
          WHERE COALESCE(m.metadata_provenance #>> '{tvdbIdAudit,fingerprint}', '') != mt.fingerprint
             OR COALESCE(m.metadata_provenance #>> '{tvdbIdAudit,checkedAt}', '1970-01-01')::timestamptz < NOW() -
                CASE COALESCE(m.metadata_provenance #>> '{tvdbIdAudit,status}', '')
                  WHEN 'benign' THEN INTERVAL '100 years'
                  WHEN 'unresolved' THEN INTERVAL '90 days'
                  WHEN 'ambiguous' THEN INTERVAL '180 days'
                  ELSE INTERVAL '0 days' END)::bigint AS "multiTvdbIdsActionable",
        (SELECT count(*) FROM multi_tvdb mt JOIN visible_media m ON m.id=mt.media_id
          WHERE m.metadata_provenance #>> '{tvdbIdAudit,fingerprint}' = mt.fingerprint
            AND m.metadata_provenance #>> '{tvdbIdAudit,status}' = 'ambiguous')::bigint AS "multiTvdbIdsAmbiguous"`;

    const toNum = (r: { c: bigint }[] | undefined) => Number(r?.[0]?.c ?? 0);
    const enContent = englishContentHealth?.[0];
    const enNum = (value: bigint | undefined) => Number(value ?? 0);
    const stats = {
      total,
      neverHydrated,
      showsMissingEpisodes: toNum(showsNoSeasons as any),
      moviesMissingOverview,
      tvdbOnly: toNum(tvdbOnly as any),
      tvdbFallbackShows: Number(integrity?.tvdbFallbackShows ?? 0),
      stale,
      byClassification: Object.fromEntries(
        classification.map((c: { contentClassification: string; _count: { _all: number } }) => [
          c.contentClassification,
          c._count._all,
        ]),
      ),
      animeOnTmdb: toNum(animeStructure as any),
      animeOnTmdbNoTvdbId: Number(animeStructure?.[0]?.withoutTvdb ?? 0),
      structuralTypeMismatch: toNum(structuralTypeMismatch as any),
      castMissingCharacterIds: toNum(castMissingCharacterIds as any),
      pendingCharacterVoteItems: Number(integrity?.pendingCharacterVoteItems ?? 0),
      pendingCharacterVoteShows: Number(integrity?.pendingCharacterVoteShows ?? 0),
      pendingCharacterVoteMovies: Number(integrity?.pendingCharacterVoteMovies ?? 0),
      pendingCharacterVoteShowsWithoutTvdb: Number(
        integrity?.pendingCharacterVoteShowsWithoutTvdb ?? 0,
      ),
      movieDataOnShows: toNum(movieDataOnShows as any),
      multiTvdbIds: toNum(multiTvdbIds as any),
      multiTvdbIdsActionable: Number(integrity?.multiTvdbIdsActionable ?? 0),
      multiTvdbIdsAmbiguous: Number(integrity?.multiTvdbIdsAmbiguous ?? 0),
      wrongKindExternalIdAliases: Number(integrity?.wrongKindExternalIdAliases ?? 0),
      wrongKindExternalIdMedia: Number(integrity?.wrongKindExternalIdMedia ?? 0),
      authorityMissing: Number(integrity?.authorityMissing ?? 0),
      authorityInvalid: Number(integrity?.authorityInvalid ?? 0),
      authorityOutdated: Number(integrity?.authorityOutdated ?? 0),
      legacyUnmappedEpisodes: Number(integrity?.legacyUnmappedEpisodes ?? 0),
      legacyUnmappedShows: Number(integrity?.legacyUnmappedShows ?? 0),
      legacyUnmappedWithUserData: Number(integrity?.legacyUnmappedWithUserData ?? 0),
      providerDuplicateMovies: toNum(providerDuplicateMovies as any),
      nonEnglishBase: toNum(nonEnglishBase as any),
      nonEnglishContent: includeContentStats ? enNum(enContent?.nonEnglishContent) : null,
      nonEnglishContentParked: includeContentStats
        ? enNum(enContent?.nonEnglishContentParked)
        : null,
      nonEnglishContentDeep: {
        totalEligible: enNum(enContent?.totalEligible),
        unverified: enNum(enContent?.unverified),
        remainingInPass: enNum(enContent?.remainingInPass),
        cursorPosition: enNum(enContent?.cursorPosition),
        cursorActive: includeDeepContentStats && deepCursor !== '',
        verifierVersion: EN_CONTENT_VERIFIER_VERSION,
      },
      bannerAsPoster: toNum(bannerAsPoster as any),
      missingRating: toNum(missingRating as any),
      animeTvdbUnresolvable: toNum(animeTvdbUnresolvable as any),
      recommendationsMissing: toNum(recommendationsMissing as any),
      moviesMissingCountry: toNum(moviesMissingCountry as any),
      ...castDuplicates,
      dualStructureShows: toNum(dualStructure as any),
    };
    return stats;
  }

  /** One batch: hydrate up to `count` media that is GENUINELY incomplete (missing data).
   *  Complete media (has episodes + overview) is NEVER selected — no point re-hydrating it. */
  async backfillBatch(
    count?: number,
    maxRps?: number,
  ): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    parked: number;
    sample: string[];
  }> {
    if (this.backfillRunning) {
      this.logger.log('Backfill already running — skipping');
      return { processed: 0, succeeded: 0, failed: 0, parked: 0, sample: [] };
    }
    this.backfillRunning = true;
    const limit = Math.max(1, Math.min(count ?? this.defaultBatchSize, 100000));
    const delayMs = maxRps && maxRps > 0 ? Math.round(60000 / maxRps) : 0;
    if (delayMs > 0)
      this.logger.log(
        `Backfill throttled to ~${maxRps} items/min (${delayMs}ms delay between items)`,
      );
    try {
      // Rows whose only external ids are dead (provider 404 on hydration) are parked
      // in metadata_provenance.hydrateNotFoundAt for 90 days — exclude them here so
      // they neither re-fail every run nor consume the batch limit.
      const parkedRows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.metadata_provenance->>'hydrateNotFoundAt' >= ${new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()}`;
      const parkedIds = parkedRows.map((p) => p.id);
      const candidates = await this.prisma.mediaItem.findMany({
        where: {
          ...VISIBLE_MEDIA_WHERE,
          id: { notIn: parkedIds },
          OR: [
            { metadataRefreshedAt: null }, // never hydrated (stub)
            { type: 'SHOW', show: { seasons: { none: {} } } }, // show with zero seasons
            { overview: null }, // missing overview (show or movie)
          ],
        },
        orderBy: { createdAt: 'asc' }, // oldest first
        take: limit,
        include: {
          externalIds: true,
          genres: { include: { genre: true } },
          show: { select: { keywords: true, structureProvider: true } },
          movie: { select: { keywords: true } },
        },
      });

      let succeeded = 0;
      let failed = 0;
      let parked = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        try {
          await this.hydrateOne(
            m.id,
            m.externalIds as unknown as {
              provider: ExternalProvider;
              value: string;
              providerEntityKind: ProviderEntityKind;
            }[],
            m.type,
            // Anime routing uses the strict TMDB genre + keyword rule.
            this.isAnimeMedia(m),
            m.show?.structureProvider ?? null,
          );
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isNotFoundError(e)) {
            // Dead/wrong provider id — this stub can never hydrate. Park 90 days.
            await this.stampRepairChecked(m.id, 'hydrateNotFoundAt');
            parked++;
            this.logger.debug(`backfill parked ${m.title}: ${(e as Error).message}`);
            continue;
          }
          failed++;
          this.logger.debug(`backfill failed for ${m.title}: ${(e as Error).message}`);
        }
        // Progress log every 50 items so the admin can see it's working.
        if ((i + 1) % 50 === 0) {
          this.logger.log(
            `Backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`,
          );
        }
        // Throttle: wait between items so normal user requests aren't starved.
        if (delayMs > 0 && i < candidates.length - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      this.logger.log(
        `Metadata backfill batch: ${succeeded}/${candidates.length} succeeded, ${failed} failed, ${parked} parked (404)`,
      );
      return { processed: candidates.length, succeeded, failed, parked, sample };
    } finally {
      this.backfillRunning = false;
    }
  }

  /** Automatic anime authority: TMDB Animation genre AND persisted TMDB `anime` keyword. */
  isAnimeMedia(m: {
    contentClassification?: string | null;
    show?: { keywords?: unknown } | null;
    movie?: { keywords?: unknown } | null;
    genres?: { genre: { slug: string; name: string } }[];
  }): boolean {
    const kw = ((m.show?.keywords ?? m.movie?.keywords ?? []) as string[]).map((k) =>
      String(k).toLowerCase(),
    );
    const animation = (m.genres ?? []).some(
      (g) => g.genre.slug === 'animation' || g.genre.name.toLowerCase() === 'animation',
    );
    return animation && kw.includes('anime');
  }

  /**
   * Hydrate a single media item by its best available provider, then enqueue anime classification.
   *
   * CRITICAL: if the media ALREADY has episodes/structure AND has a TVDB id, it was hydrated
   * from TVDB — re-hydrate from TVDB (NEVER switch to TMDB). This preserves the existing
   * season/episode structure that the user's watch history is built on. TMDB is only used for:
   *   - media with no existing structure (never-hydrated stubs)
   *   - media with no TVDB id (TMDB is the only source)
   *
   * Strict anime (TMDB Animation genre plus the anime keyword) is TVDB-authoritative.
   * Existing graphs use the remapper; new stubs use the central authority router.
   */
  private async hydrateOne(
    mediaId: string,
    externals: {
      provider: ExternalProvider;
      value: string;
      providerEntityKind: ProviderEntityKind;
    }[],
    type: string,
    isAnime: boolean = false,
    structureProvider?: StructureProvider | null,
  ) {
    const isShow = type === 'SHOW';
    const expectedKind = isShow ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const tmdb = externals.find(
      (e) => e.provider === ExternalProvider.TMDB && e.providerEntityKind === expectedKind,
    );
    const tvdb = externals.find(
      (e) => e.provider === ExternalProvider.THE_TVDB && e.providerEntityKind === expectedKind,
    );

    // Detect existing active structure before choosing whether anime needs a remap or
    // is merely a never-hydrated stub.
    const hasStructure = isShow
      ? (await this.prisma.episode.count({
          where: { structureState: 'ACTIVE', season: { show: { mediaId } } },
          take: 1,
        })) > 0
      : (await this.prisma.mediaItem.count({
          where: { id: mediaId, type: 'MOVIE', overview: { not: null } },
        })) > 0;

    if (isShow && isAnime && structureProvider === StructureProvider.TVDB) {
      // Existing anime graphs switch only through the remapper. If repair cannot
      // complete, retain the last-known structure and let the next bounded run retry.
      const { fixed } = await this.fixAnimeShowFromTvdb(mediaId).catch(() => ({
        fixed: false,
        remapped: 0,
      }));
      if (fixed) {
        await this.meta.scheduleClassification(mediaId).catch(() => undefined);
        return;
      }
      if (hasStructure) return;
      if (tvdb) {
        await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
      } else if (tmdb) {
        // The TMDB authority profile will either route to TVDB or leave a pending
        // identity-only anime stub; it cannot persist TMDB seasons for strict anime.
        await this.meta.ensureShowFull(Number(tmdb.value));
      }
      await this.meta.scheduleClassification(mediaId).catch(() => undefined);
      return;
    }

    // Deterministic structure ownership: the stamp is written at first full hydration
    // and by the anime TVDB repair. It beats the legacy heuristic below ("has episodes
    // + has a TVDB cross-id ⇒ TVDB structure"), which misroutes TMDB-structured shows
    // that merely carry a TVDB cross-id (TMDB attaches it automatically).
    const structureOwner = structureProvider?.toLowerCase();

    if (isShow && structureOwner === 'tvdb' && tvdb) {
      await this.meta.ensureShowFullTvdb(Number(tvdb.value)).catch(() => undefined);
    } else if (isShow && structureOwner === 'tmdb' && tmdb) {
      await this.meta.ensureShowFull(Number(tmdb.value));
    } else if (!isShow && hasStructure && tvdb) {
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
    // Enqueue enrichment/classification; only the strict TMDB rule can select anime.
    await this.meta.scheduleClassification(mediaId).catch(() => undefined);
  }

  // ---- Anime → TVDB rehydration (admin button + anime_tvdb_rehydrate cron) ----

  /**
   * Repair strict-anime shows whose typed TVDB authority still has active TMDB-only rows.
   *
   * Selection mirrors the `animeOnTmdb` health stat. Per show: resolve the TVDB series
   * id (stored external id → TMDB /external_ids cross-id → STRICT exact-title+year TVDB
   * search), hydrate a canonical snapshot under the media lock, then use
   * StructureRemapService to transfer user data before stale active rows are removed or
   * quarantined.
   *
   * When TVDB rate-limits us the batch stops early — remaining shows stay on TMDB until
   * the next cron run or a manual "Fix Anime → TVDB" click.
   *
   * CONVERGENCE: rows whose TVDB id can't be resolved (no stored id, TMDB has no
   * cross-id, strict title+year search fails, or the cross-id is claimed by a
   * duplicate) can NEVER succeed and used to be re-attempted EVERY run (~60 rows ×
   * provider calls = 1.5h runs and hourly collisions with the overlap guard). They
   * are remembered in metadata_provenance.animeTvdbNoId ({at, stale}) and skipped
   * for 30 days — re-armed early only if their stale-row count grows (new TMDB
   * contamination). Repeat failures are strike-counted (animeTvdbFail) and skipped
   * after 5 strikes within 30 days.
   */
  async rehydrateAnimeFromTvdb(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    noTvdbId: number;
    remapped: number;
    sample: string[];
  }> {
    const empty = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
      noTvdbId: 0,
      remapped: 0,
      sample: [] as string[],
    };
    if (this.animeFixStartedAt) {
      const lastProgressAt =
        this.repairProgress.get('anime-rehydrate')?.updatedAt?.getTime() ?? this.animeFixStartedAt;
      if (Date.now() - lastProgressAt < REPAIR_STALL_MS) {
        this.logger.log('Anime TVDB rehydration already running — skipping');
        return empty;
      }
      // Guard older than the admin stall window = the previous run's promise HUNG
      // and is no longer doing useful work. Latch released so this run can proceed.
      this.logger.error(
        'Anime TVDB rehydration: previous run made no progress for 30+ min — releasing the overlap guard',
      );
    }
    if (!this.tvdb.enabled) {
      this.logger.warn('TVDB not configured — skipping anime TVDB rehydration');
      return empty;
    }
    this.animeFixStartedAt = Date.now();
    this.trackRepair('anime-rehydrate', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const noIdRearmThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const take = Math.max(1, Math.min(limit ?? 1000, 100000));
      this.trackRepair('anime-rehydrate', { current: 'Selecting candidate shows' });
      const selectionHeartbeat = setInterval(() => {
        this.trackRepair('anime-rehydrate', { current: 'Selecting candidate shows' });
      }, 60_000);
      let candidates: { id: string; title: string; metadataProvenance: unknown }[];
      try {
        // Direct SQL avoids Prisma generating a very large nested relation-filter query over
        // seasons/episodes/episode_external_ids. `0/0` stalls in the admin panel happened
        // before this candidate list completed.
        candidates = await this.prisma.$queryRaw<
          { id: string; title: string; metadataProvenance: unknown }[]
        >`
          SELECT m.id, m.title, m.metadata_provenance AS "metadataProvenance"
          FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE ${VISIBLE_MEDIA_SQL}
            AND m.type::text = ${MediaType.SHOW}
            AND sh.structure_provider = 'TVDB'::"StructureProvider"
            AND sh.structure_reason = 'ANIME_TVDB'::"StructureReason"
            AND COALESCE(m.metadata_provenance #>> '{animeTvdbNoId,at}', '') <= ${noIdRearmThreshold}
            AND (
              SELECT count(DISTINCT e.id)
              FROM seasons s
              JOIN episodes e ON e.season_id = s.id
              WHERE s.show_id = sh.id
                AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
                AND EXISTS (
                  SELECT 1 FROM episode_external_ids tmdb_ep
                  WHERE tmdb_ep.episode_id = e.id
                    AND tmdb_ep.provider::text = ${ExternalProvider.TMDB}
                )
                AND NOT EXISTS (
                  SELECT 1 FROM episode_external_ids tvdb_ep
                  WHERE tvdb_ep.episode_id = e.id
                    AND tvdb_ep.provider::text = ${ExternalProvider.THE_TVDB}
                )
            ) > 0
          ORDER BY m.title ASC
          LIMIT ${take}`;
      } finally {
        clearInterval(selectionHeartbeat);
      }

      this.trackRepair('anime-rehydrate', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      let noTvdbId = 0;
      let remapped = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        // Strike-counted failures: skip after 5 strikes within 30 days (a row that
        // throws every run otherwise burns a repair slot forever).
        const failMark = (m.metadataProvenance as any)?.animeTvdbFail;
        if (
          failMark?.count >= 5 &&
          typeof failMark.at === 'string' &&
          failMark.at > noIdRearmThreshold
        ) {
          this.trackRepair('anime-rehydrate', { processed: i + 1, succeeded, failed });
          continue;
        }
        this.trackRepair('anime-rehydrate', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          const { fixed, remapped: moved } = await this.fixAnimeShowFromTvdb(m.id);
          if (!fixed) {
            noTvdbId++;
            continue;
          }
          remapped += moved;
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(
              `Anime TVDB rehydration rate-limited after ${i} items — deferring the rest`,
            );
            break;
          }
          failed++;
          // WARN (not debug): a persistent per-row failure must be identifiable in
          // prod logs — the run report only shows the count.
          if (failed <= 10)
            this.logger.warn(
              `anime tvdb rehydration failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
          await this.stampAnimeTvdbFail(m.id, m.metadataProvenance as any);
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `Anime TVDB rehydration progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail, ${noTvdbId} no-tvdb-id)`,
          );
        }
      }
      this.trackRepair('anime-rehydrate', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Anime TVDB rehydration: ${succeeded}/${candidates.length} rehydrated, ${failed} failed, ${rateLimited} rate-limited, ${noTvdbId} skipped (no TVDB id / already repaired), ${remapped} episodes remapped`,
      );
      return {
        processed: candidates.length,
        succeeded,
        failed,
        rateLimited,
        noTvdbId,
        remapped,
        sample,
      };
    } catch (e) {
      // Always clear the panel state on failure — a stale `running: true` entry
      // haunts the admin page forever otherwise.
      this.trackRepair('anime-rehydrate', { running: false, finishedAt: new Date() });
      throw e;
    } finally {
      this.animeFixStartedAt = null;
    }
  }

  /**
   * Repair one strict-anime show whose structure (partly) came from TMDB: resolve the
   * TVDB series id, force a full TVDB hydration (bypassing the 24h staleness gate), then
   * remap user watch data from stale TMDB-only episode rows onto the TVDB structure.
   *
   * Cheap no-op (`fixed: false`) when the show has no stale TMDB-only rows — safe to call
   * on every anime detail/episodes view. Concurrent calls for the same show COALESCE into
   * one repair, so the detail + episodes requests of one screen load both answer with the
   * post-fix TVDB structure. Shared by the batch fix, the backfill, and the shows service.
   */
  async fixAnimeShowFromTvdb(
    mediaId: string,
  ): Promise<{ fixed: boolean; remapped: number; report?: RemapStats }> {
    const existing = this.animeFixInflight.get(mediaId);
    if (existing) return existing;
    const p = this.doFixAnimeShowFromTvdb(mediaId).finally(() =>
      this.animeFixInflight.delete(mediaId),
    );
    this.animeFixInflight.set(mediaId, p);
    return p;
  }

  private async doFixAnimeShowFromTvdb(
    mediaId: string,
  ): Promise<{ fixed: boolean; remapped: number; report?: RemapStats }> {
    const notFixed = { fixed: false, remapped: 0 };
    if (!this.tvdb.enabled) return notFixed;

    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true, show: { select: { yearStart: true } } },
    });
    if (!media) return notFixed;
    const previousMatcherVersion = Number(
      (media.metadataProvenance as any)?.animeTvdbRemapVersion ?? 0,
    );
    const reconsiderLegacy = previousMatcherVersion < StructureRemapService.MATCHER_VERSION;

    // Stale rows only the TMDB structure has (TMDB episode id, no TVDB one). None →
    // already fully TVDB-structured; nothing to repair.
    // RAW SQL on purpose: the Prisma equivalent (relation filter + some/NOT-some on
    // externalIds) compiles to LEFT JOINs with `id IS NOT NULL` guards + IN/NOT IN
    // subplans — the planner then drives from a FULL seasons scan and materializes
    // ~1.3M TVDB episode ids to temp (measured 6.7s on prod data, on EVERY anime
    // detail/episodes view). Correlated EXISTS uses episode_external_ids_episode_id_idx
    // per candidate row instead — single-digit ms.
    //
    // Stale = active episode NOT linked to TVDB. A matcher-version bump also re-arms
    // LEGACY_UNMAPPED rows for one pass; otherwise the cheap active-only guard would
    // return before StructureRemapService ever got a chance to reconsider them.
    const staleRows = Number(
      (
        await this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c
        FROM episodes e
        JOIN seasons s ON s.id = e.season_id
        JOIN shows sh ON sh.id = s.show_id
        WHERE sh.media_id = ${mediaId}
          AND (
            (e.structure_state = 'ACTIVE'::"EpisodeStructureState"
              AND NOT EXISTS (
                SELECT 1 FROM episode_external_ids y
                WHERE y.episode_id = e.id AND y.provider = 'THE_TVDB'
              ))
            OR (${reconsiderLegacy} AND e.structure_state = 'LEGACY_UNMAPPED'::"EpisodeStructureState")
          )`
      )[0]?.c ?? 0,
    );
    if (staleRows === 0) return notFixed;

    // Skip when nothing new appeared since the last repair: rows KEPT by the remap
    // (unmapped, but carrying user data) still look stale forever — without this gate
    // every view re-runs a full TVDB hydration + remap for zero effect. A stale count
    // that grew past the kept count means new contamination → re-arm the repair.
    // The matcher version re-arms it too: a repair done by an older matching ladder
    // (e.g. airDate/title-only v1, which could never map flattened TMDB structures)
    // runs again so the improved matcher gets a pass at the kept rows.
    // Skip when the TVDB id recently proved UNRESOLVABLE for this row — every detail
    // view / cron run would otherwise redo the cross-id lookups for a row that can't
    // succeed. Re-arms after 30 days (providers add cross-ids eventually) or early
    // when the stale count grows (new TMDB contamination to rescue).
    const noIdMark = (media.metadataProvenance as any)?.animeTvdbNoId;
    if (
      noIdMark &&
      typeof noIdMark.at === 'string' &&
      Date.now() - new Date(noIdMark.at).getTime() < 30 * 24 * 60 * 60 * 1000 &&
      (typeof noIdMark.stale !== 'number' || staleRows <= noIdMark.stale)
    ) {
      return notFixed;
    }

    const tvdbId = await this.resolveAnimeTvdbId({
      id: media.id,
      title: media.title,
      externalIds: media.externalIds as unknown as { provider: ExternalProvider; value: string }[],
      show: media.show,
    });
    if (!tvdbId) {
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: {
          metadataProvenance: {
            ...((media.metadataProvenance as any) ?? {}),
            animeTvdbNoId: { at: new Date().toISOString(), stale: staleRows },
          },
        },
      });
      return notFixed;
    }

    // Bypass the 24h isStale gate inside ensureShowFullTvdb — this is a forced provider
    // switch, not a routine refresh.
    // The remap phase takes the media write lock (long TTL: hundred-pair remaps run
    // many small transactions) so no hydration can interleave mid-transfer.
    const remap = await this.withCastDedupLock(
      mediaId,
      async () => {
        this.trackRepair('structure-reconcile', { current: `${mediaId} (rehydrating-tvdb)` });
        await this.meta.ensureShowFullTvdb(tvdbId, undefined, {
          forceRefresh: true,
          writeScope: 'STRUCTURE_REMAP',
          lockHeld: true,
          decision: {
            provider: StructureProvider.TVDB,
            reason: StructureReason.ANIME_TVDB,
            ruleVersion: STRUCTURE_RULE_VERSION,
            decidedAt: new Date(),
            tvdbId,
          },
        });
        return this.structureRemap.remapShow(mediaId, {
          canonical: 'tvdb',
          reason: StructureReason.ANIME_TVDB,
          onProgress: (done, total) =>
            this.trackRepair('structure-reconcile', { current: `${mediaId} (${done}/${total})` }),
        });
      },
      10 * 60 * 1000,
    );
    // A success clears the no-id / fail-strike marks. Ambiguous user-data rows are
    // LEGACY_UNMAPPED and therefore no longer appear in the active mismatch selector.
    const provenance = { ...((media.metadataProvenance as any) ?? {}) } as Record<string, any>;
    delete provenance.animeTvdbNoId;
    delete provenance.animeTvdbFail;
    provenance.animeTvdbRemapVersion = StructureRemapService.MATCHER_VERSION;
    provenance.structureRemapVersion = StructureRemapService.MATCHER_VERSION;
    provenance.structureProvider = 'tvdb';
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { metadataProvenance: provenance },
    });
    return { fixed: true, remapped: remap.mapped, report: remap };
  }

  /** Strike-count a per-row repair failure (skipped after 5 strikes within 30 days). */
  private async stampAnimeTvdbFail(mediaId: string, prev: Record<string, any> | null) {
    try {
      const before = (prev?.animeTvdbFail as any) ?? {};
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: {
          metadataProvenance: {
            ...(prev ?? {}),
            animeTvdbFail: { at: new Date().toISOString(), count: (before.count ?? 0) + 1 },
          },
        },
      });
    } catch {
      /* best-effort marker */
    }
  }

  /**
   * TVDB series id for an anime show, in trust order:
   *   1. the stored THE_TVDB external id;
   *   2. TMDB's `/tv/{id}/external_ids` lookup (authoritative cross-id — no wrong-match risk);
   *   3. a STRICT TVDB search fallback (exact normalized title + matching year — a wrong
   *      match would corrupt the show's structure).
   * Returns null when no id can be trusted.
   */
  private async resolveAnimeTvdbId(media: {
    id: string;
    title: string;
    externalIds: { provider: ExternalProvider; value: string }[];
    show: { yearStart: number | null } | null;
  }): Promise<number | null> {
    const existing = media.externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB);
    if (existing) return Number(existing.value);

    // TMDB cross-id lookup: TMDB knows the equivalent TVDB series id for most shows.
    const tmdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
    if (tmdbExt) {
      const tvdbId = await this.tmdbProvider.getTvdbIdForShow(Number(tmdbExt.value));
      if (tvdbId) {
        // TMDB's own cross-id is authoritative: when it is already claimed by another
        // media row this show is a duplicate — never title-search past it (a wrong
        // search hit would merge structures).
        const claimed = await this.claimTvdbId(media.id, tvdbId);
        return claimed ? tvdbId : null;
      }
    }

    const res = await this.tvdb.searchShows(media.title, 1);
    const want = slugify(media.title);
    const year = media.show?.yearStart ?? null;
    const hit = res.items.find(
      (it) =>
        it.tvdbId &&
        slugify(it.title) === want &&
        (year == null || (it.year != null && Math.abs(it.year - year) <= 1)),
    );
    if (!hit?.tvdbId) return null;
    const claimed = await this.claimTvdbId(media.id, hit.tvdbId);
    return claimed ? hit.tvdbId : null;
  }

  /**
   * Link a TVDB series id to our media row (required before ensureShowFullTvdb, which
   * resolves the row via this external id). Never hijacks an id already linked to a
   * different media row — that would merge this show's structure into the other row.
   * Returns false when the id cannot be claimed.
   */
  private async claimTvdbId(mediaId: string, tvdbId: number): Promise<boolean> {
    const linked = await this.prisma.externalId.findFirst({
      where: {
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: String(tvdbId),
      },
      select: { mediaId: true },
    });
    if (linked) return linked.mediaId === mediaId;
    await this.prisma.externalId.create({
      data: {
        mediaId,
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: String(tvdbId),
      },
    });
    return true;
  }

  /** Real TVDB 429 (ProviderError) or internal fixed-window throttle (ProviderThrottled). */
  private isRateLimitError(e: unknown): boolean {
    return e instanceof ProviderThrottled || (isProviderError(e) && e.category === 'rate_limited');
  }

  /** Definitive provider 404 / cached 404: retrying immediately will only churn the batch. */
  private isNotFoundError(e: unknown): boolean {
    return isProviderError(e) && e.category === 'not_found';
  }

  // ---- Same-type provider duplicate repair (TVDB/IMDB-only movie row + TMDB movie row) ----
  async repairProviderDuplicateMovies(
    limit?: number,
    mode: 'dry-run' | 'repair' = 'repair',
  ): Promise<{
    mode: 'dry-run' | 'repair';
    processed: number;
    merged: number;
    attached: number;
    skipped: number;
    failed: number;
    rateLimited: number;
    skipReasons: Record<string, number>;
    sample: string[];
    outcomes: {
      sourceId: string;
      title: string;
      action: 'merge' | 'attach' | 'skip' | 'failed';
      targetId: string | null;
      tmdbId: number | null;
      reason: string;
      userDataRows: number;
    }[];
  }> {
    const empty = {
      mode,
      processed: 0,
      merged: 0,
      attached: 0,
      skipped: 0,
      failed: 0,
      rateLimited: 0,
      skipReasons: {} as Record<string, number>,
      sample: [] as string[],
      outcomes: [] as {
        sourceId: string;
        title: string;
        action: 'merge' | 'attach' | 'skip' | 'failed';
        targetId: string | null;
        tmdbId: number | null;
        reason: string;
        userDataRows: number;
      }[],
    };
    if (this.providerDuplicateRepairRunning) {
      this.logger.log('Provider duplicate movie repair already running — skipping');
      return empty;
    }
    this.providerDuplicateRepairRunning = true;
    this.trackRepair('provider-duplicates', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 200, 100000));
      const candidates = await this.prisma.$queryRaw<
        {
          id: string;
          title: string;
          tvdbId: string | null;
          imdbId: string | null;
          userDataRows: bigint;
        }[]
      >`
        SELECT m.id,
               m.title,
               (SELECT e.value FROM external_ids e
                WHERE e.media_id = m.id AND e.provider = 'THE_TVDB' AND e.provider_entity_kind = 'MOVIE'
                LIMIT 1) AS "tvdbId",
               (SELECT e.value FROM external_ids e
                WHERE e.media_id = m.id AND e.provider = 'IMDB' AND e.provider_entity_kind = 'MOVIE'
                LIMIT 1) AS "imdbId",
               (
                 (SELECT count(*) FROM user_movie_status x WHERE x.media_id = m.id) +
                 (SELECT count(*) FROM watch_history x WHERE x.media_id = m.id AND x.media_type = 'MOVIE') +
                 (SELECT count(*) FROM watchlist_items x WHERE x.media_id = m.id) +
                 (SELECT count(*) FROM favorites x WHERE x.media_id = m.id) +
                 (SELECT count(*) FROM ratings x WHERE x.media_id = m.id) +
                 (SELECT count(*) FROM reactions x WHERE x.media_id = m.id) +
                 (SELECT count(*) FROM custom_list_items x WHERE x.media_id = m.id) +
                 (SELECT count(DISTINCT x.id) FROM comments x
                    WHERE (x.thread_type = 'MOVIE' AND x.thread_id = m.id) OR x.media_id = m.id) +
                 (SELECT count(*) FROM watch_provider_alerts x WHERE x.media_id = m.id)
               )::bigint AS "userDataRows"
        FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.type = 'MOVIE'
          AND NOT EXISTS (SELECT 1 FROM external_ids tm WHERE tm.media_id = m.id AND tm.provider = 'TMDB' AND tm.provider_entity_kind = 'MOVIE')
          AND EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = m.id AND x.provider IN ('THE_TVDB','IMDB') AND x.provider_entity_kind = 'MOVIE')
          AND COALESCE(m.metadata_provenance #>> '{providerDupNoMatch,at}', '1970-01-01')::timestamptz < NOW() - INTERVAL '180 days'
        ORDER BY m.added_count DESC, m.created_at ASC
        LIMIT ${take}`;

      this.trackRepair('provider-duplicates', { total: candidates.length });
      let merged = 0;
      let attached = 0;
      let skipped = 0;
      let failed = 0;
      let rateLimited = 0;
      const skipReasons = new Map<string, number>();
      const recordSkipReason = (reason: string) => {
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      };
      const sample: string[] = [];
      const outcomes: typeof empty.outcomes = [];
      let processed = 0;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        processed = i + 1;
        this.trackRepair('provider-duplicates', {
          processed: i + 1,
          succeeded: merged + attached,
          failed,
          current: c.title,
        });
        try {
          const resolution = await this.resolveProviderDuplicateMovieTarget(c);
          // Verified TMDB id with NO local counterpart: not a duplicate at all — attach
          // the cross-id to this row (leaves the stat for good) and enrich from TMDB.
          if (resolution.attachTmdbId) {
            if (mode === 'repair') {
              await this.attachTmdbMovieId(c.id, resolution.attachTmdbId);
            }
            attached++;
            if (outcomes.length < 100) {
              outcomes.push({
                sourceId: c.id,
                title: c.title,
                action: 'attach',
                targetId: null,
                tmdbId: resolution.attachTmdbId,
                reason: resolution.reason,
                userDataRows: Number(c.userDataRows ?? 0),
              });
            }
            if (sample.length < 5) sample.push(`${c.title} (+tmdb ${resolution.attachTmdbId})`);
            continue;
          }
          if (!resolution.targetId || resolution.targetId === c.id) {
            skipped++;
            recordSkipReason(
              resolution.targetId === c.id ? 'resolved to the same row' : resolution.reason,
            );
            // Definitive "nothing to merge into" outcomes are parked for 180 days —
            // re-attempting them every run only burns provider calls. Ambiguous
            // matches are NOT parked: new data can disambiguate them.
            if (mode === 'repair' && resolution.definitive) {
              await this.stampProviderDupNoMatch(c.id, resolution.reason).catch(() => undefined);
            }
            if (outcomes.length < 100) {
              outcomes.push({
                sourceId: c.id,
                title: c.title,
                action: 'skip',
                targetId: resolution.targetId,
                tmdbId: resolution.tmdbId,
                reason: resolution.reason,
                userDataRows: Number(c.userDataRows ?? 0),
              });
            }
            continue;
          }
          if (mode === 'repair') {
            await this.mergeDuplicateMovieRows(c.id, resolution.targetId);
          }
          merged++;
          if (outcomes.length < 100) {
            outcomes.push({
              sourceId: c.id,
              title: c.title,
              action: 'merge',
              targetId: resolution.targetId,
              tmdbId: resolution.tmdbId,
              reason: resolution.reason,
              userDataRows: Number(c.userDataRows ?? 0),
            });
          }
          if (sample.length < 5) sample.push(c.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(`Provider duplicate repair rate-limited after ${i} rows`);
            break;
          }
          failed++;
          if (outcomes.length < 100) {
            outcomes.push({
              sourceId: c.id,
              title: c.title,
              action: 'failed',
              targetId: null,
              tmdbId: null,
              reason: (e as Error).message,
              userDataRows: Number(c.userDataRows ?? 0),
            });
          }
          if (failed <= 10) {
            this.logger.warn(
              `provider duplicate repair failed for ${c.title} (${c.id}): ${(e as Error).message}`,
            );
          }
        }
      }
      this.trackRepair('provider-duplicates', {
        running: false,
        processed,
        succeeded: merged + attached,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Provider duplicate movie ${mode}: ${merged} ${mode === 'repair' ? 'merged' : 'would merge'}, ${attached} ${mode === 'repair' ? 'attached' : 'would attach'}, ${skipped} skipped, ${failed} failed, ${rateLimited} rate-limited`,
      );
      if (skipReasons.size > 0) {
        this.logger.log(
          `Provider duplicate movie skip summary: ${JSON.stringify(Object.fromEntries(skipReasons))}`,
        );
      }
      return {
        mode,
        processed,
        merged,
        attached,
        skipped,
        failed,
        rateLimited,
        skipReasons: Object.fromEntries(skipReasons),
        sample,
        outcomes,
      };
    } finally {
      this.providerDuplicateRepairRunning = false;
    }
  }

  /**
   * Attach a VERIFIED TMDB movie id to a TVDB/IMDB-only row (no local row carries it, so
   * the row is not a duplicate — it just missed its cross-link). The row leaves the
   * provider-duplicates stat for good and is enriched from TMDB best-effort.
   */
  private async attachTmdbMovieId(mediaId: string, tmdbId: number): Promise<void> {
    await this.prisma.externalId.create({
      data: {
        mediaId,
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.MOVIE,
        value: String(tmdbId),
      },
    });
    this.logger.log(`Provider duplicate repair: attached TMDB movie id ${tmdbId} to ${mediaId}`);
    await this.meta.ensureMovieFull(tmdbId).catch(() => undefined);
  }

  /** Park a row whose duplicate resolution definitively found nothing to merge into
   *  (atomic jsonb merge). Parked rows leave the stat + candidate selection for 180 days. */
  private async stampProviderDupNoMatch(mediaId: string, reason: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object('providerDupNoMatch',
                 jsonb_build_object('at', ${new Date().toISOString()}::text, 'reason', ${reason}::text))
      WHERE id = ${mediaId}`;
  }

  private async resolveProviderDuplicateMovieTarget(candidate: {
    id: string;
    tvdbId: string | null;
    imdbId: string | null;
  }): Promise<{
    targetId: string | null;
    attachTmdbId: number | null;
    tmdbId: number | null;
    definitive: boolean;
    reason: string;
  }> {
    const none = (reason: string, definitive = false) => ({
      targetId: null,
      attachTmdbId: null,
      tmdbId: null,
      definitive,
      reason,
    });
    if (!this.tmdbProvider.enabled) return none('TMDB provider disabled');
    let tmdbId: number | null = null;
    let evidence = '';
    // IMDb is the strongest movie bridge and must win over a stale/unrelated TVDB id.
    if (candidate.imdbId) {
      try {
        const found = await this.tmdbProvider.findByExternalIdStrict(candidate.imdbId, 'imdb_id');
        tmdbId = found?.movie?.tmdbId ?? null;
        if (tmdbId) evidence = `IMDb ${candidate.imdbId}`;
      } catch (e) {
        if (!this.isNotFoundError(e)) throw e;
      }
    }
    // TMDB does not support TVDB movie ids in /find. Ask TVDB for its verified remote ids.
    if (!tmdbId && candidate.tvdbId && this.tvdb.enabled) {
      try {
        const identity = await this.tvdb.getMovieIdentity(Number(candidate.tvdbId));
        tmdbId = identity.tmdbId;
        if (tmdbId) evidence = `TVDB ${candidate.tvdbId} remote TMDB`;
        if (!tmdbId && identity.imdbId) {
          const found = await this.tmdbProvider.findByExternalIdStrict(identity.imdbId, 'imdb_id');
          tmdbId = found?.movie?.tmdbId ?? null;
          if (tmdbId) evidence = `TVDB ${candidate.tvdbId} remote IMDb ${identity.imdbId}`;
        }
      } catch (e) {
        // A deleted TVDB id has no remaining identity signal; title/year may still
        // identify the row. Throttle/upstream failures must stop the batch, not be
        // misreported as a definitive no-match.
        if (!this.isNotFoundError(e)) throw e;
      }
    }
    // TMDB /find does NOT index TVDB movie ids (tvdb_id maps only TV there), so TVDB-only
    // rows — the bulk of this stat — can never resolve by id. Title+year search is the
    // only id-grade evidence left for them.
    if (!tmdbId) {
      tmdbId = await this.resolveTmdbMovieIdBySearch(candidate.id);
      if (tmdbId) evidence = 'unique exact title/year TMDB search';
    }
    if (!tmdbId) {
      const meta = await this.resolveProviderDuplicateMovieTargetByMetadata(candidate.id);
      return { ...meta, attachTmdbId: null, tmdbId: null };
    }
    const target = await this.prisma.externalId.findFirst({
      where: {
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.MOVIE,
        value: String(tmdbId),
        mediaId: { not: candidate.id },
        media: { type: MediaType.MOVIE },
      },
      select: { mediaId: true },
    });
    // Verified id but no local row: not a duplicate — attach the cross-id instead of skipping.
    if (!target?.mediaId) {
      return {
        targetId: null,
        attachTmdbId: tmdbId,
        tmdbId,
        definitive: true,
        reason: `attach TMDB id (${evidence})`,
      };
    }
    return {
      targetId: target.mediaId,
      attachTmdbId: null,
      tmdbId,
      definitive: true,
      reason: `matched local TMDB movie (${evidence})`,
    };
  }

  /** Resolve a TVDB/IMDB-only movie to a TMDB movie id via /search/movie (title+year).
   *  Only an EXACTLY-one normalized-title + year hit counts — anything else is too weak. */
  private async resolveTmdbMovieIdBySearch(sourceMediaId: string): Promise<number | null> {
    const source = await this.loadDuplicateSourceRow(sourceMediaId);
    if (!source?.releaseYear) return null;
    const sourceTitles = this.normalizedDuplicateValues(source.title, source.titles, 2);
    if (sourceTitles.size === 0) return null;
    // No catch: a 429/throttle must bubble to the batch's rate-limit early break —
    // swallowing it here would read as "no match" and park rows on bad evidence.
    const res = await this.tmdbProvider.searchMovies(source.title);
    const matches = res.items.filter(
      (item) =>
        item.year === source.releaseYear &&
        (sourceTitles.has(this.normalizeDuplicateText(item.title)) ||
          (item.originalTitle
            ? sourceTitles.has(this.normalizeDuplicateText(item.originalTitle))
            : false)),
    );
    return matches.length === 1 ? matches[0].tmdbId : null;
  }

  private async loadDuplicateSourceRow(sourceMediaId: string): Promise<
    | {
        id: string;
        title: string;
        overview: string | null;
        titles: unknown;
        overviews: unknown;
        releaseYear: number | null;
        runtimeMinutes: number | null;
      }
    | undefined
  > {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        overview: string | null;
        titles: unknown;
        overviews: unknown;
        releaseYear: number | null;
        runtimeMinutes: number | null;
      }[]
    >`
      SELECT m.id,
             m.title,
             m.overview,
             m.titles,
             m.overviews,
             mv.release_year AS "releaseYear",
             mv.runtime_minutes AS "runtimeMinutes"
      FROM media_items m
      JOIN movies mv ON mv.media_id = m.id
      WHERE ${VISIBLE_MEDIA_SQL}
        AND m.id = ${sourceMediaId}`;
    return rows[0];
  }

  private async resolveProviderDuplicateMovieTargetByMetadata(
    sourceMediaId: string,
  ): Promise<{ targetId: string | null; definitive: boolean; reason: string }> {
    const source = await this.loadDuplicateSourceRow(sourceMediaId);
    if (!source) return { targetId: null, definitive: false, reason: 'source row missing' };
    if (!source.releaseYear) {
      return {
        targetId: null,
        definitive: true,
        reason: 'metadata fallback missing source release year',
      };
    }

    const sourceTitles = this.normalizedDuplicateValues(source.title, source.titles, 2);
    const sourceOverviews = this.normalizedDuplicateValues(source.overview, source.overviews, 40);
    if (sourceTitles.size === 0) {
      return { targetId: null, definitive: true, reason: 'metadata fallback missing title' };
    }

    const candidates = await this.prisma.$queryRaw<
      {
        id: string;
        title: string;
        overview: string | null;
        titles: unknown;
        overviews: unknown;
        runtimeMinutes: number | null;
      }[]
    >`
      SELECT m.id,
             m.title,
             m.overview,
             m.titles,
             m.overviews,
             mv.runtime_minutes AS "runtimeMinutes"
      FROM media_items m
      JOIN movies mv ON mv.media_id = m.id
      WHERE ${VISIBLE_MEDIA_SQL}
        AND m.type = 'MOVIE'
        AND m.id != ${sourceMediaId}
        AND mv.release_year = ${source.releaseYear}
        AND EXISTS (
          SELECT 1 FROM external_ids e
          WHERE e.media_id = m.id
            AND e.provider = 'TMDB'
            AND e.provider_entity_kind = 'MOVIE'
        )`;

    const matches = candidates.filter((candidate) => {
      const candidateTitles = this.normalizedDuplicateValues(candidate.title, candidate.titles, 2);
      if (!this.hasSetIntersection(sourceTitles, candidateTitles)) return false;
      // Overview-less sources (typical for TVDB light upserts) can't prove text identity —
      // title + year + runtime carry the match alone; with an overview, require it too.
      if (sourceOverviews.size > 0) {
        const candidateOverviews = this.normalizedDuplicateValues(
          candidate.overview,
          candidate.overviews,
          40,
        );
        if (!this.hasSetIntersection(sourceOverviews, candidateOverviews)) return false;
      }
      return this.movieRuntimeCompatible(source.runtimeMinutes, candidate.runtimeMinutes);
    });

    if (matches.length === 1) {
      return {
        targetId: matches[0].id,
        definitive: true,
        reason: 'matched local TMDB movie by metadata',
      };
    }
    if (matches.length > 1) {
      return { targetId: null, definitive: false, reason: 'metadata fallback ambiguous' };
    }
    return { targetId: null, definitive: true, reason: 'no local TMDB movie matched by metadata' };
  }

  private normalizedDuplicateValues(
    base: string | null | undefined,
    localized: unknown,
    minLength: number,
  ): Set<string> {
    const values = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value !== 'string') return;
      const normalized = this.normalizeDuplicateText(value);
      if (normalized.length >= minLength) values.add(normalized);
    };
    add(base);
    if (localized && typeof localized === 'object') {
      for (const value of Object.values(localized as Record<string, unknown>)) add(value);
    }
    return values;
  }

  private normalizeDuplicateText(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/\p{Mark}/gu, '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private hasSetIntersection(a: Set<string>, b: Set<string>): boolean {
    for (const value of a) if (b.has(value)) return true;
    return false;
  }

  private movieRuntimeCompatible(a: number | null, b: number | null): boolean {
    if (a == null || b == null) return true;
    return Math.abs(a - b) <= 2;
  }

  async repairMergedMovieThreadComments(
    sourceMediaId: string,
    targetMediaId: string,
  ): Promise<{ comments: number; externalReviews: number }> {
    if (!sourceMediaId || !targetMediaId || sourceMediaId === targetMediaId) {
      throw new BadRequestException('source and target media ids are required and must differ');
    }
    const target = await this.prisma.mediaItem.findUnique({
      where: { id: targetMediaId },
      select: { type: true },
    });
    if (!target || target.type !== MediaType.MOVIE) {
      throw new NotFoundException('target media row must be an existing movie');
    }
    // A comment can match BOTH update filters (threadId + mediaId on the source row) —
    // count the distinct rows once, up front, so the reported number is the truth.
    const comments = await this.prisma.comment.count({
      where: {
        OR: [
          { threadType: 'MOVIE', threadId: sourceMediaId },
          { mediaType: MediaType.MOVIE, mediaId: sourceMediaId },
        ],
      },
    });
    const [, , externalReviews] = await this.prisma.$transaction([
      this.prisma.comment.updateMany({
        where: { threadType: 'MOVIE', threadId: sourceMediaId },
        data: { threadId: targetMediaId },
      }),
      this.prisma.comment.updateMany({
        where: { mediaType: MediaType.MOVIE, mediaId: sourceMediaId },
        data: { mediaId: targetMediaId },
      }),
      this.prisma.externalReview.updateMany({
        where: { mediaId: sourceMediaId },
        data: { mediaId: targetMediaId },
      }),
    ]);
    this.logger.log(
      `Repointed ${comments} movie comments and ${externalReviews.count} external reviews from ${sourceMediaId} to ${targetMediaId}`,
    );
    return { comments, externalReviews: externalReviews.count };
  }

  async clearMovieThreadSelfAttachments(targetMediaId: string): Promise<{ comments: number }> {
    if (!targetMediaId) throw new BadRequestException('target media id is required');
    const target = await this.prisma.mediaItem.findUnique({
      where: { id: targetMediaId },
      select: { type: true },
    });
    if (!target || target.type !== MediaType.MOVIE) {
      throw new NotFoundException('target media row must be an existing movie');
    }
    const res = await this.prisma.comment.updateMany({
      where: {
        threadType: 'MOVIE',
        threadId: targetMediaId,
        mediaType: MediaType.MOVIE,
        mediaId: targetMediaId,
      },
      data: { mediaType: null, mediaId: null },
    });
    this.logger.log(`Cleared ${res.count} self-attachments from movie thread ${targetMediaId}`);
    return { comments: res.count };
  }

  private async mergeDuplicateMovieRows(
    sourceMediaId: string,
    targetMediaId: string,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx: any) => {
        const [source, target] = await Promise.all([
          tx.mediaItem.findUnique({
            where: { id: sourceMediaId },
            select: { type: true, title: true },
          }),
          tx.mediaItem.findUnique({
            where: { id: targetMediaId },
            select: { type: true, title: true },
          }),
        ]);
        if (!source || !target) throw new Error('source or target media row missing');
        if (source.type !== MediaType.MOVIE || target.type !== MediaType.MOVIE) {
          throw new Error('provider duplicate merge only supports movie rows');
        }

        // Preflight every source movie character vote before mutating anything. The source
        // row must not be deleted unless its role can be proven on the canonical movie.
        const sourceVotes = await tx.characterVote.findMany({
          where: { mediaId: sourceMediaId },
          include: { cast: { include: { externalIds: true, castMember: true } } },
        });
        const voteTransfers: Array<{
          voteId: string;
          targetCastId: string;
          duplicate: boolean;
          aliases: Array<{ provider: ExternalProvider; value: string }>;
        }> = [];
        const normRole = (value: string | null | undefined) =>
          String(value ?? '')
            .normalize('NFKD')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
        for (const vote of sourceVotes) {
          const aliasOr = vote.cast.externalIds.map((alias: any) => ({
            provider: alias.provider,
            value: alias.value,
          }));
          let targetCast = aliasOr.length
            ? await tx.mediaCast.findFirst({
                where: { mediaId: targetMediaId, externalIds: { some: { OR: aliasOr } } },
                select: { id: true },
              })
            : null;
          if (!targetCast && vote.cast.castMember.externalId) {
            const candidates = await tx.mediaCast.findMany({
              where: {
                mediaId: targetMediaId,
                castMember: { externalId: vote.cast.castMember.externalId },
              },
              select: { id: true, character: true },
            });
            const sourceRole = normRole(vote.cast.character);
            targetCast =
              candidates.find((candidate: any) => {
                const candidateRole = normRole(candidate.character);
                return (
                  sourceRole &&
                  candidateRole &&
                  (sourceRole === candidateRole ||
                    sourceRole.includes(candidateRole) ||
                    candidateRole.includes(sourceRole))
                );
              }) ?? null;
          }
          if (!targetCast) {
            throw new Error(
              `cannot merge duplicate movie: character vote ${vote.id} has no proven target role`,
            );
          }
          const existingTargetVote = await tx.characterVote.findUnique({
            where: { userId_mediaId: { userId: vote.userId, mediaId: targetMediaId } },
            select: { castId: true },
          });
          if (existingTargetVote && existingTargetVote.castId !== targetCast.id) {
            throw new Error(
              `cannot merge duplicate movie: user ${vote.userId} has conflicting character votes`,
            );
          }
          voteTransfers.push({
            voteId: vote.id,
            targetCastId: targetCast.id,
            duplicate: !!existingTargetVote,
            aliases: vote.cast.externalIds.map((alias: any) => ({
              provider: alias.provider,
              value: alias.value,
            })),
          });
        }
        for (const transfer of voteTransfers) {
          for (const alias of transfer.aliases) {
            await tx.mediaCastExternalId.upsert({
              where: {
                mediaId_provider_value: {
                  mediaId: targetMediaId,
                  provider: alias.provider,
                  value: alias.value,
                },
              },
              create: {
                mediaId: targetMediaId,
                castId: transfer.targetCastId,
                provider: alias.provider,
                value: alias.value,
              },
              update: { castId: transfer.targetCastId },
            });
          }
          if (transfer.duplicate) {
            await tx.characterVote.delete({ where: { id: transfer.voteId } });
          } else {
            await tx.characterVote.update({
              where: { id: transfer.voteId },
              data: { mediaId: targetMediaId, castId: transfer.targetCastId },
            });
          }
        }

        await tx.$executeRaw`
          UPDATE external_ids e
          SET media_id = ${targetMediaId}
          WHERE e.media_id = ${sourceMediaId}
            AND NOT EXISTS (
              SELECT 1 FROM external_ids t
              WHERE t.media_id = ${targetMediaId}
                AND t.provider = e.provider
                AND t.provider_entity_kind = e.provider_entity_kind
                AND t.value = e.value
            )`;

        await tx.$executeRaw`
          UPDATE user_movie_status s
          SET media_id = ${targetMediaId}
          WHERE s.media_id = ${sourceMediaId}
            AND NOT EXISTS (
              SELECT 1 FROM user_movie_status t
              WHERE t.media_id = ${targetMediaId} AND t.user_id = s.user_id
            )`;
        await tx.$executeRaw`
          UPDATE user_movie_status t
          SET watched = (t.watched OR s.watched),
              watched_at = LEAST(COALESCE(t.watched_at, s.watched_at), COALESCE(s.watched_at, t.watched_at)),
              watch_count = GREATEST(t.watch_count, s.watch_count),
              updated_at = NOW()
          FROM user_movie_status s
          WHERE s.media_id = ${sourceMediaId}
            AND t.media_id = ${targetMediaId}
            AND t.user_id = s.user_id`;
        await tx.userMovieStatus.deleteMany({ where: { mediaId: sourceMediaId } });

        await tx.watchHistory.updateMany({
          where: { mediaId: sourceMediaId, mediaType: MediaType.MOVIE },
          data: { mediaId: targetMediaId },
        });

        await tx.$executeRaw`
          UPDATE watchlist_items w SET media_id = ${targetMediaId}
          WHERE w.media_id = ${sourceMediaId}
            AND NOT EXISTS (SELECT 1 FROM watchlist_items t WHERE t.media_id = ${targetMediaId} AND t.user_id = w.user_id)`;
        await tx.$executeRaw`
          UPDATE watchlist_items t
          SET priority = GREATEST(t.priority, s.priority),
              created_at = LEAST(t.created_at, s.created_at)
          FROM watchlist_items s
          WHERE s.media_id = ${sourceMediaId}
            AND t.media_id = ${targetMediaId}
            AND t.user_id = s.user_id`;
        await tx.watchlistItem.deleteMany({ where: { mediaId: sourceMediaId } });

        await tx.$executeRaw`
          UPDATE favorites f SET media_id = ${targetMediaId}
          WHERE f.media_id = ${sourceMediaId}
            AND NOT EXISTS (SELECT 1 FROM favorites t WHERE t.media_id = ${targetMediaId} AND t.user_id = f.user_id)`;
        await tx.$executeRaw`
          UPDATE favorites t
          SET created_at = LEAST(t.created_at, s.created_at)
          FROM favorites s
          WHERE s.media_id = ${sourceMediaId}
            AND t.media_id = ${targetMediaId}
            AND t.user_id = s.user_id`;
        await tx.favorite.deleteMany({ where: { mediaId: sourceMediaId } });

        await tx.$executeRaw`
          UPDATE ratings t
          SET rating = s.rating,
              source = s.source,
              source_key = s.source_key,
              created_at = LEAST(t.created_at, s.created_at),
              updated_at = GREATEST(t.updated_at, s.updated_at)
          FROM ratings s
          WHERE s.media_id = ${sourceMediaId}
            AND t.media_id = ${targetMediaId}
            AND t.user_id = s.user_id
            AND s.updated_at > t.updated_at`;
        await tx.$executeRaw`
          UPDATE ratings r SET media_id = ${targetMediaId}
          WHERE r.media_id = ${sourceMediaId}
            AND NOT EXISTS (SELECT 1 FROM ratings t WHERE t.media_id = ${targetMediaId} AND t.user_id = r.user_id)`;
        await tx.rating.deleteMany({ where: { mediaId: sourceMediaId } });

        await tx.$executeRaw`
          UPDATE reactions t
          SET source = CASE
                WHEN COALESCE(s.updated_at, s.created_at) > COALESCE(t.updated_at, t.created_at)
                THEN s.source ELSE t.source END,
              source_key = CASE
                WHEN COALESCE(s.updated_at, s.created_at) > COALESCE(t.updated_at, t.created_at)
                THEN s.source_key ELSE t.source_key END,
              updated_at = GREATEST(
                COALESCE(t.updated_at, t.created_at),
                COALESCE(s.updated_at, s.created_at)
              )
          FROM reactions s
          WHERE s.media_id = ${sourceMediaId}
            AND t.media_id = ${targetMediaId}
            AND t.user_id = s.user_id
            AND t.reaction = s.reaction`;
        await tx.$executeRaw`
          UPDATE reactions r SET media_id = ${targetMediaId}
          WHERE r.media_id = ${sourceMediaId}
            AND NOT EXISTS (
              SELECT 1 FROM reactions t
              WHERE t.media_id = ${targetMediaId} AND t.user_id = r.user_id AND t.reaction = r.reaction
            )`;
        await tx.reaction.deleteMany({ where: { mediaId: sourceMediaId } });

        await tx.$executeRaw`
          UPDATE custom_list_items i SET media_id = ${targetMediaId}
          WHERE i.media_id = ${sourceMediaId}
            AND NOT EXISTS (SELECT 1 FROM custom_list_items t WHERE t.media_id = ${targetMediaId} AND t.list_id = i.list_id)`;
        await tx.$executeRaw`
          UPDATE custom_list_items t
          SET "order" = LEAST(t."order", s."order"),
              created_at = LEAST(t.created_at, s.created_at)
          FROM custom_list_items s
          WHERE s.media_id = ${sourceMediaId}
            AND t.media_id = ${targetMediaId}
            AND t.list_id = s.list_id`;
        await tx.customListItem.deleteMany({ where: { mediaId: sourceMediaId } });

        await tx.comment.updateMany({
          where: { threadType: 'MOVIE', threadId: sourceMediaId },
          data: { threadId: targetMediaId },
        });
        await tx.comment.updateMany({
          where: { mediaType: MediaType.MOVIE, mediaId: sourceMediaId },
          data: { mediaId: targetMediaId },
        });
        await tx.externalReview.updateMany({
          where: { mediaId: sourceMediaId },
          data: { mediaId: targetMediaId },
        });
        // These are audit/progress references rather than foreign keys. Repoint them
        // explicitly so historical import/admin reports do not link to a deleted row.
        await tx.importItem.updateMany({
          where: { matchedMediaId: sourceMediaId },
          data: { matchedMediaId: targetMediaId },
        });
        await tx.hydrationJobItem.updateMany({
          where: { mediaId: sourceMediaId },
          data: { mediaId: targetMediaId },
        });

        // Watch-provider alerts are user-owned movie data too. Their uniqueness includes
        // mediaId, so merge collisions explicitly instead of letting the source cascade.
        const sourceAlerts = await tx.watchProviderAlert.findMany({
          where: { mediaId: sourceMediaId },
        });
        for (const sourceAlert of sourceAlerts) {
          const targetAlert = await tx.watchProviderAlert.findFirst({
            where: {
              userId: sourceAlert.userId,
              mediaId: targetMediaId,
              offerType: sourceAlert.offerType,
            },
          });
          if (!targetAlert) {
            await tx.watchProviderAlert.update({
              where: { id: sourceAlert.id },
              data: { mediaId: targetMediaId },
            });
            continue;
          }
          const sourceIsNewer = sourceAlert.createdAt > targetAlert.createdAt;
          const newer = sourceIsNewer ? sourceAlert : targetAlert;
          const sameCountry = sourceAlert.country === targetAlert.country;
          const providerIds = sameCountry
            ? sourceAlert.providerIds.length === 0 || targetAlert.providerIds.length === 0
              ? []
              : [...new Set([...targetAlert.providerIds, ...sourceAlert.providerIds])]
            : newer.providerIds;
          const notifiedAt =
            sourceAlert.notifiedAt && targetAlert.notifiedAt
              ? sourceAlert.notifiedAt > targetAlert.notifiedAt
                ? sourceAlert.notifiedAt
                : targetAlert.notifiedAt
              : (sourceAlert.notifiedAt ?? targetAlert.notifiedAt);
          await tx.watchProviderAlert.update({
            where: { id: targetAlert.id },
            data: {
              active: sourceAlert.active || targetAlert.active,
              country: newer.country,
              providerIds,
              createdAt:
                sourceAlert.createdAt < targetAlert.createdAt
                  ? sourceAlert.createdAt
                  : targetAlert.createdAt,
              notifiedAt,
            },
          });
          await tx.watchProviderAlert.delete({ where: { id: sourceAlert.id } });
        }

        await tx.mediaItem.delete({ where: { id: sourceMediaId } });
      },
      { timeout: 60_000 },
    );
    this.logger.log(`Merged duplicate movie ${sourceMediaId} into ${targetMediaId}`);
  }

  // ---- Structural type mismatch repair (admin button) ----

  /**
   * Split cross-type contaminated records: a MOVIE row that carries a `shows` row (or a
   * SHOW row carrying a `movies` row) — two entities merged into one by a cross-namespace
   * id confusion (e.g. TVDB series 280103 attached to TMDB movie 62211).
   *
   * Per row: the cross-type entity is re-created correctly (detach the stray-kind
   * external id → fresh hydration), user watch data on the stray episodes is remapped
   * onto it (StructureRemapService, conservative matching — unmapped rows keep the stray
   * structure alive instead of losing data), then the contaminated row is rehydrated
   * from its OWN provider to restore its base metadata.
   */
  async repairTypeMismatches(): Promise<{
    processed: number;
    repaired: number;
    skipped: number;
    failed: number;
  }> {
    const empty = { processed: 0, repaired: 0, skipped: 0, failed: 0 };
    if (this.typeRepairRunning) {
      this.logger.log('Type mismatch repair already running — skipping');
      return empty;
    }
    this.typeRepairRunning = true;
    try {
      // User-data type mismatches first: movie statuses/history written onto SHOW rows
      // (e.g. by a mis-tagged import item). These rows are provably garbage — a movie
      // status/history on a show can never be legitimate — and hide shows under My Movies.
      const [statusDel, historyDel] = await this.prisma.$transaction([
        this.prisma.userMovieStatus.deleteMany({ where: { media: { type: 'SHOW' } } }),
        this.prisma.watchHistory.deleteMany({
          where: { mediaType: 'MOVIE', media: { type: 'SHOW' } },
        }),
      ]);
      if (statusDel.count + historyDel.count > 0) {
        this.logger.log(
          `Type mismatch repair: removed ${statusDel.count} movie statuses + ${historyDel.count} movie history rows on shows`,
        );
      }

      const mismatches = await this.prisma.mediaItem.findMany({
        where: {
          ...VISIBLE_MEDIA_WHERE,
          OR: [
            { type: 'MOVIE', show: { isNot: null } },
            { type: 'SHOW', movie: { isNot: null } },
          ],
        },
        include: { externalIds: true },
        orderBy: { createdAt: 'asc' },
      });

      let repaired = 0;
      let skipped = 0;
      let failed = 0;
      for (const m of mismatches) {
        try {
          const ok = await this.repairOneMismatch(
            m.id,
            m.type,
            m.title,
            m.externalIds as unknown as {
              provider: ExternalProvider;
              providerEntityKind: ProviderEntityKind;
              value: string;
            }[],
          );
          if (ok) repaired++;
          else skipped++;
        } catch (e) {
          failed++;
          this.logger.warn(
            `type mismatch repair failed for ${m.title} (${m.id}): ${(e as Error).message}`,
          );
        }
      }
      this.logger.log(
        `Type mismatch repair: ${repaired}/${mismatches.length} repaired, ${skipped} skipped, ${failed} failed`,
      );
      return { processed: mismatches.length, repaired, skipped, failed };
    } finally {
      this.typeRepairRunning = false;
    }
  }

  /** One contaminated row → true when fully repaired, false when skipped (needs a human). */
  private async repairOneMismatch(
    mediaId: string,
    type: string,
    title: string,
    externalIds: {
      provider: ExternalProvider;
      providerEntityKind: ProviderEntityKind;
      value: string;
    }[],
  ): Promise<boolean> {
    const isMovieRow = type === MediaType.MOVIE;
    // The cross-type entity's identity: the external id whose KIND matches the stray
    // structure (SERIES id on a MOVIE row, MOVIE id on a SHOW row).
    const strayKind = isMovieRow ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const ownKind = isMovieRow ? ProviderEntityKind.MOVIE : ProviderEntityKind.SERIES;
    const strayExt =
      externalIds.find(
        (e) => e.provider === ExternalProvider.THE_TVDB && e.providerEntityKind === strayKind,
      ) ??
      externalIds.find(
        (e) => e.provider === ExternalProvider.TMDB && e.providerEntityKind === strayKind,
      );
    const ownExt =
      externalIds.find(
        (e) => e.provider === ExternalProvider.TMDB && e.providerEntityKind === ownKind,
      ) ??
      externalIds.find(
        (e) => e.provider === ExternalProvider.THE_TVDB && e.providerEntityKind === ownKind,
      );

    if (!strayExt) {
      // No identity to rebuild the cross-type entity from: remove the stray structural
      // row only when it carries NO episodes with user data.
      if (isMovieRow && (await this.strayShowHasUserData(mediaId))) return false;
      await this.deleteStrayStructure(mediaId, isMovieRow);
      this.logger.log(
        `type mismatch: removed stray structure on ${title} (${mediaId}) — no cross-type id`,
      );
      return true;
    }

    // 1. Detach the stray-kind external id GLOBALLY (it may be parked on any row — the
    // recreated entity must be able to claim it). Re-attached to this row on failure so a
    // retry can resolve the cross-type entity again.
    const detached = await this.prisma.externalId.deleteMany({
      where: {
        provider: strayExt.provider,
        providerEntityKind: strayExt.providerEntityKind,
        value: strayExt.value,
      },
    });
    try {
      // 2. Recreate the cross-type entity correctly from its own provider.
      const newEntityId =
        strayExt.provider === ExternalProvider.THE_TVDB
          ? isMovieRow
            ? await this.meta.ensureShowFullTvdb(Number(strayExt.value))
            : await this.meta.ensureMovieFullTvdb(Number(strayExt.value))
          : isMovieRow
            ? await this.meta.ensureShowFull(Number(strayExt.value))
            : await this.meta.ensureMovieFull(Number(strayExt.value));

      // 3. Transfer watch data from the stray episodes onto the new entity.
      if (isMovieRow) {
        const remap = await this.structureRemap.remapEpisodesToMedia(mediaId, newEntityId);
        // Safety net independent of the remap result: NEVER delete the stray structure
        // while any of its episodes still carries user data — e.g. when the new entity
        // came back with 0 episodes (partial provider fetch) the remap early-exits with
        // unmapped=0 and the data would cascade away silently.
        const remaining = await this.strayShowHasUserData(mediaId);
        if (remap.unmapped > 0 || remaining) {
          this.logger.warn(
            `type mismatch: ${title} (${mediaId}) split into ${newEntityId}, but ${remap.unmapped} episodes kept unmapped user data — stray shows row retained`,
          );
          return false; // stray shows row must stay (holds user data)
        }
      }

      // 4. Remove the now-empty stray structure, then restore the row's own base metadata.
      await this.deleteStrayStructure(mediaId, isMovieRow);
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: { metadataRefreshedAt: null },
      });
      if (ownExt) {
        if (isMovieRow) {
          if (ownExt.provider === ExternalProvider.TMDB)
            await this.meta.ensureMovieFull(Number(ownExt.value));
          else await this.meta.ensureMovieFullTvdb(Number(ownExt.value));
        } else {
          if (ownExt.provider === ExternalProvider.TMDB)
            await this.meta.ensureShowFull(Number(ownExt.value));
          else await this.meta.ensureShowFullTvdb(Number(ownExt.value));
        }
      }
      this.logger.log(
        `type mismatch: split ${title} (${mediaId}) — cross-type entity is ${newEntityId}`,
      );
      return true;
    } catch (e) {
      // Restore the detached id so the next run can resolve the cross-type entity again.
      if (detached.count > 0) {
        await this.prisma.externalId
          .create({
            data: {
              mediaId,
              provider: strayExt.provider,
              providerEntityKind: strayExt.providerEntityKind,
              value: strayExt.value,
            },
          })
          .catch(() => undefined);
      }
      throw e;
    }
  }

  /** Any user data (status/rating/reaction/vote/comment) on episodes of a media's shows row? */
  private async strayShowHasUserData(mediaId: string): Promise<boolean> {
    const episodeScope = { episode: { season: { show: { mediaId } } } };
    const [statuses, ratings, reactions, votes, comments] = await Promise.all([
      this.prisma.userEpisodeStatus.count({ where: { ...episodeScope }, take: 1 }),
      this.prisma.rating.count({ where: { ...episodeScope }, take: 1 }),
      this.prisma.reaction.count({ where: { ...episodeScope }, take: 1 }),
      this.prisma.characterVote.count({ where: { ...episodeScope }, take: 1 }),
      // Comments key episodes by thread_id string (no FK relation) — raw count instead.
      this.countEpisodeThreadComments(mediaId),
    ]);
    return statuses + ratings + reactions + votes + comments > 0;
  }

  /** Episode-thread comments for any episode of a media's shows row. */
  private async countEpisodeThreadComments(mediaId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ c: bigint }[]>`
      SELECT count(*)::bigint AS c FROM comments cm
      JOIN episodes e ON cm.thread_id = e.id
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE cm.thread_type = 'EPISODE' AND sh.media_id = ${mediaId}`;
    return Number(rows?.[0]?.c ?? 0);
  }

  /** Delete the stray structural row (shows on a MOVIE row cascades seasons+episodes). */
  private async deleteStrayStructure(mediaId: string, isMovieRow: boolean): Promise<void> {
    if (isMovieRow) await this.prisma.show.delete({ where: { mediaId } }).catch(() => undefined);
    else await this.prisma.movie.delete({ where: { mediaId } }).catch(() => undefined);
  }

  // ---- Cast character-id backfill (admin button) ----

  private terminalSkipUnresolvableCharacterVotes(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE import_items ii
      SET status='SKIPPED',
          error_message='Character vote skipped: matched show has no TVDB series identity',
          updated_at=NOW()
      FROM imports i
      WHERE i.id=ii.import_id AND i.status='COMPLETED'
        AND ii.source_entity_type='EPISODE_CHARACTER_VOTE'
        AND ii.status='PENDING_MATCH'
        AND NOT EXISTS (
          SELECT 1 FROM external_ids x WHERE x.media_id=ii.matched_media_id
            AND x.provider='THE_TVDB' AND x.provider_entity_kind='SERIES')`;
  }

  /**
   * Fill `media_cast.characterExternalId` (TVDB character ids) for shows whose cast rows
   * predate the field. One full TVDB hydration per show — the cast rewrite fills every
   * role at once; never per-character calls. Powers TVTime character-vote resolution.
   * Also re-hydrates shows hydrated with the OLD top-20 cast slice (exactly 20 cast
   * rows, ids present — the old cap's fingerprint). CAST_ONLY stores the normal top 40
   * plus every staged imported character found in TVDB's full response, so rank 41+
   * votes resolve without permanently storing an unbounded cast. Stops on rate limits.
   */
  async backfillCharacterIds(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    parked: number;
    terminalSkipped: number;
    sample: string[];
  }> {
    const empty = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
      parked: 0,
      terminalSkipped: 0,
      sample: [] as string[],
    };
    if (this.charIdFixRunning) {
      this.logger.log('Character-id backfill already running — skipping');
      return empty;
    }
    // This terminal path needs no provider call and is valid even when TVDB is not
    // configured: without a TVDB series identity the staged character id has no
    // namespace in which it can ever resolve.
    empty.terminalSkipped = Number(await this.terminalSkipUnresolvableCharacterVotes());
    if (!this.tvdb.enabled) {
      this.logger.warn('TVDB not configured — skipping character-id backfill');
      return empty;
    }
    this.charIdFixRunning = true;
    this.trackRepair('character-ids', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      // Two cohorts: (a) cast with NO character ids (predates the field); (b) exactly
      // 20 cast rows WITH ids and never widened — the old slice(0,20) cap's fingerprint
      // (a show with a genuinely 20-person cast is handled by the castWidenedAt stamp:
      // one idempotent rehydration, then it leaves the cohort). Most-popular first.
      const candidates = await this.prisma.$queryRaw<
        { id: string; title: string; type: string; tvdb_id: string | null }[]
      >`
        WITH candidates AS (
          SELECT m.id, m.title, m.type::text AS type, m.popularity,
            (SELECT e.value FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB'
               AND e.provider_entity_kind = 'SERIES' LIMIT 1) AS tvdb_id
          FROM media_items m
          JOIN shows sh ON sh.media_id=m.id
          WHERE ${VISIBLE_MEDIA_SQL}
            AND m.type = 'SHOW'
            AND (
              EXISTS (
                SELECT 1 FROM import_items ii JOIN imports i ON i.id=ii.import_id
                WHERE ii.matched_media_id=m.id
                  AND ii.source_entity_type='EPISODE_CHARACTER_VOTE'
                  AND ii.status='PENDING_MATCH' AND i.status='COMPLETED'
              )
              OR (
                sh.structure_provider='TVDB'::"StructureProvider"
                AND EXISTS (SELECT 1 FROM media_cast mc WHERE mc.media_id = m.id)
                AND NOT EXISTS (SELECT 1 FROM media_cast mc WHERE mc.media_id = m.id AND mc.character_external_id IS NOT NULL)
              )
              OR (
                (SELECT count(*) FROM media_cast mc WHERE mc.media_id = m.id) = 20
                AND m.metadata_provenance->>'castWidenedAt' IS NULL
              )
            )
            AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB'
                          AND e.provider_entity_kind = 'SERIES')
            AND COALESCE(m.metadata_provenance->>'charIdsCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'
          UNION ALL
          SELECT m.id, m.title, m.type::text AS type, m.popularity, NULL::text AS tvdb_id
          FROM media_items m
          WHERE ${VISIBLE_MEDIA_SQL}
            AND m.type='MOVIE'
            AND EXISTS (
              SELECT 1 FROM import_items ii JOIN imports i ON i.id=ii.import_id
              WHERE ii.matched_media_id=m.id
                AND ii.source_entity_type='MOVIE_CHARACTER_VOTE'
                AND ii.status='PENDING_MATCH' AND i.status='COMPLETED'
            )
        )
        SELECT id, title, type, tvdb_id FROM candidates
        ORDER BY popularity DESC
        LIMIT ${Math.max(1, Math.min(limit ?? 500, 100000))}
      `;

      this.trackRepair('character-ids', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      let parked = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('character-ids', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          // This is a scoped supplemental TVDB read. It must never write seasons or
          // change the show's structural owner, and it should not age the base metadata.
          if (m.type === 'MOVIE') {
            await this.meta.enrichMovieCastForPendingVotes(m.id);
          } else {
            await this.meta.ensureShowFullTvdb(Number(m.tvdb_id), undefined, {
              skipClassification: true,
              forceRefresh: true,
              writeScope: 'CAST_ONLY',
            });
          }
          // Stamp the =20 cohort: a show still at exactly 20 cast rows AFTER a widened
          // rehydration genuinely has 20 actors — the stamp stops it from being
          // re-hydrated by every future backfill run.
          if (m.type === 'SHOW')
            await this.prisma.$executeRaw`
            UPDATE media_items
            SET metadata_provenance = jsonb_set(
                  COALESCE(metadata_provenance, '{}'::jsonb),
                  '{castWidenedAt}', to_jsonb(NOW()::text))
            WHERE id = ${m.id}`;
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(
              `Character-id backfill rate-limited after ${i} shows — deferring the rest`,
            );
            break;
          }
          if (this.isNotFoundError(e)) {
            // Dead TVDB series id — the rehydration can never succeed. Park 90 days.
            await this.stampRepairChecked(m.id, 'charIdsCheckedAt');
            parked++;
            this.logger.debug(`character-id backfill parked ${m.title}: ${(e as Error).message}`);
            continue;
          }
          failed++;
          this.logger.debug(`character-id backfill failed for ${m.title}: ${(e as Error).message}`);
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `Character-id backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`,
          );
        }
      }
      this.trackRepair('character-ids', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Character-id backfill: ${succeeded}/${candidates.length} rehydrated, ${failed} failed, ${rateLimited} rate-limited, ${parked} parked (404), ${empty.terminalSkipped} pending votes terminally skipped`,
      );
      return {
        processed: candidates.length,
        succeeded,
        failed,
        rateLimited,
        parked,
        terminalSkipped: empty.terminalSkipped,
        sample,
      };
    } finally {
      this.charIdFixRunning = false;
    }
  }

  // ---- Cast deduplication ----

  /** Same lock key as MediaMetadataService.withMediaWriteLock — dedup and hydration
   *  of the same media are mutually exclusive. */
  private async withCastDedupLock<T>(
    mediaId: string,
    fn: () => Promise<T>,
    ttlMs = 45_000,
  ): Promise<T> {
    const client = (this.redis as any)?.client;
    if (!client?.set) return fn(); // Redis unavailable (tests/degraded env) — proceed.
    const lockKey = `LOCK:hydrate:media:${mediaId}`;
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const release = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
    const deadline = Date.now() + Math.max(60_000, ttlMs);
    while (Date.now() < deadline) {
      const acquired =
        (await client.set(lockKey, token, 'PX', ttlMs, 'NX').catch(() => null)) === 'OK';
      if (acquired) {
        try {
          return await fn();
        } finally {
          await client.eval(release, 1, lockKey, token).catch(() => undefined);
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`cast-dedup: timed out waiting for hydration lock on ${mediaId}`);
  }

  /** Media ids having any likely-duplicate cast group (same person record, same TVDB
   *  character id, or same normalized person+character name — including prefix variants
   *  like "Matt Murdock" vs "Matt Murdock / Daredevil" — appearing more than once). */
  private async findCastDuplicateMediaIds(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ media_id: string }[]>`
      SELECT x.media_id FROM (
        SELECT media_id, cast_member_id::text AS k FROM media_cast
          GROUP BY media_id, cast_member_id HAVING count(*) > 1
        UNION
        SELECT media_id, 'ce:' || character_external_id::text FROM media_cast
          WHERE character_external_id IS NOT NULL
          GROUP BY media_id, character_external_id HAVING count(*) > 1
        UNION
        SELECT mc.media_id, 'n:' || lower(cm.name) || '|' || lower(COALESCE(mc.character, ''))
          FROM media_cast mc JOIN cast_members cm ON cm.id = mc.cast_member_id
          GROUP BY mc.media_id, lower(cm.name), lower(COALESCE(mc.character, ''))
          HAVING count(*) > 1
        UNION
        SELECT mc.media_id, 'nb:' || lower(cm.name) || '|' || btrim(lower(split_part(COALESCE(mc.character, ''), '/', 1)))
          FROM media_cast mc JOIN cast_members cm ON cm.id = mc.cast_member_id
          GROUP BY mc.media_id, lower(cm.name), btrim(lower(split_part(COALESCE(mc.character, ''), '/', 1)))
          HAVING count(*) > 1
        UNION
        -- Same actor, DIFFERENT character strings, mixed provider origins (at least one
        -- TVDB-sourced row and at least one TMDB-sourced row) — the "Juliette" vs
        -- "Juliette Nichols" cross-provider case. The in-memory grouping applies the
        -- word-prefix rule precisely; this is the coarse candidate filter.
        SELECT mc.media_id, 'sim:' || lower(cm.name)
          FROM media_cast mc JOIN cast_members cm ON cm.id = mc.cast_member_id
          GROUP BY mc.media_id, lower(cm.name)
          HAVING count(*) > 1
            AND count(DISTINCT lower(COALESCE(mc.character, ''))) > 1
            AND bool_or(mc.character_external_id IS NOT NULL OR starts_with(COALESCE(cm.external_id, ''), 'TVDB_'))
            AND bool_or(mc.character_external_id IS NULL AND starts_with(COALESCE(cm.external_id, ''), 'TMDB_'))
      ) x
      JOIN media_items m ON m.id = x.media_id
      WHERE ${VISIBLE_MEDIA_SQL}
      GROUP BY x.media_id
      LIMIT ${limit}`;
    return rows.map((r) => r.media_id);
  }

  /** Counts for the Metadata Health page. All set-based (single passes with hash
   *  aggregates) — correlated EXISTS/self-join variants of these queries were
   *  measured to hang the endpoint on prod-sized catalogs. */
  async getCastDuplicateStats(): Promise<{
    castDuplicateMedia: number;
    castDuplicateRows: number;
    castDuplicateVotes: number;
  }> {
    const [media] = await this.prisma.$queryRaw<{ c: bigint }[]>`
      SELECT count(*)::bigint AS c FROM (
        SELECT media_id FROM (
          SELECT media_id, cast_member_id::text AS k FROM media_cast
            GROUP BY media_id, cast_member_id HAVING count(*) > 1
          UNION
          SELECT media_id, 'ce:' || character_external_id::text FROM media_cast
            WHERE character_external_id IS NOT NULL
            GROUP BY media_id, character_external_id HAVING count(*) > 1
          UNION
          SELECT mc.media_id, 'n:' || lower(cm.name) || '|' || lower(COALESCE(mc.character, ''))
            FROM media_cast mc JOIN cast_members cm ON cm.id = mc.cast_member_id
            GROUP BY mc.media_id, lower(cm.name), lower(COALESCE(mc.character, ''))
            HAVING count(*) > 1
          UNION
          SELECT mc.media_id, 'nb:' || lower(cm.name) || '|' || btrim(lower(split_part(COALESCE(mc.character, ''), '/', 1)))
            FROM media_cast mc JOIN cast_members cm ON cm.id = mc.cast_member_id
            GROUP BY mc.media_id, lower(cm.name), btrim(lower(split_part(COALESCE(mc.character, ''), '/', 1)))
            HAVING count(*) > 1
          UNION
          SELECT mc.media_id, 'sim:' || lower(cm.name)
            FROM media_cast mc JOIN cast_members cm ON cm.id = mc.cast_member_id
            GROUP BY mc.media_id, lower(cm.name)
            HAVING count(*) > 1
              AND count(DISTINCT lower(COALESCE(mc.character, ''))) > 1
              AND bool_or(mc.character_external_id IS NOT NULL OR starts_with(COALESCE(cm.external_id, ''), 'TVDB_'))
              AND bool_or(mc.character_external_id IS NULL AND starts_with(COALESCE(cm.external_id, ''), 'TMDB_'))
        ) x
        JOIN media_items m ON m.id = x.media_id
        WHERE ${VISIBLE_MEDIA_SQL}
        GROUP BY x.media_id
      ) y`;
    const [rows] = await this.prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COALESCE(sum(cnt - 1), 0)::bigint AS c FROM (
        SELECT media_id, count(*) AS cnt FROM media_cast GROUP BY media_id, cast_member_id HAVING count(*) > 1
        UNION ALL
        SELECT media_id, count(*) FROM media_cast WHERE character_external_id IS NOT NULL
          GROUP BY media_id, character_external_id HAVING count(*) > 1
      ) z
      JOIN media_items m ON m.id = z.media_id
      WHERE ${VISIBLE_MEDIA_SQL}`;
    // Votes on rows belonging to any exact-duplicate group (member- or character-id
    // based) — set-based: duplicate keys first, then a plain join to votes.
    const [votes] = await this.prisma.$queryRaw<{ c: bigint }[]>`
      WITH dup_rows AS (
        SELECT a.id
        FROM media_cast a
        JOIN media_items m ON m.id = a.media_id
        JOIN (
          SELECT media_id, cast_member_id FROM media_cast
          GROUP BY media_id, cast_member_id HAVING count(*) > 1
        ) d ON d.media_id = a.media_id AND d.cast_member_id = a.cast_member_id
        WHERE ${VISIBLE_MEDIA_SQL}
        UNION
        SELECT a.id
        FROM media_cast a
        JOIN media_items m ON m.id = a.media_id
        JOIN (
          SELECT media_id, character_external_id FROM media_cast
          WHERE character_external_id IS NOT NULL
          GROUP BY media_id, character_external_id HAVING count(*) > 1
        ) d2 ON d2.media_id = a.media_id AND d2.character_external_id = a.character_external_id
        WHERE ${VISIBLE_MEDIA_SQL}
      )
      SELECT count(*)::bigint AS c
      FROM character_votes cv
      WHERE cv.cast_id IN (SELECT id FROM dup_rows)`;
    return {
      castDuplicateMedia: Number(media?.c ?? 0),
      castDuplicateRows: Number(rows?.c ?? 0),
      castDuplicateVotes: Number(votes?.c ?? 0),
    };
  }

  /**
   * Detect and (in repair mode) merge duplicate media_cast rows — created historically
   * when TVDB people ids were stored under the TMDB_ external-id namespace, by the
   * index-based fallback ids, or by concurrent hydrations.
   *
   * Confidence: HIGH = rows share the same cast_member id, the same TVDB
   * characterExternalId, OR the same normalized person+character name within one media
   * (including prefix variants like "Matt Murdock" vs "Matt Murdock / Daredevil") —
   * auto-merged. Genuinely different characters never group (one actor, two roles
   * stays untouched). Anything not provably the same person+role on the same title is
   * left for the manual pair-merge endpoint after human review.
   *
   * User data is preserved: character votes are re-pointed to the canonical row inside
   * the same transaction BEFORE any duplicate row is deleted; a duplicate row is only
   * deleted once zero votes reference it. Modes: report (detection only), dry-run
   * (full migration inside a rolled-back transaction — exact counts, no writes),
   * repair (commits).
   */
  async repairCastDuplicates(opts?: {
    mode?: 'report' | 'dry-run' | 'repair';
    limit?: number;
    mediaId?: string;
  }): Promise<{
    mode: string;
    processed: number;
    groupsHigh: number;
    groupsMedium: number;
    merged: number;
    rowsDeleted: number;
    votesMoved: number;
    votesConflictResolved: number;
    orphanMembersDeleted: number;
    failed: number;
    review: {
      mediaId: string;
      title: string;
      rows: { id: string; member: string; character: string | null; votes: number }[];
    }[];
    /** Total review groups (review array is capped at 50). */
    reviewTotal: number;
    sample: string[];
  }> {
    const mode = opts?.mode ?? 'report';
    const empty = {
      mode,
      processed: 0,
      groupsHigh: 0,
      groupsMedium: 0,
      merged: 0,
      rowsDeleted: 0,
      votesMoved: 0,
      votesConflictResolved: 0,
      orphanMembersDeleted: 0,
      failed: 0,
      review: [] as {
        mediaId: string;
        title: string;
        rows: { id: string; member: string; character: string | null; votes: number }[];
      }[],
      reviewTotal: 0,
      sample: [] as string[],
    };
    if (this.castDedupRunning) {
      this.logger.log('Cast dedup already running — skipping');
      return empty;
    }
    this.castDedupRunning = true;
    this.trackRepair('cast-dedup', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const limit = Math.max(1, Math.min(opts?.limit ?? 500, 100000));
      const mediaIds = opts?.mediaId
        ? (await this.prisma.mediaItem.count({
            where: { ...VISIBLE_MEDIA_WHERE, id: opts.mediaId },
          })) > 0
          ? [opts.mediaId]
          : []
        : await this.findCastDuplicateMediaIds(limit);
      this.trackRepair('cast-dedup', { total: mediaIds.length });

      let groupsHigh = 0;
      let groupsMedium = 0;
      let merged = 0;
      let rowsDeleted = 0;
      let votesMoved = 0;
      let votesConflictResolved = 0;
      let orphanMembersDeleted = 0;
      let failed = 0;
      const review: typeof empty.review = [];
      const sample: string[] = [];

      for (let i = 0; i < mediaIds.length; i++) {
        const mediaId = mediaIds[i];
        this.trackRepair('cast-dedup', {
          processed: i + 1,
          succeeded: merged,
          failed,
          current: mediaId,
        });
        try {
          const result = await this.withCastDedupLock(mediaId, () =>
            this.mergeMediaCastDuplicates(mediaId, mode),
          );
          groupsHigh += result.groupsHigh;
          groupsMedium += result.groupsMedium;
          merged += result.merged;
          rowsDeleted += result.rowsDeleted;
          votesMoved += result.votesMoved;
          votesConflictResolved += result.votesConflictResolved;
          orphanMembersDeleted += result.orphanMembersDeleted;
          if (result.review.length)
            review.push({ mediaId, title: result.title, rows: result.review });
          if (result.merged > 0 && sample.length < 10) sample.push(result.title);
        } catch (e) {
          failed++;
          this.logger.warn(`cast-dedup failed for ${mediaId}: ${(e as Error).message}`);
        }
      }

      const summary = {
        mode,
        processed: mediaIds.length,
        groupsHigh,
        groupsMedium,
        merged,
        rowsDeleted,
        votesMoved,
        votesConflictResolved,
        orphanMembersDeleted,
        failed,
        // Bounded payload (CronJobRun.result has a 2000-char budget; full detail is
        // in the logs and via the targeted inspect endpoint).
        review: review.slice(0, 50),
        reviewTotal: review.length,
        sample,
      };
      this.trackRepair('cast-dedup', {
        running: false,
        processed: mediaIds.length,
        succeeded: merged,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Cast dedup (${mode}): ${mediaIds.length} media scanned, ${groupsHigh} high-confidence groups, ` +
          `${merged} merged, ${votesMoved} votes moved, ${rowsDeleted} rows deleted, ` +
          `${groupsMedium} medium-confidence groups need review, ${failed} failed`,
      );
      return summary;
    } finally {
      this.castDedupRunning = false;
    }
  }

  /** Sentinel used to roll back a dry-run transaction after counting. */
  private static readonly DRY_RUN = Symbol('cast-dedup-dry-run');

  /** Per-media merge, executed under the hydration lock. Returns per-mode counts. */
  private async mergeMediaCastDuplicates(
    mediaId: string,
    mode: 'report' | 'dry-run' | 'repair',
  ): Promise<{
    title: string;
    groupsHigh: number;
    groupsMedium: number;
    merged: number;
    rowsDeleted: number;
    votesMoved: number;
    votesConflictResolved: number;
    orphanMembersDeleted: number;
    review: { id: string; member: string; character: string | null; votes: number }[];
  }> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const media = await tx.mediaItem.findUniqueOrThrow({
            where: { id: mediaId },
            select: { title: true },
          });
          const rows = await tx.mediaCast.findMany({
            where: { mediaId },
            include: {
              castMember: { select: { id: true, name: true, externalId: true } },
              _count: { select: { characterVotes: true } },
            },
            orderBy: { sortOrder: 'asc' },
          });
          const groups = this.castDedup.groupDuplicateCast(rows);
          const out = {
            title: media.title,
            groupsHigh: groups.filter((g) => g.confidence === 'HIGH').length,
            groupsMedium: groups.filter((g) => g.confidence === 'MEDIUM').length,
            merged: 0,
            rowsDeleted: 0,
            votesMoved: 0,
            votesConflictResolved: 0,
            orphanMembersDeleted: 0,
            review: [] as { id: string; member: string; character: string | null; votes: number }[],
          };
          if (mode === 'report') {
            for (const g of groups) {
              if (g.confidence !== 'MEDIUM') continue;
              for (const r of g.rows) {
                out.review.push({
                  id: r.id,
                  member: `${r.castMember.name} (${r.castMember.externalId ?? 'no-ext-id'})`,
                  character: r.character,
                  votes: r._count.characterVotes,
                });
              }
            }
            return out;
          }
          for (const g of groups) {
            if (g.confidence !== 'HIGH') continue;
            const r = await this.castDedup.mergeCastGroupTx(tx, mediaId, media.title, g.rows);
            out.merged += r.merged;
            out.rowsDeleted += r.rowsDeleted;
            out.votesMoved += r.votesMoved;
            out.votesConflictResolved += r.votesConflictResolved;
            out.orphanMembersDeleted += r.orphanMembersDeleted;
          }
          if (mode === 'dry-run') {
            // Counts are exact (all statements executed) but the transaction rolls back.
            this.dryRunCapture = out;
            // eslint-disable-next-line no-throw-literal
            throw MetadataBackfillService.DRY_RUN;
          }
          // Repair mode: stamp the audit trail on the media row.
          if (out.merged > 0) {
            await tx.$executeRaw`
              UPDATE media_items
              SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
                    || jsonb_build_object('castDedup', jsonb_build_object(
                         'at', ${new Date().toISOString()}::text,
                         'merged', ${out.merged}::int,
                         'votesMoved', ${out.votesMoved}::int))
              WHERE id = ${mediaId}`;
          }
          return out;
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      if (e === MetadataBackfillService.DRY_RUN) {
        // The sentinel unwound the (rolled-back) transaction; results were captured
        // just before the throw.
        const captured = this.dryRunCapture;
        this.dryRunCapture = null;
        if (captured) return captured;
        throw e;
      }
      throw e;
    }
  }

  /** Side channel for dry-run results (the sentinel exception unwinds the tx). */
  private dryRunCapture: {
    title: string;
    groupsHigh: number;
    groupsMedium: number;
    merged: number;
    rowsDeleted: number;
    votesMoved: number;
    votesConflictResolved: number;
    orphanMembersDeleted: number;
    review: { id: string; member: string; character: string | null; votes: number }[];
  } | null = null;

  /**
   * Manually merge ONE reviewed duplicate pair (the report's MEDIUM/name-only cases,
   * e.g. "Matt Murdock" vs "Matt Murdock / Daredevil"). keepCastId survives; votes on
   * mergeCastId are re-pointed before its row is deleted. Runs under the media lock,
   * in one transaction, and stamps the audit trail. Used by the admin merge endpoint
   * after a human confirms the two rows are the same person/character.
   */
  async mergeCastPair(
    mediaId: string,
    keepCastId: string,
    mergeCastId: string,
  ): Promise<{ merged: number; votesMoved: number; rowsDeleted: number }> {
    return this.withCastDedupLock(mediaId, async () => {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const media = await tx.mediaItem.findUniqueOrThrow({
            where: { id: mediaId },
            select: { title: true },
          });
          const rows = await tx.mediaCast.findMany({
            where: { id: { in: [keepCastId, mergeCastId] }, mediaId },
            include: {
              castMember: { select: { id: true, name: true, externalId: true } },
              _count: { select: { characterVotes: true } },
            },
          });
          if (rows.length !== 2) {
            throw new BadRequestException(
              `Expected 2 cast rows for media ${mediaId} (keep=${keepCastId}, merge=${mergeCastId}), found ${rows.length}`,
            );
          }
          const out = await this.castDedup.mergeCastGroupTx(
            tx,
            mediaId,
            media.title,
            rows,
            keepCastId,
          );
          if (out.merged > 0) {
            await tx.$executeRaw`
              UPDATE media_items
              SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
                    || jsonb_build_object('castDedup', jsonb_build_object(
                         'at', ${new Date().toISOString()}::text,
                         'merged', ${out.merged}::int,
                         'votesMoved', ${out.votesMoved}::int,
                         'manual', true))
              WHERE id = ${mediaId}`;
          }
          return out;
        },
        { timeout: 30_000 },
      );
      return {
        merged: result.merged,
        votesMoved: result.votesMoved,
        rowsDeleted: result.rowsDeleted,
      };
    });
  }

  // ---- Season/episode structure reconciliation ----

  /** Prevents concurrent structure-reconcile batches. */
  private structureReconcileRunning = false;

  /**
   * Repair a TMDB-canonical show: hydrate a complete TMDB snapshot while holding the
   * media lock, then remap provider-foreign active rows. Ambiguous user-data rows become
   * LEGACY_UNMAPPED, making retries idempotent without JSON count workarounds.
   */
  private async repairTmdbStructureShow(
    mediaId: string,
  ): Promise<{ fixed: boolean; remapped: number; report?: RemapStats }> {
    const notFixed = { fixed: false, remapped: 0 };
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true },
    });
    if (!media) return notFixed;
    const provenance = { ...((media.metadataProvenance as any) ?? {}) } as Record<string, any>;
    const previousMatcherVersion = Number(provenance.structureRemapVersion ?? 0);
    const reconsiderLegacy = previousMatcherVersion < StructureRemapService.MATCHER_VERSION;

    // Cheap stale count first (correlated EXISTS per candidate row — single-digit ms).
    // A newer matching ladder gets one pass over quarantined rows too. Without this
    // branch the active-only guard made MATCHER_VERSION re-arming unreachable.
    const staleRows = Number(
      (
        await this.prisma.$queryRaw<{ c: bigint }[]>`
        SELECT count(*)::bigint AS c
        FROM episodes e
        JOIN seasons s ON s.id = e.season_id
        JOIN shows sh ON sh.id = s.show_id
        WHERE sh.media_id = ${mediaId}
          AND (
            (e.structure_state = 'ACTIVE'::"EpisodeStructureState"
              AND NOT EXISTS (
                SELECT 1 FROM episode_external_ids x
                WHERE x.episode_id = e.id AND x.provider = 'TMDB'
              ))
            OR (${reconsiderLegacy} AND e.structure_state = 'LEGACY_UNMAPPED'::"EpisodeStructureState")
          )`
      )[0]?.c ?? 0,
    );
    if (staleRows === 0) return notFixed;
    const tmdb = media.externalIds.find(
      (e) =>
        e.provider === ExternalProvider.TMDB && e.providerEntityKind === ProviderEntityKind.SERIES,
    );
    const remap = await this.withCastDedupLock(
      mediaId,
      async () => {
        if (tmdb) {
          this.trackRepair('structure-reconcile', { current: `${mediaId} (rehydrating-tmdb)` });
          await this.meta.ensureShowFull(Number(tmdb.value), undefined, {
            forceRefresh: true,
            writeScope: 'STRUCTURE_REMAP',
            lockHeld: true,
            decision: {
              provider: StructureProvider.TMDB,
              reason: StructureReason.GENERAL_TMDB,
              ruleVersion: STRUCTURE_RULE_VERSION,
              decidedAt: new Date(),
              tmdbId: Number(tmdb.value),
            },
          });
        }
        return this.structureRemap.remapShow(mediaId, {
          canonical: 'tmdb',
          reason: StructureReason.GENERAL_TMDB,
          onProgress: (done, total) =>
            this.trackRepair('structure-reconcile', { current: `${mediaId} (${done}/${total})` }),
        });
      },
      10 * 60 * 1000,
    );
    if (remap.stale === 0 && !tmdb) return notFixed; // nothing to anchor to
    provenance.structureProvider = 'tmdb';
    provenance.structureRemapVersion = StructureRemapService.MATCHER_VERSION;
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { metadataProvenance: provenance as any },
    });
    return { fixed: true, remapped: remap.mapped, report: remap };
  }

  /** Repair a TVDB-canonical general show using TVDB's complete official-order graph. */
  private async repairGeneralTvdbStructureShow(
    mediaId: string,
  ): Promise<{ fixed: boolean; remapped: number; report?: RemapStats }> {
    const notFixed = { fixed: false, remapped: 0 };
    if (!this.tvdb.enabled) return notFixed;
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true },
    });
    if (!media) return notFixed;
    const tvdb = media.externalIds.find(
      (external) =>
        external.provider === ExternalProvider.THE_TVDB &&
        external.providerEntityKind === ProviderEntityKind.SERIES,
    );
    if (!tvdb) return notFixed;
    const tvdbId = Number(tvdb.value);
    if (!Number.isSafeInteger(tvdbId) || tvdbId <= 0) return notFixed;

    const snapshot = await this.tvdb.getShow(tvdbId, 'en', { seasonType: 'official' });
    const tmdb = media.externalIds.find(
      (external) =>
        external.provider === ExternalProvider.TMDB &&
        external.providerEntityKind === ProviderEntityKind.SERIES,
    );
    const tmdbId = Number(tmdb?.value);
    const foreignSnapshot =
      Number.isSafeInteger(tmdbId) && tmdbId > 0 && this.tmdbProvider.enabled
        ? await this.tmdbProvider.getShow(tmdbId, 'en-US')
        : null;
    const preview = await this.structureRemap.previewShowAgainstSnapshot(
      mediaId,
      'tvdb',
      snapshot.seasons,
      {
        foreignSeasons: foreignSnapshot?.seasons,
        preserveUnmappedSpecials: true,
      },
    );
    if (preview.legacyQuarantined > 0) {
      return { fixed: false, remapped: 0, report: { ...preview, blocked: true } };
    }

    const remap = await this.withCastDedupLock(
      mediaId,
      async () => {
        await this.meta.ensureShowFullTvdb(tvdbId, undefined, {
          forceRefresh: true,
          writeScope: 'STRUCTURE_REMAP',
          lockHeld: true,
          decision: {
            provider: StructureProvider.TVDB,
            reason: StructureReason.GENERAL_TVDB,
            ruleVersion: STRUCTURE_RULE_VERSION,
            decidedAt: new Date(),
            tmdbId: Number.isSafeInteger(tmdbId) && tmdbId > 0 ? tmdbId : undefined,
            tvdbId,
            tmdbSnapshot: foreignSnapshot ?? undefined,
            tvdbSnapshot: snapshot,
          },
        });
        return this.structureRemap.remapShow(mediaId, {
          canonical: 'tvdb',
          reason: StructureReason.GENERAL_TVDB,
          requireCompleteUserDataMapping: true,
          canonicalValues: new Set(
            snapshot.seasons.flatMap((season) =>
              season.episodes.map((episode) => String(episode.tmdbId)),
            ),
          ),
          foreignSeasons: foreignSnapshot?.seasons,
          preserveUnmappedSpecials: true,
          onProgress: (done, total) =>
            this.trackRepair('structure-reconcile', { current: `${mediaId} (${done}/${total})` }),
        });
      },
      10 * 60 * 1000,
    );
    if (remap.blocked) return { fixed: false, remapped: remap.mapped, report: remap };
    const provenance = { ...((media.metadataProvenance as any) ?? {}) } as Record<string, any>;
    provenance.structureProvider = 'tvdb';
    provenance.structureRemapVersion = StructureRemapService.MATCHER_VERSION;
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { metadataProvenance: provenance as any },
    });
    return { fixed: true, remapped: remap.mapped, report: remap };
  }

  /** Shows whose stored structure contradicts their canonical provider — the
   *  structure-reconcile job's candidate list. Canonical ownership comes from the
   *  typed Show.structureProvider field. LEGACY_UNMAPPED rows are excluded, so this
   *  selector and the dashboard metric converge on the same active set. */
  private dualStructureCandidatesSql(cursor?: string) {
    return Prisma.sql`
      WITH flags AS (
        SELECT episode_id,
          bool_or(provider = 'TMDB') AS has_tmdb,
          bool_or(provider = 'THE_TVDB') AS has_tvdb
        FROM episode_external_ids
        GROUP BY episode_id
      ),
      per_show AS (
        SELECT sh.media_id,
          count(*) FILTER (WHERE NOT s.is_special AND e.structure_state = 'ACTIVE'::"EpisodeStructureState" AND COALESCE(f.has_tmdb, false)) AS tmdb,
          count(*) FILTER (WHERE NOT s.is_special AND e.structure_state = 'ACTIVE'::"EpisodeStructureState" AND COALESCE(f.has_tvdb, false)) AS tvdb,
          count(*) FILTER (WHERE NOT s.is_special AND e.structure_state = 'ACTIVE'::"EpisodeStructureState" AND COALESCE(f.has_tmdb, false) AND NOT COALESCE(f.has_tvdb, false)) AS tmdb_only,
          count(*) FILTER (WHERE NOT s.is_special AND e.structure_state = 'ACTIVE'::"EpisodeStructureState" AND COALESCE(f.has_tvdb, false) AND NOT COALESCE(f.has_tmdb, false)) AS tvdb_only,
          count(*) FILTER (WHERE NOT s.is_special AND e.structure_state = 'ACTIVE'::"EpisodeStructureState" AND NOT COALESCE(f.has_tmdb, false) AND NOT COALESCE(f.has_tvdb, false)) AS no_ids,
          count(*) FILTER (WHERE NOT s.is_special AND e.structure_state = 'LEGACY_UNMAPPED'::"EpisodeStructureState") AS legacy
        FROM episodes e
        JOIN seasons s ON s.id = e.season_id
        JOIN shows sh ON sh.id = s.show_id
        LEFT JOIN flags f ON f.episode_id = e.id
        GROUP BY sh.media_id
      ),
      resolved AS (
        SELECT p.*, lower(sh.structure_provider::text) AS canonical,
          CASE
            WHEN COALESCE(mi.metadata_provenance->>'structureRemapVersion', '') ~ '^[0-9]+$'
              THEN (mi.metadata_provenance->>'structureRemapVersion')::int
            ELSE 0
          END AS remap_version
        FROM per_show p
        JOIN media_items mi ON mi.id = p.media_id
        JOIN shows sh ON sh.media_id = p.media_id
        WHERE ${VISIBLE_MEDIA_MI_SQL}
      ),
      structural_candidates AS (
        SELECT r.media_id,
          ((CASE WHEN r.canonical = 'tvdb' THEN r.tmdb_only + r.no_ids ELSE r.tvdb_only + r.no_ids END)
            + CASE WHEN r.remap_version < ${StructureRemapService.MATCHER_VERSION} THEN r.legacy ELSE 0 END)::bigint AS stale,
          (CASE WHEN r.canonical = 'tvdb' THEN r.tvdb ELSE r.tmdb END)::bigint AS fresh
        FROM resolved r
        WHERE (CASE WHEN r.canonical = 'tvdb' THEN r.tvdb ELSE r.tmdb END) > 0
          AND ((CASE WHEN r.canonical = 'tvdb' THEN r.tmdb_only + r.no_ids ELSE r.tvdb_only + r.no_ids END)
            + CASE WHEN r.remap_version < ${StructureRemapService.MATCHER_VERSION} THEN r.legacy ELSE 0 END) > 0
          AND (${cursor ?? ''} = '' OR r.media_id > ${cursor ?? ''})
      ),
      candidate_rows AS (
        SELECT media_id, stale, fresh FROM structural_candidates
        UNION ALL
        SELECT sh.media_id, 0::bigint AS stale, 0::bigint AS fresh
        FROM shows sh
        WHERE (
          COALESCE(sh.structure_rule_version, 0) < ${STRUCTURE_RULE_VERSION}
          OR (
            sh.structure_reason IN (
              'GENERAL_TMDB'::"StructureReason",
              'GENERAL_TVDB'::"StructureReason"
            )
            AND COALESCE(sh.structure_decided_at, to_timestamp(0)) < now() - interval '30 days'
            AND EXISTS (
              SELECT 1 FROM external_ids tmdb_identity
              WHERE tmdb_identity.media_id = sh.media_id
                AND tmdb_identity.provider = 'TMDB'::"ExternalProvider"
                AND tmdb_identity.provider_entity_kind = 'SERIES'::"ProviderEntityKind"
            )
            AND EXISTS (
              SELECT 1 FROM external_ids tvdb_identity
              WHERE tvdb_identity.media_id = sh.media_id
                AND tvdb_identity.provider = 'THE_TVDB'::"ExternalProvider"
                AND tvdb_identity.provider_entity_kind = 'SERIES'::"ProviderEntityKind"
            )
          )
        )
          AND sh.structure_reason IS DISTINCT FROM 'MANUAL_OVERRIDE'::"StructureReason"
          AND (${cursor ?? ''} = '' OR sh.media_id > ${cursor ?? ''})
      ),
      candidates AS (
        SELECT media_id, max(stale)::bigint AS stale, max(fresh)::bigint AS fresh
        FROM candidate_rows
        GROUP BY media_id
      )`;
  }

  private async countDualStructureShows(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ c: bigint }[]>(
      Prisma.sql`${this.dualStructureCandidatesSql()} SELECT count(*)::bigint AS c FROM structural_candidates`,
    );
    return Number(row?.c ?? 0);
  }

  /** Full repair queue: true mixed graphs plus titles whose authority decision is due. */
  private async countStructureReconcileBacklog(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ c: bigint }[]>(
      Prisma.sql`${this.dualStructureCandidatesSql()} SELECT count(*)::bigint AS c FROM candidates`,
    );
    return Number(row?.c ?? 0);
  }

  private async findDualStructureShows(
    limit: number,
    cursor?: string,
  ): Promise<{ mediaId: string; stale: number; fresh: number }[]> {
    const rows = await this.prisma.$queryRaw<{ media_id: string; stale: bigint; fresh: bigint }[]>(
      Prisma.sql`${this.dualStructureCandidatesSql(cursor)}
        SELECT media_id, stale, fresh
        FROM candidates
        ORDER BY media_id ASC
        LIMIT ${limit}`,
    );
    return rows.map((r) => ({
      mediaId: r.media_id,
      stale: Number(r.stale),
      fresh: Number(r.fresh),
    }));
  }

  /**
   * Detect and reconcile titles whose active season/episode structure contradicts the
   * persisted canonical provider.
   *
   * Repair hydrates a canonical snapshot under the media lock, remaps user data, deletes
   * data-free stale rows, and quarantines ambiguous user-data rows as LEGACY_UNMAPPED.
   *
   * Modes: report (detection + counts only), dry-run (matcher only), repair.
   */
  async reconcileStructures(opts?: {
    mode?: 'report' | 'dry-run' | 'repair';
    limit?: number;
    mediaId?: string;
    cursor?: string;
  }): Promise<{
    mode: string;
    processed: number;
    anime: number;
    repaired: number;
    remapped: number;
    needsReview: number;
    failed: number;
    titles: {
      mediaId: string;
      title: string;
      anime: boolean;
      structureProvider: string | null;
      authorityReason: string | null;
      missingProviderIds: string[];
      stale: number;
      fresh: number;
      action: string;
      mappingConfidence?: { high: number; medium: number; low: number };
      remap?: {
        mapped: number;
        unmapped: number;
        legacyQuarantined: number;
        episodesRemoved: number;
        seasonsRemoved: number;
        transferred: number;
        matchRules: Record<string, number>;
      };
    }[];
    /** Total candidate titles (titles array is capped at 50). */
    titlesTotal: number;
    nextCursor: string | null;
    remainingBacklog: number;
  }> {
    const mode = opts?.mode ?? 'report';
    const empty = {
      mode,
      processed: 0,
      anime: 0,
      repaired: 0,
      remapped: 0,
      needsReview: 0,
      failed: 0,
      titles: [] as {
        mediaId: string;
        title: string;
        anime: boolean;
        structureProvider: string | null;
        authorityReason: string | null;
        missingProviderIds: string[];
        stale: number;
        fresh: number;
        action: string;
        mappingConfidence?: { high: number; medium: number; low: number };
        remap?: {
          mapped: number;
          unmapped: number;
          legacyQuarantined: number;
          episodesRemoved: number;
          seasonsRemoved: number;
          transferred: number;
          matchRules: Record<string, number>;
        };
      }[],
      titlesTotal: 0,
      nextCursor: null,
      remainingBacklog: 0,
    };
    if (this.structureReconcileRunning) {
      this.logger.log('Structure reconcile already running — skipping');
      return empty;
    }
    this.structureReconcileRunning = true;
    this.trackRepair('structure-reconcile', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      remapped: 0,
      legacyQuarantined: 0,
      episodesRemoved: 0,
      transferred: 0,
      finishedAt: null,
    });
    try {
      const limit = Math.max(1, Math.min(opts?.limit ?? 200, 100000));
      const candidates = opts?.mediaId
        ? (await this.prisma.mediaItem.count({
            where: { ...VISIBLE_MEDIA_WHERE, id: opts.mediaId },
          })) > 0
          ? [{ mediaId: opts.mediaId, stale: -1, fresh: -1 }]
          : []
        : await this.findDualStructureShows(limit, opts?.cursor);
      this.trackRepair('structure-reconcile', { total: candidates.length });

      let animeCount = 0;
      let repaired = 0;
      let remapped = 0;
      let needsReview = 0;
      let failed = 0;
      let episodesRemoved = 0;
      let transferred = 0;

      for (let i = 0; i < candidates.length; i++) {
        const { mediaId, stale, fresh } = candidates[i];
        this.trackRepair('structure-reconcile', {
          processed: i + 1,
          succeeded: repaired,
          failed,
          current: mediaId,
        });
        try {
          const media = await this.prisma.mediaItem.findUnique({
            where: { id: mediaId },
            include: {
              show: {
                select: {
                  keywords: true,
                  structureProvider: true,
                  structureReason: true,
                  structureRuleVersion: true,
                  structureDecidedAt: true,
                },
              },
              genres: { include: { genre: { select: { slug: true, name: true } } } },
              externalIds: {
                select: { provider: true, providerEntityKind: true, value: true },
              },
            },
          });
          if (!media) {
            failed++;
            empty.titles.push({
              mediaId,
              title: '(media not found)',
              anime: false,
              structureProvider: null,
              authorityReason: null,
              missingProviderIds: [],
              stale,
              fresh,
              action: 'not-found',
            });
            continue;
          }
          const anime = media.show?.structureReason === StructureReason.ANIME_TVDB;
          if (anime) animeCount++;
          const structureProvider =
            media.show?.structureProvider?.toLowerCase() ??
            (media.metadataProvenance as any)?.structureProvider ??
            null;
          const expectedProvider =
            structureProvider === 'tvdb' ? ExternalProvider.THE_TVDB : ExternalProvider.TMDB;
          const missingProviderIds = media.externalIds.some(
            (external) =>
              external.provider === expectedProvider &&
              external.providerEntityKind === ProviderEntityKind.SERIES,
          )
            ? []
            : [expectedProvider];
          const entry: (typeof empty.titles)[number] = {
            mediaId,
            title: media.title,
            anime,
            structureProvider,
            authorityReason: media.show?.structureReason ?? null,
            missingProviderIds,
            stale,
            fresh,
            action: 'report',
          };

          const hasTmdbIdentity = media.externalIds.some(
            (external) =>
              external.provider === ExternalProvider.TMDB &&
              external.providerEntityKind === ProviderEntityKind.SERIES,
          );
          const hasTvdbIdentity = media.externalIds.some(
            (external) =>
              external.provider === ExternalProvider.THE_TVDB &&
              external.providerEntityKind === ProviderEntityKind.SERIES,
          );
          const generalComparisonDue =
            (media.show?.structureReason === StructureReason.GENERAL_TMDB ||
              media.show?.structureReason === StructureReason.GENERAL_TVDB) &&
            hasTmdbIdentity &&
            hasTvdbIdentity &&
            (!media.show.structureDecidedAt ||
              media.show.structureDecidedAt.getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000);
          const authorityOutdated =
            media.show?.structureReason !== StructureReason.MANUAL_OVERRIDE &&
            ((media.show?.structureRuleVersion ?? 0) < STRUCTURE_RULE_VERSION ||
              generalComparisonDue);
          let authorityHandled = false;
          if (authorityOutdated && mode !== 'report') {
            const evaluation = await this.meta.evaluateShowStructureAuthority(mediaId, {
              dryRun: mode === 'dry-run',
            });
            const providerChanged =
              !!evaluation.decision &&
              evaluation.decision.provider.toLowerCase() !== structureProvider;
            const authorityRemap = evaluation.report ?? evaluation.preview;
            if (authorityRemap) {
              entry.remap = {
                mapped: authorityRemap.mapped,
                unmapped: authorityRemap.unmapped,
                legacyQuarantined: authorityRemap.legacyQuarantined,
                episodesRemoved: authorityRemap.episodesRemoved,
                seasonsRemoved: authorityRemap.seasonsRemoved,
                transferred:
                  authorityRemap.statusesMoved +
                  authorityRemap.historiesMoved +
                  authorityRemap.ratingsMoved +
                  authorityRemap.reactionsMoved +
                  authorityRemap.votesMoved +
                  authorityRemap.commentsMoved +
                  authorityRemap.externalReviewsMoved,
                matchRules: authorityRemap.matchRules,
              };
              entry.mappingConfidence = summarizeMappingConfidence(authorityRemap.matchRules);
              needsReview += authorityRemap.legacyQuarantined;
              episodesRemoved += authorityRemap.episodesRemoved;
              transferred += entry.remap.transferred;
            }
            if (evaluation.deferred) {
              entry.action = 'authority-deferred-provider';
              authorityHandled = true;
            } else if (evaluation.blocked) {
              entry.action = 'authority-blocked-user-data';
              authorityHandled = true;
            } else if (providerChanged) {
              const target = evaluation.decision!.provider.toLowerCase();
              entry.action = mode === 'dry-run' ? `would-switch-${target}` : `switched-${target}`;
              authorityHandled = true;
              if (mode === 'repair') {
                repaired++;
                remapped += evaluation.report?.mapped ?? 0;
              }
            } else if (stale === 0) {
              const tvdbOfficial = evaluation.decision?.reason === StructureReason.GENERAL_TVDB;
              entry.action = tvdbOfficial
                ? mode === 'dry-run'
                  ? 'would-refresh-tvdb-official'
                  : 'refreshed-tvdb-official'
                : mode === 'dry-run'
                  ? 'would-confirm-equivalent-tmdb'
                  : 'confirmed-equivalent-tmdb';
              authorityHandled = true;
              if (
                mode === 'repair' &&
                (evaluation.changed ||
                  !!evaluation.report?.mapped ||
                  !!evaluation.report?.episodesRemoved)
              ) {
                repaired++;
              }
            }
          }

          if (authorityOutdated && mode === 'report') {
            entry.action = 'authority-outdated';
          } else if (authorityHandled) {
            // Authority evaluation already produced the complete dry-run/repair result.
          } else if (mode === 'dry-run') {
            const canonical = structureProvider ?? (anime ? 'tvdb' : 'tmdb');
            if (fresh !== 0) {
              const canonicalId = media.externalIds.find(
                (external) =>
                  external.provider === expectedProvider &&
                  external.providerEntityKind === ProviderEntityKind.SERIES,
              )?.value;
              // Repair force-hydrates the owner immediately before remapping. Preview
              // against that same live provider graph so stale stored titles/dates do
              // not make dry-run disagree with the actual repair.
              const snapshot = canonicalId
                ? canonical === 'tvdb'
                  ? await this.tvdb.getShow(
                      Number(canonicalId),
                      'en',
                      media.show?.structureReason === StructureReason.GENERAL_TVDB
                        ? { seasonType: 'official' }
                        : undefined,
                    )
                  : await this.tmdbProvider.getShow(Number(canonicalId), 'en-US')
                : null;
              const remap = snapshot
                ? await this.structureRemap.previewShowAgainstSnapshot(
                    mediaId,
                    canonical,
                    snapshot.seasons,
                  )
                : await this.structureRemap.remapShow(mediaId, {
                    dryRun: true,
                    canonical,
                  });
              entry.remap = {
                mapped: remap.mapped,
                unmapped: remap.unmapped,
                legacyQuarantined: remap.legacyQuarantined,
                episodesRemoved: remap.episodesRemoved,
                seasonsRemoved: remap.seasonsRemoved,
                transferred:
                  remap.statusesMoved +
                  remap.historiesMoved +
                  remap.ratingsMoved +
                  remap.reactionsMoved +
                  remap.votesMoved +
                  remap.commentsMoved +
                  remap.externalReviewsMoved,
                matchRules: remap.matchRules,
              };
              entry.mappingConfidence = summarizeMappingConfidence(remap.matchRules);
              needsReview += remap.legacyQuarantined;
              episodesRemoved += remap.episodesRemoved;
              transferred += entry.remap.transferred;
              entry.action = remap.mapped > 0 ? `would-remap-${canonical}` : 'no-matches';
            } else {
              entry.action = anime ? 'would-hydrate-tvdb' : 'would-hydrate-tmdb';
            }
          } else if (mode === 'repair') {
            // Deterministic canonical provider: anime / TVDB-stamped ⇒ TVDB repair;
            // everything else ⇒ TMDB repair (TMDB is the usual first-hydration
            // provider and its structure is what these shows were built from).
            if (structureProvider === 'tvdb' || (structureProvider == null && anime)) {
              const {
                fixed,
                remapped: moved,
                report,
              } = media.show?.structureReason === StructureReason.GENERAL_TVDB
                ? await this.repairGeneralTvdbStructureShow(mediaId)
                : await this.fixAnimeShowFromTvdb(mediaId);
              entry.action = fixed ? 'repaired-tvdb' : 'converged';
              if (fixed) {
                repaired++;
                remapped += moved;
                if (report) {
                  entry.remap = {
                    mapped: report.mapped,
                    unmapped: report.unmapped,
                    legacyQuarantined: report.legacyQuarantined,
                    episodesRemoved: report.episodesRemoved,
                    seasonsRemoved: report.seasonsRemoved,
                    transferred:
                      report.statusesMoved +
                      report.historiesMoved +
                      report.ratingsMoved +
                      report.reactionsMoved +
                      report.votesMoved +
                      report.commentsMoved +
                      report.externalReviewsMoved,
                    matchRules: report.matchRules,
                  };
                  entry.mappingConfidence = summarizeMappingConfidence(report.matchRules);
                  needsReview += report.legacyQuarantined;
                  episodesRemoved += report.episodesRemoved;
                  transferred += entry.remap.transferred;
                }
              }
            } else {
              const {
                fixed,
                remapped: moved,
                report,
              } = await this.repairTmdbStructureShow(mediaId);
              entry.action = fixed ? 'repaired-tmdb' : 'converged';
              if (fixed) {
                repaired++;
                remapped += moved;
                if (report) {
                  entry.remap = {
                    mapped: report.mapped,
                    unmapped: report.unmapped,
                    legacyQuarantined: report.legacyQuarantined,
                    episodesRemoved: report.episodesRemoved,
                    seasonsRemoved: report.seasonsRemoved,
                    transferred:
                      report.statusesMoved +
                      report.historiesMoved +
                      report.ratingsMoved +
                      report.reactionsMoved +
                      report.votesMoved +
                      report.commentsMoved +
                      report.externalReviewsMoved,
                    matchRules: report.matchRules,
                  };
                  entry.mappingConfidence = summarizeMappingConfidence(report.matchRules);
                  needsReview += report.legacyQuarantined;
                  episodesRemoved += report.episodesRemoved;
                  transferred += entry.remap.transferred;
                }
              }
            }
          } else {
            entry.action =
              structureProvider === 'tvdb' || (structureProvider == null && anime)
                ? 'tvdb-canonical'
                : 'tmdb-canonical';
          }
          empty.titles.push(entry);
          this.trackRepair('structure-reconcile', {
            processed: i + 1,
            succeeded: repaired,
            failed,
            remapped,
            legacyQuarantined: needsReview,
            episodesRemoved,
            transferred,
            current: mediaId,
          });
        } catch (e) {
          failed++;
          this.logger.warn(`structure-reconcile failed for ${mediaId}: ${(e as Error).message}`);
        }
      }

      const summary = {
        ...empty,
        processed: candidates.length,
        anime: animeCount,
        repaired,
        remapped,
        needsReview,
        failed,
        // Bounded payload (CronJobRun.result has a 2000-char budget; the full list is
        // in the logs). Top-50 by stale count (candidate SQL already orders by stale).
        titles: empty.titles.slice(0, 50),
        titlesTotal: empty.titles.length,
        nextCursor:
          !opts?.mediaId && candidates.length === limit
            ? (candidates[candidates.length - 1]?.mediaId ?? null)
            : null,
        remainingBacklog: await this.countStructureReconcileBacklog(),
      };
      this.trackRepair('structure-reconcile', {
        running: false,
        processed: candidates.length,
        succeeded: repaired,
        failed,
        remapped,
        legacyQuarantined: needsReview,
        episodesRemoved,
        transferred,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Structure reconcile (${mode}): ${candidates.length} titles scanned, ${animeCount} anime, ` +
          `${repaired} repaired (${remapped} episodes remapped), ${needsReview} need review, ${failed} failed`,
      );
      return summary;
    } finally {
      this.structureReconcileRunning = false;
    }
  }

  // ---- Rating backfill ----
  private ratingFixRunning = false;

  private async stampRatingChecked(mediaId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = jsonb_set(
            COALESCE(metadata_provenance, '{}'::jsonb),
            '{ratingCheckedAt}', to_jsonb(NOW()::text))
      WHERE id = ${mediaId}`;
  }

  private async stampTmdbRating(mediaId: string, rating: number | null): Promise<void> {
    if (rating != null) {
      await this.prisma.$executeRaw`
        UPDATE media_items
        SET rating = ${rating},
            metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
              || jsonb_build_object(
                'ratingProvider', 'TMDB',
                'ratingRefreshedAt', NOW()::text,
                'ratingCheckedAt', NOW()::text
              )
        WHERE id = ${mediaId}`;
      return;
    }

    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object(
              'ratingProvider', 'TMDB',
              'ratingRefreshedAt', NOW()::text,
              'ratingCheckedAt', NOW()::text
            )
      WHERE id = ${mediaId}`;
  }

  /**
   * Park a per-item repair failure: remember the definitive provider 404 so the
   * job's candidate SQL skips the row for 90 days instead of re-hitting a dead
   * external id on every cron run (ISO strings compare correctly lexicographically
   * and cast cleanly to timestamptz). Mirrors the ratingCheckedAt convention.
   */
  private async stampRepairChecked(mediaId: string, key: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object(${key}::text, ${new Date().toISOString()}::text)
      WHERE id = ${mediaId}`;
  }

  /**
   * Fill `media_items.rating` for rows that have none — mostly TVDB-hydrated shows
   * (anime/animation): TVDB exposes no public 0–10 rating (its `score` is a
   * popularity rank), so their rows are born unrated. Ratings come from TMDB:
   *  - row has a TMDB id → ONE light `/tv|movie/{id}` call (vote_average);
   *  - TVDB-only row → TMDB `/find?external_source=tvdb_id` (authoritative, same
   *    chain the import matcher trusts) → light base call; no match → IMDB id from
   *    the TVDB extended record → `/find?external_source=imdb_id` → light base call.
   * The cross-id is only READ (never attached). Rows the source genuinely has no
   * rating for are remembered in metadata_provenance.ratingCheckedAt and skipped
   * for 90 days so the nightly job drains instead of re-checking forever.
   * Most-popular first, rate-limit early stop. User data untouched.
   */
  async backfillRatings(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
    noneAtSource: number;
    sample: string[];
  }> {
    const empty = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
      noneAtSource: 0,
      sample: [] as string[],
    };
    if (this.ratingFixRunning) {
      this.logger.log('Rating backfill already running — skipping');
      return empty;
    }
    this.ratingFixRunning = true;
    this.trackRepair('ratings', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 500, 100000));
      const candidates = await this.prisma.$queryRaw<
        {
          id: string;
          title: string;
          type: MediaType;
          tmdb_id: string | null;
          tvdb_id: string | null;
        }[]
      >`
        SELECT m.id, m.title, m.type,
          (SELECT e.value FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB'
             AND e.provider_entity_kind = (CASE WHEN m.type = 'SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
             LIMIT 1) AS tmdb_id,
          (SELECT e.value FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB'
             AND e.provider_entity_kind = (CASE WHEN m.type = 'SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
             LIMIT 1) AS tvdb_id
        FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND (
            (
              m.rating IS NULL
              AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id
                AND e.provider IN ('TMDB','THE_TVDB')
                AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")
              AND (m.metadata_provenance->>'ratingCheckedAt' IS NULL
                   OR (m.metadata_provenance->>'ratingCheckedAt')::timestamptz < NOW() - INTERVAL '90 days')
            )
            OR (
              m.type = 'SHOW'
              AND EXISTS (
                SELECT 1 FROM shows sh
                WHERE sh.media_id = m.id AND sh.structure_provider::text = 'TVDB'
              )
              AND EXISTS (
                SELECT 1 FROM external_ids e
                WHERE e.media_id = m.id
                  AND e.provider = 'TMDB'
                  AND e.provider_entity_kind::text = 'SERIES'
              )
              AND (
                m.metadata_provenance->>'ratingProvider' IS DISTINCT FROM 'TMDB'
                OR COALESCE(
                  m.metadata_provenance->>'ratingRefreshedAt',
                  '1970-01-01'
                )::timestamptz < NOW() - INTERVAL '30 days'
              )
            )
          )
        ORDER BY m.popularity DESC
        LIMIT ${take}
      `;

      this.trackRepair('ratings', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let rateLimited = 0;
      let noneAtSource = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('ratings', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          let rating: number | null = null;
          // Resolve the TMDB id: stored external id, else the authoritative
          // cross-id chain (tvdb_id find → imdb_id find via TVDB extended).
          let tmdbId = m.tmdb_id ? Number(m.tmdb_id) : null;
          let checkedRatingSource = false;
          if (this.tmdbProvider.enabled) {
            if (!tmdbId && m.tvdb_id) {
              let imdbId: string | null = null;
              if (m.type === MediaType.SHOW) {
                const found = await this.tmdbProvider.findByExternalIdStrict(m.tvdb_id, 'tvdb_id');
                tmdbId = found?.show?.tmdbId ?? null;
              } else if (this.tvdb.enabled) {
                // TMDB /find does not resolve TVDB movie ids. Read TVDB's verified
                // remote TMDB/IMDb ids, then use IMDb as the identity bridge if needed.
                const identity = await this.tvdb.getMovieIdentity(Number(m.tvdb_id));
                tmdbId = identity?.tmdbId ?? null;
                imdbId = identity?.imdbId ?? null;
              }
              if (!tmdbId && this.tvdb.enabled) {
                imdbId ??= await this.tvdb.fetchImdbId(
                  m.type === MediaType.SHOW ? 'show' : 'movie',
                  Number(m.tvdb_id),
                );
              }
              if (!tmdbId && imdbId) {
                const foundImdb = await this.tmdbProvider.findByExternalIdStrict(imdbId, 'imdb_id');
                tmdbId =
                  (m.type === MediaType.SHOW
                    ? foundImdb?.show?.tmdbId
                    : foundImdb?.movie?.tmdbId) ?? null;
              }
              checkedRatingSource = true;
            }
            if (tmdbId) {
              const base =
                m.type === MediaType.SHOW
                  ? await this.tmdbProvider.localizedShowBase(tmdbId, 'en-US')
                  : await this.tmdbProvider.localizedMovieBase(tmdbId, 'en-US');
              rating = base.rating ?? null;
              checkedRatingSource = true;
            }
          }
          if (rating != null && rating > 0) {
            await this.stampTmdbRating(m.id, rating);
            succeeded++;
            if (sample.length < 5) sample.push(`${m.title} (${rating.toFixed(1)})`);
          } else {
            noneAtSource++;
            // Stamp ONLY definitive no-rating answers/no-match answers. The strict
            // external-id lookups above throw for provider/rate-limit failures, so a
            // null TMDB id here means the checked source chain really had no rating
            // source available and should not be picked again tomorrow.
            if (checkedRatingSource) {
              if (tmdbId) await this.stampTmdbRating(m.id, null);
              else await this.stampRatingChecked(m.id);
            }
          }
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited++;
            this.logger.warn(`Rating backfill rate-limited after ${i} rows — deferring the rest`);
            break;
          }
          if (this.isNotFoundError(e)) {
            noneAtSource++;
            await this.stampRatingChecked(m.id);
            continue;
          }
          failed++;
          if (failed <= 10)
            this.logger.warn(`rating backfill failed for ${m.title}: ${(e as Error).message}`);
        }
        if ((i + 1) % 50 === 0) {
          this.logger.log(
            `Rating backfill progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${noneAtSource} none-at-source, ${failed} fail)`,
          );
        }
      }
      this.trackRepair('ratings', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Rating backfill: ${succeeded}/${candidates.length} rated, ${noneAtSource} none-at-source, ${failed} failed, ${rateLimited} rate-limited`,
      );
      return { processed: candidates.length, succeeded, failed, rateLimited, noneAtSource, sample };
    } finally {
      this.ratingFixRunning = false;
    }
  }

  // ---- Wrong-kind external ids ----
  private wrongKindIdFixRunning = false;

  /**
   * Detach provider aliases whose entity namespace contradicts the media row. A bad
   * MOVIE alias on a SHOW (or SERIES alias on a MOVIE) is safe to remove only when the
   * row already has at least one correct-kind provider identity. Unanchored rows are
   * reported as ambiguous and retained for manual review. User data is untouched.
   */
  async repairWrongKindExternalIds(
    limit?: number,
    mode: 'dry-run' | 'repair' = 'repair',
  ): Promise<{
    mode: 'dry-run' | 'repair';
    processed: number;
    detached: number;
    ambiguous: number;
    outcomes: {
      mediaId: string;
      title: string;
      action: 'detach' | 'ambiguous';
      aliases: { id: string; provider: string; value: string; kind: string }[];
      reason: string;
    }[];
  }> {
    const empty = { mode, processed: 0, detached: 0, ambiguous: 0, outcomes: [] as any[] };
    if (this.wrongKindIdFixRunning) return empty;
    this.wrongKindIdFixRunning = true;
    this.trackRepair('wrong-kind-external-ids', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const rows = await this.prisma.$queryRaw<
        {
          mediaId: string;
          title: string;
          aliases: { id: string; provider: string; value: string; kind: string }[];
          anchored: boolean;
        }[]
      >`
        SELECT m.id AS "mediaId", m.title,
          jsonb_agg(jsonb_build_object('id', bad.id, 'provider', bad.provider,
            'value', bad.value, 'kind', bad.provider_entity_kind) ORDER BY bad.provider, bad.value) AS aliases,
          EXISTS (
            SELECT 1 FROM external_ids good WHERE good.media_id=m.id
              AND good.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
              AND good.provider IN ('TMDB','IMDB','THE_TVDB')
          ) AS anchored
        FROM media_items m
        JOIN external_ids bad ON bad.media_id=m.id
          AND bad.provider_entity_kind!=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
        WHERE ${VISIBLE_MEDIA_SQL}
        GROUP BY m.id, m.title, m.type
        ORDER BY m.popularity DESC, m.id
        LIMIT ${Math.max(1, Math.min(limit ?? 500, 100000))}`;
      this.trackRepair('wrong-kind-external-ids', { total: rows.length });
      let detached = 0;
      let ambiguous = 0;
      const outcomes: typeof empty.outcomes = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const aliases = Array.isArray(row.aliases) ? row.aliases : [];
        if (!row.anchored) {
          ambiguous++;
          outcomes.push({
            mediaId: row.mediaId,
            title: row.title,
            action: 'ambiguous',
            aliases,
            reason: 'no correct-kind provider identity anchors this media row',
          });
        } else {
          if (mode === 'repair' && aliases.length) {
            await this.prisma.externalId.deleteMany({
              where: { id: { in: aliases.map((alias) => alias.id) } },
            });
          }
          detached += aliases.length;
          outcomes.push({
            mediaId: row.mediaId,
            title: row.title,
            action: 'detach',
            aliases,
            reason: `${mode === 'repair' ? 'detached' : 'would detach'} wrong-kind aliases; correct-kind identity retained`,
          });
        }
        this.trackRepair('wrong-kind-external-ids', {
          processed: i + 1,
          succeeded: detached,
          failed: ambiguous,
          current: row.title,
        });
      }
      this.trackRepair('wrong-kind-external-ids', {
        running: false,
        processed: rows.length,
        succeeded: detached,
        failed: ambiguous,
        finishedAt: new Date(),
      });
      return { mode, processed: rows.length, detached, ambiguous, outcomes };
    } finally {
      this.wrongKindIdFixRunning = false;
    }
  }

  // ---- TVDB id conflicts (multi-id rows) ----
  private tvdbIdFixRunning = false;

  private async stampTvdbIdAudit(
    mediaId: string,
    kind: ProviderEntityKind,
    status: 'benign' | 'unresolved' | 'ambiguous',
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media_items m
      SET metadata_provenance=jsonb_set(
        COALESCE(m.metadata_provenance, '{}'::jsonb), '{tvdbIdAudit}',
        jsonb_build_object(
          'fingerprint', ids.fingerprint,
          'status', ${status}::text,
          'checkedAt', ${new Date().toISOString()}::text
        ), true)
      FROM (
        SELECT media_id, md5(string_agg(value, '|' ORDER BY value)) AS fingerprint
        FROM external_ids
        WHERE media_id=${mediaId} AND provider='THE_TVDB'
          AND provider_entity_kind=${kind}::"ProviderEntityKind"
        GROUP BY media_id
      ) ids
      WHERE m.id=ids.media_id`;
  }

  /**
   * Repair rows carrying MORE THAN ONE TVDB id (same entity kind). Two cases:
   *  - Merge leftovers: every id maps to the same identity → benign, kept as-is.
   *  - Id poisoning (the old title-attach bug): ids map to different identities →
   *    aliases contradicting the row's TMDB/IMDb anchor are detached.
   * Series ids resolve through TMDB /find; movie ids resolve through TVDB remote ids.
   * Rows where no decisive id can be picked are reported as ambiguous (never guessed).
   * NON-DESTRUCTIVE for user data: detaching an external id never deletes history —
   * it only stops future lookups from resolving to the wrong row.
   */
  async repairTvdbIdConflicts(
    limit?: number,
    mode: 'dry-run' | 'repair' = 'repair',
  ): Promise<{
    mode: 'dry-run' | 'repair';
    processed: number;
    mergedKept: number;
    conflictsFixed: number;
    idsDetached: number;
    rateLimited: boolean;
    ambiguous: {
      mediaId: string;
      title: string;
      ids: string[];
      mapped: Record<string, number | null>;
      mappedImdb: Record<string, string | null>;
    }[];
    outcomes: {
      mediaId: string;
      title: string;
      action: 'keep' | 'detach' | 'ambiguous' | 'failed';
      ids: string[];
      reason: string;
    }[];
  }> {
    const empty = {
      mode,
      processed: 0,
      mergedKept: 0,
      conflictsFixed: 0,
      idsDetached: 0,
      rateLimited: false,
      ambiguous: [] as any[],
      outcomes: [] as {
        mediaId: string;
        title: string;
        action: 'keep' | 'detach' | 'ambiguous' | 'failed';
        ids: string[];
        reason: string;
      }[],
    };
    if (this.tvdbIdFixRunning) {
      this.logger.log('TVDB-id conflict repair already running — skipping');
      return empty;
    }
    if (!this.tmdbProvider.enabled && !this.tvdb.enabled) {
      this.logger.warn('TMDB and TVDB are not configured — skipping TVDB-id conflict repair');
      return empty;
    }
    this.tvdbIdFixRunning = true;
    this.trackRepair('tvdb-id-conflicts', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const rows = await this.prisma.$queryRaw<
        {
          mediaId: string;
          title: string;
          type: string;
          kind: string;
          ids: string[];
          fingerprint: string;
          tmdb: string | null;
          imdb: string | null;
        }[]
      >`
        SELECT e.media_id AS "mediaId", m.title, m.type, e.provider_entity_kind AS kind,
               array_agg(e.value ORDER BY e.value) AS ids,
               md5(string_agg(e.value, '|' ORDER BY e.value)) AS fingerprint,
               (SELECT value FROM external_ids t
                WHERE t.media_id = e.media_id AND t.provider = 'TMDB' AND t.provider_entity_kind = e.provider_entity_kind
                LIMIT 1) AS tmdb,
               (SELECT value FROM external_ids i
                WHERE i.media_id = e.media_id AND i.provider = 'IMDB' AND i.provider_entity_kind = e.provider_entity_kind
                LIMIT 1) AS imdb
        FROM external_ids e
        JOIN media_items m ON m.id = e.media_id
        WHERE ${VISIBLE_MEDIA_SQL}
          AND e.provider = 'THE_TVDB'
        GROUP BY e.media_id, m.title, m.type, m.metadata_provenance, e.provider_entity_kind
        HAVING count(*) > 1 AND (
          COALESCE(m.metadata_provenance #>> '{tvdbIdAudit,fingerprint}', '')
            != md5(string_agg(e.value, '|' ORDER BY e.value))
          OR COALESCE(m.metadata_provenance #>> '{tvdbIdAudit,checkedAt}', '1970-01-01')::timestamptz
            < NOW() - CASE COALESCE(m.metadata_provenance #>> '{tvdbIdAudit,status}', '')
                WHEN 'benign' THEN INTERVAL '100 years'
                WHEN 'unresolved' THEN INTERVAL '90 days'
                WHEN 'ambiguous' THEN INTERVAL '180 days'
                ELSE INTERVAL '0 days' END
        )
        ORDER BY m.title
        LIMIT ${Math.max(1, Math.min(limit ?? 500, 100000))}
      `;
      this.trackRepair('tvdb-id-conflicts', { total: rows.length });

      let mergedKept = 0;
      let conflictsFixed = 0;
      let idsDetached = 0;
      let processed = 0;
      let rateLimited = false;
      const ambiguous: any[] = [];
      const outcomes: typeof empty.outcomes = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        processed = i + 1;
        this.trackRepair('tvdb-id-conflicts', {
          processed: i + 1,
          succeeded: conflictsFixed,
          failed: ambiguous.length,
          current: row.title,
        });
        try {
          const mapped: Record<string, number | null> = {};
          const mappedImdb: Record<string, string | null> = {};
          for (const id of row.ids) {
            if (row.kind === ProviderEntityKind.MOVIE) {
              let identity: Awaited<ReturnType<TvdbProvider['getMovieIdentity']>> | null = null;
              if (this.tvdb.enabled) {
                try {
                  identity = await this.tvdb.getMovieIdentity(Number(id));
                } catch (e) {
                  if (this.isRateLimitError(e)) throw e;
                }
              }
              mapped[id] = identity?.tmdbId ?? null;
              mappedImdb[id] = identity?.imdbId ?? null;
            } else {
              let found: Awaited<ReturnType<TmdbProvider['findByExternalId']>> | null = null;
              if (this.tmdbProvider.enabled) {
                try {
                  found = await this.tmdbProvider.findByExternalId(id, 'tvdb_id');
                } catch (e) {
                  if (this.isRateLimitError(e)) throw e;
                }
              }
              mapped[id] = found?.show?.tmdbId ?? null;
              mappedImdb[id] = null;
            }
          }
          const rowTmdb = row.tmdb ? Number(row.tmdb) : null;
          const identityKey = (id: string) =>
            mapped[id] != null
              ? `tmdb:${mapped[id]}`
              : mappedImdb[id]
                ? `imdb:${mappedImdb[id]}`
                : null;
          const distinct = [
            ...new Set(row.ids.map(identityKey).filter((v): v is string => v != null)),
          ];
          const hasUnresolved = row.ids.some((id) => identityKey(id) == null);
          const matchesAnchor = (id: string) =>
            (rowTmdb != null && mapped[id] === rowTmdb) ||
            Boolean(row.imdb && mappedImdb[id] === row.imdb);
          const hasAnchor = rowTmdb != null || Boolean(row.imdb);
          const keep = hasAnchor ? row.ids.filter(matchesAnchor) : [];
          const bad =
            keep.length > 0
              ? row.ids.filter((id) => identityKey(id) != null && !matchesAnchor(id))
              : [];

          if (bad.length > 0) {
            if (mode === 'repair') {
              await this.prisma.externalId.deleteMany({
                where: {
                  mediaId: row.mediaId,
                  provider: 'THE_TVDB',
                  providerEntityKind: row.kind as any,
                  value: { in: bad },
                },
              });
              const remaining = row.ids.filter((id) => !bad.includes(id));
              if (remaining.length > 1) {
                await this.stampTvdbIdAudit(
                  row.mediaId,
                  row.kind as ProviderEntityKind,
                  remaining.every((id) => identityKey(id) != null && matchesAnchor(id))
                    ? 'benign'
                    : 'unresolved',
                );
              }
            }
            conflictsFixed++;
            idsDetached += bad.length;
            outcomes.push({
              mediaId: row.mediaId,
              title: row.title,
              action: 'detach',
              ids: bad,
              reason: `verified ids conflict with row ${rowTmdb ? `TMDB ${rowTmdb}` : `IMDb ${row.imdb}`}`,
            });
            this.logger.log(
              `TVDB-id conflict ${mode} for "${row.title}" (${row.mediaId}): kept ${keep.join(', ')}, ${mode === 'repair' ? 'detached' : 'would detach'} ${bad.join(', ')}`,
            );
            continue;
          }

          if (
            (hasAnchor && keep.length === 0 && distinct.length > 0) ||
            (!hasAnchor && distinct.length > 1)
          ) {
            ambiguous.push({
              mediaId: row.mediaId,
              title: row.title,
              ids: row.ids,
              mapped,
              mappedImdb,
            });
            outcomes.push({
              mediaId: row.mediaId,
              title: row.title,
              action: 'ambiguous',
              ids: row.ids,
              reason: hasAnchor
                ? 'no TVDB id resolves to the row identity'
                : 'multiple resolved identities and no row anchor',
            });
            if (mode === 'repair') {
              await this.stampTvdbIdAudit(row.mediaId, row.kind as ProviderEntityKind, 'ambiguous');
            }
            continue;
          }

          mergedKept++;
          outcomes.push({
            mediaId: row.mediaId,
            title: row.title,
            action: 'keep',
            ids: row.ids,
            reason:
              distinct.length === 0
                ? 'unresolved; retained conservatively'
                : hasUnresolved
                  ? 'resolved ids agree; unresolved aliases retained for later verification'
                  : 'all resolved ids describe the same media identity',
          });
          if (mode === 'repair') {
            await this.stampTvdbIdAudit(
              row.mediaId,
              row.kind as ProviderEntityKind,
              distinct.length === 0 || hasUnresolved ? 'unresolved' : 'benign',
            );
          }
        } catch (e) {
          if (this.isRateLimitError(e)) {
            rateLimited = true;
            this.logger.warn(`TVDB-id conflict ${mode} rate-limited after ${i} rows`);
            break;
          }
          outcomes.push({
            mediaId: row.mediaId,
            title: row.title,
            action: 'failed',
            ids: row.ids,
            reason: (e as Error).message,
          });
          this.logger.warn(
            `TVDB-id conflict check failed for "${row.title}": ${(e as Error).message}`,
          );
        }
      }
      this.trackRepair('tvdb-id-conflicts', {
        running: false,
        processed,
        succeeded: conflictsFixed,
        failed: ambiguous.length,
        finishedAt: new Date(),
      });
      this.logger.log(
        `TVDB-id conflict ${mode}: ${processed} rows checked — ${mergedKept} same/unresolved kept, ${conflictsFixed} conflicts ${mode === 'repair' ? 'fixed' : 'found'} (${idsDetached} ids ${mode === 'repair' ? 'detached' : 'would detach'}), ${ambiguous.length} ambiguous${rateLimited ? ', rate-limited' : ''}`,
      );
      return {
        mode,
        processed,
        mergedKept,
        conflictsFixed,
        idsDetached,
        ambiguous,
        outcomes,
        rateLimited,
      };
    } finally {
      this.tvdbIdFixRunning = false;
    }
  }

  // ---- Non-English base titles ----
  private enBaseFixRunning = false;

  private async stampEnglishBaseRepairFailure(mediaId: string, error: unknown): Promise<void> {
    const message = String((error as Error)?.message ?? error).slice(0, 300);
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object(
                 'enBaseRepairFailedAt', ${new Date().toISOString()}::text,
                 'enBaseRepairFailReason', ${message}::text)
      WHERE id = ${mediaId}`;
  }

  /**
   * Restore a trusted ENGLISH base for rows whose base/override was written in the wrong
   * language (older contaminations: title_locale != 'en', or a missing/wrong 'en' slot).
   * Strategy: clear metadataRefreshedAt and run the standard hydration — persistShow/
   * persistMovie rewrite the English base and the 'en' override from the provider.
   * TMDB id wins when both exist (richer payloads); TVDB is the fallback for TVDB-only rows.
   */
  async repairNonEnglishBase(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    sample: string[];
  }> {
    const empty = { processed: 0, succeeded: 0, failed: 0, sample: [] as string[] };
    if (this.enBaseFixRunning) {
      this.logger.log('Non-English base repair already running — skipping');
      return empty;
    }
    this.enBaseFixRunning = true;
    this.trackRepair('english-base', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 200, 100000));
      const ids = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.title_locale IS NOT NULL AND m.title_locale != 'en'
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id)
          AND (m.metadata_provenance->>'enBaseRepairFailedAt' IS NULL
               OR (m.metadata_provenance->>'enBaseRepairFailedAt')::timestamptz < NOW() - INTERVAL '24 hours')
        ORDER BY m.id
        LIMIT ${take}`;
      const candidates = await this.prisma.mediaItem.findMany({
        where: { id: { in: ids.map((r) => r.id) } },
        select: {
          id: true,
          title: true,
          type: true,
          contentClassification: true,
          show: {
            select: {
              keywords: true,
              structureProvider: true,
              structureReason: true,
            },
          },
          movie: { select: { keywords: true } },
          externalIds: { select: { provider: true, value: true, providerEntityKind: true } },
          genres: { select: { genre: { select: { slug: true, name: true } } } },
        },
      });
      const order = new Map(ids.map((r, idx) => [r.id, idx]));
      candidates.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

      this.trackRepair('english-base', { total: candidates.length });

      // Anime routing — the app's REAL signals (shared `isAnimeMedia`), not a genre guess.
      let succeeded = 0;
      let failed = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('english-base', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          await this.forceEnglishRehydrate(m);
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          failed++;
          await this.stampEnglishBaseRepairFailure(m.id, e).catch(() => undefined);
          this.logger.debug(
            `non-English base repair failed for "${m.title}": ${(e as Error).message}`,
          );
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `Non-English base repair progress: ${i + 1}/${candidates.length} (${succeeded} ok, ${failed} fail)`,
          );
        }
      }
      this.trackRepair('english-base', {
        running: false,
        processed: candidates.length,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Non-English base repair: ${succeeded}/${candidates.length} re-hydrated with English base, ${failed} failed`,
      );
      return { processed: candidates.length, succeeded, failed, sample };
    } finally {
      this.enBaseFixRunning = false;
    }
  }

  /**
   * Force a full re-hydration that rewrites the English base (+ 'en' override slot).
   * Shared by the marker-driven and content-driven English-base repairs.
   * Source rules: strict TMDB Animation + anime-keyword shows are TVDB-authoritative.
   * Everything else is TMDB-first, TVDB fallback for TVDB-only rows.
   */
  private async forceEnglishRehydrate(m: {
    id: string;
    type: string;
    contentClassification?: string | null;
    show?: {
      keywords?: unknown;
      structureProvider?: StructureProvider | null;
      structureReason?: StructureReason | null;
    } | null;
    movie?: { keywords?: unknown } | null;
    externalIds: { provider: string; value: string; providerEntityKind: string }[];
    genres?: { genre: { slug: string; name: string } }[];
  }): Promise<void> {
    // Clear the freshness stamp so the standard hydration path runs a full re-fetch.
    await this.prisma.mediaItem.update({
      where: { id: m.id },
      data: { metadataRefreshedAt: null },
    });
    const tmdbExt = m.externalIds.find(
      (e) => e.provider === 'TMDB' && e.providerEntityKind !== 'EPISODE',
    );
    const tvdbExt = m.externalIds.find((e) => e.provider === 'THE_TVDB');
    if (
      m.type === 'SHOW' &&
      m.show?.structureProvider === StructureProvider.TVDB &&
      m.show.structureReason === StructureReason.ANIME_TVDB
    ) {
      const repaired = await this.fixAnimeShowFromTvdb(m.id);
      if (!repaired.fixed && tvdbExt) {
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
      } else if (!repaired.fixed && tmdbExt) {
        // A structure-less row is routed from TMDB's lightweight profile. Strict
        // anime never writes TMDB seasons, even if no TVDB series id is available yet.
        await this.meta.ensureShowFull(Number(tmdbExt.value));
      }
    } else if (
      m.type === 'SHOW' &&
      m.show?.structureProvider === StructureProvider.TVDB &&
      tvdbExt
    ) {
      await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
    } else if (tmdbExt) {
      if (m.type === 'SHOW') await this.meta.ensureShowFull(Number(tmdbExt.value));
      else await this.meta.ensureMovieFull(Number(tmdbExt.value));
    } else if (tvdbExt) {
      if (m.type === 'SHOW') await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
      else await this.meta.ensureMovieFullTvdb(Number(tvdbExt.value));
    } else {
      throw new Error('no external ids to hydrate from');
    }
    // The title just changed language: every user with watch history on this row has a
    // stats snapshot (marathons/genres/networks) baked with the OLD title — mark those
    // snapshots stale so the next profile view recomputes them (SWR). Without this the
    // repair is invisible on profile pages until the user's next watch action.
    await this.prisma.$executeRaw`
      UPDATE user_stats_summary s
      SET stale = true
      WHERE EXISTS (
        SELECT 1 FROM watch_history h WHERE h.user_id = s.user_id AND h.media_id = ${m.id}
      )`;
  }

  // ---- Non-English CONTENT (wrong-language base with a lying or missing marker) ----
  private enContentFixRunning = false;

  /** The title an English user SEES: the 'en' override slot first, then the base column. */
  private englishVisibleTitle(m: { title: string; titles?: unknown }): string {
    const t = m.titles;
    const en = t && typeof t === 'object' ? (t as Record<string, unknown>).en : undefined;
    return typeof en === 'string' && en.trim() ? en.trim() : m.title;
  }

  /** The overview an English user SEES: the 'en' override slot first, then the base column. */
  private englishVisibleOverview(m: { overview?: string | null; overviews?: unknown }): string {
    const t = m.overviews;
    const en = t && typeof t === 'object' ? (t as Record<string, unknown>).en : undefined;
    if (typeof en === 'string' && en.trim()) return en.trim();
    return typeof m.overview === 'string' ? m.overview.trim() : '';
  }

  /** Loose title comparison: case/space/quote-insensitive (punctuation variants are the
   *  same title — anything stricter would flag false mismatches). */
  private normTitleForCompare(s: string): string {
    return s.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  }

  /** Overview is fine when there is nothing to compare: no visible text, or the provider
   *  simply HAS no English overview — a rehydrate cannot fix that, so treating it as a
   *  mismatch would fail → park → retry the same row forever. */
  private englishOverviewMatches(providerOverview: string, visibleOverview: string): boolean {
    if (!visibleOverview || !providerOverview) return true;
    return this.normTitleForCompare(providerOverview) === this.normTitleForCompare(visibleOverview);
  }

  /** The provider's canonical English base in ONE light call (TMDB localized base /
   *  TVDB English payload). null = unverifiable right now (no ids, provider down). */
  private async resolveProviderEnglishBase(m: {
    type: string;
    externalIds: { provider: string; value: string; providerEntityKind: string }[];
  }): Promise<{ title: string; overview: string } | null> {
    const tmdbExt = m.externalIds.find(
      (e) => e.provider === 'TMDB' && e.providerEntityKind !== 'EPISODE',
    );
    if (tmdbExt && this.tmdbProvider.enabled) {
      const base =
        m.type === 'SHOW'
          ? await this.tmdbProvider.localizedShowBase(Number(tmdbExt.value), 'en-US')
          : await this.tmdbProvider.localizedMovieBase(Number(tmdbExt.value), 'en-US');
      const title = base?.title?.trim();
      return title ? { title, overview: base?.overview?.trim() || '' } : null;
    }
    const tvdbExt = m.externalIds.find((e) => e.provider === 'THE_TVDB');
    if (tvdbExt && this.tvdb.enabled) {
      let base: { title?: string | null; overview?: string | null } | null | undefined;
      try {
        base =
          m.type === 'SHOW'
            ? await this.tvdb.localizedShowBase(Number(tvdbExt.value), 'eng')
            : await this.tvdb.localizedMovieBase(Number(tvdbExt.value), 'eng');
      } catch (e) {
        // TVDB sometimes has English in the extended meta=translations payload even when
        // the standalone /translations/eng endpoint 404s. Do not park those rows as
        // unfixable; fall back to the full English-normalized mapper.
        if (!this.isNotFoundError(e)) throw e;
        base =
          m.type === 'SHOW'
            ? await this.tvdb.getShow(Number(tvdbExt.value), 'en')
            : await this.tvdb.getMovie(Number(tvdbExt.value), 'en');
      }
      const title = base?.title?.trim();
      return title ? { title, overview: base?.overview?.trim() || '' } : null;
    }
    return null;
  }

  private async getEpisodeContentStats(
    mediaIds: string[],
  ): Promise<Map<string, { fingerprint: string; hasSuspect: boolean }>> {
    if (mediaIds.length === 0) return new Map();
    const ids = mediaIds.map((id) => Prisma.sql`${id}`);
    const rows = await this.prisma.$queryRaw<
      { mediaId: string; fingerprint: string | null; hasSuspect: boolean | null }[]
    >`
      SELECT sh.media_id AS "mediaId",
             count(e.id)::text || ':' || md5(COALESCE(string_agg(
               e.id || ':' || COALESCE(NULLIF(e.titles->>'en',''), e.title) || ':' || COALESCE(NULLIF(e.overviews->>'en',''), e.overview, ''),
               '|' ORDER BY e.id), '')) AS "fingerprint",
             bool_or(
               length(regexp_replace(COALESCE(NULLIF(e.titles->>'en',''), e.title), '[[:space:] -~‘’“”„‟‚‛‹›«»‐‑‒–—―…·•°©®™]', '', 'g')) >= 3
               OR length(regexp_replace(COALESCE(NULLIF(e.overviews->>'en',''), e.overview, ''), '[[:space:] -~‘’“”„‟‚‛‹›«»‐‑‒–—―…·•°©®™]', '', 'g')) >= 3
             ) AS "hasSuspect"
      FROM shows sh
      JOIN seasons s ON s.show_id = sh.id
      JOIN episodes e ON e.season_id = s.id
      WHERE sh.media_id IN (${Prisma.join(ids)})
      GROUP BY sh.media_id`;
    return new Map(
      rows.map((row) => [
        row.mediaId,
        { fingerprint: row.fingerprint ?? '', hasSuspect: row.hasSuspect === true },
      ]),
    );
  }

  private async stampEnglishContentVerified(
    mediaId: string,
    visibleTitle: string,
    visibleOverview: string,
    episodeFingerprint: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = ((COALESCE(metadata_provenance, '{}'::jsonb)
              - 'enContentRepairFailedAt') - 'enContentRepairFailReason')
            || jsonb_build_object('enContentVerifiedTitle', ${visibleTitle}::text,
                                  'enContentVerifiedOverview', ${visibleOverview}::text,
                                  'enContentVerifiedEpisodeFingerprint', ${episodeFingerprint}::text,
                                  'enContentVerifiedAt', ${new Date().toISOString()}::text,
                                  'enContentVerifiedVersion', ${EN_CONTENT_VERIFIER_VERSION})
      WHERE id = ${mediaId}`;
  }

  private async readEnglishVisibleContent(
    mediaId: string,
    fallback: { title: string; overview?: string | null },
  ): Promise<{ title: string; overview: string }> {
    const fresh = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: { title: true, titles: true, overview: true, overviews: true },
    });
    const source = fresh ?? {
      title: fallback.title,
      titles: null,
      overview: fallback.overview ?? null,
      overviews: null,
    };
    return {
      title: this.englishVisibleTitle(source),
      overview: this.englishVisibleOverview(source),
    };
  }

  private async stampEnglishContentRepairFailure(mediaId: string, error: unknown): Promise<void> {
    const message = String((error as Error)?.message ?? error).slice(0, 300);
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object(
                 'enContentRepairFailedAt', ${new Date().toISOString()}::text,
                 'enContentRepairFailReason', ${message}::text)
      WHERE id = ${mediaId}`;
  }

  /**
   * Content-based English repair — the blind spot of the marker stat: rows whose base
   * title/overview or episode text is the WRONG language even though title_locale says
   * 'en' (or is unset). This is what English users actually complain about.
   *
   * Normal mode scans SUSPECTS (the English-visible title/overview or episode text contains
   * non-ASCII), most-popular first — what users actually see gets verified first. Deep mode
   * verifies EVERY row with external ids — the only way to catch wrong-language media titles
   * or overviews that are pure ASCII (e.g. Italian) — paging the catalog with a wrapping Redis
   * id-cursor.
   *
   * CONVERGENCE: a row verified as already-English or successfully fixed is remembered
   * (metadata_provenance.enContentVerified*) and skipped until its English-visible content
   * changes — legit non-ASCII titles (Pokémon) are verified ONCE, not every run, and
   * new/changed contamination re-enters the pool automatically. Every media candidate is
   * VERIFIED against the provider's canonical English title/overview; episode suspects trigger
   * the parent show's existing English rehydrate path. User data untouched.
   */
  async repairNonEnglishContent(
    limit?: number,
    deep?: boolean,
  ): Promise<{
    processed: number;
    verified: number;
    fixed: number;
    failed: number;
    sample: string[];
  }> {
    const empty = { processed: 0, verified: 0, fixed: 0, failed: 0, sample: [] as string[] };
    if (this.enContentFixRunning) {
      this.logger.log('English-content repair already running — skipping');
      return empty;
    }
    this.enContentFixRunning = true;
    this.trackRepair('english-content', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 200, 100000));
      let ids: { id: string }[];
      if (deep) {
        const cursor = (await this.redis.get<string>(EN_CONTENT_DEEP_CURSOR_KEY)) ?? '';
        ids = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT m.id FROM media_items m
          WHERE ${VISIBLE_MEDIA_SQL}
            AND m.id > ${cursor}
            AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id)
            AND (m.metadata_provenance->>'enContentRepairFailedAt' IS NULL
                 OR (m.metadata_provenance->>'enContentRepairFailedAt')::timestamptz < NOW() - INTERVAL '24 hours')
            AND (
              COALESCE(NULLIF(m.titles->>'en',''), m.title)
                    IS DISTINCT FROM m.metadata_provenance->>'enContentVerifiedTitle'
              OR COALESCE(NULLIF(m.overviews->>'en',''), m.overview, '')
                    IS DISTINCT FROM COALESCE(m.metadata_provenance->>'enContentVerifiedOverview', '')
              OR COALESCE(
                   CASE WHEN (m.metadata_provenance->>'enContentVerifiedVersion') ~ '^\\d+$'
                        THEN (m.metadata_provenance->>'enContentVerifiedVersion')::int
                        ELSE 0 END,
                   0) < ${EN_CONTENT_VERIFIER_VERSION}
              OR (
                m.type = 'SHOW'
                AND EXISTS (SELECT 1 FROM shows sh JOIN seasons s ON s.show_id = sh.id JOIN episodes e ON e.season_id = s.id WHERE sh.media_id = m.id)
                AND COALESCE(m.metadata_provenance->>'enContentVerifiedEpisodeFingerprint', '')
                      IS DISTINCT FROM COALESCE((
                        SELECT count(e.id)::text || ':' || md5(COALESCE(string_agg(
                          e.id || ':' || COALESCE(NULLIF(e.titles->>'en',''), e.title) || ':' || COALESCE(NULLIF(e.overviews->>'en',''), e.overview, ''),
                          '|' ORDER BY e.id), ''))
                        FROM shows sh
                        JOIN seasons s ON s.show_id = sh.id
                        JOIN episodes e ON e.season_id = s.id
                        WHERE sh.media_id = m.id
                      ), '')
              )
            )
          ORDER BY m.id
          LIMIT ${take}`;
        // End of the catalog reached → next deep run wraps to the beginning.
        await this.redis.set(
          EN_CONTENT_DEEP_CURSOR_KEY,
          ids.length < take ? '' : (ids[ids.length - 1]?.id ?? cursor),
          86400 * 30,
        );
      } else {
        // Suspects, most-popular first. No cursor: verified (remembered) and fixed rows
        // leave the pool, so every run advances through NEW suspects only.
        ids = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT m.id FROM media_items m
          WHERE ${VISIBLE_MEDIA_SQL}
            AND (
              COALESCE(NULLIF(m.titles->>'en',''), m.title) ~ '[^ -~]'
              OR COALESCE(NULLIF(m.overviews->>'en',''), m.overview, '') ~ '[^ -~]'
              OR EXISTS (
                SELECT 1 FROM shows sh
                JOIN seasons s ON s.show_id = sh.id
                JOIN episodes e ON e.season_id = s.id
                WHERE sh.media_id = m.id
                  AND (
                    length(regexp_replace(COALESCE(NULLIF(e.titles->>'en',''), e.title), '[[:space:] -~‘’“”„‟‚‛‹›«»‐‑‒–—―…·•°©®™]', '', 'g')) >= 3
                    OR length(regexp_replace(COALESCE(NULLIF(e.overviews->>'en',''), e.overview, ''), '[[:space:] -~‘’“”„‟‚‛‹›«»‐‑‒–—―…·•°©®™]', '', 'g')) >= 3
                  )
              )
            )
            AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id)
            AND (m.metadata_provenance->>'enContentRepairFailedAt' IS NULL
                 OR (m.metadata_provenance->>'enContentRepairFailedAt')::timestamptz < NOW() - INTERVAL '24 hours')
            AND (
              COALESCE(NULLIF(m.titles->>'en',''), m.title)
                    IS DISTINCT FROM m.metadata_provenance->>'enContentVerifiedTitle'
              OR COALESCE(NULLIF(m.overviews->>'en',''), m.overview, '')
                    IS DISTINCT FROM COALESCE(m.metadata_provenance->>'enContentVerifiedOverview', '')
              OR COALESCE(
                   CASE WHEN (m.metadata_provenance->>'enContentVerifiedVersion') ~ '^\\d+$'
                        THEN (m.metadata_provenance->>'enContentVerifiedVersion')::int
                        ELSE 0 END,
                   0) < ${EN_CONTENT_VERIFIER_VERSION}
              OR (
                m.type = 'SHOW'
                AND EXISTS (SELECT 1 FROM shows sh JOIN seasons s ON s.show_id = sh.id JOIN episodes e ON e.season_id = s.id WHERE sh.media_id = m.id)
                AND COALESCE(m.metadata_provenance->>'enContentVerifiedEpisodeFingerprint', '')
                      IS DISTINCT FROM COALESCE((
                        SELECT count(e.id)::text || ':' || md5(COALESCE(string_agg(
                          e.id || ':' || COALESCE(NULLIF(e.titles->>'en',''), e.title) || ':' || COALESCE(NULLIF(e.overviews->>'en',''), e.overview, ''),
                          '|' ORDER BY e.id), ''))
                        FROM shows sh
                        JOIN seasons s ON s.show_id = sh.id
                        JOIN episodes e ON e.season_id = s.id
                        WHERE sh.media_id = m.id
                      ), '')
              )
            )
          ORDER BY m.popularity DESC, m.id
          LIMIT ${take}`;
      }
      if (ids.length === 0) {
        this.trackRepair('english-content', {
          running: false,
          processed: 0,
          total: 0,
          succeeded: 0,
          failed: 0,
          finishedAt: new Date(),
        });
        return empty;
      }
      const candidates = await this.prisma.mediaItem.findMany({
        where: { id: { in: ids.map((r) => r.id) } },
        select: {
          id: true,
          title: true,
          titles: true,
          overview: true,
          overviews: true,
          type: true,
          contentClassification: true,
          show: { select: { keywords: true } },
          movie: { select: { keywords: true } },
          externalIds: { select: { provider: true, value: true, providerEntityKind: true } },
          genres: { select: { genre: { select: { slug: true, name: true } } } },
        },
      });
      // Process in the SELECT's order (popularity for suspects, id for deep) —
      // findMany doesn't preserve the IN order.
      const order = new Map(ids.map((r, idx) => [r.id, idx]));
      candidates.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      const episodeStats = await this.getEpisodeContentStats(candidates.map((m) => m.id));
      this.trackRepair('english-content', { total: candidates.length });

      let verified = 0;
      let fixed = 0;
      let failed = 0;
      const sample: string[] = [];
      const failureReasons = new Map<string, number>();
      const recordFailureReason = (reason: string) => {
        failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1);
      };
      const classifyFailureReason = (error: unknown): string => {
        const message = String((error as Error)?.message ?? error);
        if (/429|rate.?limit|throttl/i.test(message)) return 'provider rate-limited/throttled';
        if (/timeout|timed out|ETIMEDOUT/i.test(message)) return 'provider timeout';
        if (/cached 404|not.?found|\b404\b/i.test(message)) return 'provider not found/404';
        return message.slice(0, 120) || 'unknown error';
      };
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('english-content', {
          processed: i + 1,
          succeeded: fixed,
          failed,
          current: m.title,
        });
        try {
          const providerBase = await this.resolveProviderEnglishBase(m);
          if (!providerBase) {
            failed++; // unverifiable right now — never guess
            recordFailureReason('no provider English base');
            await this.stampEnglishContentRepairFailure(m.id, 'no provider English base').catch(
              () => undefined,
            );
            if (failed <= 10)
              this.logger.warn(
                `English-content verify: no provider English base for "${m.title}" (${m.id}) — providers: ${m.externalIds.map((e) => e.provider).join(',') || 'none'}`,
              );
            continue;
          }
          const visibleTitle = this.englishVisibleTitle(m);
          const visibleOverview = this.englishVisibleOverview(m);
          const ep = episodeStats.get(m.id) ?? { fingerprint: '', hasSuspect: false };
          const titleMatches =
            this.normTitleForCompare(providerBase.title) === this.normTitleForCompare(visibleTitle);
          const overviewMatches = this.englishOverviewMatches(
            providerBase.overview,
            visibleOverview,
          );
          if (titleMatches && overviewMatches && !ep.hasSuspect) {
            verified++;
            // Remember the verified visible content: the row leaves the suspect pool until
            // its title/overview/episode fingerprint changes (new contamination re-arms it).
            await this.stampEnglishContentVerified(
              m.id,
              visibleTitle,
              visibleOverview,
              ep.fingerprint,
            );
            continue;
          }
          await this.forceEnglishRehydrate(m);
          const refreshedEp = (await this.getEpisodeContentStats([m.id])).get(m.id) ?? {
            fingerprint: ep.fingerprint,
            hasSuspect: false,
          };
          const refreshedContent = await this.readEnglishVisibleContent(m.id, providerBase);
          const refreshedTitleMatches =
            this.normTitleForCompare(providerBase.title) ===
            this.normTitleForCompare(refreshedContent.title);
          const refreshedOverviewMatches = this.englishOverviewMatches(
            providerBase.overview,
            refreshedContent.overview,
          );
          const stillWrongReasons = [
            !refreshedTitleMatches ? 'title still differs after rehydrate' : null,
            !refreshedOverviewMatches ? 'overview still differs after rehydrate' : null,
            refreshedEp.hasSuspect ? 'episode text still suspicious after rehydrate' : null,
          ].filter(Boolean) as string[];
          if (stillWrongReasons.length > 0) {
            failed++;
            const reason = stillWrongReasons.join('; ');
            recordFailureReason(reason);
            await this.stampEnglishContentRepairFailure(m.id, reason).catch(() => undefined);
            if (failed <= 10)
              this.logger.warn(`English-content repair: ${reason} for "${m.title}" (${m.id})`);
            continue;
          }
          await this.stampEnglishContentVerified(
            m.id,
            refreshedContent.title,
            refreshedContent.overview,
            refreshedEp.fingerprint,
          );
          fixed++;
          if (sample.length < 5) sample.push(`${m.title} → ${providerBase.title}`);
        } catch (e) {
          // A throttled provider would fail (and failure-stamp) every remaining row —
          // stop the batch like the sibling backfills instead of parking valid repairs.
          if (this.isRateLimitError(e)) {
            recordFailureReason('provider rate-limited/throttled');
            this.logger.warn(
              `English-content repair rate-limited after ${i} rows — stopping the batch early`,
            );
            break;
          }
          failed++;
          recordFailureReason(classifyFailureReason(e));
          await this.stampEnglishContentRepairFailure(m.id, e).catch(() => undefined);
          // First failures are WARN-visible (prod runs at info level); the rest stay debug.
          if (failed <= 10)
            this.logger.warn(
              `English-content repair failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
          else
            this.logger.debug(
              `English-content repair failed for "${m.title}": ${(e as Error).message}`,
            );
        }
        if ((i + 1) % 25 === 0) {
          this.logger.log(
            `English-content repair progress: ${i + 1}/${candidates.length} (${verified} already ok, ${fixed} fixed, ${failed} failed)`,
          );
        }
      }
      this.trackRepair('english-content', {
        running: false,
        processed: candidates.length,
        succeeded: fixed,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `English-content repair: ${candidates.length} checked — ${verified} already English, ${fixed} re-hydrated, ${failed} failed`,
      );
      if (failureReasons.size > 0) {
        const summary = [...failureReasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([reason, count]) => `${reason}: ${count}`)
          .join('; ');
        this.logger.warn(`English-content repair failure summary: ${summary}`);
      }
      return { processed: candidates.length, verified, fixed, failed, sample };
    } finally {
      this.enContentFixRunning = false;
    }
  }

  async repairOneEnglishContent(mediaId: string): Promise<{ fixed: boolean; reason?: string }> {
    const m = await this.prisma.mediaItem.findFirst({
      where: { ...VISIBLE_MEDIA_WHERE, id: mediaId },
      select: {
        id: true,
        title: true,
        titles: true,
        overview: true,
        overviews: true,
        type: true,
        contentClassification: true,
        show: { select: { keywords: true } },
        movie: { select: { keywords: true } },
        externalIds: { select: { provider: true, value: true, providerEntityKind: true } },
        genres: { select: { genre: { select: { slug: true, name: true } } } },
      },
    });
    if (!m) throw new NotFoundException('media not found');
    const providerBase = await this.resolveProviderEnglishBase(m);
    if (!providerBase) {
      await this.stampEnglishContentRepairFailure(mediaId, 'no provider English base').catch(
        () => undefined,
      );
      return { fixed: false, reason: 'no provider English base' };
    }
    await this.forceEnglishRehydrate(m);
    const refreshedEp = (await this.getEpisodeContentStats([mediaId])).get(mediaId) ?? {
      fingerprint: '',
      hasSuspect: false,
    };
    const refreshedContent = await this.readEnglishVisibleContent(mediaId, providerBase);
    const titleMatches =
      this.normTitleForCompare(providerBase.title) ===
      this.normTitleForCompare(refreshedContent.title);
    const overviewMatches = this.englishOverviewMatches(
      providerBase.overview,
      refreshedContent.overview,
    );
    const stillWrongReasons = [
      !titleMatches ? 'title still differs after rehydrate' : null,
      !overviewMatches ? 'overview still differs after rehydrate' : null,
      refreshedEp.hasSuspect ? 'episode text still suspicious after rehydrate' : null,
    ].filter(Boolean) as string[];
    if (stillWrongReasons.length) {
      const reason = stillWrongReasons.join('; ');
      await this.stampEnglishContentRepairFailure(mediaId, reason).catch(() => undefined);
      return { fixed: false, reason };
    }
    await this.stampEnglishContentVerified(
      mediaId,
      refreshedContent.title,
      refreshedContent.overview,
      refreshedEp.fingerprint,
    );
    return { fixed: true };
  }

  // ---- TVDB banner-as-poster rows (legacy of the swapped series artwork mapping) ----
  private bannerFixRunning = false;
  /** Prevents concurrent recommendations backfills. */
  private recommendationsFixRunning = false;

  private normalizeDuplicatedTvdbArtworkUrl(url?: string | null): string | null | undefined {
    if (!url) return url;
    const bases = ['https://artworks.thetvdb.com/banners/', 'http://artworks.thetvdb.com/banners/'];
    let out = url.trim();
    let changed = false;
    for (const base of bases) {
      const duplicate = `${base}${base}`;
      while (out.startsWith(duplicate)) {
        out = out.slice(base.length);
        changed = true;
      }
    }
    return changed ? out : url;
  }

  private normalizePosterUrlMap(value: unknown): { value: unknown; changed: boolean } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { value, changed: false };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string') {
        const normalized = this.normalizeDuplicatedTvdbArtworkUrl(raw);
        next[key] = normalized;
        if (normalized !== raw) changed = true;
      } else {
        next[key] = raw;
      }
    }
    return changed ? { value: next, changed } : { value, changed: false };
  }

  private isTvdbBannerPosterUrl(url?: string | null): boolean {
    return !!url && /\/banners\/[^/]+$/.test(url);
  }

  /**
   * Rehydrate rows whose POSTER is a TVDB banner (wide artwork in a poster slot) — the
   * old swapped series artwork mapping (type 1=banner taken as poster) wrote
   * `/banners/<file>` URLs into poster_url. The corrected TVDB mapper re-picks
   * poster=type 2 / backdrop=type 3, so a standard TVDB rehydration repairs the images.
   * Most-popular first; one TVDB call per row; stops early on TVDB rate limits.
   * User data untouched.
   */
  async repairBannerPosters(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    parked: number;
    sample: string[];
  }> {
    const empty = { processed: 0, succeeded: 0, failed: 0, parked: 0, sample: [] as string[] };
    if (this.bannerFixRunning) {
      this.logger.log('Banner-poster repair already running — skipping');
      return empty;
    }
    this.bannerFixRunning = true;
    this.trackRepair('banner-posters', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 500, 100000));
      const candidates = await this.prisma.$queryRaw<
        {
          id: string;
          title: string;
          type: string;
          structureProvider: StructureProvider | null;
          tmdb: string | null;
          tvdb: string | null;
          posterUrl: string | null;
          posterUrls: unknown;
        }[]
      >`
        SELECT m.id, m.title, m.type, sh.structure_provider AS "structureProvider",
               m.poster_url AS "posterUrl", m.poster_urls AS "posterUrls",
               (SELECT e.value FROM external_ids e
                  WHERE e.media_id=m.id AND e.provider='TMDB'
                    AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
                  ORDER BY e.value LIMIT 1) AS tmdb,
               (SELECT e.value FROM external_ids e
                  WHERE e.media_id = m.id AND e.provider = 'THE_TVDB'
                    AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
                  ORDER BY e.value LIMIT 1) AS tvdb
        FROM media_items m
        LEFT JOIN shows sh ON sh.media_id=m.id
        WHERE ${VISIBLE_MEDIA_SQL}
          AND (
            m.poster_url ~ '/banners/[^/]+$'
            OR m.poster_url LIKE 'https://artworks.thetvdb.com/banners/https://artworks.thetvdb.com/banners/%'
            OR m.poster_url LIKE 'http://artworks.thetvdb.com/banners/http://artworks.thetvdb.com/banners/%'
            OR EXISTS (
              SELECT 1 FROM jsonb_each_text(COALESCE(m.poster_urls, '{}'::jsonb)) p
              WHERE p.value ~ '/banners/[^/]+$'
                 OR p.value LIKE 'https://artworks.thetvdb.com/banners/https://artworks.thetvdb.com/banners/%'
                 OR p.value LIKE 'http://artworks.thetvdb.com/banners/http://artworks.thetvdb.com/banners/%'
            )
          )
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id
            AND e.provider IN ('TMDB','THE_TVDB')
            AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")
          AND COALESCE(m.metadata_provenance->>'bannerCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'
        ORDER BY m.popularity DESC, m.id
        LIMIT ${take}`;
      this.trackRepair('banner-posters', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let parked = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('banner-posters', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          const normalizedPosterUrl = this.normalizeDuplicatedTvdbArtworkUrl(m.posterUrl);
          const normalizedPosterUrls = this.normalizePosterUrlMap(m.posterUrls);
          if (normalizedPosterUrl !== m.posterUrl || normalizedPosterUrls.changed) {
            const data: any = {};
            if (normalizedPosterUrl !== m.posterUrl) data.posterUrl = normalizedPosterUrl;
            if (normalizedPosterUrls.changed) data.posterUrls = normalizedPosterUrls.value;
            await this.prisma.mediaItem.update({ where: { id: m.id }, data });
          }
          const localizedHasBanner =
            normalizedPosterUrls.value &&
            typeof normalizedPosterUrls.value === 'object' &&
            !Array.isArray(normalizedPosterUrls.value) &&
            Object.values(normalizedPosterUrls.value as Record<string, unknown>).some(
              (v) => typeof v === 'string' && this.isTvdbBannerPosterUrl(v),
            );
          if (!this.isTvdbBannerPosterUrl(normalizedPosterUrl) && !localizedHasBanner) {
            succeeded++;
            if (sample.length < 5) sample.push(m.title);
            continue;
          }
          if (m.type === 'SHOW') {
            if (m.structureProvider === StructureProvider.TMDB && m.tmdb) {
              await this.meta.ensureShowFull(Number(m.tmdb), undefined, {
                forceRefresh: true,
                writeScope: 'ARTWORK_ONLY',
              });
            } else if (m.tvdb) {
              await this.meta.ensureShowFullTvdb(Number(m.tvdb), undefined, {
                skipClassification: true,
                forceRefresh: true,
                writeScope: 'ARTWORK_ONLY',
              });
            } else {
              throw new Error('No correct-kind structural-owner id for artwork repair');
            }
          } else if (m.tmdb) {
            await this.prisma.mediaItem.update({
              where: { id: m.id },
              data: { metadataRefreshedAt: null },
            });
            await this.meta.ensureMovieFull(Number(m.tmdb));
          } else if (m.tvdb) {
            await this.prisma.mediaItem.update({
              where: { id: m.id },
              data: { metadataRefreshedAt: null },
            });
            await this.meta.ensureMovieFullTvdb(Number(m.tvdb));
          } else {
            throw new Error('No correct-kind provider id for artwork repair');
          }
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            this.logger.warn(
              `Banner-poster repair: TVDB rate limit at ${i + 1}/${candidates.length} — stopping early (${succeeded} fixed, ${failed} failed)`,
            );
            break;
          }
          if (this.isNotFoundError(e)) {
            // Dead TVDB id — the rehydration can never fix this row. Park 90 days.
            await this.stampRepairChecked(m.id, 'bannerCheckedAt');
            parked++;
            this.logger.debug(
              `Banner-poster repair parked "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
            continue;
          }
          failed++;
          if (failed <= 10)
            this.logger.warn(
              `Banner-poster repair failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
          else
            this.logger.debug(
              `Banner-poster repair failed for "${m.title}": ${(e as Error).message}`,
            );
        }
      }
      this.trackRepair('banner-posters', {
        running: false,
        processed: succeeded + failed + parked,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Banner-poster repair: ${succeeded}/${candidates.length} re-hydrated from TVDB with corrected artworks, ${failed} failed, ${parked} parked (404)`,
      );
      return { processed: succeeded + failed + parked, succeeded, failed, parked, sample };
    } finally {
      this.bannerFixRunning = false;
    }
  }

  /**
   * Sync the TMDB /recommendations snapshot for rows that never got one. Direct TMDB
   * rows use one light call. A TVDB canonical show without a live aggregate TMDB id
   * merges the lists of its verified active TMDB components, excludes every family id,
   * and falls back to a component's retained snapshot only when that component now 404s.
   * Other failures preserve the current snapshot and retry later. User data untouched.
   */
  async repairRecommendations(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    parked: number;
    sample: string[];
  }> {
    const empty = { processed: 0, succeeded: 0, failed: 0, parked: 0, sample: [] as string[] };
    if (!this.tmdbProvider.enabled) {
      this.logger.warn('TMDB not configured — skipping recommendations backfill');
      return empty;
    }
    if (this.recommendationsFixRunning) {
      this.logger.log('Recommendations backfill already running — skipping');
      return empty;
    }
    this.recommendationsFixRunning = true;
    this.trackRepair('recommendations', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 500, 100000));
      const candidates = await this.prisma.$queryRaw<
        { id: string; title: string; type: string; tmdb: string | null }[]
      >`
        SELECT m.id, m.title, m.type,
               (SELECT e.value FROM external_ids e
                  WHERE e.media_id = m.id AND e.provider = 'TMDB'
                    AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind"
                  ORDER BY e.value LIMIT 1) AS tmdb
        FROM media_items m
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.recommendations_synced_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB'
              AND e.provider_entity_kind=(CASE WHEN m.type='SHOW' THEN 'SERIES' ELSE 'MOVIE' END)::"ProviderEntityKind")
            OR (
              m.type = 'SHOW'
              AND EXISTS (
                SELECT 1
                FROM media_canonical_links l
                JOIN external_ids e ON e.media_id = l.source_media_id
                WHERE l.target_media_id = m.id
                  AND l.status = 'ACTIVE'::"MediaCanonicalStatus"
                  AND l.relation IN (
                    'EXACT_DUPLICATE'::"MediaCanonicalRelation",
                    'SEASON_COMPONENT'::"MediaCanonicalRelation"
                  )
                  AND e.provider = 'TMDB'
                  AND e.provider_entity_kind = 'SERIES'::"ProviderEntityKind"
              )
            )
          )
          AND COALESCE(m.metadata_provenance->>'recsCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'
        ORDER BY m.popularity DESC, m.id
        LIMIT ${take}`;
      this.trackRepair('recommendations', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let parked = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('recommendations', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          let recommendations: RecommendationItem[];
          if (m.type === 'SHOW') {
            if (m.tmdb) {
              try {
                recommendations = await this.tmdbProvider.getShowRecommendations(Number(m.tmdb));
              } catch (error) {
                if (!this.isNotFoundError(error)) throw error;
                const bridged = await this.canonicalShowRecommendations(m.id);
                if (bridged === null) throw error;
                recommendations = bridged;
              }
            } else {
              const bridged = await this.canonicalShowRecommendations(m.id);
              if (bridged === null) {
                throw new Error(`no verified TMDB recommendation sources for ${m.id}`);
              }
              recommendations = bridged;
            }
          } else {
            recommendations = await this.tmdbProvider.getMovieRecommendations(Number(m.tmdb));
          }
          // Empty lists stamp too — the provider has none for this row, so the
          // row leaves the stat and is never re-checked pointlessly.
          await this.prisma.mediaItem.update({
            where: { id: m.id },
            data: { recommendations: recommendations as any, recommendationsSyncedAt: new Date() },
          });
          succeeded++;
          if (sample.length < 5) sample.push(m.title);
        } catch (e) {
          if (this.isRateLimitError(e)) {
            this.logger.warn(
              `Recommendations backfill: TMDB rate limit at ${i + 1}/${candidates.length} — stopping early (${succeeded} synced, ${failed} failed)`,
            );
            break;
          }
          if (this.isNotFoundError(e)) {
            // Dead/wrong TMDB id (real or negative-cached 404): retrying every run
            // only churns the batch — park for 90 days, like the rating backfill.
            await this.stampRepairChecked(m.id, 'recsCheckedAt');
            parked++;
            this.logger.debug(
              `Recommendations backfill parked "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
            continue;
          }
          failed++;
          if (failed <= 10)
            this.logger.warn(
              `Recommendations backfill failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
          else
            this.logger.debug(
              `Recommendations backfill failed for "${m.title}": ${(e as Error).message}`,
            );
        }
      }
      this.trackRepair('recommendations', {
        running: false,
        processed: succeeded + failed + parked,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Recommendations backfill: ${succeeded}/${candidates.length} synced from TMDB, ${failed} failed, ${parked} parked (404)`,
      );
      return { processed: succeeded + failed + parked, succeeded, failed, parked, sample };
    } finally {
      this.recommendationsFixRunning = false;
    }
  }

  private async canonicalShowRecommendations(
    targetMediaId: string,
  ): Promise<RecommendationItem[] | null> {
    const links = await this.prisma.mediaCanonicalLink.findMany({
      where: {
        targetMediaId,
        status: MediaCanonicalStatus.ACTIVE,
        relation: {
          in: [MediaCanonicalRelation.EXACT_DUPLICATE, MediaCanonicalRelation.SEASON_COMPONENT],
        },
      },
      select: {
        relation: true,
        source: {
          select: {
            recommendations: true,
            externalIds: {
              where: {
                provider: ExternalProvider.TMDB,
                providerEntityKind: ProviderEntityKind.SERIES,
              },
              select: { value: true },
            },
          },
        },
      },
    });
    const sources = new Map<
      number,
      { relation: MediaCanonicalRelation; recommendations: unknown }
    >();
    for (const link of links) {
      for (const external of link.source.externalIds) {
        const tmdbId = Number(external.value);
        if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || sources.has(tmdbId)) continue;
        sources.set(tmdbId, {
          relation: link.relation,
          recommendations: link.source.recommendations,
        });
      }
    }
    if (sources.size === 0) return null;

    const lists: RecommendationItem[][] = [];
    let usableSources = 0;
    for (const [tmdbId, source] of sources) {
      try {
        lists.push(await this.tmdbProvider.getShowRecommendations(tmdbId));
        usableSources++;
      } catch (error) {
        if (!this.isNotFoundError(error)) throw error;
        const retained = recommendationItems(source.recommendations);
        if (retained.length > 0 || source.recommendations !== null) {
          lists.push(retained);
          usableSources++;
          continue;
        }
        // A dead exact aggregate is expected in TVDB-fallback families. A component,
        // however, must have either a live endpoint or its retained snapshot.
        if (source.relation === MediaCanonicalRelation.SEASON_COMPONENT) {
          throw new Error(`TMDB component ${tmdbId} has no recommendation snapshot`);
        }
      }
    }
    if (usableSources === 0) return null;
    return mergeCanonicalRecommendations(lists, new Set(sources.keys()));
  }

  // ---- Movie production-country backfill (movies.country is NULL on light/TVDB rows) ----
  private movieCountriesFixRunning = false;

  async repairMovieCountries(limit?: number): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    parked: number;
    sample: string[];
  }> {
    const empty = { processed: 0, succeeded: 0, failed: 0, parked: 0, sample: [] as string[] };
    if (!this.tmdbProvider.enabled) {
      this.logger.warn('TMDB not configured — skipping movie country backfill');
      return empty;
    }
    if (this.movieCountriesFixRunning) {
      this.logger.log('Movie country backfill already running — skipping');
      return empty;
    }
    this.movieCountriesFixRunning = true;
    this.trackRepair('movie-countries', {
      running: true,
      processed: 0,
      total: 0,
      succeeded: 0,
      failed: 0,
      finishedAt: null,
    });
    try {
      const take = Math.max(1, Math.min(limit ?? 500, 100000));
      const candidates = await this.prisma.$queryRaw<{ id: string; title: string; tmdb: string }[]>`
        SELECT m.id, m.title,
               (SELECT e.value FROM external_ids e
                  WHERE e.media_id = m.id AND e.provider = 'TMDB' AND e.provider_entity_kind = 'MOVIE'
                  LIMIT 1) AS tmdb
        FROM media_items m
        JOIN movies mv ON mv.media_id = m.id
        WHERE ${VISIBLE_MEDIA_SQL}
          AND m.type = 'MOVIE'
          AND mv.country IS NULL
          AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB' AND e.provider_entity_kind = 'MOVIE')
          AND COALESCE(m.metadata_provenance->>'countryCheckedAt', '1970-01-01')::timestamptz < NOW() - INTERVAL '90 days'
        ORDER BY m.popularity DESC, m.id
        LIMIT ${take}`;
      this.trackRepair('movie-countries', { total: candidates.length });

      let succeeded = 0;
      let failed = 0;
      let parked = 0;
      const sample: string[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const m = candidates[i];
        this.trackRepair('movie-countries', {
          processed: i + 1,
          succeeded,
          failed,
          current: m.title,
        });
        try {
          const country = await this.tmdbProvider.getMovieCountry(Number(m.tmdb));
          if (country) {
            await this.prisma.movie.update({ where: { mediaId: m.id }, data: { country } });
            succeeded++;
            if (sample.length < 5) sample.push(`${m.title} → ${country}`);
          }
          // Stamp every processed row (found or not — TMDB has no country for it) so the
          // stat drains and rows are re-checked only after 90 days, like the rating backfill.
          await this.stampRepairChecked(m.id, 'countryCheckedAt');
        } catch (e) {
          if (this.isRateLimitError(e)) {
            this.logger.warn(
              `Movie country backfill: TMDB rate limit at ${i + 1}/${candidates.length} — stopping early`,
            );
            break;
          }
          if (this.isNotFoundError(e)) {
            // Dead/wrong TMDB movie id — park for 90 days like the rows above.
            await this.stampRepairChecked(m.id, 'countryCheckedAt');
            parked++;
            continue;
          }
          failed++;
          if (failed <= 10)
            this.logger.warn(
              `Movie country backfill failed for "${m.title}" (${m.id}): ${(e as Error).message}`,
            );
        }
      }
      this.trackRepair('movie-countries', {
        running: false,
        processed: succeeded + failed + parked,
        succeeded,
        failed,
        finishedAt: new Date(),
      });
      this.logger.log(
        `Movie country backfill: ${succeeded}/${candidates.length} resolved from TMDB, ${failed} failed, ${parked} parked (404)`,
      );
      return { processed: succeeded + failed + parked, succeeded, failed, parked, sample };
    } finally {
      this.movieCountriesFixRunning = false;
    }
  }

  // ---- TMDB Changes sync (daily cron) ----

  /**
   * Call TMDB's /tv/changes and /movie/changes to detect media whose TMDB data changed
   * since the last run. For each changed ID that exists in our DB: clear the TMDB provider
   * cache, then ACTUALLY re-hydrate (ensureShowFull/ensureMovieFull) so the data is updated
   * immediately — not just marked stale. Shows whose persisted structural owner is TVDB
   * are skipped; TMDB may refresh their supplemental data through scoped jobs only.
   *
   * First run goes back 14 days; subsequent runs use the date stored in Redis.
   * Fully paginated (no arbitrary cap).
   *
   * `startDate` (YYYY-MM-DD): manual one-off backfill from a specific date. Custom-range
   * runs do NOT move the Redis cursor, so the daily progression is never disturbed.
   */
  async syncTmdbChanges(startDate?: string): Promise<{
    tvChanged: number;
    movieChanged: number;
    matched: number;
    hydrated: number;
    failed: number;
    skippedAnime: number;
  }> {
    if (!this.tmdb.enabled) {
      this.logger.warn('TMDB not configured — skipping changes sync');
      return { tvChanged: 0, movieChanged: 0, matched: 0, hydrated: 0, failed: 0, skippedAnime: 0 };
    }

    // Start date: explicit param (one-off), else last sync (Redis), else 14 days ago.
    const lastRunStr = await this.redis.get<string>('TMDB_CHANGES_LAST_RUN');
    const startDate_ =
      startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
        ? new Date(`${startDate}T00:00:00Z`)
        : lastRunStr
          ? new Date(lastRunStr)
          : new Date(Date.now() - 1000 * 60 * 60 * 24 * 14);
    const endDate = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    this.logger.log(
      `TMDB changes sync: ${fmt(startDate_)} → ${fmt(endDate)}${startDate ? ' (custom range)' : ''}`,
    );

    // Fetch ALL changed IDs from TMDB (fully paginated).
    const tvIds = await this.fetchChangedIds('tv', fmt(startDate_), fmt(endDate));
    const movieIds = await this.fetchChangedIds('movie', fmt(startDate_), fmt(endDate));
    const allIds = [...tvIds, ...movieIds];
    this.logger.log(
      `TMDB changes: ${tvIds.length} TV + ${movieIds.length} movie = ${allIds.length} total changed IDs`,
    );

    // Store the end date so the next run starts from here — EXCEPT for custom-range
    // one-offs, which must never disturb the daily progression.
    if (!startDate) {
      await this.redis.set('TMDB_CHANGES_LAST_RUN', endDate.toISOString(), 86400 * 30);
    }

    if (allIds.length === 0)
      return { tvChanged: 0, movieChanged: 0, matched: 0, hydrated: 0, failed: 0, skippedAnime: 0 };

    // Match against our DB in chunks (PostgreSQL has a 32767 bind-variable limit).
    const matched: {
      mediaId: string;
      value: string;
      media: {
        type: string;
        externalIds: any[];
        metadataProvenance?: unknown;
        show?: { structureProvider: StructureProvider | null } | null;
      };
    }[] = [];
    const CHUNK = 5000;
    for (let i = 0; i < allIds.length; i += CHUNK) {
      const chunk = allIds.slice(i, i + CHUNK).map(String);
      const rows = await this.prisma.externalId.findMany({
        where: { provider: ExternalProvider.TMDB, value: { in: chunk } },
        select: {
          mediaId: true,
          value: true,
          media: {
            select: {
              type: true,
              externalIds: true,
              metadataProvenance: true,
              show: { select: { structureProvider: true } },
            },
          },
        },
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
    let skippedAnime = 0;
    for (let i = 0; i < matched.length; i++) {
      const m = matched[i];
      const owner =
        m.media.show?.structureProvider?.toLowerCase() ??
        (m.media.metadataProvenance as any)?.structureProvider;
      try {
        if (m.media.type === 'SHOW') {
          if (owner === 'tvdb') {
            // TMDB may refresh its exclusive supplemental fields, but cannot write
            // TVDB-owned titles/cast/artwork/seasons/episodes.
            await this.meta.ensureShowFull(Number(m.value), undefined, {
              forceRefresh: true,
              writeScope: 'METADATA_ONLY',
            });
            skippedAnime++;
          } else {
            await this.meta.ensureShowFull(Number(m.value));
          }
        } else {
          await this.meta.ensureMovieFull(Number(m.value));
        }
        await this.meta.scheduleClassification(m.mediaId).catch(() => undefined);
        hydrated++;
      } catch (e) {
        failed++;
        this.logger.debug(
          `TMDB changes re-hydration failed for ${m.value}: ${(e as Error).message}`,
        );
      }
      // Progress log every 500 items so the admin can see it's working.
      if ((i + 1) % 500 === 0) {
        this.logger.log(
          `TMDB changes sync progress: ${i + 1}/${matched.length} processed (${hydrated} ok, ${failed} fail, ${skippedAnime} TVDB-owner structures skipped)`,
        );
      }
    }

    this.logger.log(
      `TMDB changes sync complete: ${hydrated} refreshed, ${failed} failed, ${skippedAnime} TVDB-owner structures skipped (TMDB supplemental fields refreshed)`,
    );
    return {
      tvChanged: tvIds.length,
      movieChanged: movieIds.length,
      matched: matched.length,
      hydrated,
      failed,
      skippedAnime,
    };
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
  private async fetchChangedIds(
    type: 'tv' | 'movie',
    startDate: string,
    endDate: string,
  ): Promise<number[]> {
    const ids: number[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      try {
        const res = await this.tmdb.get<any>(`/${type}/changes`, {
          start_date: startDate,
          end_date: endDate,
          page,
        });
        const results = Array.isArray(res?.results) ? res.results : [];
        if (results.length === 0) break;
        ids.push(...results.map((r: any) => Number(r.id)).filter(Number.isFinite));
        totalPages = res?.total_pages ?? 1;
        page++;
      } catch (e) {
        this.logger.debug(
          `TMDB changes fetch failed (page ${page}, ${type}): ${(e as Error).message}`,
        );
        break;
      }
    }
    return ids;
  }
}

function summarizeMappingConfidence(matchRules: Record<string, number>): {
  high: number;
  medium: number;
  low: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const [rule, count] of Object.entries(matchRules)) {
    if (rule === 'externalId' || rule === 'absolute+date') high += count;
    else if (rule === 'absolute' || rule === 'airDate+title') medium += count;
    else low += count;
  }
  return { high, medium, low };
}
