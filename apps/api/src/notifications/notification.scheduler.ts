import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingService } from '../common/setting.service';
import { NotificationService } from './notification.service';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { pickReminderShow, type ReminderCandidate } from './watchlist-reminder.util';

@Injectable()
export class NotificationScheduler {
  private readonly logger = new Logger(NotificationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly meta: MediaMetadataService,
    private readonly config: ConfigService,
    private readonly settings: SettingService,
  ) {}

  /** Hourly: episodes airing TODAY for tracked shows.
   *  - Batch per user, spread push times across the afternoon
   *  - Season premiere (S2+E1) → "X is back!" message
   *  - Series premiere (S1E1) → notify watchlist users
   *  - Only notify users who have watched at least 1 episode (cross-referenced)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduleEpisodeNotifications() {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);

    const episodes = await this.prisma.episode.findMany({
      where: { airDate: { gte: startOfToday, lt: endOfToday } },
      include: { season: { include: { show: { include: { media: true } } } } },
      orderBy: [{ airDate: 'asc' }],
      take: 200,
    });

    if (!episodes.length) return;

    const perUser = new Map<string, { ep: any; media: any; isSeasonPremiere: boolean; isSeriesPremiere: boolean; lastWatchedAt: Date | null }[]>();

    for (const ep of episodes) {
      const mediaId = ep.season.show.mediaId;
      const media = ep.season.show.media;
      const isSeasonPremiere = ep.number === 1 && ep.season.number > 1;
      const isSeriesPremiere = ep.number === 1 && ep.season.number === 1;

      if (isSeriesPremiere) {
        const watchlistUsers = await this.prisma.watchlistItem.findMany({
          where: { mediaId },
          select: { userId: true },
        });
        for (const { userId } of watchlistUsers) {
          if (!perUser.has(userId)) perUser.set(userId, []);
          perUser.get(userId)!.push({ ep, media, isSeasonPremiere: false, isSeriesPremiere: true, lastWatchedAt: null });
        }
        continue;
      }

      const userStatuses = await this.trackingUsersWithStatus(mediaId);
      for (const { userId, lastWatchedAt, watchedCount } of userStatuses) {
        if (watchedCount === 0) continue;
        if (!perUser.has(userId)) perUser.set(userId, []);
        perUser.get(userId)!.push({ ep, media, isSeasonPremiere, isSeriesPremiere: false, lastWatchedAt });
      }
    }

    let sent = 0;
    const spreadStartHour = this.config.get<number>('notifications.spreadStartHour') ?? 12;
    const slotHours = [0, 3, 4, 5, 6, 7, 8];

    for (const [userId, items] of perUser) {
      items.sort((a, b) => {
        if (a.isSeasonPremiere && !b.isSeasonPremiere) return -1;
        if (!a.isSeasonPremiere && b.isSeasonPremiere) return 1;
        return (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0);
      });

      for (let i = 0; i < items.length; i++) {
        const { ep, media, isSeasonPremiere, isSeriesPremiere } = items[i];

        const slotOffset = slotHours[Math.min(i, slotHours.length - 1)];
        const pushAt = new Date(startOfToday);
        pushAt.setHours(spreadStartHour + slotOffset, 0, 0, 0);
        if (pushAt <= now) {
          pushAt.setTime(now.getTime() + 10 * 60 * 1000);
        }

        const title = isSeasonPremiere
          ? `🎬 ${media.title} is back!`
          : isSeriesPremiere
            ? `🆕 ${media.title} premieres today`
            : `📺 New ${media.title}`;
        const body = isSeasonPremiere
          ? `Season ${ep.season.number} premieres today. S${ep.season.number}E1 · ${ep.title}`
          : `S${ep.season.number}E${ep.number} · ${ep.title} airs today`;

        await this.notifications.createForUser(userId, {
          category: 'EPISODE_TODAY',
          title,
          body,
          imageUrl: media.backdropUrl,
          link: `tvwatchtime://episode/${ep.id}`,
          dedupeKey: `ep:${ep.id}:today`,
          push: true,
          pushAt,
        });
        sent++;
      }
    }

    this.logger.log(`Episode notifications: ${episodes.length} airing today → ${sent} sent across ${perUser.size} users (spread from ${spreadStartHour}:00)`);
  }

  /** Daily: watchlist reminders — max 1 per user per day, rotating across shows.
   *  Skips shows where the user has watched ALL available episodes (nothing left to watch).
   *  A show isn't reminded again until WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS elapses, so a
   *  different show surfaces each day. Still fires daily (one reminder per user). */
  @Cron('0 22 * * *')
  async watchlistReminders() {
    const cooldownDays = await this.settings.getNumber('WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS', 30);
    const staleDays = await this.settings.getNumber('WATCHLIST_REMINDER_STALE_DAYS', 14);
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;

    const stale = await this.prisma.userShowStatus.findMany({
      where: { watchedCount: { gt: 0 }, OR: [{ lastWatchedAt: { lt: cutoff } }, { lastWatchedAt: null }] },
      include: { media: true },
      take: 500,
    });

    // Build per-user candidate lists (stale shows that still have unaired-watched episodes).
    const byUser = new Map<string, { candidate: ReminderCandidate; media: any; lastWatchedAt: Date | null }[]>();
    for (const s of stale) {
      const remaining = await this.prisma.episode.count({
        where: {
          season: { show: { mediaId: s.mediaId }, isSpecial: false },
          OR: [{ airDate: { lte: now } }, { airDate: null }],
          userStatuses: { none: { userId: s.userId, watched: true } },
        },
      });
      if (remaining === 0) continue;
      if (!byUser.has(s.userId)) byUser.set(s.userId, []);
      byUser.get(s.userId)!.push({
        candidate: { mediaId: s.mediaId, lastWatchedAt: s.lastWatchedAt },
        media: s.media,
        lastWatchedAt: s.lastWatchedAt,
      });
    }

    let count = 0;
    for (const [userId, shows] of byUser) {
      // Look up the most recent reminder per show (from the notification `link`) so we can rotate.
      const recent = await this.prisma.notification.findMany({
        where: { userId, category: 'WATCHLIST_REMINDER' },
        select: { link: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 300,
      });
      const lastReminded = new Map<string, Date>();
      for (const n of recent) {
        const m = n.link?.match(/show\/(.+)$/)?.[1];
        if (m && !lastReminded.has(m)) lastReminded.set(m, new Date(n.createdAt));
      }

      const chosen = pickReminderShow(
        shows.map((s) => s.candidate),
        lastReminded,
        cooldownMs,
        now,
      );
      if (!chosen) continue;
      const pick = shows.find((s) => s.candidate.mediaId === chosen.mediaId)!;

      await this.notifications.createForUser(userId, {
        category: 'WATCHLIST_REMINDER',
        title: `Catch up on ${pick.media.title}`,
        body: "You haven't watched for a while. Ready for the next episode?",
        imageUrl: pick.media.backdropUrl,
        link: `tvwatchtime://show/${pick.candidate.mediaId}`,
        dedupeKey: `remind:${userId}:${now.toISOString().slice(0, 10)}`,
        push: true,
      });
      count++;
    }
    if (count)
      this.logger.log(
        `Watchlist reminders: ${count} sent (rotating, ${cooldownDays}-day per-show cooldown, skipped fully-watched shows)`,
      );
  }

  /** Daily at 3 AM local: refresh air times from TVmaze. */
  @Cron('0 7 * * *')
  async refreshAirtimes() {
    const needsRefresh = await this.prisma.mediaItem.findMany({
      where: {
        type: 'SHOW',
        status: 'RETURNING',
        OR: [
          { showStatuses: { some: {} } },
          { watchlist: { some: {} } },
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

    this.logger.log(`Nightly TVmaze refresh: ${needsRefresh.length} shows need air time enrichment`);

    for (const show of needsRefresh) {
      try {
        await this.meta.ensureAirtimes(show.id);
      } catch (e) {
        this.logger.debug(`TVmaze refresh failed for "${show.title}": ${(e as Error).message}`);
      }
    }
    this.logger.log(`TVmaze refresh complete: ${needsRefresh.length} shows processed`);
  }

  /** Hourly: clean up expired data export files. */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredExports() {
    const expired = await this.prisma.dataExport.findMany({
      where: { expiresAt: { lt: new Date() }, status: 'ready' },
    });
    const exportDir = path.join(process.cwd(), 'storage', 'exports');
    for (const record of expired) {
      try { await fs.unlink(path.join(exportDir, record.fileName)); } catch {}
    }
    if (expired.length) {
      await this.prisma.dataExport.updateMany({
        where: { id: { in: expired.map((e) => e.id) } },
        data: { status: 'expired' },
      });
      this.logger.log(`Cleaned up ${expired.length} expired export files`);
    }
  }

  /** Get tracking users WITH accurate watched counts (cross-referenced with userEpisodeStatus). */
  private async trackingUsersWithStatus(mediaId: string): Promise<{ userId: string; lastWatchedAt: Date | null; watchedCount: number }[]> {
    const [statuses, watchlist, actualCounts] = await Promise.all([
      this.prisma.userShowStatus.findMany({ where: { mediaId }, select: { userId: true, lastWatchedAt: true, watchedCount: true } }),
      this.prisma.watchlistItem.findMany({ where: { mediaId }, select: { userId: true } }),
      this.prisma.$queryRaw<{ userId: string; cnt: number; lastAt: Date | null }[]>`
        SELECT ues.user_id AS "userId", COUNT(*)::int AS "cnt", MAX(ues.watched_at) AS "lastAt"
        FROM user_episode_status ues
        JOIN episodes e ON ues.episode_id = e.id
        JOIN seasons s ON e.season_id = s.id
        JOIN shows sh ON s.show_id = sh.id
        WHERE sh.media_id = ${mediaId} AND ues.watched = true AND s.is_special = false
        GROUP BY ues.user_id
      `,
    ]);

    const statusMap = new Map(statuses.map((s) => [s.userId, s]));
    const actualMap = new Map(actualCounts.map((r) => [r.userId, r]));
    const allUserIds = [...new Set([...statuses.map((s) => s.userId), ...watchlist.map((w) => w.userId)])];

    return allUserIds.map((userId) => {
      const status = statusMap.get(userId);
      const actual = actualMap.get(userId);
      return {
        userId,
        lastWatchedAt: status?.lastWatchedAt ?? actual?.lastAt ?? null,
        watchedCount: Math.max(status?.watchedCount ?? 0, actual?.cnt ?? 0),
      };
    });
  }
}
