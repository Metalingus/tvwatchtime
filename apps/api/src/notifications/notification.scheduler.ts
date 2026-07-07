import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationCategory } from '@prisma/client';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from './notification.service';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';

@Injectable()
export class NotificationScheduler {
  private readonly logger = new Logger(NotificationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly meta: MediaMetadataService,
  ) {}

  /** Hourly: episodes airing TODAY for tracked shows. Rules:
   *  - Season premiere (episode 1) → always notify
   *  - Show watched within 30 days → notify
   *  - Show not watched for 30+ days → skip
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduleEpisodeNotifications() {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Only episodes airing today
    const episodes = await this.prisma.episode.findMany({
      where: { airDate: { gte: startOfToday, lt: endOfToday } },
      include: { season: { include: { show: { include: { media: true } } } } },
      orderBy: [{ airDate: 'asc' }],
      take: 200,
    });

    let sent = 0;
    let skipped = 0;

    // Group eligible (user, episode) pairs, then sort by lastWatchedAt DESC
    // so the daily push limit prioritizes shows the user watches actively.
    const eligible: { userId: string; ep: any; media: any; isPremiere: boolean; lastWatchedAt: Date | null }[] = [];

    for (const ep of episodes) {
      const mediaId = ep.season.show.mediaId;
      const media = ep.season.show.media;
      const isPremiere = ep.number === 1;

      const userStatuses = await this.trackingUsersWithStatus(mediaId);

      for (const { userId, lastWatchedAt, watchedCount } of userStatuses) {
        if (isPremiere) {
          // Season premiere → always eligible
        } else if (watchedCount > 0 && (!lastWatchedAt || lastWatchedAt < thirtyDaysAgo)) {
          skipped++;
          continue;
        }
        eligible.push({ userId, ep, media, isPremiere, lastWatchedAt });
      }
    }

    // Sort: premieres first, then by most recently watched
    eligible.sort((a, b) => {
      // Premieres get priority
      if (a.isPremiere && !b.isPremiere) return -1;
      if (!a.isPremiere && b.isPremiere) return 1;
      // Then by lastWatchedAt DESC (most recent first)
      return (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0);
    });

    for (const { userId, ep, media } of eligible) {
      const dedupeKey = `ep:${ep.id}:today`;

      await this.notifications.createForUser(userId, {
        category: 'EPISODE_TODAY',
        title: `New episode of ${media.title} airs today`,
        body: `S${ep.season.number} E${ep.number} · ${ep.title}`,
        imageUrl: media.backdropUrl,
        link: `tvwatchtime://episode/${ep.id}`,
        dedupeKey,
        push: true,
        pushAt: ep.airDate!,
      });
      sent++;
    }
    this.logger.log(`Episode notifications: ${episodes.length} airing today → ${sent} sent, ${skipped} skipped (stale) | eligible sorted by recency, daily push limit enforced per user`);
  }

  /** Daily: watchlist reminders for shows not watched for a while. */
  @Cron('0 3 * * *')
  async watchlistReminders() {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const stale = await this.prisma.userShowStatus.findMany({
      where: { watchedCount: { gt: 0 }, OR: [{ lastWatchedAt: { lt: cutoff } }, { lastWatchedAt: null }] },
      include: { media: true },
      take: 500,
    });
    for (const s of stale) {
      await this.notifications.createForUser(s.userId, {
        category: 'WATCHLIST_REMINDER',
        title: `Catch up on ${s.media.title}`,
        body: "You haven't watched for a while. Ready for the next episode?",
        imageUrl: s.media.backdropUrl,
        link: `tvwatchtime://show/${s.mediaId}`,
        dedupeKey: `remind:${s.mediaId}:${new Date().toISOString().slice(0, 10)}`,
        push: true,
      });
    }
  }

  /** Daily at 3 AM: refresh air times from TVmaze. Only for RETURNING shows with upcoming episodes missing air times. */
  @Cron('0 3 * * *')
  async refreshAirtimes() {
    // Single query: find shows that are (a) RETURNING, (b) tracked by someone, 
    // (c) have at least one upcoming episode with airTime = null.
    // Ended shows, fully-enriched shows, and shows with no future episodes are all skipped.
    const needsRefresh = await this.prisma.mediaItem.findMany({
      where: {
        type: 'SHOW',
        status: 'RETURNING',
        OR: [
          { showStatuses: { some: {} } },           // tracked via user_show_status
          { watchlist: { some: {} } },               // tracked via watchlist
        ],
        show: {
          seasons: {
            some: {
              episodes: {
                some: {
                  airTime: null,
                  airDate: { gte: new Date() },
                },
              },
            },
          },
        },
      },
      select: { id: true, title: true },
    });

    this.logger.log(`Nightly TVmaze refresh: ${needsRefresh.length} shows need air time enrichment (skipping ended/enriched/no-upcoming)`);

    for (const show of needsRefresh) {
      try {
        await this.meta.ensureAirtimes(show.id);
        this.logger.debug(`Enriched air times for "${show.title}"`);
      } catch (e) {
        this.logger.debug(`TVmaze refresh failed for "${show.title}": ${(e as Error).message}`);
      }
    }
    this.logger.log(`TVmaze refresh complete: ${needsRefresh.length} shows processed`);
  }

  private async trackingUsers(mediaId: string): Promise<string[]> {
    const [statuses, watchlist] = await Promise.all([
      this.prisma.userShowStatus.findMany({ where: { mediaId }, select: { userId: true } }),
      this.prisma.watchlistItem.findMany({ where: { mediaId }, select: { userId: true } }),
    ]);
    return [...new Set([...statuses.map((s) => s.userId), ...watchlist.map((w) => w.userId)])];
  }

  /** Get tracking users WITH their show status (lastWatchedAt, watchedCount) for filtering. */
  private async trackingUsersWithStatus(mediaId: string): Promise<{ userId: string; lastWatchedAt: Date | null; watchedCount: number }[]> {
    const [statuses, watchlist] = await Promise.all([
      this.prisma.userShowStatus.findMany({ where: { mediaId }, select: { userId: true, lastWatchedAt: true, watchedCount: true } }),
      this.prisma.watchlistItem.findMany({ where: { mediaId }, select: { userId: true } }),
    ]);

    // Merge: show status users get their actual data, watchlist-only users get defaults
    const statusMap = new Map(statuses.map((s) => [s.userId, s]));
    const allUserIds = [...new Set([...statuses.map((s) => s.userId), ...watchlist.map((w) => w.userId)])];

    return allUserIds.map((userId) => {
      const status = statusMap.get(userId);
      return {
        userId,
        lastWatchedAt: status?.lastWatchedAt ?? null,
        watchedCount: status?.watchedCount ?? 0,
      };
    });
  }
}
