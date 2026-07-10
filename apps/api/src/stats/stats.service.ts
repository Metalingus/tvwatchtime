import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ChartPointDto,
  DurationDto,
  MovieStatsDto,
  StatsSummaryDto,
  ShowStatsDto,
} from '@tvwatch/shared';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { toDuration } from '../common/utils/duration.util';

@Injectable()
export class StatsService implements OnModuleInit {
  private readonly logger = new Logger(StatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // listeners attached via decorators
  }

  @OnEvent('watch.episode')
  @OnEvent('unwatch.episode')
  @OnEvent('watch.movie')
  @OnEvent('unwatch.movie')
  @OnEvent('watchlist.added')
  @OnEvent('import.applied')
  async invalidate(payload: { userId: string }) {
    await this.prisma.userStatsSummary.upsert({
      where: { userId: payload.userId },
      create: { userId: payload.userId, stale: true },
      update: { stale: true },
    });
  }

  private async loadOrCompute<T>(userId: string, field: 'summary' | 'showStats' | 'movieStats', compute: () => Promise<T>): Promise<T> {
    const row = await this.prisma.userStatsSummary.findUnique({ where: { userId } });
    if (row && !row.stale && row[field]) return row[field] as unknown as T;
    const value = await compute();
    await this.prisma.userStatsSummary.upsert({
      where: { userId },
      create: { userId, [field]: value as any, stale: false, computedAt: new Date() },
      update: { [field]: value as any, stale: false, computedAt: new Date() },
    });
    return value;
  }

  async getSummary(userId: string): Promise<StatsSummaryDto> {
    return this.loadOrCompute(userId, 'summary', () => this.computeSummary(userId));
  }

  async getShowStats(userId: string): Promise<ShowStatsDto> {
    return this.loadOrCompute(userId, 'showStats', () => this.computeShowStats(userId));
  }

  async getMovieStats(userId: string): Promise<MovieStatsDto> {
    return this.loadOrCompute(userId, 'movieStats', () => this.computeMovieStats(userId));
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

    const charVotes = await this.prisma.characterVote.findMany({ where: { userId }, include: { episode: { include: { season: { include: { show: { include: { media: true } } } } } } } });
    const charByShow = new Map<string, string>();
    for (const cv of charVotes) {
      const title = cv.episode?.season.show.media.title ?? 'Unknown';
      charByShow.set(title, cv.characterName);
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
    const remainingMovies = await this.prisma.userMovieStatus.count({ where: { userId, watched: false } });
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

  async getLeaderboard(userId: string, type: 'shows' | 'movies' | 'combined') {
    const [following, followers] = await Promise.all([
      this.prisma.follow.findMany({ where: { followerId: userId }, select: { targetId: true } }),
      this.prisma.follow.findMany({ where: { targetId: userId }, select: { followerId: true } }),
    ]);
    const followingSet = new Set(following.map((f) => f.targetId));
    const mutualIds = followers.filter((f) => followingSet.has(f.followerId)).map((f) => f.followerId);
    const userIds = [userId, ...mutualIds];

    const where = type === 'shows'
      ? { userId: { in: userIds }, mediaType: MediaType.SHOW }
      : type === 'movies'
        ? { userId: { in: userIds }, mediaType: MediaType.MOVIE }
        : { userId: { in: userIds } };

    const grouped = await this.prisma.watchHistory.groupBy({
      by: ['userId'],
      where: where as any,
      _sum: { runtimeMinutes: true },
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      include: { profile: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const entries = userIds
      .map((id) => {
        const g = grouped.find((x: any) => x.userId === id);
        const mins = g?._sum?.runtimeMinutes ?? 0;
        const u = userMap.get(id);
        return {
          userId: id,
          username: u?.username ?? '?',
          displayName: u?.profile?.displayName ?? null,
          avatarUrl: u?.profile?.avatarUrl ?? null,
          totalMinutes: mins,
        };
      })
      .filter((e) => e.totalMinutes > 0 || e.userId === userId)
      .sort((a, b) => b.totalMinutes - a.totalMinutes);

    entries.forEach((e, i) => { (e as any).position = i + 1; });

    const top10 = entries.slice(0, 10);
    const me = entries.find((e) => e.userId === userId);
    const inTop10 = top10.some((e) => e.userId === userId);

    return { top10, me: inTop10 ? null : me, type };
  }
}
