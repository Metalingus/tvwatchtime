import { Injectable } from '@nestjs/common';
import {
  EpisodeLabel,
  MediaType,
  UpcomingBucket,
  WatchNextBucket,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { mapEpisode } from '../common/utils/mapper.util';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
  ) {}

  async watchNext(userId: string) {
    // Shows the user has started watching (has user_show_status)
    const statuses = await this.prisma.userShowStatus.findMany({
      where: { userId },
      include: { media: { include: { show: true } } },
      orderBy: { lastWatchedAt: 'desc' },
      take: 500,
    });

    // Watchlist shows that DON'T have a user_show_status yet (never watched)
    const statusMediaIds = new Set(statuses.map((s) => s.mediaId));
    const watchlistShows = await this.prisma.watchlistItem.findMany({
      where: {
        userId,
        media: { type: 'SHOW' },
        ...(statusMediaIds.size ? { mediaId: { notIn: [...statusMediaIds] } } : {}),
      },
      include: { media: { include: { show: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // Fallback: shows the user has watched episodes for but missing from user_show_status
    // (e.g. import didn't rebuild statuses, or status was lost)
    const existingMediaIds = new Set([
      ...statusMediaIds,
      ...watchlistShows.map((w) => w.mediaId),
    ]);
    const watchedShowsRaw = await this.prisma.$queryRaw<
      Array<{ mediaId: string; watchedCount: number; lastWatchedAt: Date | null }>
    >`
      SELECT sh.media_id AS "mediaId", COUNT(ues.id)::int AS "watchedCount", MAX(ues.watched_at) AS "lastWatchedAt"
      FROM user_episode_status ues
      JOIN episodes e ON ues.episode_id = e.id
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE ues.user_id = ${userId} AND ues.watched = true AND s.is_special = false
      GROUP BY sh.media_id
    `;
    const missingShowIds = watchedShowsRaw
      .filter((r) => !existingMediaIds.has(r.mediaId))
      .map((r) => r.mediaId);
    const missingShows = missingShowIds.length
      ? await this.prisma.mediaItem.findMany({
          where: { id: { in: missingShowIds }, type: 'SHOW' },
          include: { show: true },
        })
      : [];
    const watchedMap = new Map(watchedShowsRaw.map((r) => [r.mediaId, r]));

    // Merge all sources
    const allStatuses: any[] = [
      ...statuses,
      ...watchlistShows.map((w) => ({
        userId,
        mediaId: w.mediaId,
        media: w.media,
        watchedCount: 0,
        totalCount: 0,
        lastWatchedAt: null,
        isWatchlistOnly: true,
      })),
      ...missingShows.map((m) => ({
        userId,
        mediaId: m.id,
        media: m,
        watchedCount: watchedMap.get(m.id)?.watchedCount ?? 0,
        totalCount: 0,
        lastWatchedAt: watchedMap.get(m.id)?.lastWatchedAt ?? null,
        isWatchlistOnly: false,
        fromEpisodeStatus: true,
      })),
    ];

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const watchNext: any[] = [];
    const notRecently: any[] = [];

    for (const status of allStatuses) {
      // Always try to find the next unwatched aired episode — handles ongoing shows
      // where new seasons were added after the user finished watching
      const next = await this.prisma.episode.findFirst({
        where: {
          season: { show: { mediaId: status.mediaId }, isSpecial: false },
          airDate: { not: null, lte: now },
          userStatuses: { none: { userId, watched: true } },
        },
        orderBy: [{ season: { number: 'asc' } }, { number: 'asc' }],
        include: { season: { include: { show: true } } },
      });
      if (!next) continue;

      // Always recalculate total from DB (stored totalCount may be stale)
      const totalCount = await this.prisma.episode.count({
        where: { season: { show: { mediaId: status.mediaId }, isSpecial: false } },
      });

      const realRemaining = Math.max(1, totalCount - (status.watchedCount ?? 0));
      const card = {
        showId: status.mediaId,
        showTitle: status.media.title,
        posterUrl: status.media.posterUrl,
        backdropUrl: status.media.backdropUrl,
        network: status.media.show?.network ?? null,
        episode: mapEpisode(next, { watched: false }),
        remainingUnwatched: realRemaining,
        label: this.episodeLabel(next, status.watchedCount ?? 0),
        lastWatchedAt: status.lastWatchedAt,
        progress: totalCount ? (status.watchedCount ?? 0) / totalCount : 0,
        watchedCount: status.watchedCount ?? 0,
        bucket: '' as WatchNextBucket,
      };

      const stale = !status.lastWatchedAt || status.lastWatchedAt < thirtyDaysAgo;
      if (status.isWatchlistOnly) {
        card.bucket = WatchNextBucket.START_WATCHING;
        watchNext.push(card);
      } else if (stale && (status.watchedCount ?? 0) > 0) {
        card.bucket = WatchNextBucket.NOT_RECENTLY;
        notRecently.push(card);
      } else {
        card.bucket = WatchNextBucket.WATCH_NEXT;
        watchNext.push(card);
      }
    }

    const history = await this.recentlyWatchedEpisodes(userId, 10);

    watchNext.sort((a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0));
    // Sort NOT_RECENTLY by engagement: most watched first, then most recent
    notRecently.sort((a, b) => {
      if (b.watchedCount !== a.watchedCount) return b.watchedCount - a.watchedCount;
      return (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0);
    });

    return { items: [...history, ...watchNext, ...notRecently] };
  }

  private async recentlyWatchedEpisodes(userId: string, limit: number) {
    const rows = await this.prisma.watchHistory.findMany({
      where: { userId, mediaType: MediaType.SHOW, episodeId: { not: null } },
      orderBy: { watchedAt: 'desc' },
      take: limit,
      include: { episode: { include: { season: { include: { show: { include: { media: { include: { show: true } } } } } } } } },
    });
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
          episode: mapEpisode(ep, { watched: true, watchedAt: r.watchedAt }),
          remainingUnwatched: 0,
          label: EpisodeLabel.AIRED,
          lastWatchedAt: r.watchedAt,
          progress: 1,
          bucket: WatchNextBucket.HISTORY,
        };
      });
  }

  async upcoming(userId: string) {
    const tracked = await this.trackedMediaIds(userId);

    // TVmaze enrichment is handled by a nightly cron job (NotificationScheduler.refreshAirtimes).
    // This endpoint is a pure DB read — no external API calls.

    // Include the past 7 days too (revealed by scrolling up); default lands on "Today".
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 7);

    const episodes = await this.prisma.episode.findMany({
      where: {
        airDate: { gte: start },
        season: { show: { mediaId: { in: tracked } } },
      },
      include: { season: { include: { show: { include: { media: { include: { show: true } } } } } } },
      orderBy: [{ airDate: 'asc' }, { season: { number: 'asc' } }, { number: 'asc' }],
      take: 200,
    });

    const items = episodes.map((e) => {
      const media = e.season.show.media;
      const bucket = this.upcomingBucket(e.airDate!);
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
        watched: false,
      };
    });

    const groups = this.groupByBucket(items);
    return { groups };
  }

  async history(
    userId: string,
    opts: { mediaType?: MediaType; from?: string; to?: string; page?: number; pageSize?: number },
  ) {
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 20;
    const where = {
      userId,
      ...(opts.mediaType ? { mediaType: opts.mediaType } : {}),
      ...(opts.from || opts.to
        ? { watchedAt: { gte: opts.from ? new Date(opts.from) : undefined, lte: opts.to ? new Date(opts.to) : undefined } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.watchHistory.findMany({
        where,
        orderBy: { watchedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { media: true },
      }),
      this.prisma.watchHistory.count({ where }),
    ]);
    const items = rows.map((r) => ({
      id: r.id,
      mediaType: r.mediaType,
      mediaId: r.mediaId,
      title: r.media.title,
      posterUrl: r.media.posterUrl,
      episodeId: r.episodeId,
      seasonNumber: r.seasonNumber,
      episodeNumber: r.episodeNumber,
      runtimeMinutes: r.runtimeMinutes,
      watchedAt: r.watchedAt.toISOString(),
    }));
    return paginate(items, page, pageSize, total);
  }

  // ---------------- helpers ----------------
  private async trackedMediaIds(userId: string): Promise<string[]> {
    const [statuses, watchlist] = await Promise.all([
      this.prisma.userShowStatus.findMany({ where: { userId }, select: { mediaId: true } }),
      this.prisma.watchlistItem.findMany({
        where: { userId, media: { type: MediaType.SHOW } },
        select: { mediaId: true },
      }),
    ]);
    return [...new Set([...statuses.map((s) => s.mediaId), ...watchlist.map((w) => w.mediaId)])];
  }

  async showsByStatus(userId: string) {
    const [statuses, watchlist] = await Promise.all([
      this.prisma.userShowStatus.findMany({
        where: { userId },
        include: { media: { select: { id: true, title: true, posterUrl: true, backdropUrl: true } } },
      }),
      this.prisma.watchlistItem.findMany({
        where: { userId, media: { type: MediaType.SHOW } },
        include: { media: { select: { id: true, title: true, posterUrl: true, backdropUrl: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const watching: any[] = [];
    const finished: any[] = [];
    for (const s of statuses) {
      const total = s.totalCount ?? 0;
      const w = s.watchedCount ?? 0;
      const progress = total > 0 ? w / total : 0;
      const item = { id: s.media.id, title: s.media.title, posterUrl: s.media.posterUrl, progress, lastWatchedAt: s.lastWatchedAt };
      if (w > 0 && progress < 1) watching.push(item);
      else if (total > 0 && w >= total) finished.push(item);
    }
    watching.sort((a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0));
    finished.sort((a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0));

    const progressedIds = new Set([...watching.map((i) => i.id), ...finished.map((i) => i.id)]);
    const notStarted = watchlist
      .filter((w) => !progressedIds.has(w.mediaId))
      .map((w) => ({ id: w.media.id, title: w.media.title, posterUrl: w.media.posterUrl, progress: 0, addedAt: w.createdAt }));

    return { watching, notStarted, finished };
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

  private groupByBucket(items: any[]) {
    const order: string[] = [
      'EARLIER',
      UpcomingBucket.TODAY,
      UpcomingBucket.TOMORROW,
      UpcomingBucket.THIS_WEEK,
      UpcomingBucket.LATER,
    ];
    const labels: Record<string, string> = {
      EARLIER: 'Earlier this week',
      [UpcomingBucket.TODAY]: 'Today',
      [UpcomingBucket.TOMORROW]: 'Tomorrow',
      [UpcomingBucket.THIS_WEEK]: 'This Week',
      [UpcomingBucket.LATER]: 'Later',
    };
    return order
      .map((key) => ({
        key,
        label: labels[key] ?? key,
        items: items.filter((i) => i.bucket === key),
      }))
      .filter((g) => g.items.length > 0);
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
