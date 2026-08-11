import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { DiscoveryService } from '../media-metadata/discovery.service';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { markPersonalizationDirty } from '../media-metadata/personalization-cache';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly redis: RedisService,
    private readonly discovery: DiscoveryService,
    private readonly canonicalization?: MediaCanonicalizationService,
  ) {}

  private async canonicalMediaId(mediaId: string) {
    return this.canonicalization?.resolveMediaId(mediaId) ?? mediaId;
  }

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
      this.redis.delByPattern(`showsprogress:${userId}:*`),
      // Watchlist membership feeds the for-you exclusion set; favorites feed
      // its affinity — both must recompute on change.
      markPersonalizationDirty(this.redis, userId),
      this.redis.del(`watchnext:${userId}`),
      this.redis.del(`upcoming:${userId}`),
    ]);
  }

  // ---------------- Watchlist ----------------
  async addWatchlist(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const media = await this.prisma.mediaItem.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    await this.prisma.watchlistItem.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId },
      update: {},
    });
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { addedCount: { increment: 1 } },
    });
    // Adding a previously dropped show explicitly restores active tracking.
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
    mediaId = await this.canonicalMediaId(mediaId);
    const existing = await this.prisma.watchlistItem.deleteMany({
      where: { userId, mediaId },
    });
    if (existing.count > 0) {
      await this.prisma.mediaItem.update({
        where: { id: mediaId },
        data: { addedCount: { decrement: 1 } },
      });
      await this.invalidateUserLibraryCaches(userId);
      this.events.emit('watchlist.removed', { userId, mediaId });
    }
    return { inWatchlist: false };
  }

  /**
   * Explicitly drop a title while preserving favorites, custom-list membership, and
   * watch history. A dropped show stays watchlisted but moves into its own inactive
   * library state. Movies have no equivalent progress bucket yet, so their legacy
   * drop behavior still removes them from the watchlist.
   */
  async dropMedia(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const media = await this.prisma.mediaItem.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');

    if (media.type === MediaType.SHOW) {
      const [, watchlist] = await Promise.all([
        this.prisma.userShowStatus.upsert({
          where: { userId_mediaId: { userId, mediaId } },
          create: { userId, mediaId, dropped: true },
          update: { dropped: true, pausedAt: null },
        }),
        this.prisma.watchlistItem.findUnique({
          where: { userId_mediaId: { userId, mediaId } },
          select: { id: true },
        }),
      ]);
      await this.invalidateUserLibraryCaches(userId);
      return { dropped: true, inWatchlist: !!watchlist };
    }

    let removedFromWatchlist = false;
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.watchlistItem.deleteMany({ where: { userId, mediaId } });
      removedFromWatchlist = existing.count > 0;
      if (existing.count > 0) {
        await tx.mediaItem.update({
          where: { id: mediaId },
          data: { addedCount: { decrement: 1 } },
        });
      }
    });

    await this.invalidateUserLibraryCaches(userId);
    if (removedFromWatchlist) this.events.emit('watchlist.removed', { userId, mediaId });
    return { dropped: true, inWatchlist: false };
  }

  /** Restore a dropped show to its normal progress bucket. Watchlist membership is
   * preserved exactly as-is so legacy dropped rows do not silently gain membership. */
  async restoreDroppedShow(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    await this.prisma.userShowStatus.updateMany({
      where: { userId, mediaId, dropped: true },
      data: { dropped: false },
    });
    await this.invalidateUserLibraryCaches(userId);
    return { dropped: false };
  }

  // ---------------- Tracking pause ----------------
  /** Pause tracking: hidden from watch-next/upcoming, no episode/watchlist
   *  notifications. Idempotent; the row is upserted because watchlist-only shows
   *  (never watched) may not have a UserShowStatus row yet. */
  async pauseTracking(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const media = await this.prisma.mediaItem.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    if (media.type !== MediaType.SHOW) throw new BadRequestException('Only shows can be paused');
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, pausedAt: new Date(), dropped: false },
      update: { pausedAt: new Date(), dropped: false },
    });
    await this.invalidateUserLibraryCaches(userId);
    return { trackingPaused: true };
  }

  async resumeTracking(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    await this.prisma.userShowStatus.updateMany({
      where: { userId, mediaId, pausedAt: { not: null } },
      data: { pausedAt: null },
    });
    await this.invalidateUserLibraryCaches(userId);
    return { trackingPaused: false };
  }

  async watchlist(
    userId: string,
    type?: MediaType,
    page = 1,
    pageSize = 20,
    genre?: string,
    unwatchedOnly = false,
  ) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 100));
    const genreFilter = genre?.trim()
      ? {
          genres: {
            some: { genre: { slug: { equals: genre.trim(), mode: 'insensitive' as const } } },
          },
        }
      : {};
    const mediaWhere = {
      OR: [
        { canonicalSource: { is: null } },
        { canonicalSource: { is: { status: { not: 'ACTIVE' as const } } } },
      ],
      ...(type ? { type } : {}),
      ...genreFilter,
      ...(unwatchedOnly && type === MediaType.MOVIE
        ? { movieStatuses: { none: { userId, watched: true } } }
        : {}),
    };
    const where = { userId, ...(Object.keys(mediaWhere).length ? { media: mediaWhere } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.watchlistItem.findMany({
        where,
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.watchlistItem.count({ where }),
    ]);
    // Lite cards: clients only render poster/title/progress.
    const items = await this.discovery.fetchCardDtos(
      rows.map((r) => r.mediaId),
      userId,
      safePageSize,
    );
    return paginate(items, safePage, safePageSize, total);
  }

  // ---------------- Favorites ----------------
  async addFavorite(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const media = await this.prisma.mediaItem.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');
    await this.prisma.favorite.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId },
      update: {},
    });
    this.events.emit('favorite.added', { userId, mediaId, mediaType: media.type });
    await this.invalidateUserLibraryCaches(userId);
    return { favorite: true };
  }

  async removeFavorite(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const existing = await this.prisma.favorite.deleteMany({ where: { userId, mediaId } });
    await this.invalidateUserLibraryCaches(userId);
    if (existing.count > 0) this.events.emit('favorite.removed', { userId, mediaId });
    return { favorite: false };
  }

  async favorites(userId: string, type: MediaType, page = 1, pageSize = 20, genre?: string) {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 100));
    const genreFilter = genre?.trim()
      ? {
          genres: {
            some: { genre: { slug: { equals: genre.trim(), mode: 'insensitive' as const } } },
          },
        }
      : {};
    const where = {
      userId,
      media: {
        type,
        ...genreFilter,
        OR: [
          { canonicalSource: { is: null } },
          { canonicalSource: { is: { status: { not: 'ACTIVE' as const } } } },
        ],
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.favorite.findMany({
        where,
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.favorite.count({ where }),
    ]);
    // Lite cards: clients only render poster/title/progress.
    const items = await this.discovery.fetchCardDtos(
      rows.map((r) => r.mediaId),
      userId,
      safePageSize,
    );
    return paginate(items, safePage, safePageSize, total);
  }
}
