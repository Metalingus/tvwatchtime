import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { DiscoveryService } from '../media-metadata/discovery.service';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly discovery: DiscoveryService,
  ) {}

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
    const items = await this.discovery.fetchListDtos(rows.map((r) => r.mediaId), userId);
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
    const items = await this.discovery.fetchListDtos(rows.map((r) => r.mediaId), userId);
    return paginate(items, page, pageSize, total);
  }
}
