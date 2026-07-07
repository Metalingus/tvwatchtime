import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationCategory } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';

@Injectable()
export class SocialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly notifications: NotificationService,
  ) {}

  async follow(followerId: string, targetId: string) {
    if (followerId === targetId) return { following: false };
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return { following: false };
    try {
      await this.prisma.follow.create({ data: { followerId, targetId } });
      await this.notifications.createForUser(targetId, {
        category: NotificationCategory.FOLLOW,
        title: 'You have a new follower',
        body: `${await this.usernameOf(followerId)} followed you`,
        link: `tvwatchtime://user/${await this.usernameOf(followerId)}`,
        dedupeKey: `follow:${followerId}:${targetId}`,
        push: true,
      });
      this.events.emit('follow.created', { userId: followerId });
    } catch {
      // already following
    }
    return { following: true };
  }

  async unfollow(followerId: string, targetId: string) {
    await this.prisma.follow.deleteMany({ where: { followerId, targetId } });
    return { following: false };
  }

  async counts(userId: string) {
    const [followingCount, followersCount] = await Promise.all([
      this.prisma.follow.count({ where: { followerId: userId } }),
      this.prisma.follow.count({ where: { targetId: userId } }),
    ]);
    return { followingCount, followersCount };
  }

  async activity(userId: string, limit = 30) {
    const history = await this.prisma.watchHistory.findMany({
      where: { userId },
      orderBy: { watchedAt: 'desc' },
      take: limit,
      include: { media: true },
    });
    return history.map((h) => ({
      id: h.id,
      type: 'WATCHED' as const,
      text:
        h.mediaType === 'SHOW'
          ? `watched S${h.seasonNumber}E${h.episodeNumber}`
          : 'watched a movie',
      mediaTitle: h.media.title,
      mediaPoster: h.media.posterUrl,
      createdAt: h.watchedAt.toISOString(),
    }));
  }

  private async usernameOf(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    return u?.username ?? 'someone';
  }
}
