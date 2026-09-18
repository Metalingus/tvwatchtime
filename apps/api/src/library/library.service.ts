import type { WatchNextResponseDto, WatchNextBucketPageDto } from '@tvwatch/shared';
import { releaseDay } from '@tvwatch/shared';
import { currentCalendarDay, currentTimeZone, releaseCacheScope } from '../common/timezone.context';
import {
  isEpisodeBulkWatchEligible,
  episodeBeforeLocalDayWhere,
} from '../common/utils/episode-progress.util';
import { episodeProgressSql, episodeAiredSql } from '../common/utils/episode-progress.util';
import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EpisodeLabel,
  MediaType,
  MEDIA_TAG_SLUGS,
  UpcomingBucket,
  WatchNextBucket,
  type LibrarySort,
  type ShowProgressItemDto,
  type ShowProgressSection,
  type ShowProgressSummaryDto,
  type UpcomingGroupDto,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { currentLanguage } from '../common/language.context';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { mapEpisode } from '../common/utils/mapper.util';
import { localized } from '../common/utils/localization.util';
import { paginate } from '../common/dto/pagination.dto';
import { pastBucket } from './lib/past-buckets';
import { mostRecentlyWatchedFirst, promoteWatchNextFallback } from './lib/watch-next-fallback';
import { watchNextAiredEpisodeSql } from './lib/watch-next-eligibility';

/** Max items returned in the "Haven't watched for a while" (NOT_RECENTLY) rail. */
const NOT_RECENTLY_LIMIT = 10;

/** Initial Watch Next slice. Remaining cards page through the shared bucket endpoint. */
const WATCH_NEXT_LIMIT = 20;

/** Initial "Start watching" (START_WATCHING) slice — the rest pages via /me/watch-next/bucket. */
const START_WATCHING_LIMIT = 10;

/** Initial HISTORY slice on the watch list — older items page via /me/watch-next/history. */
const WATCH_NEXT_HISTORY_LIMIT = 10;

/** Past-episodes page size for the upcoming screen's infinite scroll-up. */
const UPCOMING_PAST_PAGE_SIZE = 10;
const UPCOMING_PAST_MAX_PAGE_SIZE = 50;

/**
 * Watch-next cache lifetime (seconds). Long enough that tab revisits and client
 * refetch storms hit Redis instead of recomputing (the recompute runs several
 * raw aggregate queries plus locale-overrides); correctness on user actions is
 * guaranteed by the explicit `watchnext:{userId}:*` invalidation in
 * tracking/collections/import/onboarding, not by this TTL.
 */
const WATCH_NEXT_CACHE_TTL_S = 300;

/** COPYING/FAILED sources stay visible. Only a fully verified ACTIVE cutover is hidden. */
const CANONICAL_VISIBLE_MEDIA = {
  OR: [
    { canonicalSource: { is: null } },
    { canonicalSource: { is: { status: { not: 'ACTIVE' as const } } } },
  ],
} satisfies Prisma.MediaItemWhereInput;

@Injectable()
export class LibraryService {
  /** Coalesce simultaneous cold-cache requests inside one API process. */
  private readonly cacheInflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly meta: MediaMetadataService,
  ) {}

  private slugList(value?: string) {
    return [
      ...new Set(
        (value ?? '')
          .split(',')
          .map((slug) => slug.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }

  private libraryMediaWhere(
    type: MediaType,
    filters?: {
      genre?: string;
      excludeGenres?: string;
      country?: string;
      tags?: string;
    },
  ): Prisma.MediaItemWhereInput {
    const included = this.slugList(filters?.genre);
    const excluded = this.slugList(filters?.excludeGenres);
    const knownTags = new Set<string>(MEDIA_TAG_SLUGS);
    const tags = this.slugList(filters?.tags).filter((slug) => knownTags.has(slug));
    const country = filters?.country?.trim().toUpperCase();
    return {
      type,
      ...(included.length
        ? {
            AND: included.map((slug) => ({
              genres: {
                some: { genre: { slug: { equals: slug, mode: 'insensitive' as const } } },
              },
            })),
          }
        : {}),
      ...(excluded.length
        ? {
            genres: {
              none: { genre: { slug: { in: excluded, mode: 'insensitive' as const } } },
            },
          }
        : {}),
      ...(tags.length ? { tags: { some: { tag: { slug: { in: tags } } } } } : {}),
      ...(country && type === MediaType.SHOW
        ? { show: { originCountries: { has: country } } }
        : {}),
      ...(country && type === MediaType.MOVIE
        ? { movie: { country: { equals: country, mode: 'insensitive' as const } } }
        : {}),
    };
  }

  private libraryStatusOrderBy(type: MediaType, sort: LibrarySort = 'addedDate'): any[] {
    if (sort === 'name') return [{ media: { normalizedTitle: 'asc' } }, { id: 'asc' }];
    if (sort === 'popularity') return [{ media: { popularity: 'desc' } }, { id: 'desc' }];
    if (sort === 'rating') {
      return [{ media: { rating: { sort: 'desc', nulls: 'last' } } }, { id: 'desc' }];
    }
    if (sort === 'releaseDate') {
      return [
        type === MediaType.MOVIE
          ? { media: { movie: { releaseDate: { sort: 'desc', nulls: 'last' } } } }
          : { media: { show: { yearStart: { sort: 'desc', nulls: 'last' } } } },
        { id: 'desc' },
      ];
    }
    return [{ watchedAt: 'desc' }, { id: 'desc' }];
  }

  private showLibraryFilterSql(filters?: {
    genre?: string;
    excludeGenres?: string;
    country?: string;
    tags?: string;
  }) {
    const included = this.slugList(filters?.genre);
    const excluded = this.slugList(filters?.excludeGenres);
    const knownTags = new Set<string>(MEDIA_TAG_SLUGS);
    const tags = this.slugList(filters?.tags).filter((slug) => knownTags.has(slug));
    const country = filters?.country?.trim().toUpperCase();
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    for (const slug of included) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM media_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE mg.media_id = mi.id AND LOWER(g.slug) = ${slug}
      )`);
    }
    if (excluded.length) {
      conditions.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM media_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE mg.media_id = mi.id AND LOWER(g.slug) IN (${Prisma.join(excluded)})
      )`);
    }
    if (country) conditions.push(Prisma.sql`${country} = ANY(sh.origin_countries)`);
    if (tags.length) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM media_item_tags mit
        JOIN media_tags mt ON mt.id = mit.tag_id
        WHERE mit.media_id = mi.id AND mt.slug IN (${Prisma.join(tags)})
      )`);
    }
    return Prisma.join(conditions, ' AND ');
  }

  private showLibraryOrderSql(sort: LibrarySort = 'addedDate') {
    if (sort === 'name') {
      return Prisma.sql`LOWER(COALESCE(mi.titles ->> ${currentLanguage()}, mi.title)) ASC, mi.id ASC`;
    }
    if (sort === 'releaseDate') return Prisma.sql`sh.year_start DESC NULLS LAST, mi.id DESC`;
    if (sort === 'popularity') return Prisma.sql`mi.popularity DESC, mi.id DESC`;
    if (sort === 'rating') return Prisma.sql`mi.rating DESC NULLS LAST, mi.id DESC`;
    return Prisma.sql`COALESCE(wi.created_at, p.created_at) DESC NULLS LAST, mi.id DESC`;
  }

  private async cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const usable = (value: T | null): value is T => {
      if (!value) return false;
      const refreshAt = (value as { refreshAt?: string }).refreshAt;
      return !refreshAt || Date.parse(refreshAt) > Date.now();
    };
    const cached = await this.redis.get<T>(key);
    if (usable(cached)) return cached;

    const running = this.cacheInflight.get(key) as Promise<T> | undefined;
    if (running) return running;

    const work = (async () => {
      // A sibling request may have filled Redis between the first lookup and
      // registration in the local in-flight map.
      const second = await this.redis.get<T>(key);
      if (usable(second)) return second;

      // Also coalesce across API replicas. A waiter briefly polls for the winner's
      // value, then falls back to its own computation if Redis is degraded or the
      // lock holder dies; the short lock TTL prevents permanent stalls.
      const client = (this.redis as any).client;
      const lockKey = `LOCK:library-cache:${key}`;
      const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const ownsLock = client?.set
        ? (await client.set(lockKey, token, 'PX', 30_000, 'NX').catch(() => null)) === 'OK'
        : false;
      if (client?.set && !ownsLock) {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const filled = await this.redis.get<T>(key);
          if (usable(filled)) return filled;
        }
      }

      try {
        const value = await load();
        if (key.startsWith('showsprogress:') && value && typeof value === 'object') {
          const nextBroadcast = await this.prisma.episode.findFirst({
            where: {
              structureState: 'ACTIVE',
              airTime: { not: null },
              NOT: { airTime: '' },
              airDate: { gt: new Date() },
              season: {
                isSpecial: false,
                show: { media: { showStatuses: { some: { userId: key.split(':')[1] } } } },
              },
            },
            orderBy: { airDate: 'asc' },
            select: { airDate: true },
          });
          (value as { refreshAt?: string }).refreshAt = nextBroadcast?.airDate?.toISOString();
        }
        await this.redis.set(key, value, ttlSeconds);
        return value;
      } finally {
        if (ownsLock && client?.eval) {
          const release = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
          await client.eval(release, 1, lockKey, token).catch(() => undefined);
        }
      }
    })().finally(() => this.cacheInflight.delete(key));
    this.cacheInflight.set(key, work);
    return work;
  }

  /**
   * Localize media title/poster/backdrop fields on a list of result items in the
   * request language, populating the locale override first (best-effort). Used by
   * library rails that read `media.title` directly instead of going through
   * fetchListDtos.
   */
  private async localizeItems<T>(
    items: T[],
    getMediaId: (i: T) => string | undefined,
  ): Promise<T[]> {
    const ids = [...new Set(items.map(getMediaId).filter((v): v is string => !!v))];
    if (ids.length === 0) return items;
    await this.meta.ensureListLocaleOverrides(ids);
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, titles: true, posterUrls: true, backdropUrls: true },
    });
    const map = new Map(rows.map((r) => [r.id, r]));
    return items.map((item) => {
      const m = map.get(getMediaId(item) as string);
      if (!m) return item;
      const out: any = { ...(item as any) };
      if ('showTitle' in out) out.showTitle = localized(m, 'titles', 'title') ?? out.showTitle;
      else if ('title' in out) out.title = localized(m, 'titles', 'title') ?? out.title;
      if ('posterUrl' in out)
        out.posterUrl = localized(m, 'posterUrls', 'posterUrl') ?? out.posterUrl;
      if ('backdropUrl' in out)
        out.backdropUrl = localized(m, 'backdropUrls', 'backdropUrl') ?? out.backdropUrl;
      return out as T;
    });
  }

  /** Localize the embedded episode title/overview/still on cards (watch-next,
   *  history) in the request language, populating the override first. Also localizes the
   *  `nextEpisode` payload used for optimistic mark-watched swaps. */
  private async localizeEpisodeTitles(items: any[]) {
    const epIds = items
      .flatMap((i) => [i?.episode?.id, i?.nextEpisode?.id])
      .filter(Boolean) as string[];
    if (epIds.length === 0) return;
    await this.meta.ensureEpisodeLocaleOverrides(epIds);
    const fresh = await this.prisma.episode.findMany({
      where: { id: { in: epIds } },
      select: {
        id: true,
        title: true,
        overview: true,
        stillUrl: true,
        runtimeMinutes: true,
        airDate: true,
        airTime: true,
        titles: true,
        overviews: true,
        stillUrls: true,
      },
    });
    const map = new Map(fresh.map((e) => [e.id, e]));
    let releaseChanged = false;
    const apply = (ep: any) => {
      const f = ep && map.get(ep.id);
      if (ep && f) {
        ep.title = localized(f, 'titles', 'title') ?? ep.title;
        ep.overview = localized(f, 'overviews', 'overview') ?? ep.overview;
        ep.stillUrl = localized(f, 'stillUrls', 'stillUrl') ?? ep.stillUrl;
        ep.runtimeMinutes = f.runtimeMinutes ?? ep.runtimeMinutes;
        if ('airDate' in f) {
          const airDate = f.airDate?.toISOString() ?? null;
          if (ep.airDate !== airDate || ep.airTime !== f.airTime) releaseChanged = true;
          ep.airDate = airDate;
          ep.airTime = f.airTime;
        }
      }
    };
    for (const item of items) {
      apply(item?.episode);
      apply(item?.nextEpisode);
    }
    return releaseChanged;
  }

  /**
   * Full watch-list computation (uncapped rails), cached per user+lang for 5 min.
   * Both watchNext (capped presentation payload) and watchNextBucket (per-rail
   * pagination for the "See more" buttons) derive from this one computation.
   * Key carries a v8 infix AFTER the userId (the empty-primary fallback now
   * prioritizes recently watched and fills from watchlist addition time,
   * Start Watching is ordered by watchlist addition time, and
   * eligibility is based on an actual watchlist row, not a potentially stale
   * user_show_status row) and
   * the old 500-show computation cap was removed). The key must stay inside the
   * `watchnext:{userId}:*` invalidation pattern shared by tracking/collections/
   * import/onboarding, or removed/paused shows linger until the TTL. Freshness
   * on user actions (mark watched, watchlist add/pause/remove, import) comes
   * from that explicit invalidation, NOT from a short TTL — language changes
   * need no invalidation because the language is part of the key.
   */
  private async computeWatchNext(userId: string) {
    const cacheKey = `watchnext:${userId}:v8:${currentLanguage()}:${releaseCacheScope()}`;
    return this.cached(cacheKey, WATCH_NEXT_CACHE_TTL_S, async () => {
      // Watch Next is a view of the user's current watchlist. A show-status row is
      // only progress state: imports/repairs can legitimately leave one behind after
      // the watchlist row is gone, so it must never be used as membership by itself.
      const [statusRows, watchlistIdsRaw] = await Promise.all([
        this.prisma.userShowStatus.findMany({
          where: { userId, dropped: false, pausedAt: null, media: CANONICAL_VISIBLE_MEDIA },
          include: { media: { include: { show: true } } },
          orderBy: { lastWatchedAt: 'desc' },
        }),
        this.prisma.watchlistItem.findMany({
          where: { userId, media: { type: 'SHOW', ...CANONICAL_VISIBLE_MEDIA } },
          select: { mediaId: true, createdAt: true },
        }),
      ]);
      const watchlistIds = new Set(watchlistIdsRaw.map((w) => w.mediaId));
      const watchlistAddedAt = new Map(
        watchlistIdsRaw.map((item) => [item.mediaId, item.createdAt] as const),
      );
      const statuses = statusRows.filter((status) => watchlistIds.has(status.mediaId));

      // Watchlist shows that DON'T have a user_show_status yet (never watched).
      // The full identity pool is retained server-side; only bounded pages are sent.
      const statusMediaIds = new Set(statuses.map((s) => s.mediaId));
      const watchlistShows = await this.prisma.watchlistItem.findMany({
        where: {
          userId,
          media: {
            type: 'SHOW',
            ...CANONICAL_VISIBLE_MEDIA,
            showStatuses: {
              none: {
                userId,
                OR: [{ pausedAt: { not: null } }, { dropped: true }],
              },
            },
          },
          ...(statusMediaIds.size ? { mediaId: { notIn: [...statusMediaIds] } } : {}),
        },
        include: { media: { include: { show: true } } },
        orderBy: { createdAt: 'desc' },
      });

      // Correct stale persisted counts from actual episode state, but constrain the
      // aggregation to watchlisted shows. History-only shows remain visible in the
      // History rail and cannot be resurrected into Watch Next by this query.
      const watchedShowsRaw = watchlistIds.size
        ? await this.prisma.$queryRaw<
            Array<{ mediaId: string; watchedCount: number; lastWatchedAt: Date | null }>
          >`
      SELECT sh.media_id AS "mediaId", COUNT(ues.id)::int AS "watchedCount", MAX(ues.watched_at) AS "lastWatchedAt"
      FROM user_episode_status ues
      JOIN episodes e ON ues.episode_id = e.id
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE ues.user_id = ${userId} AND ues.watched = true
        AND sh.media_id IN (${Prisma.join([...watchlistIds])})
        AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
        AND s.is_special = false
      GROUP BY sh.media_id
    `
        : [];
      const watchedMap = new Map(watchedShowsRaw.map((r) => [r.mediaId, r]));

      // Merge all sources — correct stale userShowStatus counts using actual userEpisodeStatus data
      const allStatuses: any[] = [
        ...statuses.map((s) => ({
          ...s,
          watchedCount: Math.max(s.watchedCount ?? 0, watchedMap.get(s.mediaId)?.watchedCount ?? 0),
          lastWatchedAt: s.lastWatchedAt ?? watchedMap.get(s.mediaId)?.lastWatchedAt ?? null,
          // Status-row shows with zero watched episodes still belong in Start Watching
          // when they're watchlisted (e.g. user unmarked every episode).
          isWatchlistOnly:
            watchlistIds.has(s.mediaId) &&
            Math.max(s.watchedCount ?? 0, watchedMap.get(s.mediaId)?.watchedCount ?? 0) === 0,
        })),
        ...watchlistShows.map((w) => ({
          userId,
          mediaId: w.mediaId,
          media: w.media,
          watchedCount: watchedMap.get(w.mediaId)?.watchedCount ?? 0,
          totalCount: 0,
          lastWatchedAt: watchedMap.get(w.mediaId)?.lastWatchedAt ?? null,
          // Usually this row means "never watched", but if a repair/import lost
          // user_show_status while retaining episode history, preserve that progress.
          isWatchlistOnly: (watchedMap.get(w.mediaId)?.watchedCount ?? 0) === 0,
        })),
      ];

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const airedEpisodeSql = watchNextAiredEpisodeSql(now);

      // Shows that can produce a card: started (has watched episodes) or watchlist-only.
      // (Shows the user viewed but never interacted with are skipped — previously via
      // `continue` in the loop, now filtered up-front so they don't bloat the queries.)
      const candidates = allStatuses.filter((s) => s.isWatchlistOnly || (s.watchedCount ?? 0) > 0);
      const candidateIds = candidates.map((s) => s.mediaId);
      const nextBroadcast = candidateIds.length
        ? await this.prisma.episode.findFirst({
            where: {
              structureState: 'ACTIVE',
              airTime: { not: null },
              NOT: { airTime: '' },
              airDate: { gt: now },
              season: { isSpecial: false, show: { mediaId: { in: candidateIds } } },
            },
            orderBy: { airDate: 'asc' },
            select: { airDate: true },
          })
        : null;

      // Batched episode lookups — one round trip each instead of two queries PER SHOW
      // (previously ~1000 sequential queries for 500 tracked shows → multi-second loads).
      const nextByMedia = new Map<string, any[]>();
      const rewatchNextByMedia = new Map<string, any[]>();
      const progressByMedia = new Map<string, { total: number; watched: number }>();
      const rewatchProgressByMedia = new Map<
        string,
        { total: number; watched: number; lastWatchedAt: Date | null }
      >();
      if (candidateIds.length) {
        // Next 2 unwatched, provably aired episodes per show via a window function.
        // A missing air date is not evidence that an episode aired and cannot create a card.
        // rn <= 2 so we also get the FOLLOWING episode → nextEpisode, used by the client
        // to optimistically swap the Watch-Next card to the next episode on mark-watched.
        const nextRows = await this.prisma.$queryRaw<
          Array<{ mediaId: string; episodeId: string; rn: number }>
        >`
        SELECT t."mediaId", t."episodeId", t.rn::int AS rn FROM (
          SELECT sh.media_id AS "mediaId", e.id AS "episodeId",
                 ROW_NUMBER() OVER (PARTITION BY sh.media_id ORDER BY s.number ASC, e.number ASC) AS rn
          FROM episodes e
          JOIN seasons s ON e.season_id = s.id
          JOIN shows sh ON s.show_id = sh.id
          WHERE sh.media_id IN (${Prisma.join(candidateIds)})
            AND s.is_special = false
            AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
            AND ${airedEpisodeSql}
            AND NOT EXISTS (
              SELECT 1 FROM user_episode_status ues
              WHERE ues.episode_id = e.id AND ues.user_id = ${userId} AND ues.watched = true
            )
        ) t
        WHERE t.rn <= 2
        ORDER BY t."mediaId", t.rn
      `;

        const rewatchNextRows = await this.prisma.$queryRaw<
          Array<{ mediaId: string; episodeId: string; rn: number }>
        >`
        SELECT t."mediaId", t."episodeId", t.rn::int AS rn FROM (
          SELECT sh.media_id AS "mediaId", e.id AS "episodeId",
                 ROW_NUMBER() OVER (PARTITION BY sh.media_id ORDER BY s.number ASC, e.number ASC) AS rn
          FROM user_show_status uss
          JOIN shows sh ON sh.media_id = uss.media_id
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE uss.user_id = ${userId}
            AND uss.rewatch_started_at IS NOT NULL
            AND sh.media_id IN (${Prisma.join(candidateIds)})
            AND s.is_special = false
            AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
            AND ${airedEpisodeSql}
            AND NOT EXISTS (
              SELECT 1 FROM watch_history wh
              WHERE wh.user_id = ${userId}
                AND wh.media_id = sh.media_id
                AND wh.episode_id = e.id
                AND wh.watched_at >= uss.rewatch_started_at
            )
        ) t
        WHERE t.rn <= 2
        ORDER BY t."mediaId", t.rn
      `;

        // Hydrate the picked episodes (one query) so mapEpisode/episodeLabel get full rows.
        const episodeIds = [
          ...new Set([...nextRows, ...rewatchNextRows].map((row) => row.episodeId)),
        ];
        const episodes = episodeIds.length
          ? await this.prisma.episode.findMany({
              where: { id: { in: episodeIds } },
              include: { season: true },
            })
          : [];
        const epById = new Map(episodes.map((e) => [e.id, e]));
        for (const r of nextRows) {
          const ep = epById.get(r.episodeId);
          if (!ep) continue;
          const arr = nextByMedia.get(r.mediaId) ?? [];
          arr.push(ep);
          nextByMedia.set(r.mediaId, arr);
        }
        for (const row of rewatchNextRows) {
          const episode = epById.get(row.episodeId);
          if (!episode) continue;
          const values = rewatchNextByMedia.get(row.mediaId) ?? [];
          values.push(episode);
          rewatchNextByMedia.set(row.mediaId, values);
        }

        // Progress-eligible episode totals per show — one round trip.
        const totals = await this.prisma.$queryRaw<
          Array<{ mediaId: string; total: number; watched: number }>
        >`
        SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS total,
               COUNT(ues.id) FILTER (WHERE ues.watched = true)::int AS watched
        FROM shows sh
        JOIN seasons s ON s.show_id = sh.id
        JOIN episodes e ON e.season_id = s.id
        LEFT JOIN user_episode_status ues
          ON ues.episode_id = e.id AND ues.user_id = ${userId}
        WHERE sh.media_id IN (${Prisma.join(candidateIds)})
          AND s.is_special = false
          AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
          AND ${airedEpisodeSql}
        GROUP BY sh.media_id
      `;
        for (const row of totals) {
          progressByMedia.set(row.mediaId, { total: row.total, watched: row.watched });
        }

        const rewatchTotals = await this.prisma.$queryRaw<
          Array<{
            mediaId: string;
            total: number;
            watched: number;
            lastWatchedAt: Date | null;
          }>
        >`
        SELECT sh.media_id AS "mediaId",
               COUNT(DISTINCT e.id)::int AS total,
               COUNT(DISTINCT wh.episode_id)::int AS watched,
               MAX(wh.watched_at) AS "lastWatchedAt"
        FROM user_show_status uss
        JOIN shows sh ON sh.media_id = uss.media_id
        JOIN seasons s ON s.show_id = sh.id
        JOIN episodes e ON e.season_id = s.id
        LEFT JOIN watch_history wh
          ON wh.user_id = ${userId}
         AND wh.media_id = sh.media_id
         AND wh.episode_id = e.id
         AND wh.watched_at >= uss.rewatch_started_at
        WHERE uss.user_id = ${userId}
          AND uss.rewatch_started_at IS NOT NULL
          AND sh.media_id IN (${Prisma.join(candidateIds)})
          AND s.is_special = false
          AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
          AND ${airedEpisodeSql}
        GROUP BY sh.media_id
      `;
        for (const row of rewatchTotals) rewatchProgressByMedia.set(row.mediaId, row);
      }

      const watchNext: any[] = [];
      const startWatching: any[] = [];
      const notRecently: any[] = [];

      for (const status of candidates) {
        const isRewatching = !!status.rewatchStartedAt;
        // Next unwatched AIRED episode — handles ongoing shows where new seasons were
        // added after the user finished watching.
        const nextEpisodes = isRewatching
          ? (rewatchNextByMedia.get(status.mediaId) ?? [])
          : (nextByMedia.get(status.mediaId) ?? []);
        const next = nextEpisodes[0];
        if (!next) continue;

        const progress = isRewatching
          ? rewatchProgressByMedia.get(status.mediaId)
          : progressByMedia.get(status.mediaId);
        const { total: totalCount = 0, watched: watchedCount = 0 } = progress ?? {};
        const sessionLastWatchedAt =
          isRewatching && progress && 'lastWatchedAt' in progress
            ? progress.lastWatchedAt
            : status.lastWatchedAt;

        const realRemaining = Math.max(1, totalCount - watchedCount);
        const card = {
          showId: status.mediaId,
          showTitle: status.media.title,
          posterUrl: status.media.posterUrl,
          backdropUrl: status.media.backdropUrl,
          network: status.media.show?.network ?? null,
          episode: mapEpisode(next, { watched: isRewatching }),
          // Following unwatched episode, used by the client for the optimistic mark-watched swap.
          // null when `next` is the last unwatched episode (show will finish when it's watched).
          nextEpisode: nextEpisodes[1]
            ? mapEpisode(nextEpisodes[1], { watched: isRewatching })
            : null,
          remainingUnwatched: realRemaining,
          label: this.episodeLabel(next, watchedCount),
          lastWatchedAt: sessionLastWatchedAt ?? status.rewatchStartedAt ?? status.lastWatchedAt,
          progress: totalCount ? watchedCount / totalCount : 0,
          watchedCount,
          isRewatching,
          bucket: '' as WatchNextBucket,
        };

        if (isRewatching) {
          card.bucket = WatchNextBucket.WATCH_NEXT;
          watchNext.push(card);
          continue;
        }

        const stale = !status.lastWatchedAt || status.lastWatchedAt < thirtyDaysAgo;
        // If the next episode aired recently (new season just started), prioritize as WATCH_NEXT
        // even if the user hasn't watched in a while — fresh content is always relevant
        const nextAirDate = next.airDate ? new Date(next.airDate) : null;
        const hasFreshContent = nextAirDate && nextAirDate > thirtyDaysAgo;
        if (status.isWatchlistOnly) {
          card.bucket = WatchNextBucket.START_WATCHING;
          startWatching.push(card);
        } else if (stale && watchedCount > 0 && !hasFreshContent) {
          card.bucket = WatchNextBucket.NOT_RECENTLY;
          notRecently.push(card);
        } else {
          card.bucket = WatchNextBucket.WATCH_NEXT;
          watchNext.push(card);
        }
      }

      const history = await this.recentlyWatchedEpisodes(userId, WATCH_NEXT_HISTORY_LIMIT + 1);
      const historyHasMore = history.length > WATCH_NEXT_HISTORY_LIMIT;
      if (historyHasMore) history.length = WATCH_NEXT_HISTORY_LIMIT;

      watchNext.sort(
        (a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0),
      );
      // Status-backed and watchlist-only shows are merged above, so sort the completed
      // rail from the authoritative watchlist timestamps rather than source-query order.
      startWatching.sort((a, b) => {
        const addedAtDifference =
          (watchlistAddedAt.get(b.showId)?.getTime() ?? 0) -
          (watchlistAddedAt.get(a.showId)?.getTime() ?? 0);
        return addedAtDifference || a.showId.localeCompare(b.showId);
      });
      // The stale rail is chronological: the show watched most recently appears first.
      notRecently.sort(mostRecentlyWatchedFirst);

      // If the primary rail is empty, promote up to five recently watched eligible
      // shows first. Only unfilled slots come from the most recently watchlist-added
      // candidates (including Start Watching). Every card still has a real aired episode.
      const fallback = promoteWatchNextFallback(watchNext, notRecently, startWatching, (a, b) => {
        const addedAtDifference =
          (watchlistAddedAt.get(b.showId)?.getTime() ?? 0) -
          (watchlistAddedAt.get(a.showId)?.getTime() ?? 0);
        return addedAtDifference || mostRecentlyWatchedFirst(a, b);
      });

      // Cache raw uncapped rails. Localization is deliberately deferred until the
      // bounded response slice is known; otherwise a cold request hydrates locale
      // overrides for hundreds of off-screen cards.
      return {
        refreshAt: nextBroadcast?.airDate?.toISOString(),
        history,
        historyHasMore,
        watchNext: fallback.watchNext,
        startWatching: fallback.recentlyAdded,
        notRecently: fallback.notRecently,
      };
    });
  }

  /** Capped presentation payload for the Watch list tab (first page per rail). */
  async watchNext(userId: string, reconcileRelease = true): Promise<WatchNextResponseDto> {
    const c = await this.computeWatchNext(userId);
    let items = [
      ...c.history,
      ...c.watchNext.slice(0, WATCH_NEXT_LIMIT),
      // "Haven't watched for a while" renders before "Start watching".
      ...c.notRecently.slice(0, NOT_RECENTLY_LIMIT),
      ...c.startWatching.slice(0, START_WATCHING_LIMIT),
    ];
    items = await this.localizeItems(items, (item) => item.showId);
    const metadataPending =
      (await this.meta.scheduleIncompleteEpisodeRefresh?.(
        items
          .filter((item) => item.bucket !== WatchNextBucket.HISTORY)
          .flatMap((item) => [item.episode?.id, item.nextEpisode?.id])
          .filter((id): id is string => !!id),
      )) ?? false;
    const releaseChanged = await this.localizeEpisodeTitles(items);
    if (releaseChanged && reconcileRelease) {
      await this.redis.delByPattern('watchnext:' + userId + ':*');
      await this.redis.delByPattern('upcoming:' + userId + ':*');
      await this.redis.delByPattern('showsprogress:' + userId + ':*');
      return this.watchNext(userId, false);
    }
    return {
      items,
      metadataPending,
      historyHasMore: c.historyHasMore,
      refreshAt: c.refreshAt,
      // Totals drive the per-section "See more" buttons (10-at-a-time paging).
      bucketTotals: {
        watchNext: c.watchNext.length,
        notRecently: c.notRecently.length,
        startWatching: c.startWatching.length,
      },
    };
  }

  /**
   * Offset pagination over a capped watch-list rail (WATCH_NEXT / START_WATCHING /
   * NOT_RECENTLY)
   * for the section "See more" buttons — reads the same cached computation as
   * watchNext, so page fetches are cheap within the cache TTL window.
   */
  async watchNextBucket(
    userId: string,
    bucket: 'WATCH_NEXT' | 'START_WATCHING' | 'NOT_RECENTLY',
    offset = 0,
    limit = 10,
    reconcileRelease = true,
  ): Promise<WatchNextBucketPageDto> {
    const c = await this.computeWatchNext(userId);
    const full =
      bucket === 'WATCH_NEXT'
        ? c.watchNext
        : bucket === 'START_WATCHING'
          ? c.startWatching
          : c.notRecently;
    let items = full.slice(offset, offset + limit);
    items = await this.localizeItems(items, (item) => item.showId);
    const metadataPending =
      (await this.meta.scheduleIncompleteEpisodeRefresh?.(
        items
          .filter((item) => item.bucket !== WatchNextBucket.HISTORY)
          .flatMap((item) => [item.episode?.id, item.nextEpisode?.id])
          .filter((id): id is string => !!id),
      )) ?? false;
    const releaseChanged = await this.localizeEpisodeTitles(items);
    if (releaseChanged && reconcileRelease) {
      await this.redis.delByPattern('watchnext:' + userId + ':*');
      await this.redis.delByPattern('upcoming:' + userId + ':*');
      await this.redis.delByPattern('showsprogress:' + userId + ':*');
      return this.watchNextBucket(userId, bucket, offset, limit, false);
    }
    return {
      items,
      metadataPending,
      refreshAt: c.refreshAt,
      total: full.length,
      hasMore: offset + items.length < full.length,
      nextOffset: offset + items.length,
    };
  }

  /**
   * Watch-next cards for PAUSED shows (tracking paused): the same next-unwatched-
   * aired-episode pipeline as watchNext, sourced only from paused, non-dropped
   * statuses with at least one watched episode. Rendered in the mobile Shows tab as
   * its own rail under "Haven't watched for a while". Cache key stays under the
   * `watchnext:{userId}:*` invalidation pattern shared by tracking/collections.
   */
  async pausedWatchNext(
    userId: string,
    reconcileRelease = true,
  ): Promise<Pick<WatchNextResponseDto, 'items' | 'metadataPending'>> {
    const cacheKey = `watchnext:${userId}:paused:${currentLanguage()}:${releaseCacheScope()}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) {
      cached.metadataPending =
        (await this.meta.scheduleIncompleteEpisodeRefresh?.(
          cached.items
            .flatMap((item: any) => [item.episode?.id, item.nextEpisode?.id])
            .filter(Boolean),
        )) ?? false;
      const releaseChanged = await this.localizeEpisodeTitles(cached.items);
      if (releaseChanged && reconcileRelease) {
        await this.redis.delByPattern('watchnext:' + userId + ':*');
        await this.redis.delByPattern('upcoming:' + userId + ':*');
        await this.redis.delByPattern('showsprogress:' + userId + ':*');
        return this.pausedWatchNext(userId, false);
      }
      return cached;
    }

    const statuses = await this.prisma.userShowStatus.findMany({
      where: {
        userId,
        dropped: false,
        pausedAt: { not: null },
        watchedCount: { gt: 0 },
        media: CANONICAL_VISIBLE_MEDIA,
      },
      include: { media: { include: { show: true } } },
      orderBy: { lastWatchedAt: 'desc' },
      take: 100,
    });
    const candidateIds = statuses.map((s) => s.mediaId);

    const now = new Date();
    const nextByMedia = new Map<string, any[]>();
    const progressByMedia = new Map<string, { total: number; watched: number }>();
    if (candidateIds.length) {
      // Same window-function pipeline as watchNext (rn <= 2: next + following episode).
      const nextRows = await this.prisma.$queryRaw<
        Array<{ mediaId: string; episodeId: string; rn: number }>
      >`
        SELECT t."mediaId", t."episodeId", t.rn::int AS rn FROM (
          SELECT sh.media_id AS "mediaId", e.id AS "episodeId",
                 ROW_NUMBER() OVER (PARTITION BY sh.media_id ORDER BY s.number ASC, e.number ASC) AS rn
          FROM episodes e
          JOIN seasons s ON e.season_id = s.id
          JOIN shows sh ON s.show_id = sh.id
          WHERE sh.media_id IN (${Prisma.join(candidateIds)})
            AND s.is_special = false
            AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
            AND ${episodeAiredSql(now)}
            AND NOT EXISTS (
              SELECT 1 FROM user_episode_status ues
              WHERE ues.episode_id = e.id AND ues.user_id = ${userId} AND ues.watched = true
            )
        ) t
        WHERE t.rn <= 2
        ORDER BY t."mediaId", t.rn
      `;
      const episodeIds = nextRows.map((r) => r.episodeId);
      const episodes = episodeIds.length
        ? await this.prisma.episode.findMany({
            where: { id: { in: episodeIds } },
            include: { season: true },
          })
        : [];
      const epById = new Map(episodes.map((e) => [e.id, e]));
      for (const r of nextRows) {
        const ep = epById.get(r.episodeId);
        if (!ep) continue;
        const arr = nextByMedia.get(r.mediaId) ?? [];
        arr.push(ep);
        nextByMedia.set(r.mediaId, arr);
      }

      const totals = await this.prisma.$queryRaw<
        Array<{ mediaId: string; total: number; watched: number }>
      >`
        SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS total,
               COUNT(ues.id) FILTER (WHERE ues.watched = true)::int AS watched
        FROM shows sh
        JOIN seasons s ON s.show_id = sh.id
        JOIN episodes e ON e.season_id = s.id
        LEFT JOIN user_episode_status ues
          ON ues.episode_id = e.id AND ues.user_id = ${userId}
        WHERE sh.media_id IN (${Prisma.join(candidateIds)})
          AND s.is_special = false
          AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
          AND ${episodeAiredSql(now)}
        GROUP BY sh.media_id
      `;
      for (const row of totals) {
        progressByMedia.set(row.mediaId, { total: row.total, watched: row.watched });
      }
    }

    const items: any[] = [];
    for (const status of statuses) {
      const nextEpisodes = nextByMedia.get(status.mediaId) ?? [];
      const next = nextEpisodes[0];
      if (!next) continue; // fully caught up — nothing to watch next
      const { total: totalCount = 0, watched: watchedCount = 0 } =
        progressByMedia.get(status.mediaId) ?? {};
      const realRemaining = Math.max(1, totalCount - watchedCount);
      items.push({
        showId: status.mediaId,
        showTitle: status.media.title,
        posterUrl: status.media.posterUrl,
        backdropUrl: status.media.backdropUrl,
        network: status.media.show?.network ?? null,
        episode: mapEpisode(next, { watched: false }),
        nextEpisode: nextEpisodes[1] ? mapEpisode(nextEpisodes[1], { watched: false }) : null,
        remainingUnwatched: realRemaining,
        label: this.episodeLabel(next, watchedCount),
        lastWatchedAt: status.lastWatchedAt,
        progress: totalCount ? watchedCount / totalCount : 0,
        watchedCount,
        bucket: WatchNextBucket.PAUSED,
      });
    }

    const metadataPending =
      (await this.meta.scheduleIncompleteEpisodeRefresh?.(
        items
          .flatMap((item) => [item.episode?.id, item.nextEpisode?.id])
          .filter((id): id is string => !!id),
      )) ?? false;
    const result = { items, metadataPending };
    result.items = await this.localizeItems(result.items, (i) => i.showId);
    const releaseChanged = await this.localizeEpisodeTitles(result.items);
    if (releaseChanged && reconcileRelease) {
      await this.redis.delByPattern('watchnext:' + userId + ':*');
      await this.redis.delByPattern('upcoming:' + userId + ':*');
      await this.redis.delByPattern('showsprogress:' + userId + ':*');
      return this.pausedWatchNext(userId, false);
    }
    await this.redis.set(cacheKey, result, WATCH_NEXT_CACHE_TTL_S);
    return result;
  }

  private async recentlyWatchedEpisodes(userId: string, limit: number) {
    const rows = await this.prisma.watchHistory.findMany({
      where: {
        userId,
        mediaType: MediaType.SHOW,
        episodeId: { not: null },
        media: CANONICAL_VISIBLE_MEDIA,
      },
      // id tiebreak: bulk imports stamp identical watchedAt values, and the scroll-up
      // history cursor (watchedAt, id) needs a deterministic total order.
      orderBy: [{ watchedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        episode: {
          include: {
            season: { include: { show: { include: { media: { include: { show: true } } } } } },
          },
        },
      },
    });
    return this.mapWatchHistoryRows(userId, rows);
  }

  /**
   * Older watch-history pages for the watch list's scroll-up. Cursor-based
   * ((watchedAt, id) strictly older than the oldest loaded row) so prepended pages
   * never shift under new watch events. Returns HISTORY-bucket cards in the same
   * shape as watchNext, newest first, plus the cursor for the next page.
   */
  async watchNextHistory(
    userId: string,
    q: { before: string; beforeId: string; limit?: number },
  ): Promise<{
    items: any[];
    hasMore: boolean;
    cursor: { before: string; beforeId: string } | null;
  }> {
    const before = new Date(q.before);
    if (Number.isNaN(before.getTime())) throw new BadRequestException('Invalid before cursor');
    const take = Math.max(1, Math.min(q.limit ?? 20, 50));
    const rows = await this.prisma.watchHistory.findMany({
      where: {
        userId,
        mediaType: MediaType.SHOW,
        episodeId: { not: null },
        media: CANONICAL_VISIBLE_MEDIA,
        OR: [{ watchedAt: { lt: before } }, { watchedAt: before, id: { lt: q.beforeId } }],
      },
      orderBy: [{ watchedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: {
        episode: {
          include: {
            season: { include: { show: { include: { media: { include: { show: true } } } } } },
          },
        },
      },
    });
    const hasMore = rows.length > take;
    const pageRows = hasMore ? rows.slice(0, take) : rows;
    let items = await this.mapWatchHistoryRows(userId, pageRows);
    items = await this.localizeItems(items, (i) => i.showId);
    await this.localizeEpisodeTitles(items);
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      hasMore,
      cursor: hasMore && last ? { before: last.watchedAt.toISOString(), beforeId: last.id } : null,
    };
  }

  private async mapWatchHistoryRows(userId: string, rows: any[]) {
    // Real per-episode watch counts for the ×N rewatch badge — watch_history rows
    // alone don't carry them (without this every history card showed a plain checkmark).
    const epIds = [...new Set(rows.map((r) => r.episodeId).filter((x): x is string => !!x))];
    const statuses = epIds.length
      ? await this.prisma.userEpisodeStatus.findMany({
          where: { userId, episodeId: { in: epIds } },
          select: { episodeId: true, watchCount: true },
        })
      : [];
    const countByEp = new Map(statuses.map((s) => [s.episodeId, s.watchCount]));
    return rows
      .filter((r) => r.episode)
      .map((r) => {
        const ep = r.episode!;
        return {
          showId: r.mediaId,
          showTitle: r.episode?.season.show.media.title ?? '',
          posterUrl: r.episode?.season.show.media.posterUrl ?? null,
          backdropUrl: r.episode?.season.show.media.backdropUrl ?? null,
          network: r.episode?.season.show.media.show?.network ?? null,
          episode: mapEpisode(ep, {
            watched: true,
            watchedAt: r.watchedAt,
            watchCount: countByEp.get(r.episodeId!) ?? 1,
          }),
          remainingUnwatched: 0,
          label: EpisodeLabel.AIRED,
          lastWatchedAt: r.watchedAt,
          historyId: r.id,
          progress: 1,
          bucket: WatchNextBucket.HISTORY,
        };
      });
  }

  async upcoming(userId: string) {
    const cacheKey = `upcoming:${userId}:v2:${currentLanguage()}:${releaseCacheScope()}`;
    return this.cached(cacheKey, 60, async () => {
      const tracked = await this.trackedMediaIds(userId);

      // Airtimes are populated by provider hydration and the interactive metadata queue.
      // This endpoint is a pure DB read — no external API calls.

      // Past side: newest 10 aired episodes (scroll-up history, granular buckets),
      // paginated further via /me/upcoming/past. Future side unchanged.
      const pastWhere = {
        structureState: 'ACTIVE' as const,
        ...episodeBeforeLocalDayWhere(),
        season: { show: { mediaId: { in: tracked } } },
      };
      const include = {
        season: { include: { show: { include: { media: { include: { show: true } } } } } },
      };
      const [pastEpisodesWithExtra, futureEpisodes] = await Promise.all([
        this.prisma.episode.findMany({
          where: pastWhere,
          include,
          orderBy: [{ airDate: 'desc' }, { id: 'desc' }],
          // One extra row answers hasMore without COUNT(*) across the complete
          // historical episode footprint of every tracked show.
          take: UPCOMING_PAST_PAGE_SIZE + 1,
        }),
        this.prisma.episode.findMany({
          where: {
            structureState: 'ACTIVE',
            airDate: { not: null },
            NOT: episodeBeforeLocalDayWhere(),
            season: { show: { mediaId: { in: tracked } } },
          },
          include,
          orderBy: [{ airDate: 'asc' }, { season: { number: 'asc' } }, { number: 'asc' }],
          take: 200,
        }),
      ]);
      const pastHasMore = pastEpisodesWithExtra.length > UPCOMING_PAST_PAGE_SIZE;
      const pastEpisodesDesc = pastEpisodesWithExtra.slice(0, UPCOMING_PAST_PAGE_SIZE);

      // Display order is chronological (oldest on top → future at the bottom).
      const pastItems = await this.mapUpcomingItems([...pastEpisodesDesc].reverse());
      const futureItems = await this.mapUpcomingItems(futureEpisodes);
      const items = [...pastItems, ...futureItems];

      const oldest = pastEpisodesDesc[pastEpisodesDesc.length - 1];
      const result = {
        refreshAt: futureEpisodes
          .filter((e) => e.airTime && e.airDate && e.airDate > new Date())
          .map((e) => e.airDate!.toISOString())
          .sort()[0],
        groups: this.groupUpcoming(items),
        past: {
          hasMore: pastHasMore,
          cursor: oldest ? { before: oldest.airDate!.toISOString(), beforeId: oldest.id } : null,
        },
      };
      return result;
    });
  }

  /**
   * Older past pages for the upcoming screen's infinite scroll-up. Cursor-based
   * (airDate + episode id tiebreaker, descending) so newly hydrated old episodes
   * never shift an offset. Groups are returned in ascending chronological order,
   * ready to be prepended above the already-loaded past groups.
   */
  async upcomingPast(userId: string, opts: { before: string; beforeId: string; limit?: number }) {
    const limit = Math.min(
      Math.max(opts.limit || UPCOMING_PAST_PAGE_SIZE, 1),
      UPCOMING_PAST_MAX_PAGE_SIZE,
    );
    const beforeDate = new Date(opts.before);
    if (Number.isNaN(beforeDate.getTime()) || !opts.beforeId) {
      throw new BadRequestException('Invalid cursor');
    }

    // Keep paged keys inside `upcoming:{userId}:*` so watchlist mutations clear
    // already-fetched server pages as well as the initial Upcoming payload.
    const cacheKey = `upcoming:${userId}:past:v2:${currentLanguage()}:${releaseCacheScope()}:${beforeDate.toISOString()}:${opts.beforeId}:${limit}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) return cached;

    const tracked = await this.trackedMediaIds(userId);

    const episodes = await this.prisma.episode.findMany({
      where: {
        structureState: 'ACTIVE',
        AND: [episodeBeforeLocalDayWhere()],
        season: { show: { mediaId: { in: tracked } } },
        OR: [{ airDate: { lt: beforeDate } }, { airDate: beforeDate, id: { lt: opts.beforeId } }],
      },
      include: {
        season: { include: { show: { include: { media: { include: { show: true } } } } } },
      },
      orderBy: [{ airDate: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = episodes.length > limit;
    const page = episodes.slice(0, limit);
    const items = await this.mapUpcomingItems([...page].reverse());
    const oldest = page[page.length - 1];
    const result = {
      groups: this.groupUpcoming(items),
      hasMore,
      cursor: oldest ? { before: oldest.airDate!.toISOString(), beforeId: oldest.id } : null,
    };
    await this.redis.set(cacheKey, result, 60);
    return result;
  }

  /** Map episode rows to upcoming items (localized media + episode titles). Rows must
   *  arrive in ascending chronological order. */
  private async mapUpcomingItems(episodes: any[]) {
    const items = await this.localizeItems(
      episodes.map((e) => {
        const media = e.season.show.media;
        const day = releaseDay(e.airDate!, !!e.airTime, currentTimeZone());
        const past = pastBucket(day, currentCalendarDay());
        const bucket = past ? past.key : this.upcomingBucket(day);
        return {
          id: e.id,
          mediaType: MediaType.SHOW,
          mediaId: media.id,
          title: media.title,
          posterUrl: media.posterUrl,
          seasonNumber: e.season.number,
          episodeNumber: e.number,
          episodeTitle: e.title,
          airDate: e.airDate!.toISOString(),
          airTime: e.airTime,
          network: media.show?.network ?? null,
          label: this.episodeLabel(e, 0),
          bucket,
          bucketParams: past?.params,
          bucketLabel: past?.label,
          watched: false,
        };
      }) as any[],
      (i) => i.mediaId,
    );

    // Localize episode titles (item.id is the episode id here).
    const upEpIds = items.map((i) => i.id).filter(Boolean) as string[];
    if (upEpIds.length) {
      await this.meta.ensureEpisodeLocaleOverrides(upEpIds);
      const freshUp = await this.prisma.episode.findMany({
        where: { id: { in: upEpIds } },
        select: { id: true, titles: true },
      });
      const upMap = new Map(freshUp.map((e) => [e.id, e]));
      for (const it of items) {
        const f = upMap.get(it.id);
        if (f) it.episodeTitle = localized(f, 'titles', 'title') ?? it.episodeTitle;
      }
    }
    return items;
  }

  /**
   * Group chronologically-sorted items by bucket identity (key + params). Insertion
   * order = chronological order because buckets are monotonic in time.
   */
  private groupUpcoming(items: any[]): UpcomingGroupDto[] {
    const futureLabels: Record<string, string> = {
      [UpcomingBucket.TODAY]: 'Today',
      [UpcomingBucket.TOMORROW]: 'Tomorrow',
      [UpcomingBucket.THIS_WEEK]: 'This Week',
      [UpcomingBucket.LATER]: 'Later',
    };
    const groups: UpcomingGroupDto[] = [];
    const byIdentity = new Map<string, UpcomingGroupDto>();
    for (const it of items) {
      const identity = `${it.bucket}|${JSON.stringify(it.bucketParams ?? null)}`;
      let g = byIdentity.get(identity);
      if (!g) {
        g = {
          key: it.bucket,
          label: it.bucketLabel ?? futureLabels[it.bucket] ?? it.bucket,
          ...(it.bucketParams ? { params: it.bucketParams } : {}),
          items: [],
        };
        byIdentity.set(identity, g);
        groups.push(g);
      }
      const { bucketParams: _p, bucketLabel: _l, ...item } = it;
      g.items.push(item);
    }
    return groups;
  }

  async history(
    userId: string,
    opts: { mediaType?: MediaType; from?: string; to?: string; page?: number; pageSize?: number },
  ) {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.max(1, Math.min(opts.pageSize || 20, 100));
    const where = {
      userId,
      media: CANONICAL_VISIBLE_MEDIA,
      ...(opts.mediaType ? { mediaType: opts.mediaType } : {}),
      ...(opts.from || opts.to
        ? {
            watchedAt: {
              gte: opts.from ? new Date(opts.from) : undefined,
              lte: opts.to ? new Date(opts.to) : undefined,
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.watchHistory.findMany({
        where,
        orderBy: { watchedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          media: {
            include: {
              show: { select: { yearStart: true } },
              movie: { select: { releaseYear: true } },
            },
          },
        },
      }),
      this.prisma.watchHistory.count({ where }),
    ]);
    const items = await this.localizeItems(
      rows.map((r) => ({
        id: r.id,
        mediaType: r.mediaType,
        mediaId: r.mediaId,
        title: r.media.title,
        posterUrl: r.media.posterUrl,
        rating: r.media.rating ?? null,
        year:
          r.mediaType === MediaType.SHOW
            ? (r.media.show?.yearStart ?? null)
            : (r.media.movie?.releaseYear ?? null),
        episodeId: r.episodeId,
        seasonNumber: r.seasonNumber,
        episodeNumber: r.episodeNumber,
        runtimeMinutes: r.runtimeMinutes,
        watchedAt: r.watchedAt.toISOString(),
      })) as any[],
      (i) => i.mediaId,
    );
    return paginate(items, page, pageSize, total);
  }

  /** Distinct watched movies, paged from user_movie_status rather than replaying
   * every watch_history event. Rewatches therefore never multiply library cards. */
  async watchedMovies(
    userId: string,
    page = 1,
    pageSize = 24,
    filters?: {
      genre?: string;
      excludeGenres?: string;
      country?: string;
      tags?: string;
      sort?: LibrarySort;
    },
  ) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 60));
    const where = {
      userId,
      watched: true,
      media: {
        ...CANONICAL_VISIBLE_MEDIA,
        ...this.libraryMediaWhere(MediaType.MOVIE, filters),
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.userMovieStatus.findMany({
        where,
        orderBy: this.libraryStatusOrderBy(MediaType.MOVIE, filters?.sort),
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        include: {
          media: {
            select: {
              id: true,
              title: true,
              titles: true,
              posterUrl: true,
              posterUrls: true,
              rating: true,
              movie: { select: { releaseYear: true } },
            },
          },
        },
      }),
      this.prisma.userMovieStatus.count({ where }),
    ]);
    const items = rows.map((row) => ({
      id: row.media.id,
      title: localized(row.media, 'titles', 'title') ?? row.media.title,
      posterUrl: localized(row.media, 'posterUrls', 'posterUrl') ?? row.media.posterUrl,
      rating: row.media.rating ?? null,
      year: row.media.movie?.releaseYear ?? null,
      watched: true as const,
      progress: 1 as const,
    }));
    return paginate(items, safePage, safePageSize, total);
  }

  // ---------------- helpers ----------------
  private async trackedMediaIds(userId: string): Promise<string[]> {
    // Upcoming follows actual watchlist membership, just like Watch Next. Status
    // rows retain progress/history state and may survive imports or repairs, but
    // cannot independently opt a show back into active tracking.
    const watchlist = await this.prisma.watchlistItem.findMany({
      where: {
        userId,
        media: {
          type: MediaType.SHOW,
          ...CANONICAL_VISIBLE_MEDIA,
          showStatuses: {
            none: {
              userId,
              OR: [{ pausedAt: { not: null } }, { dropped: true }],
            },
          },
        },
      },
      select: { mediaId: true },
    });
    return [...new Set(watchlist.map((w) => w.mediaId))];
  }

  /** User-scoped canonical progress used by the paged My Shows API. Starting from the
   * user's status rows prevents a catalog-wide episode aggregation. */
  private showProgressCte(userId: string) {
    return Prisma.sql`
      WITH progress AS (
        SELECT uss.media_id,
               COUNT(ues.id) FILTER (
                 WHERE s.is_special = false
                   AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
                   AND ${episodeProgressSql()}
                   AND ues.watched = true
               )::int AS watched_count,
               uss.last_watched_at,
               uss.paused_at,
               uss.dropped,
               uss.rewatch_started_at,
               uss.created_at,
               uss.updated_at,
               COUNT(e.id) FILTER (
                 WHERE s.is_special = false
                   AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
                   AND ${episodeProgressSql()}
               )::int AS aired_total,
               COUNT(DISTINCT e.id) FILTER (
                 WHERE uss.rewatch_started_at IS NOT NULL
                   AND s.is_special = false
                   AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
                   AND ${episodeAiredSql()}
               )::int AS rewatch_total,
               COUNT(DISTINCT e.id) FILTER (
                 WHERE uss.rewatch_started_at IS NOT NULL
                   AND s.is_special = false
                   AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
                   AND ${episodeAiredSql()}
                   AND EXISTS (
                     SELECT 1 FROM watch_history wh
                     WHERE wh.user_id = uss.user_id
                       AND wh.media_id = uss.media_id
                       AND wh.episode_id = e.id
                       AND wh.watched_at >= uss.rewatch_started_at
                   )
               )::int AS rewatch_watched
        FROM user_show_status uss
        JOIN shows sh ON sh.media_id = uss.media_id
        LEFT JOIN seasons s ON s.show_id = sh.id
        LEFT JOIN episodes e ON e.season_id = s.id
        LEFT JOIN user_episode_status ues
          ON ues.episode_id = e.id AND ues.user_id = uss.user_id
        WHERE uss.user_id = ${userId}
          AND NOT EXISTS (
            SELECT 1 FROM media_canonical_links mcl
            WHERE mcl.source_media_id = uss.media_id
              AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
          )
        GROUP BY uss.media_id, uss.last_watched_at,
                 uss.paused_at, uss.dropped, uss.rewatch_started_at,
                 uss.created_at, uss.updated_at
      )
    `;
  }

  async showsProgressSummary(
    userId: string,
    filters?: {
      genre?: string;
      excludeGenres?: string;
      country?: string;
      tags?: string;
      sort?: LibrarySort;
    },
  ): Promise<ShowProgressSummaryDto> {
    const filterKey = [
      filters?.genre ?? '',
      filters?.excludeGenres ?? '',
      filters?.country ?? '',
      filters?.tags ?? '',
    ].join('|');
    const cacheKey = `showsprogress:${userId}:v7:${currentLanguage()}:${releaseCacheScope()}:summary:${filterKey}`;
    return this.cached(cacheKey, 120, async () => {
      const mediaFilter = this.showLibraryFilterSql(filters);
      const rows = await this.prisma.$queryRaw<
        Array<{
          rewatching: number;
          watching: number;
          notStarted: number;
          finished: number;
          paused: number;
          dropped: number;
        }>
      >`
        ${this.showProgressCte(userId)}
        SELECT
          COUNT(*) FILTER (
            WHERE p.dropped = false AND p.paused_at IS NULL
              AND p.rewatch_started_at IS NOT NULL
          )::int AS rewatching,
          COUNT(*) FILTER (
            WHERE p.dropped = false AND p.paused_at IS NULL
              AND p.rewatch_started_at IS NULL AND p.watched_count > 0
              AND p.aired_total > 0 AND p.watched_count < p.aired_total
          )::int AS watching,
          COUNT(*) FILTER (
            WHERE p.dropped = false AND p.paused_at IS NULL
              AND p.rewatch_started_at IS NULL
              AND p.aired_total > 0 AND p.watched_count >= p.aired_total
          )::int AS finished,
          COUNT(*) FILTER (WHERE p.dropped = false AND p.paused_at IS NOT NULL)::int AS paused,
          COUNT(*) FILTER (WHERE p.dropped = true)::int AS dropped,
          (
            SELECT COUNT(*)::int
            FROM watchlist_items wi
            JOIN media_items mi ON mi.id = wi.media_id
            JOIN shows sh ON sh.media_id = mi.id
            WHERE wi.user_id = ${userId}
              AND mi.type = 'SHOW'::"MediaType"
              AND ${mediaFilter}
              AND NOT EXISTS (
                SELECT 1 FROM media_canonical_links mcl
                WHERE mcl.source_media_id = wi.media_id
                  AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
              )
              AND NOT EXISTS (
                SELECT 1 FROM progress p
                WHERE p.media_id = wi.media_id
                  AND (
                    p.dropped = true OR
                    p.paused_at IS NOT NULL OR
                    p.rewatch_started_at IS NOT NULL OR
                    (p.watched_count > 0 AND p.aired_total > 0)
                  )
              )
          ) AS "notStarted"
        FROM progress p
        JOIN media_items mi ON mi.id = p.media_id
        JOIN shows sh ON sh.media_id = mi.id
        LEFT JOIN watchlist_items wi ON wi.user_id = ${userId} AND wi.media_id = p.media_id
        WHERE ${mediaFilter}
      `;
      const row = rows[0];
      return {
        rewatching: Number(row?.rewatching ?? 0),
        watching: Number(row?.watching ?? 0),
        notStarted: Number(row?.notStarted ?? 0),
        finished: Number(row?.finished ?? 0),
        paused: Number(row?.paused ?? 0),
        dropped: Number(row?.dropped ?? 0),
      };
    });
  }

  async showsProgressPage(
    userId: string,
    section: ShowProgressSection,
    page = 1,
    pageSize = 24,
    filters?: {
      genre?: string;
      excludeGenres?: string;
      country?: string;
      tags?: string;
      sort?: LibrarySort;
    },
  ) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 60));
    const filterKey = [
      filters?.genre ?? '',
      filters?.excludeGenres ?? '',
      filters?.country ?? '',
      filters?.tags ?? '',
      filters?.sort ?? 'addedDate',
    ].join('|');
    const cacheKey = `showsprogress:${userId}:v7:${currentLanguage()}:${releaseCacheScope()}:${section}:${safePage}:${safePageSize}:${filterKey}`;
    return this.cached(cacheKey, 120, async () => {
      type Row = {
        mediaId: string;
        watchedCount: number;
        airedTotal: number;
        rewatching?: boolean;
      };
      const skip = (safePage - 1) * safePageSize;
      const mediaFilter = this.showLibraryFilterSql(filters);
      let rows: Row[];

      if (section === 'notStarted') {
        rows = await this.prisma.$queryRaw<Row[]>`
          ${this.showProgressCte(userId)}
          SELECT wi.media_id AS "mediaId", 0::int AS "watchedCount", 0::int AS "airedTotal"
          FROM watchlist_items wi
          JOIN media_items mi ON mi.id = wi.media_id
          JOIN shows sh ON sh.media_id = mi.id
          WHERE wi.user_id = ${userId}
            AND mi.type = 'SHOW'::"MediaType"
            AND ${mediaFilter}
            AND NOT EXISTS (
              SELECT 1 FROM media_canonical_links mcl
              WHERE mcl.source_media_id = wi.media_id
                AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
            )
            AND NOT EXISTS (
              SELECT 1 FROM progress p
              WHERE p.media_id = wi.media_id
                AND (
                  p.dropped = true OR
                  p.paused_at IS NOT NULL OR
                  p.rewatch_started_at IS NOT NULL OR
                  (p.watched_count > 0 AND p.aired_total > 0)
                )
            )
          ORDER BY ${
            filters?.sort && filters.sort !== 'addedDate'
              ? this.showLibraryOrderSql(filters.sort)
              : Prisma.sql`wi.created_at DESC, wi.id DESC`
          }
          OFFSET ${skip} LIMIT ${safePageSize}
        `;
      } else {
        const order = this.showLibraryOrderSql(filters?.sort);
        const filter =
          section === 'rewatching'
            ? Prisma.sql`p.dropped = false AND p.paused_at IS NULL AND p.rewatch_started_at IS NOT NULL`
            : section === 'watching'
              ? Prisma.sql`p.dropped = false AND p.paused_at IS NULL AND p.rewatch_started_at IS NULL AND p.watched_count > 0 AND p.aired_total > 0 AND p.watched_count < p.aired_total`
              : section === 'finished'
                ? Prisma.sql`p.dropped = false AND p.paused_at IS NULL AND p.rewatch_started_at IS NULL AND p.aired_total > 0 AND p.watched_count >= p.aired_total`
                : section === 'paused'
                  ? Prisma.sql`p.dropped = false AND p.paused_at IS NOT NULL`
                  : Prisma.sql`p.dropped = true`;
        rows = await this.prisma.$queryRaw<Row[]>`
          ${this.showProgressCte(userId)}
          SELECT p.media_id AS "mediaId",
                 CASE WHEN p.rewatch_started_at IS NOT NULL
                   THEN p.rewatch_watched ELSE p.watched_count END AS "watchedCount",
                 CASE WHEN p.rewatch_started_at IS NOT NULL
                   THEN p.rewatch_total ELSE p.aired_total END AS "airedTotal",
                 (p.rewatch_started_at IS NOT NULL) AS rewatching
          FROM progress p
          JOIN media_items mi ON mi.id = p.media_id
          JOIN shows sh ON sh.media_id = mi.id
          LEFT JOIN watchlist_items wi ON wi.user_id = ${userId} AND wi.media_id = p.media_id
          WHERE ${filter} AND ${mediaFilter}
          ORDER BY ${order}
          OFFSET ${skip} LIMIT ${safePageSize}
        `;
      }

      const mediaIds = rows.map((r) => r.mediaId);
      const media = mediaIds.length
        ? await this.prisma.mediaItem.findMany({
            where: { id: { in: mediaIds } },
            select: {
              id: true,
              title: true,
              posterUrl: true,
              rating: true,
              show: { select: { yearStart: true } },
            },
          })
        : [];
      const byId = new Map(media.map((m) => [m.id, m]));
      const items = rows
        .map((row): ShowProgressItemDto | null => {
          const m = byId.get(row.mediaId);
          if (!m) return null;
          return {
            id: m.id,
            title: m.title,
            posterUrl: m.posterUrl,
            rating: m.rating ?? null,
            year: m.show?.yearStart ?? null,
            progress: row.airedTotal > 0 ? Math.min(1, row.watchedCount / row.airedTotal) : 0,
            rewatching: row.rewatching,
          };
        })
        .filter((item): item is ShowProgressItemDto => item !== null);
      const localizedItems = await this.localizeItems(items, (item) => item.id);
      const summary = await this.showsProgressSummary(userId, filters);
      return paginate(localizedItems, safePage, safePageSize, summary[section] ?? 0);
    });
  }

  async showsByStatus(userId: string) {
    // Same 30s user+lang cache pattern as watchNext/upcoming (busted by tracking writes).
    // v4 infix (the result gained the `dropped` bucket) stays AFTER the userId so the
    // `showsprogress:{userId}:*` invalidation pattern keeps matching.
    const cacheKey = `showsprogress:${userId}:v4:${currentLanguage()}:${releaseCacheScope()}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) return cached;

    const [statuses, watchlist] = await Promise.all([
      this.prisma.userShowStatus.findMany({
        where: { userId, media: CANONICAL_VISIBLE_MEDIA },
        include: {
          media: {
            select: {
              id: true,
              title: true,
              posterUrl: true,
              backdropUrl: true,
              rating: true,
              show: { select: { yearStart: true } },
            },
          },
        },
      }),
      this.prisma.watchlistItem.findMany({
        where: {
          userId,
          media: { type: MediaType.SHOW, ...CANONICAL_VISIBLE_MEDIA },
        },
        include: {
          media: {
            select: {
              id: true,
              title: true,
              posterUrl: true,
              backdropUrl: true,
              rating: true,
              show: { select: { yearStart: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Batch-query canonical progress totals (includes undated, excludes explicit future).
    const showMediaIds = statuses.map((s) => s.mediaId);
    const progressCounts =
      showMediaIds.length > 0
        ? await this.prisma.$queryRaw<
            Array<{ mediaId: string; totalCount: number; watchedCount: number }>
          >`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "totalCount",
                 COUNT(ues.id) FILTER (WHERE ues.watched = true)::int AS "watchedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          LEFT JOIN user_episode_status ues
            ON ues.episode_id = e.id AND ues.user_id = ${userId}
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
            AND ${episodeProgressSql()}
          GROUP BY sh.media_id
        `
        : [];
    const progressMap = new Map(progressCounts.map((row) => [row.mediaId, row]));

    const watching: any[] = [];
    const finished: any[] = [];
    const paused: any[] = [];
    const dropped: any[] = [];
    for (const s of statuses) {
      const counts = progressMap.get(s.mediaId);
      const w = counts?.watchedCount ?? 0;
      const eligibleTotal = counts?.totalCount ?? 0;
      const progress = eligibleTotal > 0 ? w / eligibleTotal : 0;
      const item = {
        id: s.media.id,
        title: s.media.title,
        posterUrl: s.media.posterUrl,
        rating: s.media.rating ?? null,
        year: s.media.show?.yearStart ?? null,
        progress,
        lastWatchedAt: s.lastWatchedAt,
        pausedAt: s.pausedAt,
      };
      if (s.dropped) {
        dropped.push({ ...item, updatedAt: s.updatedAt });
        continue;
      }
      // Tracking-paused shows get their own rail — out of the
      // To watch/Finished buckets regardless of progress.
      if (s.pausedAt) {
        paused.push(item);
        continue;
      }
      if (w > 0 && progress < 1) watching.push(item);
      else if (eligibleTotal > 0 && w >= eligibleTotal) finished.push(item);
    }
    watching.sort((a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0));
    finished.sort((a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0));
    paused.sort((a, b) => (b.pausedAt?.getTime() ?? 0) - (a.pausedAt?.getTime() ?? 0));
    dropped.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));

    const progressedIds = new Set([
      ...watching.map((i) => i.id),
      ...finished.map((i) => i.id),
      ...paused.map((i) => i.id),
      ...dropped.map((i) => i.id),
    ]);
    const notStarted = watchlist
      .filter((w) => !progressedIds.has(w.mediaId))
      .map((w) => ({
        id: w.media.id,
        title: w.media.title,
        posterUrl: w.media.posterUrl,
        rating: w.media.rating ?? null,
        year: w.media.show?.yearStart ?? null,
        progress: 0,
        addedAt: w.createdAt,
      }));

    const [watchingL, finishedL, notStartedL, pausedL, droppedL] = await Promise.all([
      this.localizeItems(watching, (i) => i.id),
      this.localizeItems(finished, (i) => i.id),
      this.localizeItems(notStarted, (i) => i.id),
      this.localizeItems(paused, (i) => i.id),
      this.localizeItems(dropped, (i) => i.id),
    ]);

    const result = {
      watching: watchingL,
      notStarted: notStartedL,
      finished: finishedL,
      paused: pausedL,
      dropped: droppedL,
    };
    await this.redis.set(cacheKey, result, 30);
    return result;
  }

  private upcomingBucket(date: Date): string {
    const now = currentCalendarDay();
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    const diffDays = Math.round((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays < 0) return 'EARLIER';
    if (diffDays === 0) return UpcomingBucket.TODAY;
    if (diffDays === 1) return UpcomingBucket.TOMORROW;
    if (diffDays > 1 && diffDays <= 7) return UpcomingBucket.THIS_WEEK;
    return UpcomingBucket.LATER;
  }

  private episodeLabel(ep: any, watchedCount: number): EpisodeLabel | undefined {
    if (ep.isFinale) return EpisodeLabel.FINALE;
    if (watchedCount === 0 && ep.number === 1) return EpisodeLabel.PREMIERE;
    if (isEpisodeBulkWatchEligible(ep.airDate, new Date(), ep.airTime)) return EpisodeLabel.AIRED;
    return undefined;
  }
}
