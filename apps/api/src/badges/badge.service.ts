import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BadgeCategory } from '@prisma/client';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';

interface BadgeDef {
  name: string;
  category: BadgeCategory;
  icon: string;
  description: string;
  unlockCondition: string;
  threshold: number;
  metric: 'episodes' | 'movies' | 'ratings' | 'comments' | 'follows' | 'marathon' | 'days_active';
}

const BADGES: BadgeDef[] = [
  { name: 'First Steps', category: 'WATCH', icon: '🎬', description: 'Watch your first episode', unlockCondition: 'Watch 1 episode', threshold: 1, metric: 'episodes' },
  { name: 'Getting Into It', category: 'WATCH', icon: '📺', description: 'Watch 10 episodes', unlockCondition: 'Watch 10 episodes', threshold: 10, metric: 'episodes' },
  { name: 'Marathoner', category: 'MARATHON', icon: '🏃', description: 'Watch 100 episodes', unlockCondition: 'Watch 100 episodes', threshold: 100, metric: 'episodes' },
  { name: 'Cinephile', category: 'WATCH', icon: '🎞️', description: 'Watch 25 movies', unlockCondition: 'Watch 25 movies', threshold: 25, metric: 'movies' },
  { name: 'Movie Buff', category: 'WATCH', icon: '🍿', description: 'Watch 100 movies', unlockCondition: 'Watch 100 movies', threshold: 100, metric: 'movies' },
  { name: 'Big Marathon', category: 'MARATHON', icon: '🔥', description: 'Watch 6 episodes in a single day', unlockCondition: '6 episodes in one day', threshold: 6, metric: 'marathon' },
  { name: 'Critic', category: 'RATING', icon: '⭐', description: 'Rate 10 episodes', unlockCondition: 'Rate 10 episodes', threshold: 10, metric: 'ratings' },
  { name: 'Voice', category: 'COMMENT', icon: '💬', description: 'Post 5 comments', unlockCondition: 'Post 5 comments', threshold: 5, metric: 'comments' },
  { name: 'Social Butterfly', category: 'FOLLOW', icon: '🦋', description: 'Follow 5 people', unlockCondition: 'Follow 5 people', threshold: 5, metric: 'follows' },
  { name: 'Welcome Aboard', category: 'APP_USAGE', icon: '👋', description: 'Join the community', unlockCondition: 'First sign-in', threshold: 1, metric: 'days_active' },
];

@Injectable()
export class BadgeService implements OnModuleInit {
  private readonly logger = new Logger(BadgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  async onModuleInit() {
    await this.seedBadges();
  }

  private async seedBadges() {
    for (const def of BADGES) {
      await this.prisma.badge.upsert({
        where: { name: def.name },
        create: {
          name: def.name,
          category: def.category,
          icon: def.icon,
          description: def.description,
          unlockCondition: def.unlockCondition,
          threshold: def.threshold,
          scopeType: 'GLOBAL',
        },
        update: { description: def.description, unlockCondition: def.unlockCondition, icon: def.icon },
      });
    }
    this.logger.log(`Seeded ${BADGES.length} badges`);
  }

  @OnEvent('watch.episode')
  @OnEvent('watch.movie')
  @OnEvent('comment.created')
  @OnEvent('follow.created')
  async onActivity(payload: { userId: string }) {
    await this.evaluateUser(payload.userId);
  }

  async evaluateUser(userId: string) {
    const metrics = await this.computeMetrics(userId);
    const badges = await this.prisma.badge.findMany();
    for (const badge of badges) {
      const def = BADGES.find((d) => d.name === badge.name);
      if (!def) continue;
      const current = metrics[def.metric] ?? 0;
      const unlocked = current >= def.threshold;
      const record = await this.prisma.userBadge.upsert({
        where: { userId_badgeId: { userId, badgeId: badge.id } },
        create: { userId, badgeId: badge.id, unlocked, unlockedAt: unlocked ? new Date() : null, current },
        update: { current },
      });
      if (unlocked && !record.unlockedAt) {
        await this.prisma.userBadge.update({
          where: { id: record.id },
          data: { unlocked: true, unlockedAt: new Date() },
        });
        await this.notifications.createForUser(userId, {
          category: 'BADGE',
          title: `You unlocked the ${badge.name} badge!`,
          body: badge.description,
          iconUrl: null,
          imageUrl: null,
          link: `tvwatchtime://stats`,
          dedupeKey: `badge:${badge.id}`,
          push: true,
        });
      } else if (unlocked && record.unlockedAt) {
        // already unlocked
      }
    }
  }

  private async computeMetrics(userId: string) {
    const [episodes, movies, ratings, comments, follows, marathons] = await Promise.all([
      this.prisma.watchHistory.count({ where: { userId, mediaType: MediaType.SHOW } }),
      this.prisma.watchHistory.count({ where: { userId, mediaType: MediaType.MOVIE } }),
      this.prisma.rating.count({ where: { userId, episodeId: { not: null } } }),
      this.prisma.comment.count({ where: { userId } }),
      this.prisma.follow.count({ where: { followerId: userId } }),
      this.biggestMarathon(userId),
    ]);
    return {
      episodes,
      movies,
      ratings,
      comments,
      follows,
      marathon: marathons,
      days_active: 1,
    };
  }

  private async biggestMarathon(userId: string): Promise<number> {
    const rows = await this.prisma.watchHistory.findMany({ where: { userId, mediaType: MediaType.SHOW }, select: { watchedAt: true } });
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const key = new Date(r.watchedAt).toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) || 0) + 1);
    }
    return Math.max(0, ...byDay.values());
  }

  async listAll() {
    return this.prisma.badge.findMany({ orderBy: { category: 'asc' } });
  }

  async listMine(userId: string) {
    const badges = await this.prisma.badge.findMany({
      include: { userBadges: { where: { userId } } },
    });
    const totalUnlocked = await this.prisma.userBadge.count({ where: { userId, unlocked: true } });
    return {
      badges: badges.map((b) => {
        const ub = b.userBadges[0];
        return {
          id: b.id,
          category: b.category,
          name: b.name,
          description: b.description,
          icon: b.icon,
          iconColor: b.iconColor,
          unlockCondition: b.unlockCondition,
          threshold: b.threshold,
          unlocked: ub?.unlocked ?? false,
          unlockedAt: ub?.unlockedAt?.toISOString() ?? null,
          progress: b.threshold ? Math.min(1, (ub?.current ?? 0) / b.threshold) : 0,
          current: ub?.current ?? 0,
          target: b.threshold ?? null,
        };
      }),
      totalUnlocked,
      totalBadges: badges.length,
    };
  }
}
