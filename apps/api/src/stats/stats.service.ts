import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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
import { LeaderboardBustProcessor } from './leaderboard-bust.processor';
import { toDuration } from '../common/utils/duration.util';

const LEADERBOARD_TYPES: LeaderboardType[] = ['combined', 'shows', 'movies'];

interface ComputedStats {
  summary: StatsSummaryDto;
  showStats: ShowStatsDto;
  movieStats: MovieStatsDto;
  stale: boolean;
}

@Injectable()
export class StatsService implements OnModuleInit {
  private readonly logger = new Logger(StatsService.name);
  private readonly lbTtlSec = Number(process.env.LEADERBOARD_CACHE_TTL_SEC) || 120;
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
    // listeners attached via decorators
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
  async onWatchActivity() {
    await this.leaderboardBust.request();
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
    if (row && row.summary && row.showStats && row.movieStats) {
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
    const [summary, showStats, movieStats] = await Promise.all([
      this.computeSummary(userId),
      this.computeShowStats(userId),
      this.computeMovieStats(userId),
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

  private async runBackgroundRecompute(userId: string, lockKey: string, token: string): Promise<void> {
    let superseded = false;
    try {
      const row = await this.prisma.userStatsSummary.findUnique({ where: { userId } });
      if (!row || !row.stale) return; // already fresh / nothing to do
      const startingVersion = row.dirtyVersion ?? 0;
      const payloads = await this.computePayloads(userId); // throws → caught by caller .catch
      ({ superseded } = await this.storeAndCheckSuperseded(userId, payloads, startingVersion));
    } finally {
      // ownership-safe release: only delete if our token still owns the lock.
      await this.redis.client.eval(StatsService.LOCK_RELEASE, 1, lockKey, token).catch(() => undefined);
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
  private async computeSummary(userId: string): Promise<StatsSummaryDto> {
    const [showRows, movieRows] = await Promise.all([
      this.prisma.watchHistory.findMany({
        where: { userId, mediaType: MediaType.SHOW },
        include: { media: { include: { show: true } } },
      }),
      this.prisma.watchHistory.findMany({
        where: { userId, mediaType: MediaType.MOVIE },
        include: { media: { include: { movie: true } } },
      }),
    ]);
    const tvMinutes = showRows.reduce((a, r) => a + (r.runtimeMinutes ?? 0), 0);
    const movieMinutes = movieRows.reduce((a, r) => a + (r.runtimeMinutes ?? r.media?.movie?.runtimeMinutes ?? 0), 0);

    const statuses = await this.prisma.userShowStatus.findMany({ where: { userId } });
    const remainingEpisodes = statuses.reduce((a, s) => a + Math.max(0, (s.totalCount ?? 0) - (s.watchedCount ?? 0)), 0);

    // Remaining movies = watchlist movies that aren't watched yet
    const watchlistMovieIds = await this.prisma.watchlistItem.findMany({
      where: { userId, media: { type: MediaType.MOVIE } },
      select: { mediaId: true },
    });
    const watchedMovieIds = new Set(
      (await this.prisma.userMovieStatus.findMany({
        where: { userId, watched: true },
        select: { mediaId: true },
      })).map((m) => m.mediaId),
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
      addedMovies: await this.prisma.watchlistItem.count({ where: { userId, media: { type: MediaType.MOVIE } } }),
    };
  }

  private weeklyChart(rows: { watchedAt: Date; runtimeMinutes?: number | null }[], weeks = 12, mode: 'count' | 'minutes' = 'count'): ChartPointDto[] {
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
      if (idx >= 0) buckets[idx].value += mode === 'minutes' ? r.runtimeMinutes ?? 0 : 1;
    }
    return buckets.map((b) => ({ label: b.label, value: b.value }));
  }

  private async topCounts(items: { name: string | null }[]): Promise<{ name: string; count: number }[]> {
    const map = new Map<string, number>();
    for (const it of items) {
      if (!it.name) continue;
      map.set(it.name, (map.get(it.name) || 0) + 1);
    }
    return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  }

  private async computeShowStats(userId: string): Promise<ShowStatsDto> {
    const showRows = await this.prisma.watchHistory.findMany({
      where: { userId, mediaType: MediaType.SHOW },
      include: { media: { include: { show: true, genres: { include: { genre: true } } } } },
    });
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
        return { showTitle: title, episodeCount: v.count, periodLabel: v.date.toISOString().slice(0, 10) };
      })
      .sort((a, b) => b.episodeCount - a.episodeCount)
      .slice(0, 5);

    const genres = await this.topCounts(showRows.flatMap((r) => r.media.genres.map((g: any) => ({ name: g.genre.name }))));
    const networks = await this.topCounts(showRows.map((r) => ({ name: r.media.show?.network ?? null })));

    const episodeRatings = await this.prisma.rating.findMany({ where: { userId, episodeId: { not: null } }, include: { episode: { include: { season: { include: { show: { include: { media: true } } } } } } } });
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
      where: { userId },
      include: { cast: { include: { castMember: true } }, episode: { include: { season: { include: { show: { include: { media: true } } } } } } },
    });
    const charByShow = new Map<string, string>();
    for (const cv of charVotes) {
      const title = cv.episode?.season.show.media.title ?? 'Unknown';
      const character = cv.cast?.character ?? cv.cast?.castMember?.name ?? 'Unknown';
      charByShow.set(title, character);
    }

    const comments = await this.prisma.comment.findMany({ where: { userId, threadType: 'EPISODE' } });
    const earnedLikes = await this.prisma.commentLike.count({ where: { comment: { userId, threadType: 'EPISODE' } } });

    const statuses = await this.prisma.userShowStatus.findMany({ where: { userId } });
    const remainingEpisodes = statuses.reduce((a, s) => a + Math.max(0, (s.totalCount ?? 0) - (s.watchedCount ?? 0)), 0);

    const recent = showRows.filter((r) => r.watchedAt >= new Date(Date.now() - 28 * 86400000));
    const speed = recent.length / 4; // per week
    const avgRuntime = showRows.length ? tvMinutes / showRows.length : 45;
    const timeToWatch = toDuration(remainingEpisodes * avgRuntime);
    const prediction = speed > 0 ? new Date(Date.now() + (remainingEpisodes / speed) * 7 * 86400000) : null;

    const futureChart: ChartPointDto[] = Array.from({ length: 8 }).map((_, i) => ({ label: `W+${i + 1}`, value: Math.round(speed * 7) }));

    return {
      tvTime: toDuration(tvMinutes),
      tvTimeChart,
      episodesWatched: showRows.length,
      episodesWatchedChart,
      biggestMarathons,
      addedShows: statuses.length,
      topGenres: genres,
      topNetworks: networks,
      votedRatings: { ratings: episodeRatings.length, showsRated: ratingByShow.size },
      mostVotedRatings,
      characterVotes: { votes: charVotes.length, shows: charByShow.size },
      mostVotedCharacters: [...charByShow.entries()].map(([showTitle, character]) => ({ showTitle, character })),
      comments: { count: comments.length, shows: new Set(comments.map((c) => c.threadId)).size },
      earnedLikes,
      episodeCommentsChart: this.weeklyChart(comments.map((c) => ({ watchedAt: c.createdAt, runtimeMinutes: 0 })), 12, 'count'),
      remainingEpisodes,
      upcomingEpisodesChart: [],
      catchUpSpeedEpisodesPerWeek: Math.round(speed * 10) / 10,
      timeToWatch,
      futureWatchTimeChart: futureChart,
      catchUpPredictionDate: prediction ? prediction.toISOString() : null,
    };
  }

  private async computeMovieStats(userId: string): Promise<MovieStatsDto> {
    const movieRows = await this.prisma.watchHistory.findMany({
      where: { userId, mediaType: MediaType.MOVIE },
      include: { media: { include: { movie: true, genres: { include: { genre: true } } } } },
    });
    // Use movie runtime from Movie table as fallback when watch history has null runtime
    const movieMinutes = movieRows.reduce((a, r) => a + (r.runtimeMinutes ?? r.media?.movie?.runtimeMinutes ?? 0), 0);

    const genres = await this.topCounts(movieRows.flatMap((r) => r.media.genres.map((g: any) => ({ name: g.genre.name }))));
    const mediaRatings = await this.prisma.rating.findMany({ where: { userId, mediaId: { not: null } } });
    // Remaining movies = watchlist movies not yet watched (same definition as the summary;
    // NOT userMovieStatus.watched=false, which misses movies that only exist in the watchlist).
    const watchlistMovieIds = await this.prisma.watchlistItem.findMany({
      where: { userId, media: { type: MediaType.MOVIE } },
      select: { mediaId: true },
    });
    const watchedMovieIds = new Set(
      (await this.prisma.userMovieStatus.findMany({
        where: { userId, watched: true },
        select: { mediaId: true },
      })).map((m) => m.mediaId),
    );
    const remainingMovies = watchlistMovieIds.filter((w) => !watchedMovieIds.has(w.mediaId)).length;
    const comments = await this.prisma.comment.findMany({ where: { userId, threadType: 'MOVIE' } });
    const earnedLikes = await this.prisma.commentLike.count({ where: { comment: { userId, threadType: 'MOVIE' } } });
    const recent = movieRows.filter((r) => r.watchedAt >= new Date(Date.now() - 28 * 86400000));
    const speed = recent.length / 4;
    const avgRuntime = movieRows.length ? movieMinutes / movieRows.length : 110;
    const timeToWatch = toDuration(remainingMovies * avgRuntime);
    const prediction = speed > 0 ? new Date(Date.now() + (remainingMovies / speed) * 7 * 86400000) : null;

    return {
      movieTime: toDuration(movieMinutes),
      movieTimeChart: this.weeklyChart(movieRows, 12, 'minutes'),
      moviesWatched: movieRows.length,
      moviesWatchedChart: this.weeklyChart(movieRows, 12, 'count'),
      addedMovies: await this.prisma.watchlistItem.count({ where: { userId, media: { type: MediaType.MOVIE } } }),
      topGenres: genres,
      votedRatings: { ratings: mediaRatings.length, moviesRated: new Set(mediaRatings.map((r) => r.mediaId)).size },
      characterVotes: { votes: 0, movies: 0 },
      comments: { count: comments.length, movies: new Set(comments.map((c) => c.threadId)).size },
      earnedLikes,
      movieCommentsChart: this.weeklyChart(comments.map((c) => ({ watchedAt: c.createdAt, runtimeMinutes: 0 })), 12, 'count'),
      remainingMovies,
      upcomingMoviesChart: [],
      catchUpSpeedMoviesPerWeek: Math.round(speed * 10) / 10,
      timeToWatch,
      futureWatchTimeChart: Array.from({ length: 8 }).map((_, i) => ({ label: `W+${i + 1}`, value: Math.round(speed * 7) })),
      catchUpPredictionDate: prediction ? prediction.toISOString() : null,
    };
  }

  /**
   * Full global ranking for a type, cached in Redis under `lb:${type}`.
   * Ranked users = active (not suspended), public (profile not private), with >0 watch
   * minutes for the type. Sorted by totalMinutes desc, position = index+1.
   */
  private async getRankedLeaderboard(type: LeaderboardType): Promise<LeaderboardEntryDto[]> {
    const cacheKey = `lb:${type}`;
    const cached = await this.redis.get<LeaderboardEntryDto[]>(cacheKey);
    if (cached) return cached;

    const where = type === 'shows'
      ? { mediaType: MediaType.SHOW }
      : type === 'movies'
        ? { mediaType: MediaType.MOVIE }
        : {};

    const groups = await this.prisma.watchHistory.groupBy({
      by: ['userId'],
      where: where as any,
      _sum: { runtimeMinutes: true },
    });

    const userIds = groups.map((g: any) => g.userId);
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, include: { profile: true } })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const entries: LeaderboardEntryDto[] = groups
      .map((g: any) => {
        const u = userMap.get(g.userId);
        return {
          userId: g.userId,
          username: u?.username ?? '?',
          displayName: u?.profile?.displayName ?? null,
          avatarUrl: u?.profile?.avatarUrl ?? null,
          totalMinutes: g._sum?.runtimeMinutes ?? 0,
        };
      })
      // Exclude suspended + private-profile users; keep 0-min out of the ranked list.
      .filter((e) => {
        const u = userMap.get(e.userId);
        return !!u && !u.isSuspended && !(u.profile?.isPrivate) && e.totalMinutes > 0;
      })
      .sort((a, b) => b.totalMinutes - a.totalMinutes || a.username.localeCompare(b.username))
      .map((e, i) => ({ ...e, position: i + 1 }));

    await this.redis.set(cacheKey, entries, this.lbTtlSec);
    return entries;
  }

  /** Clear all three leaderboard caches (called on import.applied). */
  @OnEvent('import.applied')
  async invalidateLeaderboard() {
    await Promise.all(LEADERBOARD_TYPES.map((t) => this.redis.del(`lb:${t}`)));
  }

  async getLeaderboard(
    userId: string,
    type: LeaderboardType,
    page = 1,
    pageSize = 10,
  ): Promise<LeaderboardPageDto> {
    const safeSize = Math.max(1, Math.min(pageSize, 50));
    const ranked = await this.getRankedLeaderboard(type);
    const total = ranked.length;
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const safePage = Math.min(Math.max(1, page), totalPages);

    const start = (safePage - 1) * safeSize;
    const entries = ranked.slice(start, start + safeSize);

    // Current user: null if already shown on this page, else their global entry.
    let me: LeaderboardEntryDto | null = null;
    if (!entries.some((e) => e.userId === userId)) {
      const mine = ranked.find((e) => e.userId === userId);
      if (mine) {
        me = { ...mine };
      } else {
        // Viewer not in the ranked list (private / suspended / 0-min): compute their own.
        const where = type === 'shows'
          ? { userId, mediaType: MediaType.SHOW }
          : type === 'movies'
            ? { userId, mediaType: MediaType.MOVIE }
            : { userId };
        const [agg, u] = await Promise.all([
          this.prisma.watchHistory.aggregate({ where: where as any, _sum: { runtimeMinutes: true } }),
          this.prisma.user.findUnique({ where: { id: userId }, include: { profile: true } }),
        ]);
        const mins = agg._sum.runtimeMinutes ?? 0;
        const position = ranked.filter((e) => e.totalMinutes > mins).length + 1;
        me = {
          userId,
          username: u?.username ?? '?',
          displayName: u?.profile?.displayName ?? null,
          avatarUrl: u?.profile?.avatarUrl ?? null,
          totalMinutes: mins,
          position,
        };
      }
    }

    return { entries, me, total, page: safePage, pageSize: safeSize, totalPages, type };
  }
}
