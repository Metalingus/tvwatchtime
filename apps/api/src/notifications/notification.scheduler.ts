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
import {
  catchUpPushAt,
  dateOnlyMatchesLocalDay,
  utcFromZoned,
  zonedDayRange,
  zonedParts,
} from '../common/utils/timezone.util';
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

  /** Hourly: episodes airing TODAY for tracked shows. Scheduled by CronManagerService
   *  (DB-driven — NOT a @Cron decorator, or the job would fire twice).
   *  - "Today" and the afternoon spread are computed PER USER in their device timezone
   *    (latest active device; fallback: notification prefs tz; fallback: server tz).
   *  - Batch per user, spread push times across the afternoon
   *  - Season premiere (S2+E1) → "X is back!" message
   *  - Series premiere (S1E1) → notify watchlist users
   *  - Only notify users who have watched at least 1 episode (cross-referenced)
   */
  async scheduleEpisodeNotifications() {
    const now = new Date();
    // Broad window: "today" differs per user timezone (UTC-12 … UTC+14), so fetch
    // server-yesterday → server-day-after-tomorrow once and filter per user below.
    const windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);
    windowStart.setDate(windowStart.getDate() - 1);
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 3);

    const episodes = await this.prisma.episode.findMany({
      where: {
        structureState: 'ACTIVE',
        airDate: { gte: windowStart, lt: windowEnd },
        season: {
          show: {
            media: {
              OR: [
                { canonicalSource: { is: null } },
                { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
              ],
            },
          },
        },
      },
      include: { season: { include: { show: { include: { media: true } } } } },
      orderBy: [{ airDate: 'asc' }],
      take: 400,
    });

    if (!episodes.length) return;

    const perUser = new Map<
      string,
      {
        ep: any;
        media: any;
        isSeasonPremiere: boolean;
        isSeriesPremiere: boolean;
        lastWatchedAt: Date | null;
      }[]
    >();

    for (const ep of episodes) {
      const mediaId = ep.season.show.mediaId;
      const media = ep.season.show.media;
      const isSeasonPremiere = ep.number === 1 && ep.season.number > 1;
      const isSeriesPremiere = ep.number === 1 && ep.season.number === 1;

      if (isSeriesPremiere) {
        // Paused or dropped trackers get no premiere notification for this show.
        const [watchlistUsers, suppressedRows] = await Promise.all([
          this.prisma.watchlistItem.findMany({
            where: { mediaId },
            select: { userId: true },
          }),
          this.prisma.userShowStatus.findMany({
            where: {
              mediaId,
              OR: [{ pausedAt: { not: null } }, { dropped: true }],
            },
            select: { userId: true },
          }),
        ]);
        const suppressedIds = new Set(suppressedRows.map((r) => r.userId));
        for (const { userId } of watchlistUsers) {
          if (suppressedIds.has(userId)) continue;
          if (!perUser.has(userId)) perUser.set(userId, []);
          perUser.get(userId)!.push({
            ep,
            media,
            isSeasonPremiere: false,
            isSeriesPremiere: true,
            lastWatchedAt: null,
          });
        }
        continue;
      }

      const userStatuses = await this.trackingUsersWithStatus(mediaId);
      for (const { userId, lastWatchedAt, watchedCount } of userStatuses) {
        if (watchedCount === 0) continue;
        if (!perUser.has(userId)) perUser.set(userId, []);
        perUser
          .get(userId)!
          .push({ ep, media, isSeasonPremiere, isSeriesPremiere: false, lastWatchedAt });
      }
    }

    // Per-user timezone: latest active device carrying a tz, then notification prefs.
    const userIds = [...perUser.keys()];
    const tzByUser = new Map<string, string>();
    const devices = await this.prisma.device.findMany({
      where: { userId: { in: userIds }, active: true, timezone: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { userId: true, timezone: true },
    });
    for (const d of devices) {
      if (!tzByUser.has(d.userId) && d.timezone) tzByUser.set(d.userId, d.timezone);
    }
    const missingTz = userIds.filter((id) => !tzByUser.has(id));
    if (missingTz.length) {
      const prefs = await this.prisma.notificationPreference.findMany({
        where: { userId: { in: missingTz }, timezone: { not: null } },
        select: { userId: true, timezone: true },
      });
      for (const p of prefs) {
        if (p.timezone) tzByUser.set(p.userId, p.timezone);
      }
    }

    let sent = 0;
    const spreadStartHour = this.config.get<number>('notifications.spreadStartHour') ?? 12;
    const preciseAirtimesEnabled = this.config.get<boolean>('metadata.tvmazeEnabled') === true;
    const slotHours = [0, 3, 4, 5, 6, 7, 8];
    // Server-tz fallback range (previous behavior).
    const serverStart = new Date(now);
    serverStart.setHours(0, 0, 0, 0);
    const serverEnd = new Date(serverStart);
    serverEnd.setDate(serverEnd.getDate() + 1);

    for (const [userId, items] of perUser) {
      const tz = tzByUser.get(userId) ?? null;
      const day = tz ? zonedDayRange(tz, now) : { start: serverStart, end: serverEnd };
      const todays = items.filter(({ ep }) => {
        if (!ep.airDate) return false;
        // TVmaze airstamps are real instants. TMDB/TVDB values are date-only and
        // must remain the same calendar date in every user's timezone.
        return preciseAirtimesEnabled && ep.airTime
          ? ep.airDate >= day.start && ep.airDate < day.end
          : dateOnlyMatchesLocalDay(ep.airDate, now, tz);
      });
      if (!todays.length) continue;

      todays.sort((a, b) => {
        if (a.isSeasonPremiere && !b.isSeasonPremiere) return -1;
        if (!a.isSeasonPremiere && b.isSeasonPremiere) return 1;
        return (b.lastWatchedAt?.getTime() ?? 0) - (a.lastWatchedAt?.getTime() ?? 0);
      });

      for (let i = 0; i < todays.length; i++) {
        const { ep, media, isSeasonPremiere, isSeriesPremiere } = todays[i];

        const slotOffset = slotHours[Math.min(i, slotHours.length - 1)];
        let pushAt: Date;
        if (tz) {
          const p = zonedParts(now, tz);
          pushAt = utcFromZoned(tz, p.year, p.month, p.day, spreadStartHour + slotOffset, 0);
        } else {
          pushAt = new Date(day.start);
          pushAt.setHours(spreadStartHour + slotOffset, 0, 0, 0);
        }
        if (pushAt <= now) {
          // The ideal slot already passed — fire ~now, unless the local evening has
          // started (>= 21:00); then DEFER to tomorrow's first spread slot in the
          // user's tz (never skip, never a midnight "airs today" push).
          const localHour = tz ? zonedParts(now, tz).hour : now.getHours();
          let nextSlot: Date;
          if (tz) {
            const p = zonedParts(now, tz);
            nextSlot = utcFromZoned(tz, p.year, p.month, p.day + 1, spreadStartHour, 0);
          } else {
            nextSlot = new Date(day.end.getTime() + spreadStartHour * 3_600_000);
          }
          pushAt = catchUpPushAt(pushAt, now, localHour, nextSlot);
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

    this.logger.log(
      `Episode notifications: ${sent} scheduled for ${perUser.size} users (per-user tz, spread from ${spreadStartHour}:00 local)`,
    );
  }

  /** Daily: watchlist reminders — max 1 per user per day, rotating across shows.
   *  Scheduled by CronManagerService (DB-driven — NOT a @Cron decorator, or the job
   *  would fire twice).
   *  Skips shows where the user has watched ALL available episodes (nothing left to watch).
   *  A show isn't reminded again until WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS elapses, so a
   *  different show surfaces each day. Still fires daily (one reminder per user). */
  async watchlistReminders() {
    const cooldownDays = await this.settings.getNumber('WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS', 30);
    const staleDays = await this.settings.getNumber('WATCHLIST_REMINDER_STALE_DAYS', 14);
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
    const now = new Date();
    const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;

    const stale = await this.prisma.userShowStatus.findMany({
      where: {
        dropped: false,
        pausedAt: null,
        watchedCount: { gt: 0 },
        OR: [{ lastWatchedAt: { lt: cutoff } }, { lastWatchedAt: null }],
        media: {
          OR: [
            { canonicalSource: { is: null } },
            { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
          ],
        },
      },
      include: { media: true },
      take: 500,
    });

    // Build per-user candidate lists (stale shows that still have unaired-watched episodes).
    const byUser = new Map<
      string,
      { candidate: ReminderCandidate; media: any; lastWatchedAt: Date | null }[]
    >();
    for (const s of stale) {
      const remaining = await this.prisma.episode.count({
        where: {
          structureState: 'ACTIVE',
          season: { show: { mediaId: s.mediaId }, isSpecial: false },
          airDate: { not: null, lte: now },
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

  /** Daily at 7 AM local: refresh air times from TVmaze. Scheduled by CronManagerService
   *  (DB-driven — NOT a @Cron decorator, or the job would fire twice). */
  async refreshAirtimes() {
    if (this.config.get<boolean>('metadata.tvmazeEnabled') !== true) {
      this.logger.debug('TVmaze refresh disabled; TMDB/TVDB schedule refreshes remain active');
      return { processed: 0, disabled: true };
    }
    const needsRefresh = await this.prisma.mediaItem.findMany({
      where: {
        type: 'SHOW',
        status: 'RETURNING',
        OR: [
          { showStatuses: { some: { dropped: false, pausedAt: null } } },
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

    this.logger.log(
      `Nightly TVmaze refresh: ${needsRefresh.length} shows need air time enrichment`,
    );

    for (const show of needsRefresh) {
      try {
        await this.meta.ensureAirtimes(show.id);
      } catch (e) {
        this.logger.debug(`TVmaze refresh failed for "${show.title}": ${(e as Error).message}`);
      }
    }
    this.logger.log(`TVmaze refresh complete: ${needsRefresh.length} shows processed`);
    return { processed: needsRefresh.length, disabled: false };
  }

  /** Hourly: clean up expired data export files. */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredExports() {
    const expired = await this.prisma.dataExport.findMany({
      where: { expiresAt: { lt: new Date() }, status: 'ready' },
    });
    const exportDir = path.join(process.cwd(), 'storage', 'exports');
    for (const record of expired) {
      try {
        await fs.unlink(path.join(exportDir, record.fileName));
      } catch {}
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
  private async trackingUsersWithStatus(
    mediaId: string,
  ): Promise<{ userId: string; lastWatchedAt: Date | null; watchedCount: number }[]> {
    const [statuses, watchlist, actualCounts] = await Promise.all([
      this.prisma.userShowStatus.findMany({
        where: { mediaId },
        select: {
          userId: true,
          lastWatchedAt: true,
          watchedCount: true,
          pausedAt: true,
          dropped: true,
        },
      }),
      this.prisma.watchlistItem.findMany({ where: { mediaId }, select: { userId: true } }),
      this.prisma.$queryRaw<{ userId: string; cnt: number; lastAt: Date | null }[]>`
        SELECT ues.user_id AS "userId", COUNT(*)::int AS "cnt", MAX(ues.watched_at) AS "lastAt"
        FROM user_episode_status ues
        JOIN episodes e ON ues.episode_id = e.id
        JOIN seasons s ON e.season_id = s.id
        JOIN shows sh ON s.show_id = sh.id
        WHERE sh.media_id = ${mediaId} AND ues.watched = true
          AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
          AND s.is_special = false
        GROUP BY ues.user_id
      `,
    ]);

    // Paused and dropped trackers are excluded from BOTH branches: keeping their
    // watchlist row must not let them leak back into notification recipients.
    const suppressedIds = new Set(
      statuses.filter((s) => s.pausedAt || s.dropped).map((s) => s.userId),
    );
    const statusMap = new Map(
      statuses.filter((s) => !s.pausedAt && !s.dropped).map((s) => [s.userId, s]),
    );
    const actualMap = new Map(actualCounts.map((r) => [r.userId, r]));
    const allUserIds = [
      ...new Set([...statuses.map((s) => s.userId), ...watchlist.map((w) => w.userId)]),
    ].filter((userId) => !suppressedIds.has(userId));

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
