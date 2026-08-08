import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EpisodeLabel,
  MediaType,
  UpcomingBucket,
  WatchNextBucket,
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

@Injectable()
export class LibraryService {
  /** Coalesce simultaneous cold-cache requests inside one API process. */
  private readonly cacheInflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly meta: MediaMetadataService,
  ) {}

  private async cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.redis.get<T>(key);
    if (cached) return cached;

    const running = this.cacheInflight.get(key) as Promise<T> | undefined;
    if (running) return running;

    const work = (async () => {
      // A sibling request may have filled Redis between the first lookup and
      // registration in the local in-flight map.
      const second = await this.redis.get<T>(key);
      if (second) return second;

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
          if (filled) return filled;
        }
      }

      try {
        const value = await load();
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
      select: { id: true, titles: true, overviews: true, stillUrls: true },
    });
    const map = new Map(fresh.map((e) => [e.id, e]));
    const apply = (ep: any) => {
      const f = ep && map.get(ep.id);
      if (ep && f) {
        ep.title = localized(f, 'titles', 'title') ?? ep.title;
        ep.overview = localized(f, 'overviews', 'overview') ?? ep.overview;
        ep.stillUrl = localized(f, 'stillUrls', 'stillUrl') ?? ep.stillUrl;
      }
    };
    for (const item of items) {
      apply(item?.episode);
      apply(item?.nextEpisode);
    }
  }

  /**
   * Full watch-list computation (uncapped rails), cached per user+lang for 5 min.
   * Both watchNext (capped presentation payload) and watchNextBucket (per-rail
   * pagination for the "See more" buttons) derive from this one computation.
   * Key carries a v4 infix AFTER the userId (all three rails are now pageable and
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
    const cacheKey = `watchnext:${userId}:v4:${currentLanguage()}`;
    return this.cached(cacheKey, WATCH_NEXT_CACHE_TTL_S, async () => {
      // Watch Next is a view of the user's current watchlist. A show-status row is
      // only progress state: imports/repairs can legitimately leave one behind after
      // the watchlist row is gone, so it must never be used as membership by itself.
      const [statusRows, watchlistIdsRaw] = await Promise.all([
        this.prisma.userShowStatus.findMany({
          where: { userId, dropped: false, pausedAt: null },
          include: { media: { include: { show: true } } },
          orderBy: { lastWatchedAt: 'desc' },
        }),
        this.prisma.watchlistItem.findMany({
          where: { userId, media: { type: 'SHOW' } },
          select: { mediaId: true },
        }),
      ]);
      const watchlistIds = new Set(watchlistIdsRaw.map((w) => w.mediaId));
      const statuses = statusRows.filter((status) => watchlistIds.has(status.mediaId));

      // Watchlist shows that DON'T have a user_show_status yet (never watched).
      // The full identity pool is retained server-side; only bounded pages are sent.
      const statusMediaIds = new Set(statuses.map((s) => s.mediaId));
      const watchlistShows = await this.prisma.watchlistItem.findMany({
        where: {
          userId,
          media: {
            type: 'SHOW',
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

      // Shows that can produce a card: started (has watched episodes) or watchlist-only.
      // (Shows the user viewed but never interacted with are skipped — previously via
      // `continue` in the loop, now filtered up-front so they don't bloat the queries.)
      const candidates = allStatuses.filter((s) => s.isWatchlistOnly || (s.watchedCount ?? 0) > 0);
      const candidateIds = candidates.map((s) => s.mediaId);

      // Batched episode lookups — one round trip each instead of two queries PER SHOW
      // (previously ~1000 sequential queries for 500 tracked shows → multi-second loads).
      const nextByMedia = new Map<string, any[]>();
      const progressByMedia = new Map<string, { total: number; watched: number }>();
      if (candidateIds.length) {
        // Next 2 unwatched progress-eligible episodes per show via a window function.
        // Undated official episodes count; only explicit future episodes are excluded.
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
            AND (e.air_date IS NULL OR e.air_date <= ${now})
            AND NOT EXISTS (
              SELECT 1 FROM user_episode_status ues
              WHERE ues.episode_id = e.id AND ues.user_id = ${userId} AND ues.watched = true
            )
        ) t
        WHERE t.rn <= 2
        ORDER BY t."mediaId", t.rn
      `;

        // Hydrate the picked episodes (one query) so mapEpisode/episodeLabel get full rows.
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
          AND (e.air_date IS NULL OR e.air_date <= ${now})
        GROUP BY sh.media_id
      `;
        for (const row of totals) {
          progressByMedia.set(row.mediaId, { total: row.total, watched: row.watched });
        }
      }

      const watchNext: any[] = [];
      const startWatching: any[] = [];
      const notRecently: any[] = [];

      for (const status of candidates) {
        // Next unwatched AIRED episode — handles ongoing shows where new seasons were
        // added after the user finished watching.
        const nextEpisodes = nextByMedia.get(status.mediaId) ?? [];
        const next = nextEpisodes[0];
        if (!next) continue;

        const { total: totalCount = 0, watched: watchedCount = 0 } =
          progressByMedia.get(status.mediaId) ?? {};

        const realRemaining = Math.max(1, totalCount - watchedCount);
        const card = {
          showId: status.mediaId,
          showTitle: status.media.title,
          posterUrl: status.media.posterUrl,
          backdropUrl: status.media.backdropUrl,
          network: status.media.show?.network ?? null,
          episode: mapEpisode(next, { watched: false }),
          // Following unwatched episode, used by the client for the optimistic mark-watched swap.
          // null when `next` is the last unwatched episode (show will finish when it's watched).
          nextEpisode: nextEpisodes[1] ? mapEpisode(nextEpisodes[1], { watched: false }) : null,
          remainingUnwatched: realRemaining,
          label: this.episodeLabel(next, watchedCount),
          lastWatchedAt: status.lastWatchedAt,
          progress: totalCount ? watchedCount / totalCount : 0,
          watchedCount,
          bucket: '' as WatchNextBucket,
        };

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
      // Sort NOT_RECENTLY by engagement: most watched first, then most recent
      notRecently.sort((a, b) => {
        if (b.watchedCount !== a.watchedCount) return b.watchedCount - a.watchedCount;
        return (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0);
      });

      // Cache raw uncapped rails. Localization is deliberately deferred until the
      // bounded response slice is known; otherwise a cold request hydrates locale
      // overrides for hundreds of off-screen cards.
      return {
        history,
        historyHasMore,
        watchNext,
        startWatching,
        notRecently,
      };
    });
  }

  /** Capped presentation payload for the Watch list tab (first page per rail). */
  async watchNext(userId: string) {
    const c = await this.computeWatchNext(userId);
    let items = [
      ...c.history,
      ...c.watchNext.slice(0, WATCH_NEXT_LIMIT),
      // "Haven't watched for a while" renders before "Start watching".
      ...c.notRecently.slice(0, NOT_RECENTLY_LIMIT),
      ...c.startWatching.slice(0, START_WATCHING_LIMIT),
    ];
    items = await this.localizeItems(items, (item) => item.showId);
    await this.localizeEpisodeTitles(items);
    return {
      items,
      historyHasMore: c.historyHasMore,
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
  ) {
    const c = await this.computeWatchNext(userId);
    const full =
      bucket === 'WATCH_NEXT'
        ? c.watchNext
        : bucket === 'START_WATCHING'
          ? c.startWatching
          : c.notRecently;
    let items = full.slice(offset, offset + limit);
    items = await this.localizeItems(items, (item) => item.showId);
    await this.localizeEpisodeTitles(items);
    return {
      items,
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
  async pausedWatchNext(userId: string) {
    const cacheKey = `watchnext:${userId}:paused:${currentLanguage()}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) return cached;

    const statuses = await this.prisma.userShowStatus.findMany({
      where: { userId, dropped: false, pausedAt: { not: null }, watchedCount: { gt: 0 } },
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
            AND (e.air_date IS NULL OR e.air_date <= ${now})
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
          AND (e.air_date IS NULL OR e.air_date <= ${now})
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

    const result = { items };
    result.items = await this.localizeItems(result.items, (i) => i.showId);
    await this.localizeEpisodeTitles(result.items);
    await this.redis.set(cacheKey, result, WATCH_NEXT_CACHE_TTL_S);
    return result;
  }

  private async recentlyWatchedEpisodes(userId: string, limit: number) {
    const rows = await this.prisma.watchHistory.findMany({
      where: { userId, mediaType: MediaType.SHOW, episodeId: { not: null } },
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
    const cacheKey = `upcoming:${userId}:v2:${currentLanguage()}`;
    return this.cached(cacheKey, 60, async () => {
      const tracked = await this.trackedMediaIds(userId);

      // TVmaze enrichment is handled by a nightly cron job (NotificationScheduler.refreshAirtimes).
      // This endpoint is a pure DB read — no external API calls.

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Past side: newest 10 aired episodes (scroll-up history, granular buckets),
      // paginated further via /me/upcoming/past. Future side unchanged.
      const pastWhere = {
        structureState: 'ACTIVE' as const,
        airDate: { lt: today },
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
            airDate: { gte: today },
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
    const cacheKey = `upcoming:${userId}:past:v2:${currentLanguage()}:${beforeDate.toISOString()}:${opts.beforeId}:${limit}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) return cached;

    const tracked = await this.trackedMediaIds(userId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Clamp: never cross into today/future even with a bogus cursor.
    const effectiveBefore = beforeDate < today ? beforeDate : today;

    const episodes = await this.prisma.episode.findMany({
      where: {
        structureState: 'ACTIVE',
        airDate: { lt: today },
        season: { show: { mediaId: { in: tracked } } },
        OR: [
          { airDate: { lt: effectiveBefore } },
          { airDate: effectiveBefore, id: { lt: opts.beforeId } },
        ],
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
        const past = pastBucket(e.airDate!);
        const bucket = past ? past.key : this.upcomingBucket(e.airDate!);
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
  async watchedMovies(userId: string, page = 1, pageSize = 24) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 60));
    const where = { userId, watched: true };
    const [rows, total] = await Promise.all([
      this.prisma.userMovieStatus.findMany({
        where,
        orderBy: [{ watchedAt: 'desc' }, { id: 'desc' }],
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
                   AND (e.air_date IS NULL OR e.air_date <= NOW())
                   AND ues.watched = true
               )::int AS watched_count,
               uss.last_watched_at,
               uss.paused_at,
               uss.dropped,
               uss.updated_at,
               COUNT(e.id) FILTER (
                 WHERE s.is_special = false
                   AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
                   AND (e.air_date IS NULL OR e.air_date <= NOW())
               )::int AS aired_total
        FROM user_show_status uss
        JOIN shows sh ON sh.media_id = uss.media_id
        LEFT JOIN seasons s ON s.show_id = sh.id
        LEFT JOIN episodes e ON e.season_id = s.id
        LEFT JOIN user_episode_status ues
          ON ues.episode_id = e.id AND ues.user_id = uss.user_id
        WHERE uss.user_id = ${userId}
        GROUP BY uss.media_id, uss.last_watched_at,
                 uss.paused_at, uss.dropped, uss.updated_at
      )
    `;
  }

  async showsProgressSummary(userId: string): Promise<ShowProgressSummaryDto> {
    const cacheKey = `showsprogress:${userId}:v6:${currentLanguage()}:summary`;
    return this.cached(cacheKey, 120, async () => {
      const rows = await this.prisma.$queryRaw<
        Array<{
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
            WHERE dropped = false AND paused_at IS NULL AND watched_count > 0
              AND aired_total > 0 AND watched_count < aired_total
          )::int AS watching,
          COUNT(*) FILTER (
            WHERE dropped = false AND paused_at IS NULL
              AND aired_total > 0 AND watched_count >= aired_total
          )::int AS finished,
          COUNT(*) FILTER (WHERE dropped = false AND paused_at IS NOT NULL)::int AS paused,
          COUNT(*) FILTER (WHERE dropped = true)::int AS dropped,
          (
            SELECT COUNT(*)::int
            FROM watchlist_items wi
            JOIN media_items mi ON mi.id = wi.media_id
            WHERE wi.user_id = ${userId}
              AND mi.type = 'SHOW'::"MediaType"
              AND NOT EXISTS (
                SELECT 1 FROM progress p
                WHERE p.media_id = wi.media_id
                  AND (
                    p.dropped = true OR
                    p.paused_at IS NOT NULL OR
                    (p.watched_count > 0 AND p.aired_total > 0)
                  )
              )
          ) AS "notStarted"
        FROM progress
      `;
      const row = rows[0];
      return {
        watching: Number(row?.watching ?? 0),
        notStarted: Number(row?.notStarted ?? 0),
        finished: Number(row?.finished ?? 0),
        paused: Number(row?.paused ?? 0),
        dropped: Number(row?.dropped ?? 0),
      };
    });
  }

  async showsProgressPage(userId: string, section: ShowProgressSection, page = 1, pageSize = 24) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 60));
    const cacheKey = `showsprogress:${userId}:v6:${currentLanguage()}:${section}:${safePage}:${safePageSize}`;
    return this.cached(cacheKey, 120, async () => {
      type Row = { mediaId: string; watchedCount: number; airedTotal: number };
      const skip = (safePage - 1) * safePageSize;
      let rows: Row[];

      if (section === 'notStarted') {
        rows = await this.prisma.$queryRaw<Row[]>`
          ${this.showProgressCte(userId)}
          SELECT wi.media_id AS "mediaId", 0::int AS "watchedCount", 0::int AS "airedTotal"
          FROM watchlist_items wi
          JOIN media_items mi ON mi.id = wi.media_id
          WHERE wi.user_id = ${userId}
            AND mi.type = 'SHOW'::"MediaType"
            AND NOT EXISTS (
              SELECT 1 FROM progress p
              WHERE p.media_id = wi.media_id
                AND (
                  p.dropped = true OR
                  p.paused_at IS NOT NULL OR
                  (p.watched_count > 0 AND p.aired_total > 0)
                )
            )
          ORDER BY wi.created_at DESC, wi.id DESC
          OFFSET ${skip} LIMIT ${safePageSize}
        `;
      } else {
        const order =
          section === 'paused'
            ? Prisma.sql`paused_at DESC NULLS LAST, media_id`
            : section === 'dropped'
              ? Prisma.sql`updated_at DESC, media_id`
              : Prisma.sql`last_watched_at DESC NULLS LAST, media_id`;
        const filter =
          section === 'watching'
            ? Prisma.sql`dropped = false AND paused_at IS NULL AND watched_count > 0 AND aired_total > 0 AND watched_count < aired_total`
            : section === 'finished'
              ? Prisma.sql`dropped = false AND paused_at IS NULL AND aired_total > 0 AND watched_count >= aired_total`
              : section === 'paused'
                ? Prisma.sql`dropped = false AND paused_at IS NOT NULL`
                : Prisma.sql`dropped = true`;
        rows = await this.prisma.$queryRaw<Row[]>`
          ${this.showProgressCte(userId)}
          SELECT media_id AS "mediaId", watched_count AS "watchedCount", aired_total AS "airedTotal"
          FROM progress
          WHERE ${filter}
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
          };
        })
        .filter((item): item is ShowProgressItemDto => item !== null);
      const localizedItems = await this.localizeItems(items, (item) => item.id);
      const summary = await this.showsProgressSummary(userId);
      return paginate(localizedItems, safePage, safePageSize, summary[section] ?? 0);
    });
  }

  async showsByStatus(userId: string) {
    // Same 30s user+lang cache pattern as watchNext/upcoming (busted by tracking writes).
    // v4 infix (the result gained the `dropped` bucket) stays AFTER the userId so the
    // `showsprogress:{userId}:*` invalidation pattern keeps matching.
    const cacheKey = `showsprogress:${userId}:v4:${currentLanguage()}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) return cached;

    const [statuses, watchlist] = await Promise.all([
      this.prisma.userShowStatus.findMany({
        where: { userId },
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
        where: { userId, media: { type: MediaType.SHOW } },
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
            AND (e.air_date IS NULL OR e.air_date <= NOW())
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
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
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
    if (ep.airDate) {
      const air = new Date(ep.airDate);
      const now = new Date();
      if (ep.airTime) {
        // Precise datetime (from TVmaze): AIRED only once the moment has passed.
        if (air.getTime() <= now.getTime()) return EpisodeLabel.AIRED;
      } else {
        // Date-only (no time known): never claim today's has already aired.
        const airDay = new Date(air);
        airDay.setHours(0, 0, 0, 0);
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        if (airDay.getTime() < today.getTime()) return EpisodeLabel.AIRED;
      }
    }
    return undefined;
  }
}
