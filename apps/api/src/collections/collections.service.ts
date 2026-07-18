import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { DiscoveryService } from '../media-metadata/discovery.service';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly redis: RedisService,
    private readonly discovery: DiscoveryService,
  ) { }

  /**
   * Watch-next / upcoming caches are language-suffixed per user
   * (watchnext:userId:<lang>, upcoming:userId:<lang>) and both include
   * watchlist-driven entries — bust every locale variant on any watchlist
   * change, otherwise removed shows linger in the cached payloads.
   * (Same pattern as TrackingService.invalidateUserCache.)
   */
  private async invalidateUserLibraryCaches(userId: string) {
    await Promise.all([
      this.redis.delByPattern(`watchnext:${userId}:*`),
      this.redis.delByPattern(`upcoming:${userId}:*`),
      this.redis.del(`watchnext:${userId}`),
      this.redis.del(`upcoming:${userId}`),
    ]);
  }

  // ---------------- Watchlist ----------------
  async addWatchlist(userId: string, mediaId: string) {
    const media = await this.prisma.mediaItem.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    await this.prisma.watchlistItem
      .upsert({ where: { userId_mediaId: { userId, mediaId } }, create: { userId, mediaId }, update: {} });
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { addedCount: { increment: 1 } },
    });
    // Re-adding a show un-drops it (resurfaces it in watch-next / upcoming).
    if (media.type === MediaType.SHOW) {
      await this.prisma.userShowStatus.updateMany({
        where: { userId, mediaId, dropped: true },
        data: { dropped: false },
      });
    }
    await this.invalidateUserLibraryCaches(userId);
    this.events.emit('watchlist.added', { userId, mediaId, mediaType: media.type });
    return { inWatchlist: true };
  }

  async removeWatchlist(userId: string, mediaId: string) {
    const existing = await this.prisma.watchlistItem.deleteMany({
      where: { userId, mediaId },
    });
    if (existing.count > 0) {
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: { addedCount: { decrement: 1 } },
      });
      // Removing a show from the watchlist marks it "dropped": watch history is
      // kept, but the show is hidden from watch-next / upcoming until it is
      // re-added to the watchlist or an episode is watched again.
      await this.prisma.userShowStatus.updateMany({
        where: { userId, mediaId, dropped: false },
        data: { dropped: true },
      });
      await this.invalidateUserLibraryCaches(userId);
    }
    return { inWatchlist: false };
  }

  async watchlist(userId: string, type?: MediaType, page = 1, pageSize = 20) {
    const where = { userId, ...(type ? { media: { type } } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.watchlistItem.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.watchlistItem.count({ where }),
    ]);
    // Lite cards: clients only render poster/title/progress, even at pageSize=500.
    const items = await this.discovery.fetchCardDtos(rows.map((r) => r.mediaId), userId, pageSize);
    return paginate(items, page, pageSize, total);
  }

  // ---------------- Favorites ----------------
  async addFavorite(userId: string, mediaId: string) {
    const media = await this.prisma.mediaItem.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    await this.prisma.favorite.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId },
      update: {},
    });
    this.events.emit('favorite.added', { userId, mediaId, mediaType: media.type });
    return { favorite: true };
  }

  async removeFavorite(userId: string, mediaId: string) {
    await this.prisma.favorite.deleteMany({ where: { userId, mediaId } });
    return { favorite: false };
  }

  async favorites(userId: string, type: MediaType, page = 1, pageSize = 20) {
    const where = { userId, media: { type } };
    const [rows, total] = await Promise.all([
      this.prisma.favorite.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.favorite.count({ where }),
    ]);
    // Lite cards: clients only render poster/title/progress, even at pageSize=500.
    const items = await this.discovery.fetchCardDtos(rows.map((r) => r.mediaId), userId, pageSize);
    return paginate(items, page, pageSize, total);
  }
}
