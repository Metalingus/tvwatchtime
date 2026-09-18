import { validTimeZone } from '@tvwatch/shared';
import { currentTimeZone } from '../common/timezone.context';
import { zonedDayRange } from '../common/utils/timezone.util';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, NotificationCategory } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flag.service';
import { mapNotification } from '../common/utils/mapper.util';
import { paginate } from '../common/dto/pagination.dto';
import { PushService } from './push.service';

export interface CreateInAppInput {
  category: NotificationCategory;
  title: string;
  body?: string;
  imageUrl?: string | null;
  iconUrl?: string | null;
  actorAvatarUrl?: string | null;
  link?: string | null;
  dedupeKey?: string;
  pushDedupeKey?: string;
  push?: boolean;
  pushAt?: Date;
  timezone?: string;
}

const DEFAULT_PREFS: Record<string, { push: boolean; inApp: boolean }> = Object.fromEntries(
  Object.values(NotificationCategory).map((c) => [c, { push: true, inApp: true }]),
);

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly config: ConfigService,
    private readonly flags: FeatureFlagService,
  ) {}

  async createForUser(userId: string, input: CreateInAppInput) {
    if (input.dedupeKey && ['EPISODE_TODAY', 'WATCHLIST_REMINDER'].includes(input.category)) {
      // Serialize admission across scheduler runs/replicas, including push-only preferences.
      return this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'scheduled-notification:' + userId}, 0))::text`;
        return this.createScheduledOrImmediate(userId, input, tx);
      });
    }
    return this.createScheduledOrImmediate(userId, input, this.prisma);
  }

  private async createScheduledOrImmediate(
    userId: string,
    input: CreateInAppInput,
    db: Prisma.TransactionClient,
  ) {
    const prefs = await this.getPreferences(userId, db);
    const pref = prefs.preferences[input.category] ?? DEFAULT_PREFS[input.category];

    // Global push kill switch
    if (input.push && !(await this.flags.isEnabled('push_notifications'))) {
      input.push = false;
    }

    if (!pref?.inApp && !pref?.push) return null;

    if (input.dedupeKey && ['EPISODE_TODAY', 'WATCHLIST_REMINDER'].includes(input.category)) {
      const duplicate = await db.pushNotificationJob.findFirst({
        where: {
          userId,
          category: input.category,
          status: { not: 'FAILED' },
          OR: [
            { payload: { path: ['dedupeKey'], equals: input.dedupeKey } },
            ...(input.pushDedupeKey
              ? [{ payload: { path: ['pushDedupeKey'], equals: input.pushDedupeKey } }]
              : []),
          ],
        },
        select: { id: true },
      });
      if (duplicate) return null;
      const existing = await db.notification.findUnique({
        where: { userId_dedupeKey: { userId, dedupeKey: input.dedupeKey } },
      });
      if (existing) return null;
    }
    if (input.category === 'WATCHLIST_REMINDER') {
      const cutoff = new Date(Date.now() - 3 * 86400000);
      const [inApp, push] = await Promise.all([
        db.notification.findFirst({
          where: {
            userId,
            category: 'WATCHLIST_REMINDER',
            createdAt: { gt: cutoff },
          },
          select: { id: true },
        }),
        db.pushNotificationJob.findFirst({
          where: {
            userId,
            category: 'WATCHLIST_REMINDER',
            createdAt: { gt: cutoff },
            status: { not: 'FAILED' },
          },
          select: { id: true },
        }),
      ]);
      if (inApp || push) return null;
    }

    // Daily push limit — count pushes already scheduled/dispatched today for this user
    const shouldPush = input.push && pref.push;
    if (shouldPush) {
      const day = zonedDayRange(
        validTimeZone(input.timezone ?? prefs.timezone ?? currentTimeZone()),
        input.pushAt ?? new Date(),
      );
      const maxPerDay = this.config.get<number>('notifications.maxPushPerUserPerDay') ?? 3;
      const pushesToday = await db.pushNotificationJob.count({
        where: { userId, scheduledFor: { gte: day.start, lt: day.end }, status: { not: 'FAILED' } },
      });
      if (pushesToday >= maxPerDay) {
        // Still create in-app notification, just don't push
        input.push = false;
      }
    }

    if (pref.inApp) {
      const where = input.dedupeKey
        ? { userId_dedupeKey: { userId, dedupeKey: input.dedupeKey } }
        : undefined;
      if (where) {
        const existing = await db.notification.findUnique({ where });
        if (existing) return mapNotification(existing);
      }
      await db.notification.create({
        data: {
          userId,
          category: input.category,
          title: input.title,
          body: input.body,
          imageUrl: input.imageUrl,
          iconUrl: input.iconUrl,
          actorAvatarUrl: input.actorAvatarUrl,
          link: input.link,
          dedupeKey: input.dedupeKey,
          channel: input.push ? 'BOTH' : 'IN_APP',
        },
      });
    }

    if (input.push && pref.push) {
      await this.push.schedule(
        {
          userId,
          category: input.category,
          title: input.title,
          body: input.body,
          imageUrl: input.imageUrl,
          link: input.link,
          scheduledFor: input.pushAt ?? new Date(),
          dedupeKey: input.dedupeKey,
          pushDedupeKey: input.pushDedupeKey,
        },
        db,
      );
    }
    return { ok: true };
  }

  async list(userId: string, opts: { unreadOnly?: boolean; page?: number; pageSize?: number }) {
    const page = opts.page || 1;
    const pageSize = opts.pageSize || 30;
    const where = { userId, ...(opts.unreadOnly ? { read: false } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return paginate(rows.map(mapNotification), page, pageSize, total);
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId }, data: { read: true } });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { ok: true };
  }

  async remove(userId: string, id: string) {
    await this.prisma.notification.deleteMany({ where: { id, userId } });
    return { ok: true };
  }

  async clearAll(userId: string) {
    await this.prisma.notification.deleteMany({ where: { userId } });
    return { ok: true };
  }

  async getPreferences(userId: string, db: Prisma.TransactionClient = this.prisma) {
    // First access can come from several event listeners at once. Use one atomic
    // statement so concurrent callers cannot both observe a missing row and race
    // to insert the same unique userId.
    const prefs = await db.notificationPreference.upsert({
      where: { userId },
      create: { userId, preferences: DEFAULT_PREFS },
      update: {},
    });
    return {
      preferences: prefs.preferences as Record<
        NotificationCategory,
        { push: boolean; inApp: boolean }
      >,
      quietHoursEnabled: prefs.quietHoursEnabled,
      quietHoursStart: prefs.quietHoursStart,
      quietHoursEnd: prefs.quietHoursEnd,
      timezone: prefs.timezone,
      timing: prefs.timing,
    };
  }

  async updatePreferences(userId: string, dto: any) {
    const current = await this.getPreferences(userId);
    const data: any = {};
    if (dto.preferences) data.preferences = { ...current.preferences, ...dto.preferences };
    if (dto.quietHoursEnabled !== undefined) data.quietHoursEnabled = dto.quietHoursEnabled;
    if (dto.quietHoursStart !== undefined) data.quietHoursStart = dto.quietHoursStart;
    if (dto.quietHoursEnd !== undefined) data.quietHoursEnd = dto.quietHoursEnd;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.timing !== undefined) data.timing = dto.timing;
    await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data, preferences: data.preferences ?? DEFAULT_PREFS },
      update: data,
    });
    return this.getPreferences(userId);
  }
}
