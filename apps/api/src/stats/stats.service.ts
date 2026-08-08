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
  LB_COMPUTED_VERSION_KEY,
  LB_VERSION_KEY,
  LeaderboardBustProcessor,
} from './leaderboard-bust.processor';
import { toDuration } from '../common/utils/duration.util';

const LEADERBOARD_TYPES: LeaderboardType[] = ['combined', 'shows', 'movies'];

type LeaderboardRankings = Record<LeaderboardType, LeaderboardEntryDto[]>;
type RankedLeaderboard = { entries: LeaderboardEntryDto[]; stale: boolean };

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
  private readonly lbTtlSec = Number(process.env.LEADERBOARD_CACHE_TTL_SEC) || 900;
  private readonly lbStaleTtlSec = Math.max(this.lbTtlSec * 30, 86_400);
  /** All three rankings use the same expensive aggregate, so every cache miss shares one run. */
  private lbRecomputeInFlight: Promise<LeaderboardRankings> | null = null;
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
        where: { userId },
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
            season: { isSpecial: false },
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

    const statuses = await this.prisma.userShowStatus.findMany({ where: { userId } });
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
      where: { userId, episodeId: { not: null } },
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
      where: { userId, episodeId: { not: null } },
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

    const comments = await this.prisma.comment.findMany({
      where: { userId, threadType: 'EPISODE' },
      select: { threadId: true, createdAt: true },
    });
    const earnedLikes = await this.prisma.commentLike.count({
      where: { comment: { userId, threadType: 'EPISODE' } },
    });

    const statuses = await this.prisma.userShowStatus.findMany({ where: { userId } });
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

  /**
   * Full global ranking for a type, cached in Redis under `lb:${type}`.
   * Ranked users = active (not suspended), public (profile not private), with >0 watch
   * minutes for the type. Sorted by totalMinutes desc, position = index+1.
   */
  private async getRankedLeaderboard(type: LeaderboardType): Promise<RankedLeaderboard> {
    const cacheKey = `lb:${type}`;
    const [cached, version, computedVersion] = await Promise.all([
      this.redis.get<LeaderboardEntryDto[]>(cacheKey),
      this.redis.client.get(LB_VERSION_KEY),
      this.redis.client.get(LB_COMPUTED_VERSION_KEY),
    ]);
    if (cached && computedVersion != null && computedVersion === (version ?? '0')) {
      return { entries: cached, stale: false };
    }

    const stale =
      cached ?? (await this.redis.get<LeaderboardEntryDto[]>(`lb:stale:${type}`).catch(() => null));
    const recompute = this.startLeaderboardRecompute();

    // The watch-count-aware aggregate scans millions of history/status rows. Never hold a profile
    // request behind it when a previous ranking exists: return that snapshot and refresh all three
    // leaderboard types in the background. A truly cold installation still computes synchronously.
    if (stale) {
      void recompute.catch((e) =>
        this.logger.error(`leaderboard background recompute failed: ${e.message}`),
      );
      return { entries: stale, stale: true };
    }
    return { entries: (await recompute)[type], stale: false };
  }

  private startLeaderboardRecompute(): Promise<LeaderboardRankings> {
    if (this.lbRecomputeInFlight) return this.lbRecomputeInFlight;
    const promise = this.computeRankedLeaderboards().finally(() => {
      if (this.lbRecomputeInFlight === promise) this.lbRecomputeInFlight = null;
    });
    this.lbRecomputeInFlight = promise;
    return promise;
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
        GROUP BY wh.user_id, wh.episode_id
      ),
      movie_play_counts AS (
        SELECT wh.user_id, wh.media_id, COUNT(*)::int AS plays
        FROM watch_history wh
        WHERE wh.media_type = 'MOVIE' ${historyUser}
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
        LEFT JOIN episode_play_counts epc
          ON epc.user_id = ues.user_id AND epc.episode_id = ues.episode_id
        WHERE ues.watched = TRUE
          AND e.structure_state = 'ACTIVE'
          AND s.is_special = FALSE
          AND (e.air_date IS NULL OR e.air_date <= NOW())
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

  private async computeRankedLeaderboards(attempt = 0): Promise<LeaderboardRankings> {
    const startingVersion = (await this.redis.client.get(LB_VERSION_KEY)) ?? '0';
    const totals = await this.loadLeaderboardMinutes();
    const userIds = totals.map((row) => row.userId);
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          include: { profile: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const rankings = Object.fromEntries(
      LEADERBOARD_TYPES.map((type) => {
        const entries: LeaderboardEntryDto[] = totals
          .map((row) => {
            const u = userMap.get(row.userId);
            const totalMinutes =
              type === 'shows'
                ? row.showMinutes
                : type === 'movies'
                  ? row.movieMinutes
                  : row.showMinutes + row.movieMinutes;
            return {
              userId: row.userId,
              username: u?.username ?? '?',
              displayName: u?.profile?.displayName ?? null,
              avatarUrl: u?.profile?.avatarUrl ?? null,
              totalMinutes,
            };
          })
          // Exclude suspended + private-profile users; keep 0-min out of the ranked list.
          .filter((entry) => {
            const u = userMap.get(entry.userId);
            return !!u && !u.isSuspended && !u.profile?.isPrivate && entry.totalMinutes > 0;
          })
          .sort((a, b) => b.totalMinutes - a.totalMinutes || a.username.localeCompare(b.username))
          .map((entry, index) => ({ ...entry, position: index + 1 }));
        return [type, entries];
      }),
    ) as LeaderboardRankings;

    const endingVersion = (await this.redis.client.get(LB_VERSION_KEY)) ?? '0';
    if (endingVersion !== startingVersion) {
      // A second season/bulk action landed while the global query was running. Discard the partial
      // snapshot and retry once against the current generation; never publish the first result.
      if (attempt < 1) return this.computeRankedLeaderboards(attempt + 1);
      throw new Error('leaderboard changed during both recompute attempts');
    }

    await Promise.all(
      LEADERBOARD_TYPES.flatMap((type) => [
        this.redis.set(`lb:${type}`, rankings[type], this.lbTtlSec),
        this.redis.set(`lb:stale:${type}`, rankings[type], this.lbStaleTtlSec),
      ]),
    );
    await this.redis.client.set(LB_COMPUTED_VERSION_KEY, startingVersion);
    return rankings;
  }

  /** Record import activity and coalesce the corresponding leaderboard cache bust. */
  @OnEvent('import.applied')
  async invalidateLeaderboard() {
    await this.leaderboardBust.request();
  }

  private async currentViewerLeaderboardEntry(
    userId: string,
    type: LeaderboardType,
    ranked: LeaderboardEntryDto[],
  ): Promise<LeaderboardEntryDto> {
    const cachedViewer = ranked.find((entry) => entry.userId === userId);
    const [totals, user] = await Promise.all([
      this.loadLeaderboardMinutes(userId),
      cachedViewer
        ? Promise.resolve(null)
        : this.prisma.user.findUnique({ where: { id: userId }, include: { profile: true } }),
    ]);
    const own = totals[0];
    const totalMinutes = own
      ? type === 'shows'
        ? own.showMinutes
        : type === 'movies'
          ? own.movieMinutes
          : own.showMinutes + own.movieMinutes
      : 0;
    const position =
      ranked.filter((entry) => entry.userId !== userId && entry.totalMinutes > totalMinutes)
        .length + 1;
    return {
      userId,
      username: cachedViewer?.username ?? user?.username ?? '?',
      displayName: cachedViewer?.displayName ?? user?.profile?.displayName ?? null,
      avatarUrl: cachedViewer?.avatarUrl ?? user?.profile?.avatarUrl ?? null,
      totalMinutes,
      position,
    };
  }

  async getLeaderboard(
    userId: string,
    type: LeaderboardType,
    page = 1,
    pageSize = 10,
  ): Promise<LeaderboardPageDto> {
    const safeSize = Math.max(1, Math.min(pageSize, 50));
    const ranking = await this.getRankedLeaderboard(type);
    const ranked = ranking.entries;
    const total = ranked.length;
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const safePage = Math.min(Math.max(1, page), totalPages);

    const start = (safePage - 1) * safeSize;
    let entries = ranked.slice(start, start + safeSize);

    // Current user: null if already shown on this page, else their global entry.
    let me: LeaderboardEntryDto | null = null;
    if (ranking.stale) {
      // Global ordering may be from the previous burst, but never show the signed-in user an old
      // total. Remove their cached row and pin an authoritative user-scoped calculation instead.
      entries = entries.filter((entry) => entry.userId !== userId);
      me = await this.currentViewerLeaderboardEntry(userId, type, ranked);
    } else if (!entries.some((entry) => entry.userId === userId)) {
      const mine = ranked.find((entry) => entry.userId === userId);
      me = mine ? { ...mine } : await this.currentViewerLeaderboardEntry(userId, type, ranked);
    }

    return {
      entries,
      me,
      total,
      page: safePage,
      pageSize: safeSize,
      totalPages,
      type,
      stale: ranking.stale,
    };
  }
}
