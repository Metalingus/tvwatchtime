import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationCategory } from '@prisma/client';
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
  push?: boolean;
  pushAt?: Date;
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
    const prefs = await this.getPreferences(userId);
    const pref = prefs.preferences[input.category] ?? DEFAULT_PREFS[input.category];

    // Global push kill switch
    if (input.push && !(await this.flags.isEnabled('push_notifications'))) {
      input.push = false;
    }

    if (!pref?.inApp && !pref?.push) return null;

    // Daily push limit — count pushes already scheduled/dispatched today for this user
    const shouldPush = input.push && pref.push;
    if (shouldPush) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const maxPerDay = this.config.get<number>('notifications.maxPushPerUserPerDay') ?? 3;
      const pushesToday = await this.prisma.pushNotificationJob.count({
        where: { userId, createdAt: { gte: startOfDay }, status: { not: 'FAILED' } },
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
        const existing = await this.prisma.notification.findUnique({ where });
        if (existing) return mapNotification(existing);
      }
      await this.prisma.notification.create({
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

    if (pref.push) {
      await this.push.schedule({
        userId,
        category: input.category,
        title: input.title,
        body: input.body,
        imageUrl: input.imageUrl,
        link: input.link,
        scheduledFor: input.pushAt ?? new Date(),
      });
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
    await this.prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
    return { ok: true };
  }

  async remove(userId: string, id: string) {
    await this.prisma.notification.deleteMany({ where: { id, userId } });
    return { ok: true };
  }

  async getPreferences(userId: string) {
    let prefs = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    if (!prefs) {
      prefs = await this.prisma.notificationPreference.create({
        data: { userId, preferences: DEFAULT_PREFS },
      });
    }
    return {
      preferences: prefs.preferences as Record<NotificationCategory, { push: boolean; inApp: boolean }>,
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
