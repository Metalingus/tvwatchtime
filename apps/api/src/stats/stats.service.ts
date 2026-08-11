import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  ChartPointDto,
  DurationDto,
  LeaderboardEntryDto,
  LeaderboardPageDto,
  LeaderboardType,
  MovieStatsDto,
  StatsSummaryDto,
  ShowStatsDto,
} from '@tvwatch/shared';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import {
  LB_DIRTY_USERS_KEY,
  LB_VERSION_KEY,
  LeaderboardBustProcessor,
  leaderboardUserComputedVersionKey,
  leaderboardUserVersionKey,
} from './leaderboard-bust.processor';
import { toDuration } from '../common/utils/duration.util';

const LEADERBOARD_TYPES: LeaderboardType[] = ['combined', 'shows', 'movies'];
const LEADERBOARD_READY_KEY = 'lb:v2:ready';
const LEADERBOARD_READY_VERSION = '1';
const LEADERBOARD_REBUILD_LOCK_KEY = 'lb:v2:rebuild-lock';
const leaderboardSortedSetKey = (type: LeaderboardType) => `lb:v2:rank:${type}`;

/** A source remains queryable until copy verification atomically activates its link. */
const CANONICAL_VISIBLE_MEDIA = {
  OR: [
    { canonicalSource: { is: null } },
    { canonicalSource: { is: { status: { not: 'ACTIVE' as const } } } },
  ],
} satisfies Prisma.MediaItemWhereInput;

interface ComputedStats {
  summary: StatsSummaryDto;
  showStats: ShowStatsDto;
  movieStats: MovieStatsDto;
  stale: boolean;
}

type GenreMediaRow = {
  mediaId: string;
  media: { genres: { genre: { name: string | null } }[] };
};

/**
 * Native rewatches already append one history row per play. Imports may instead retain one row
 * and put the full play total in watchCount. Fill only that gap so every view is represented once.
 */
export function reconcileCollapsedWatchRows(
  rows: any[],
  episodeStatuses: any[],
  movieStatuses: any[],
): any[] {
  const expanded = [...rows];
  const episodeRows = new Map<string, number>();
  const episodeCoordinates = new Map<string, number>();
  const movieRows = new Map<string, number>();

  for (const row of rows) {
    if (row.mediaType === MediaType.MOVIE) {
      movieRows.set(row.mediaId, (movieRows.get(row.mediaId) ?? 0) + 1);
      continue;
    }
    if (row.episodeId) {
      episodeRows.set(row.episodeId, (episodeRows.get(row.episodeId) ?? 0) + 1);
    }
    if (row.seasonNumber != null && row.episodeNumber != null) {
      const key = `${row.mediaId}|${row.seasonNumber}|${row.episodeNumber}`;
      episodeCoordinates.set(key, (episodeCoordinates.get(key) ?? 0) + 1);
    }
  }

  for (const status of episodeStatuses) {
    if (!status.watched || !status.episode) continue;
    const episode = status.episode;
    const media = episode.season.show.media;
    const coordinateKey = `${media.id}|${episode.season.number}|${episode.number}`;
    const existing = Math.max(
      episodeRows.get(status.episodeId) ?? 0,
      episodeCoordinates.get(coordinateKey) ?? 0,
    );
    const desired = Math.max(1, status.watchCount ?? 1);
    for (let index = existing; index < desired; index += 1) {
      expanded.push({
        mediaId: media.id,
        mediaType: MediaType.SHOW,
        episodeId: status.episodeId,
        seasonNumber: episode.season.number,
        episodeNumber: episode.number,
        runtimeMinutes: episode.runtimeMinutes,
        watchedAt: status.watchedAt ?? status.updatedAt ?? status.createdAt,
        media,
      });
    }
  }

  for (const status of movieStatuses) {
    if (!status.watched || !status.media) continue;
    const existing = movieRows.get(status.mediaId) ?? 0;
    const desired = Math.max(1, status.watchCount ?? 1);
    for (let index = existing; index < desired; index += 1) {
      expanded.push({
        mediaId: status.mediaId,
        mediaType: MediaType.MOVIE,
        episodeId: null,
        seasonNumber: null,
        episodeNumber: null,
        runtimeMinutes: status.media.movie?.runtimeMinutes ?? null,
        watchedAt: status.watchedAt ?? status.updatedAt ?? status.createdAt,
        media: status.media,
      });
    }
  }
  return expanded;
}

/** Count each genre once per distinct title. Watch history contains one row per episode/rewatch. */
export function topGenresByDistinctTitles(rows: GenreMediaRow[]) {
  const titles = new Map<string, GenreMediaRow>();
  for (const row of rows) {
    if (!titles.has(row.mediaId)) titles.set(row.mediaId, row);
  }
  const counts = new Map<string, number>();
  for (const row of titles.values()) {
    const names = new Set(row.media.genres.map(({ genre }) => genre.name).filter(Boolean));
    for (const name of names) counts.set(name!, (counts.get(name!) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8);
}

@Injectable()
export class StatsService implements OnModuleInit {
  private readonly logger = new Logger(StatsService.name);
  /** Cold initialization is shared in-process and protected across replicas by a Redis lock. */
  private leaderboardInitInFlight: Promise<void> | null = null;
  /** User refreshes are authoritative but deduped when a queue job and a request overlap. */
  private readonly leaderboardUserInFlight = new Map<string, Promise<void>>();
  private readonly leaderboardRebuildLockTtlSec =
    Number(process.env.LEADERBOARD_REBUILD_LOCK_TTL_SEC) || 600;
  /** Per-user background recompute lock TTL. Must exceed the worst-case recompute duration; if a
   *  recompute outlasts it, a duplicate may start but the `dirtyVersion` conditional store keeps
   *  results consistent. */
  private readonly recomputeLockTtlSec = Number(process.env.STATS_RECOMPUTE_LOCK_TTL_SEC) || 60;
  /** Ownership-safe lock release: only the token holder may delete the lock (prevents deleting a
   *  lock that expired and was re-acquired by another worker). Mirrors rate-limiter.ts. */
  private static readonly LOCK_RELEASE =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly leaderboardBust: LeaderboardBustProcessor,
  ) {}

  onModuleInit() {
    // Build the v2 sorted sets once per Redis lifecycle before the first leaderboard visit when
    // possible. The distributed lock makes this safe across API replicas.
    void this.ensureLeaderboardReady().catch((error) =>
      this.logger.warn(`leaderboard cold initialization deferred: ${error.message}`),
    );
  }

  // Preserve the complete existing invalidate() event set. These are the only mutations that
  // currently mark stats stale (see plan §3 audit: ratings/character-votes/comments/watchlist
  // removals remain pre-existing gaps, out of scope). Every event bumps the monotonic
  // `dirtyVersion` so an in-flight recompute can detect it was superseded.
  @OnEvent('watch.episode')
  @OnEvent('unwatch.episode')
  @OnEvent('watch.movie')
  @OnEvent('unwatch.movie')
  @OnEvent('rewatch.episode')
  @OnEvent('rewatch.movie')
  @OnEvent('watchlist.added')
  @OnEvent('import.applied')
  async invalidate(payload: { userId: string }) {
    await this.prisma.userStatsSummary.upsert({
      where: { userId: payload.userId },
      create: { userId: payload.userId, stale: true, dirtyVersion: 1 },
      update: { stale: true, dirtyVersion: { increment: 1 } },
    });
  }

  // Leaderboard handler: restricted to events that change watched minutes / ranking. (Import still
  // busts unconditionally via invalidateLeaderboard().)
  @OnEvent('watch.episode')
  @OnEvent('unwatch.episode')
  @OnEvent('watch.movie')
  @OnEvent('unwatch.movie')
  @OnEvent('rewatch.episode')
  @OnEvent('rewatch.movie')
  async onWatchActivity(payload: { userId: string }) {
    await this.leaderboardBust.request(payload.userId);
  }

  @OnEvent('leaderboard.user-changed')
  async onLeaderboardUserChanged(payload: { userId: string }) {
    await this.leaderboardBust.request(payload.userId);
  }

  @OnEvent('leaderboard.refresh-user')
  async onLeaderboardUserRefresh(payload: { userId: string }) {
    await this.refreshLeaderboardUser(payload.userId);
  }

  /**
   * Stale-while-revalidate. All three payloads share one `stale` flag + `dirtyVersion`, so they
   * are computed together. A complete cached row is returned immediately (even when stale) and a
   * background recompute is scheduled; only a missing/incomplete row triggers a synchronous
   * (first-ever) compute. `inflight` dedups concurrent first-ever requests for the same user.
   */
  private readonly inflight = new Map<string, Promise<ComputedStats>>();

  private async loadOrComputeAll(userId: string): Promise<ComputedStats> {
    const row = await this.prisma.userStatsSummary.findUnique({ where: { userId } });
    const showStats = row?.showStats as { genreCountUnit?: string } | null | undefined;
    const movieStats = row?.movieStats as { genreCountUnit?: string } | null | undefined;
    const currentGenreCounts =
      showStats?.genreCountUnit === 'titles' && movieStats?.genreCountUnit === 'titles';
    if (row && row.summary && row.showStats && row.movieStats && currentGenreCounts) {
      // SWR: complete cached JSON present → return immediately; refresh in background if stale.
      if (row.stale) this.scheduleBackgroundRecompute(userId);
      return {
        summary: row.summary as unknown as StatsSummaryDto,
        showStats: row.showStats as unknown as ShowStatsDto,
        movieStats: row.movieStats as unknown as MovieStatsDto,
        stale: row.stale,
      };
    }
    return this.loadOrComputeFirstTime(userId);
  }

  /** Synchronous first-ever compute, deduped across concurrent callers. */
  private loadOrComputeFirstTime(userId: string): Promise<ComputedStats> {
    const existing = this.inflight.get(userId);
    if (existing) return existing;
    const promise = this.computeSyncFirstTime(userId).finally(() => {
      // Only delete our own entry — a newer entry may have replaced it.
      if (this.inflight.get(userId) === promise) this.inflight.delete(userId);
    });
    this.inflight.set(userId, promise);
    return promise;
  }

  private async computeSyncFirstTime(userId: string): Promise<ComputedStats> {
    // Ensure a row exists and is marked stale WITHOUT bumping dirtyVersion (requesting stats is not
    // a mutation). Covers: a new user, an existing row with missing JSON, a partially initialized
    // legacy row, or a previously-failed first-time compute. Return dirtyVersion from the upsert
    // (no second read).
    const up = await this.prisma.userStatsSummary.upsert({
      where: { userId },
      create: { userId, stale: true },
      update: { stale: true },
      select: { dirtyVersion: true },
    });
    const startingVersion = up.dirtyVersion;
    const payloads = await this.computePayloads(userId); // throws → propagates to the request
    const { superseded } = await this.storeAndCheckSuperseded(userId, payloads, startingVersion);
    if (superseded) this.scheduleBackgroundRecompute(userId);
    return { ...payloads, stale: superseded };
  }

  private async computePayloads(userId: string) {
    const now = new Date();
    const mediaSelect = {
      id: true,
      title: true,
      genres: { select: { genre: { select: { name: true } } } },
      show: { select: { network: true } },
      movie: { select: { runtimeMinutes: true } },
    } as const;
    // History is event-shaped for native watches but import-shaped data can collapse rewatches
    // into status.watchCount. Load both representations once and reconcile them in memory.
    const [rawRows, episodeStatuses, movieStatuses] = await Promise.all([
      this.prisma.watchHistory.findMany({
        where: { userId, media: CANONICAL_VISIBLE_MEDIA },
        select: {
          mediaId: true,
          mediaType: true,
          episodeId: true,
          seasonNumber: true,
          episodeNumber: true,
          runtimeMinutes: true,
          watchedAt: true,
          episode: {
            select: {
              airDate: true,
              structureState: true,
              season: { select: { isSpecial: true } },
            },
          },
          media: { select: mediaSelect },
        },
      }),
      this.prisma.userEpisodeStatus.findMany({
        where: {
          userId,
          watched: true,
          episode: {
            structureState: 'ACTIVE',
            OR: [{ airDate: null }, { airDate: { lte: now } }],
            season: { isSpecial: false, show: { media: CANONICAL_VISIBLE_MEDIA } },
          },
        },
        select: {
          episodeId: true,
          watched: true,
          watchedAt: true,
          watchCount: true,
          createdAt: true,
          updatedAt: true,
          episode: {
            select: {
              number: true,
              runtimeMinutes: true,
              season: {
                select: {
                  number: true,
                  show: { select: { media: { select: mediaSelect } } },
                },
              },
            },
          },
        },
      }),
      this.prisma.userMovieStatus.findMany({
        where: { userId, watched: true },
        select: {
          mediaId: true,
          watched: true,
          watchedAt: true,
          watchCount: true,
          createdAt: true,
          updatedAt: true,
          media: { select: mediaSelect },
        },
      }),
    ]);
    const validRows = rawRows.filter((row) => {
      if (row.mediaType === MediaType.MOVIE) return true;
      if (!row.episode) return row.seasonNumber !== 0;
      return (
        row.episode.structureState === 'ACTIVE' &&
        !row.episode.season.isSpecial &&
        (!row.episode.airDate || row.episode.airDate <= now)
      );
    });
    const rows = reconcileCollapsedWatchRows(validRows, episodeStatuses, movieStatuses);
    const showRows = rows.filter((r) => r.mediaType === MediaType.SHOW);
    const movieRows = rows.filter((r) => r.mediaType === MediaType.MOVIE);
    const [summary, showStats, movieStats] = await Promise.all([
      this.computeSummary(userId, showRows as any, movieRows as any),
      this.computeShowStats(userId, showRows as any),
      this.computeMovieStats(userId, movieRows as any),
    ]);
    return { summary, showStats, movieStats };
  }

  /**
   * Persist computed payloads only if the row still matches the version captured at compute start
   * AND is still stale. The `stale: true` predicate is required: without it two workers that
   * computed the SAME startingVersion could both match `{ userId, dirtyVersion }` and both write.
   * With it, the row lock makes exactly one UPDATE flip stale→false; the other matches 0 rows.
   * On count 0 we re-read to distinguish "another worker stored this version" from "a newer
   * invalidation superseded us".
   */
  private async storeAndCheckSuperseded(
    userId: string,
    payloads: { summary: StatsSummaryDto; showStats: ShowStatsDto; movieStats: MovieStatsDto },
    startingVersion: number,
  ): Promise<{ stored: boolean; superseded: boolean }> {
    const res = await this.prisma.userStatsSummary.updateMany({
      where: { userId, dirtyVersion: startingVersion, stale: true },
      data: {
        summary: payloads.summary as any,
        showStats: payloads.showStats as any,
        movieStats: payloads.movieStats as any,
        stale: false,
        computedAt: new Date(),
      },
    });
    if (res.count > 0) return { stored: true, superseded: false };
    const latest = await this.prisma.userStatsSummary.findUnique({
      where: { userId },
      select: { stale: true, dirtyVersion: true },
    });
    const superseded = !latest || latest.dirtyVersion !== startingVersion || latest.stale;
    return { stored: false, superseded };
  }

  /** Background recompute (fire-and-forget). Never throws into the request path. */
  private scheduleBackgroundRecompute(userId: string): void {
    const token = randomUUID();
    const lockKey = `stats:recompute:${userId}`;
    void this.redis.client
      .set(lockKey, token, 'EX', this.recomputeLockTtlSec, 'NX')
      .then((ok) => {
        if (ok !== 'OK') return; // another worker owns it
        void this.runBackgroundRecompute(userId, lockKey, token).catch((e) =>
          this.logger.error(`bg stats recompute failed ${userId}: ${e.message}`),
        );
      })
      .catch((e) => this.logger.error(`recompute lock acquire failed ${userId}: ${e.message}`));
  }

  private async runBackgroundRecompute(
    userId: string,
    lockKey: string,
    token: string,
  ): Promise<void> {
    let superseded = false;
    try {
      const row = await this.prisma.userStatsSummary.findUnique({ where: { userId } });
      if (!row || !row.stale) return; // already fresh / nothing to do
      const startingVersion = row.dirtyVersion ?? 0;
      const payloads = await this.computePayloads(userId); // throws → caught by caller .catch
      ({ superseded } = await this.storeAndCheckSuperseded(userId, payloads, startingVersion));
    } finally {
      // ownership-safe release: only delete if our token still owns the lock.
      await this.redis.client
        .eval(StatsService.LOCK_RELEASE, 1, lockKey, token)
        .catch(() => undefined);
    }
    if (superseded) this.scheduleBackgroundRecompute(userId); // re-arm AFTER releasing the lock
  }

  async getSummary(userId: string): Promise<StatsSummaryDto> {
    const r = await this.loadOrComputeAll(userId);
    return { ...(r.summary as StatsSummaryDto), stale: r.stale };
  }

  async getShowStats(userId: string): Promise<ShowStatsDto> {
    const r = await this.loadOrComputeAll(userId);
    return { ...(r.showStats as ShowStatsDto), stale: r.stale };
  }

  async getMovieStats(userId: string): Promise<MovieStatsDto> {
    const r = await this.loadOrComputeAll(userId);
    return { ...(r.movieStats as MovieStatsDto), stale: r.stale };
  }

  // ---------------- computations ----------------
  private async computeSummary(
    userId: string,
    showRows: any[],
    movieRows: any[],
  ): Promise<StatsSummaryDto> {
    const tvMinutes = showRows.reduce((a, r) => a + (r.runtimeMinutes ?? 0), 0);
    const movieMinutes = movieRows.reduce(
      (a, r) => a + (r.runtimeMinutes ?? r.media?.movie?.runtimeMinutes ?? 0),
      0,
    );

    const statuses = await this.prisma.userShowStatus.findMany({
      where: { userId, media: CANONICAL_VISIBLE_MEDIA },
    });
    const remainingEpisodes = statuses.reduce(
      (a, s) => a + Math.max(0, (s.totalCount ?? 0) - (s.watchedCount ?? 0)),
      0,
    );

    // Remaining movies = watchlist movies that aren't watched yet
    const watchlistMovieIds = await this.prisma.watchlistItem.findMany({
      where: { userId, media: { type: MediaType.MOVIE } },
      select: { mediaId: true },
    });
    const watchedMovieIds = new Set(
      (
        await this.prisma.userMovieStatus.findMany({
          where: { userId, watched: true },
          select: { mediaId: true },
        })
      ).map((m) => m.mediaId),
    );
    const remainingMovies = watchlistMovieIds.filter((w) => !watchedMovieIds.has(w.mediaId)).length;

    return {
      tvTime: toDuration(tvMinutes),
      episodesWatched: showRows.length,
      movieTime: toDuration(movieMinutes),
      moviesWatched: movieRows.length,
      remainingEpisodes,
      remainingMovies,
      addedShows: statuses.length,
      // Same set as watchlistMovieIds above — was a duplicate COUNT query.
      addedMovies: watchlistMovieIds.length,
    };
  }

  private weeklyChart(
    rows: { watchedAt: Date; runtimeMinutes?: number | null }[],
    weeks = 12,
    mode: 'count' | 'minutes' = 'count',
  ): ChartPointDto[] {
    const now = new Date();
    const buckets: { label: string; value: number; start: Date }[] = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const start = new Date(now);
      start.setDate(now.getDate() - now.getDay() - i * 7);
      start.setHours(0, 0, 0, 0);
      const label = `${start.getMonth() + 1}/${start.getDate()}`;
      buckets.push({ label, value: 0, start });
    }
    for (const r of rows) {
      const idx = buckets.findIndex((b, i) => {
        const end = i < buckets.length - 1 ? buckets[i + 1].start : new Date();
        return r.watchedAt >= b.start && r.watchedAt < end;
      });
      if (idx >= 0) buckets[idx].value += mode === 'minutes' ? (r.runtimeMinutes ?? 0) : 1;
    }
    return buckets.map((b) => ({ label: b.label, value: b.value }));
  }

  private async topCounts(
    items: { name: string | null }[],
  ): Promise<{ name: string; count: number }[]> {
    const map = new Map<string, number>();
    for (const it of items) {
      if (!it.name) continue;
      map.set(it.name, (map.get(it.name) || 0) + 1);
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }

  private async computeShowStats(userId: string, showRows: any[]): Promise<ShowStatsDto> {
    const tvMinutes = showRows.reduce((a, r) => a + (r.runtimeMinutes ?? 0), 0);
    const tvTimeChart = this.weeklyChart(showRows, 12, 'minutes');
    const episodesWatchedChart = this.weeklyChart(showRows, 12, 'count');

    // biggest marathons: most episodes watched in a single day per show
    const marathonMap = new Map<string, { count: number; date: Date }>();
    for (const r of showRows) {
      const day = new Date(r.watchedAt);
      day.setHours(0, 0, 0, 0);
      const key = `${r.mediaId}|${day.toISOString().slice(0, 10)}`;
      const cur = marathonMap.get(key);
      if (cur) cur.count++;
      else marathonMap.set(key, { count: 1, date: day });
    }
    const biggestMarathons = [...marathonMap.entries()]
      .map(([key, v]) => {
        const mediaId = key.split('|')[0];
        const title = showRows.find((r) => r.mediaId === mediaId)?.media.title ?? 'Unknown';
        return {
          showTitle: title,
          episodeCount: v.count,
          periodLabel: v.date.toISOString().slice(0, 10),
        };
      })
      .sort((a, b) => b.episodeCount - a.episodeCount)
      .slice(0, 5);

    const distinctShows = [...new Map(showRows.map((row) => [row.mediaId, row])).values()] as any[];
    const genres = topGenresByDistinctTitles(showRows);
    const networks = await this.topCounts(
      distinctShows.map((r) => ({ name: r.media.show?.network ?? null })),
    );

    // Slim selects only (title path + rating) — the old 4-deep includes pulled full
    // episode/season/show/media rows for every rating the user ever cast.
    const episodeRatings = await this.prisma.rating.findMany({
      where: {
        userId,
        episodeId: { not: null },
        episode: { season: { show: { media: CANONICAL_VISIBLE_MEDIA } } },
      },
      select: {
        rating: true,
        episode: {
          select: {
            season: {
              select: {
                show: { select: { media: { select: { title: true } } } },
              },
            },
          },
        },
      },
    });
    const ratingByShow = new Map<string, { title: string; sum: number; count: number }>();
    for (const rt of episodeRatings) {
      const title = rt.episode?.season.show.media.title ?? 'Unknown';
      const cur = ratingByShow.get(title) ?? { title, sum: 0, count: 0 };
      cur.sum += rt.rating;
      cur.count++;
      ratingByShow.set(title, cur);
    }
    const mostVotedRatings = [...ratingByShow.entries()]
      .map(([, v]) => ({ showTitle: v.title, rating: Math.round((v.sum / v.count) * 10) / 10 }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 5);

    const charVotes = await this.prisma.characterVote.findMany({
      where: {
        userId,
        episodeId: { not: null },
        episode: { season: { show: { media: CANONICAL_VISIBLE_MEDIA } } },
      },
      select: {
        cast: { select: { character: true, castMember: { select: { name: true } } } },
        episode: {
          select: {
            season: {
              select: {
                show: { select: { media: { select: { title: true } } } },
              },
            },
          },
        },
      },
    });
    const charByShow = new Map<string, string>();
    for (const cv of charVotes) {
      const title = cv.episode?.season.show.media.title ?? 'Unknown';
      const character = cv.cast?.character ?? cv.cast?.castMember?.name ?? 'Unknown';
      charByShow.set(title, character);
    }

    const comments = await this.prisma.$queryRaw<Array<{ threadId: string; createdAt: Date }>>`
      SELECT c.thread_id AS "threadId", c.created_at AS "createdAt"
      FROM comments c
      JOIN episodes e ON e.id = c.thread_id
      JOIN seasons s ON s.id = e.season_id
      JOIN shows sh ON sh.id = s.show_id
      WHERE c.user_id = ${userId}
        AND c.thread_type = 'EPISODE'::"CommentThreadType"
        AND NOT EXISTS (
          SELECT 1 FROM media_canonical_links mcl
          WHERE mcl.source_media_id = sh.media_id
            AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
        )
    `;
    const earnedLikeRows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(cl.id)::int AS count
      FROM comment_likes cl
      JOIN comments c ON c.id = cl.comment_id
      JOIN episodes e ON e.id = c.thread_id
      JOIN seasons s ON s.id = e.season_id
      JOIN shows sh ON sh.id = s.show_id
      WHERE c.user_id = ${userId}
        AND c.thread_type = 'EPISODE'::"CommentThreadType"
        AND NOT EXISTS (
          SELECT 1 FROM media_canonical_links mcl
          WHERE mcl.source_media_id = sh.media_id
            AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
        )
    `;
    const earnedLikes = Number(earnedLikeRows[0]?.count ?? 0);

    const statuses = await this.prisma.userShowStatus.findMany({
      where: { userId, media: CANONICAL_VISIBLE_MEDIA },
    });
    const remainingEpisodes = statuses.reduce(
      (a, s) => a + Math.max(0, (s.totalCount ?? 0) - (s.watchedCount ?? 0)),
      0,
    );

    const recent = showRows.filter((r) => r.watchedAt >= new Date(Date.now() - 28 * 86400000));
    const speed = recent.length / 4; // per week
    const avgRuntime = showRows.length ? tvMinutes / showRows.length : 45;
    const timeToWatch = toDuration(remainingEpisodes * avgRuntime);
    const prediction =
      speed > 0 ? new Date(Date.now() + (remainingEpisodes / speed) * 7 * 86400000) : null;

    const futureChart: ChartPointDto[] = Array.from({ length: 8 }).map((_, i) => ({
      label: `W+${i + 1}`,
      value: Math.round(speed * 7),
    }));

    return {
      tvTime: toDuration(tvMinutes),
      tvTimeChart,
      episodesWatched: showRows.length,
      episodesWatchedChart,
      biggestMarathons,
      addedShows: statuses.length,
      topGenres: genres,
      genreCountUnit: 'titles',
      topNetworks: networks,
      votedRatings: { ratings: episodeRatings.length, showsRated: ratingByShow.size },
      mostVotedRatings,
      characterVotes: { votes: charVotes.length, shows: charByShow.size },
      mostVotedCharacters: [...charByShow.entries()].map(([showTitle, character]) => ({
        showTitle,
        character,
      })),
      comments: { count: comments.length, shows: new Set(comments.map((c) => c.threadId)).size },
      earnedLikes,
      episodeCommentsChart: this.weeklyChart(
        comments.map((c) => ({ watchedAt: c.createdAt, runtimeMinutes: 0 })),
        12,
        'count',
      ),
      remainingEpisodes,
      upcomingEpisodesChart: [],
      catchUpSpeedEpisodesPerWeek: Math.round(speed * 10) / 10,
      timeToWatch,
      futureWatchTimeChart: futureChart,
      catchUpPredictionDate: prediction ? prediction.toISOString() : null,
    };
  }

  private async computeMovieStats(userId: string, movieRows: any[]): Promise<MovieStatsDto> {
    // Use movie runtime from Movie table as fallback when watch history has null runtime
    const movieMinutes = movieRows.reduce(
      (a, r) => a + (r.runtimeMinutes ?? r.media?.movie?.runtimeMinutes ?? 0),
      0,
    );

    const genres = topGenresByDistinctTitles(movieRows);
    const mediaRatings = await this.prisma.rating.findMany({
      where: { userId, mediaId: { not: null } },
    });
    // Remaining movies = watchlist movies not yet watched (same definition as the summary;
    // NOT userMovieStatus.watched=false, which misses movies that only exist in the watchlist).
    const watchlistMovieIds = await this.prisma.watchlistItem.findMany({
      where: { userId, media: { type: MediaType.MOVIE } },
      select: { mediaId: true },
    });
    const watchedMovieIds = new Set(
      (
        await this.prisma.userMovieStatus.findMany({
          where: { userId, watched: true },
          select: { mediaId: true },
        })
      ).map((m) => m.mediaId),
    );
    const remainingMovies = watchlistMovieIds.filter((w) => !watchedMovieIds.has(w.mediaId)).length;
    const comments = await this.prisma.comment.findMany({
      where: { userId, threadType: 'MOVIE' },
      select: { threadId: true, createdAt: true },
    });
    const earnedLikes = await this.prisma.commentLike.count({
      where: { comment: { userId, threadType: 'MOVIE' } },
    });
    const recent = movieRows.filter((r) => r.watchedAt >= new Date(Date.now() - 28 * 86400000));
    const speed = recent.length / 4;
    const avgRuntime = movieRows.length ? movieMinutes / movieRows.length : 110;
    const timeToWatch = toDuration(remainingMovies * avgRuntime);
    const prediction =
      speed > 0 ? new Date(Date.now() + (remainingMovies / speed) * 7 * 86400000) : null;
    const movieCharacterVotes = await this.prisma.characterVote.findMany({
      where: { userId, mediaId: { not: null } },
      select: { mediaId: true },
    });

    return {
      movieTime: toDuration(movieMinutes),
      movieTimeChart: this.weeklyChart(movieRows, 12, 'minutes'),
      moviesWatched: movieRows.length,
      moviesWatchedChart: this.weeklyChart(movieRows, 12, 'count'),
      // Same set as watchlistMovieIds above — was a duplicate COUNT query.
      addedMovies: watchlistMovieIds.length,
      topGenres: genres,
      genreCountUnit: 'titles',
      votedRatings: {
        ratings: mediaRatings.length,
        moviesRated: new Set(mediaRatings.map((r) => r.mediaId)).size,
      },
      characterVotes: {
        votes: movieCharacterVotes.length,
        movies: new Set(movieCharacterVotes.map((vote) => vote.mediaId)).size,
      },
      comments: { count: comments.length, movies: new Set(comments.map((c) => c.threadId)).size },
      earnedLikes,
      movieCommentsChart: this.weeklyChart(
        comments.map((c) => ({ watchedAt: c.createdAt, runtimeMinutes: 0 })),
        12,
        'count',
      ),
      remainingMovies,
      upcomingMoviesChart: [],
      catchUpSpeedMoviesPerWeek: Math.round(speed * 10) / 10,
      timeToWatch,
      futureWatchTimeChart: Array.from({ length: 8 }).map((_, i) => ({
        label: `W+${i + 1}`,
        value: Math.round(speed * 7),
      })),
      catchUpPredictionDate: prediction ? prediction.toISOString() : null,
    };
  }

  private async ensureLeaderboardReady(): Promise<void> {
    if ((await this.redis.client.get(LEADERBOARD_READY_KEY)) === LEADERBOARD_READY_VERSION) return;
    if (this.leaderboardInitInFlight) return this.leaderboardInitInFlight;
    const promise = this.initializeLeaderboard().finally(() => {
      if (this.leaderboardInitInFlight === promise) this.leaderboardInitInFlight = null;
    });
    this.leaderboardInitInFlight = promise;
    return promise;
  }

  /**
   * Cold/recovery path only. A Redis lock prevents separate API replicas from scanning every user
   * simultaneously. Normal watch/import activity never calls this path once the v2 sets are ready.
   */
  private async initializeLeaderboard(): Promise<void> {
    const token = randomUUID();
    const acquired = await this.redis.client.set(
      LEADERBOARD_REBUILD_LOCK_KEY,
      token,
      'EX',
      this.leaderboardRebuildLockTtlSec,
      'NX',
    );
    if (acquired !== 'OK') {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if ((await this.redis.client.get(LEADERBOARD_READY_KEY)) === LEADERBOARD_READY_VERSION) {
          return;
        }
      }
      throw new Error('leaderboard cold initialization is still owned by another API replica');
    }

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await this.buildLeaderboardSnapshot()) return;
      }
      throw new Error('leaderboard kept changing during cold initialization');
    } finally {
      await this.redis.client
        .eval(StatsService.LOCK_RELEASE, 1, LEADERBOARD_REBUILD_LOCK_KEY, token)
        .catch(() => undefined);
    }
  }

  private async buildLeaderboardSnapshot(): Promise<boolean> {
    const startingVersion = (await this.redis.client.get(LB_VERSION_KEY)) ?? '0';
    const totals = await this.loadLeaderboardMinutes();
    const userIds = totals.map((row) => row.userId);
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, isSuspended: true, profile: { select: { isPrivate: true } } },
        })
      : [];
    const eligible = new Set(
      users.filter((user) => !user.isSuspended && !user.profile?.isPrivate).map((user) => user.id),
    );
    const suffix = randomUUID();
    const temporaryKeys = LEADERBOARD_TYPES.map(
      (type) => `${leaderboardSortedSetKey(type)}:building:${suffix}`,
    );
    const write = this.redis.client.multi();
    write.del(...temporaryKeys);
    for (const row of totals) {
      if (!eligible.has(row.userId)) continue;
      const scores = [row.showMinutes + row.movieMinutes, row.showMinutes, row.movieMinutes];
      for (let index = 0; index < LEADERBOARD_TYPES.length; index += 1) {
        if (scores[index] > 0) write.zadd(temporaryKeys[index], scores[index], row.userId);
      }
    }
    await write.exec();

    const publish = `
      local version = redis.call('GET', KEYS[1]) or '0'
      if version ~= ARGV[1] then return 0 end
      for i = 4, 8, 2 do
        if redis.call('EXISTS', KEYS[i]) == 1 then
          redis.call('RENAME', KEYS[i], KEYS[i + 1])
        else
          redis.call('DEL', KEYS[i + 1])
        end
      end
      redis.call('SET', KEYS[2], ARGV[2])
      redis.call('DEL', KEYS[3])
      return 1
    `;
    const published = await this.redis.client.eval(
      publish,
      9,
      LB_VERSION_KEY,
      LEADERBOARD_READY_KEY,
      LB_DIRTY_USERS_KEY,
      temporaryKeys[0],
      leaderboardSortedSetKey('combined'),
      temporaryKeys[1],
      leaderboardSortedSetKey('shows'),
      temporaryKeys[2],
      leaderboardSortedSetKey('movies'),
      startingVersion,
      LEADERBOARD_READY_VERSION,
    );
    if (Number(published) === 1) return true;
    await this.redis.client.del(...temporaryKeys);
    return false;
  }

  private refreshLeaderboardUser(userId: string): Promise<void> {
    const existing = this.leaderboardUserInFlight.get(userId);
    if (existing) return existing;
    const promise = this.refreshLeaderboardUserOnce(userId).finally(() => {
      if (this.leaderboardUserInFlight.get(userId) === promise) {
        this.leaderboardUserInFlight.delete(userId);
      }
    });
    this.leaderboardUserInFlight.set(userId, promise);
    return promise;
  }

  private async refreshLeaderboardUserOnce(userId: string): Promise<void> {
    if ((await this.redis.client.get(LEADERBOARD_READY_KEY)) !== LEADERBOARD_READY_VERSION) return;
    const versionKey = leaderboardUserVersionKey(userId);
    const computedVersionKey = leaderboardUserComputedVersionKey(userId);
    const startingVersion = (await this.redis.client.get(versionKey)) ?? '0';
    const [totals, user] = await Promise.all([
      this.loadLeaderboardMinutes(userId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, isSuspended: true, profile: { select: { isPrivate: true } } },
      }),
    ]);
    const own = totals[0];
    const scores: Record<LeaderboardType, number> = {
      combined: (own?.showMinutes ?? 0) + (own?.movieMinutes ?? 0),
      shows: own?.showMinutes ?? 0,
      movies: own?.movieMinutes ?? 0,
    };
    const eligible = !!user && !user.isSuspended && !user.profile?.isPrivate;
    const write = this.redis.client.multi();
    for (const type of LEADERBOARD_TYPES) {
      if (eligible && scores[type] > 0) {
        write.zadd(leaderboardSortedSetKey(type), scores[type], userId);
      } else {
        write.zrem(leaderboardSortedSetKey(type), userId);
      }
    }
    await write.exec();

    const markCurrent = `
      local version = redis.call('GET', KEYS[1]) or '0'
      if version ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[2], ARGV[1])
      redis.call('SREM', KEYS[3], ARGV[2])
      return 1
    `;
    const current = await this.redis.client.eval(
      markCurrent,
      3,
      versionKey,
      computedVersionKey,
      LB_DIRTY_USERS_KEY,
      startingVersion,
      userId,
    );
    if (Number(current) !== 1) await this.leaderboardBust.scheduleExisting(userId);
  }

  private async ensureLeaderboardUserCurrent(userId: string): Promise<void> {
    const [requested, computed, dirty] = await Promise.all([
      this.redis.client.get(leaderboardUserVersionKey(userId)),
      this.redis.client.get(leaderboardUserComputedVersionKey(userId)),
      this.redis.client.sismember(LB_DIRTY_USERS_KEY, userId),
    ]);
    if (dirty === 1 || (requested != null && requested !== computed)) {
      await this.refreshLeaderboardUser(userId);
    }
  }

  private async requeueDirtyLeaderboardUsers(): Promise<void> {
    const [, userIds] = await this.redis.client.sscan(LB_DIRTY_USERS_KEY, '0', 'COUNT', 25);
    await Promise.all(
      userIds.map((dirtyUserId) => this.leaderboardBust.scheduleExisting(dirtyUserId)),
    );
  }

  /**
   * Return per-user minutes with collapsed imported rewatches restored. Base history minutes are
   * retained exactly; only max(watchCount - historyRows, 0) missing plays are added. The query also
   * enforces the global stats rules for specials, inactive remap rows, and known future episodes.
   */
  private async loadLeaderboardMinutes(
    userId?: string,
  ): Promise<Array<{ userId: string; showMinutes: number; movieMinutes: number }>> {
    const historyUser = userId ? Prisma.sql`AND wh.user_id = ${userId}` : Prisma.empty;
    const episodeStatusUser = userId ? Prisma.sql`AND ues.user_id = ${userId}` : Prisma.empty;
    const movieStatusUser = userId ? Prisma.sql`AND ums.user_id = ${userId}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ userId: string; showMinutes: bigint | number; movieMinutes: bigint | number }>
    >(Prisma.sql`
      WITH episode_play_counts AS (
        SELECT wh.user_id, wh.episode_id, COUNT(*)::int AS plays
        FROM watch_history wh
        WHERE wh.episode_id IS NOT NULL ${historyUser}
          AND NOT EXISTS (
            SELECT 1 FROM media_canonical_links mcl
            WHERE mcl.source_media_id = wh.media_id
              AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
          )
        GROUP BY wh.user_id, wh.episode_id
      ),
      movie_play_counts AS (
        SELECT wh.user_id, wh.media_id, COUNT(*)::int AS plays
        FROM watch_history wh
        WHERE wh.media_type = 'MOVIE' ${historyUser}
          AND NOT EXISTS (
            SELECT 1 FROM media_canonical_links mcl
            WHERE mcl.source_media_id = wh.media_id
              AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
          )
        GROUP BY wh.user_id, wh.media_id
      ),
      base AS (
        SELECT
          wh.user_id,
          SUM(
            CASE
              WHEN wh.media_type = 'SHOW' AND (
                (wh.episode_id IS NULL AND COALESCE(wh.season_number, -1) <> 0)
                OR (
                  wh.episode_id IS NOT NULL
                  AND e.structure_state = 'ACTIVE'
                  AND s.is_special = FALSE
                  AND (e.air_date IS NULL OR e.air_date <= NOW())
                )
              ) THEN COALESCE(wh.runtime_minutes, e.runtime_minutes, 0)
              ELSE 0
            END
          )::bigint AS show_minutes,
          SUM(
            CASE WHEN wh.media_type = 'MOVIE'
              THEN COALESCE(wh.runtime_minutes, m.runtime_minutes, 0)
              ELSE 0
            END
          )::bigint AS movie_minutes
        FROM watch_history wh
        LEFT JOIN episodes e ON e.id = wh.episode_id
        LEFT JOIN seasons s ON s.id = e.season_id
        LEFT JOIN movies m ON m.media_id = wh.media_id
        WHERE 1 = 1 ${historyUser}
          AND NOT EXISTS (
            SELECT 1 FROM media_canonical_links mcl
            WHERE mcl.source_media_id = wh.media_id
              AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
          )
        GROUP BY wh.user_id
      ),
      episode_extra AS (
        SELECT
          ues.user_id,
          SUM(
            GREATEST(ues.watch_count - COALESCE(epc.plays, 0), 0)
            * COALESCE(e.runtime_minutes, 0)
          )::bigint AS minutes
        FROM user_episode_status ues
        JOIN episodes e ON e.id = ues.episode_id
        JOIN seasons s ON s.id = e.season_id
        JOIN shows sh ON sh.id = s.show_id
        LEFT JOIN episode_play_counts epc
          ON epc.user_id = ues.user_id AND epc.episode_id = ues.episode_id
        WHERE ues.watched = TRUE
          AND e.structure_state = 'ACTIVE'
          AND s.is_special = FALSE
          AND (e.air_date IS NULL OR e.air_date <= NOW())
          AND NOT EXISTS (
            SELECT 1 FROM media_canonical_links mcl
            WHERE mcl.source_media_id = sh.media_id
              AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
          )
          ${episodeStatusUser}
        GROUP BY ues.user_id
      ),
      movie_extra AS (
        SELECT
          ums.user_id,
          SUM(
            GREATEST(ums.watch_count - COALESCE(mpc.plays, 0), 0)
            * COALESCE(m.runtime_minutes, 0)
          )::bigint AS minutes
        FROM user_movie_status ums
        JOIN movies m ON m.media_id = ums.media_id
        LEFT JOIN movie_play_counts mpc
          ON mpc.user_id = ums.user_id AND mpc.media_id = ums.media_id
        WHERE ums.watched = TRUE ${movieStatusUser}
        GROUP BY ums.user_id
      ),
      user_ids AS (
        SELECT user_id FROM base
        UNION SELECT user_id FROM episode_extra
        UNION SELECT user_id FROM movie_extra
      )
      SELECT
        ids.user_id AS "userId",
        (COALESCE(base.show_minutes, 0) + COALESCE(episode_extra.minutes, 0))::bigint
          AS "showMinutes",
        (COALESCE(base.movie_minutes, 0) + COALESCE(movie_extra.minutes, 0))::bigint
          AS "movieMinutes"
      FROM user_ids ids
      LEFT JOIN base ON base.user_id = ids.user_id
      LEFT JOIN episode_extra ON episode_extra.user_id = ids.user_id
      LEFT JOIN movie_extra ON movie_extra.user_id = ids.user_id
    `);
    return rows.map((row) => ({
      userId: row.userId,
      showMinutes: Number(row.showMinutes),
      movieMinutes: Number(row.movieMinutes),
    }));
  }

  /** Record import completion/replay and coalesce one authoritative update for that user. */
  @OnEvent('import.applied')
  async invalidateLeaderboard(payload: { userId: string }) {
    await this.leaderboardBust.request(payload.userId);
  }

  private async currentViewerLeaderboardEntry(
    userId: string,
    type: LeaderboardType,
  ): Promise<LeaderboardEntryDto> {
    const key = leaderboardSortedSetKey(type);
    const [score, rank, user] = await Promise.all([
      this.redis.client.zscore(key, userId),
      this.redis.client.zrevrank(key, userId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          profile: { select: { displayName: true, avatarUrl: true } },
        },
      }),
    ]);
    let totalMinutes = score == null ? 0 : Number(score);
    if (score == null) {
      const own = (await this.loadLeaderboardMinutes(userId))[0];
      totalMinutes = own
        ? type === 'shows'
          ? own.showMinutes
          : type === 'movies'
            ? own.movieMinutes
            : own.showMinutes + own.movieMinutes
        : 0;
    }
    const position =
      rank == null
        ? Number(await this.redis.client.zcount(key, `(${totalMinutes}`, '+inf')) + 1
        : rank + 1;
    return {
      userId,
      username: user?.username ?? '?',
      displayName: user?.profile?.displayName ?? null,
      avatarUrl: user?.profile?.avatarUrl ?? null,
      totalMinutes,
      position,
    };
  }

  private async readLeaderboardPage(
    type: LeaderboardType,
    start: number,
    end: number,
  ): Promise<{ entries: LeaderboardEntryDto[]; invalidUserIds: string[] }> {
    const values = await this.redis.client.zrevrange(
      leaderboardSortedSetKey(type),
      start,
      end,
      'WITHSCORES',
    );
    const ranked = Array.from({ length: Math.floor(values.length / 2) }, (_, index) => ({
      userId: values[index * 2],
      totalMinutes: Number(values[index * 2 + 1]),
      position: start + index + 1,
    }));
    const users = ranked.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ranked.map((entry) => entry.userId) } },
          select: {
            id: true,
            username: true,
            isSuspended: true,
            profile: {
              select: { displayName: true, avatarUrl: true, isPrivate: true },
            },
          },
        })
      : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    const invalidUserIds = ranked
      .filter((entry) => {
        const user = byId.get(entry.userId);
        return !user || user.isSuspended || !!user.profile?.isPrivate;
      })
      .map((entry) => entry.userId);
    const invalid = new Set(invalidUserIds);
    return {
      invalidUserIds,
      entries: ranked
        .filter((entry) => !invalid.has(entry.userId))
        .map((entry) => {
          const user = byId.get(entry.userId)!;
          return {
            ...entry,
            username: user.username,
            displayName: user.profile?.displayName ?? null,
            avatarUrl: user.profile?.avatarUrl ?? null,
          };
        }),
    };
  }

  private async removeLeaderboardMembers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const remove = this.redis.client.multi();
    for (const type of LEADERBOARD_TYPES) {
      remove.zrem(leaderboardSortedSetKey(type), ...userIds);
    }
    await remove.exec();
  }

  async getLeaderboard(
    userId: string,
    type: LeaderboardType,
    page = 1,
    pageSize = 10,
  ): Promise<LeaderboardPageDto> {
    const safeType = LEADERBOARD_TYPES.includes(type) ? type : 'combined';
    const safeSize = Math.max(1, Math.min(pageSize, 50));
    await this.ensureLeaderboardReady();
    await this.ensureLeaderboardUserCurrent(userId);

    for (let repairAttempt = 0; repairAttempt < 3; repairAttempt += 1) {
      const total = await this.redis.client.zcard(leaderboardSortedSetKey(safeType));
      const totalPages = Math.max(1, Math.ceil(total / safeSize));
      const safePage = Math.min(Math.max(1, page), totalPages);
      const start = (safePage - 1) * safeSize;
      const { entries, invalidUserIds } = await this.readLeaderboardPage(
        safeType,
        start,
        start + safeSize - 1,
      );
      if (invalidUserIds.length > 0) {
        await this.removeLeaderboardMembers(invalidUserIds);
        continue;
      }
      const me = entries.some((entry) => entry.userId === userId)
        ? null
        : await this.currentViewerLeaderboardEntry(userId, safeType);
      const stale = (await this.redis.client.scard(LB_DIRTY_USERS_KEY)) > 0;
      if (stale) {
        void this.requeueDirtyLeaderboardUsers().catch((error) =>
          this.logger.warn(`leaderboard dirty-user recovery deferred: ${error.message}`),
        );
      }
      return {
        entries,
        me,
        total,
        page: safePage,
        pageSize: safeSize,
        totalPages,
        type: safeType,
        stale,
      };
    }
    throw new Error('leaderboard page could not remove invalid members');
  }
}
