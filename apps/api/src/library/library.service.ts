import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  EpisodeLabel,
  MediaType,
  UpcomingBucket,
  WatchNextBucket,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { currentLanguage } from '../common/language.context';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { mapEpisode } from '../common/utils/mapper.util';
import { localized } from '../common/utils/localization.util';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly meta: MediaMetadataService,
  ) {}

  /**
   * Localize media title/poster/backdrop fields on a list of result items in the
   * request language, populating the locale override first (best-effort). Used by
   * library rails that read `media.title` directly instead of going through
   * fetchListDtos.
   */
  private async localizeItems<T>(items: T[], getMediaId: (i: T) => string | undefined): Promise<T[]> {
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
      if ('posterUrl' in out) out.posterUrl = localized(m, 'posterUrls', 'posterUrl') ?? out.posterUrl;
      if ('backdropUrl' in out) out.backdropUrl = localized(m, 'backdropUrls', 'backdropUrl') ?? out.backdropUrl;
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

  async watchNext(userId: string) {
    const cacheKey = `watchnext:${userId}:${currentLanguage()}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) return cached;

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

    // Merge all sources — correct stale userShowStatus counts using actual userEpisodeStatus data
    const allStatuses: any[] = [
      ...statuses.map((s) => ({
        ...s,
        watchedCount: Math.max(s.watchedCount ?? 0, watchedMap.get(s.mediaId)?.watchedCount ?? 0),
        lastWatchedAt: s.lastWatchedAt ?? watchedMap.get(s.mediaId)?.lastWatchedAt ?? null,
      })),
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
      // Skip shows the user viewed but never interacted with (no watched episodes, not in watchlist)
      if (!status.isWatchlistOnly && (status.watchedCount ?? 0) === 0) continue;

      // Always try to find the next unwatched AIRED episode — handles ongoing shows
      // where new seasons were added after the user finished watching.
      // Episodes with no air date are treated as UNAIRED (excluded).
      // take: 2 so we also get the FOLLOWING episode → nextEpisode, used by the client to
      // optimistically swap the Watch-Next card to the next episode on mark-watched.
      const nextEpisodes = await this.prisma.episode.findMany({
        where: {
          season: { show: { mediaId: status.mediaId }, isSpecial: false },
          airDate: { not: null, lte: now },
          userStatuses: { none: { userId, watched: true } },
        },
        orderBy: [{ season: { number: 'asc' } }, { number: 'asc' }],
        include: { season: { include: { show: true } } },
        take: 2,
      });
      const next = nextEpisodes[0];
      if (!next) continue;

      // Always recalculate total from DB — only count AIRED episodes (null air date = unaired)
      const totalCount = await this.prisma.episode.count({
        where: {
          season: { show: { mediaId: status.mediaId }, isSpecial: false },
          airDate: { not: null, lte: now },
        },
      });

      const realRemaining = Math.max(1, totalCount - (status.watchedCount ?? 0));
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
        label: this.episodeLabel(next, status.watchedCount ?? 0),
        lastWatchedAt: status.lastWatchedAt,
        progress: totalCount ? (status.watchedCount ?? 0) / totalCount : 0,
        watchedCount: status.watchedCount ?? 0,
        bucket: '' as WatchNextBucket,
      };

      const stale = !status.lastWatchedAt || status.lastWatchedAt < thirtyDaysAgo;
      // If the next episode aired recently (new season just started), prioritize as WATCH_NEXT
      // even if the user hasn't watched in a while — fresh content is always relevant
      const nextAirDate = next.airDate ? new Date(next.airDate) : null;
      const hasFreshContent = nextAirDate && nextAirDate > thirtyDaysAgo;
      if (status.isWatchlistOnly) {
        card.bucket = WatchNextBucket.START_WATCHING;
        watchNext.push(card);
      } else if (stale && (status.watchedCount ?? 0) > 0 && !hasFreshContent) {
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

    const result = { items: [...history, ...watchNext, ...notRecently] };
    result.items = await this.localizeItems(result.items, (i) => i.showId);
    await this.localizeEpisodeTitles(result.items);
    await this.redis.set(cacheKey, result, 30);
    return result;
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
    const cacheKey = `upcoming:${userId}:${currentLanguage()}`;
    const cached = await this.redis.get<any>(cacheKey);
    if (cached) return cached;

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

    const items = await this.localizeItems(
      episodes.map((e) => {
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

    const groups = this.groupByBucket(items);
    const result = { groups };
    await this.redis.set(cacheKey, result, 60);
    return result;
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
    const items = await this.localizeItems(
      rows.map((r) => ({
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
      })) as any[],
      (i) => i.mediaId,
    );
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

    // Batch-query accurate AIRED episode counts (excludes future + null air dates)
    const showMediaIds = statuses.map((s) => s.mediaId);
    const airedCounts = showMediaIds.length > 0
      ? await this.prisma.$queryRaw<{ mediaId: string; airedCount: number }[]>`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "airedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.air_date IS NOT NULL
            AND e.air_date <= NOW()
          GROUP BY sh.media_id
        `
      : [];
    const airedMap = new Map(airedCounts.map((r) => [r.mediaId, r.airedCount]));

    const watching: any[] = [];
    const finished: any[] = [];
    for (const s of statuses) {
      const w = s.watchedCount ?? 0;
      const airedTotal = airedMap.get(s.mediaId) ?? 0;
      const progress = airedTotal > 0 ? w / airedTotal : 0;
      const item = { id: s.media.id, title: s.media.title, posterUrl: s.media.posterUrl, progress, lastWatchedAt: s.lastWatchedAt };
      if (w > 0 && progress < 1) watching.push(item);
      else if (airedTotal > 0 && w >= airedTotal) finished.push(item);
    }
    watching.sort((a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0));
    finished.sort((a, b) => (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0));

    const progressedIds = new Set([...watching.map((i) => i.id), ...finished.map((i) => i.id)]);
    const notStarted = watchlist
      .filter((w) => !progressedIds.has(w.mediaId))
      .map((w) => ({ id: w.media.id, title: w.media.title, posterUrl: w.media.posterUrl, progress: 0, addedAt: w.createdAt }));

    const [watchingL, finishedL, notStartedL] = await Promise.all([
      this.localizeItems(watching, (i) => i.id),
      this.localizeItems(finished, (i) => i.id),
      this.localizeItems(notStarted, (i) => i.id),
    ]);

    return { watching: watchingL, notStarted: notStartedL, finished: finishedL };
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
