import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ListVisibility, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { NotificationService } from '../notifications/notification.service';

@Injectable()
export class ListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly canonicalization?: MediaCanonicalizationService,
  ) {}

  private async canonicalMediaId(mediaId: string) {
    return this.canonicalization?.resolveMediaId(mediaId) ?? mediaId;
  }

  /**
   * Show/movie item counts for MANY lists in one GROUP BY query — replaces the
   * 2 COUNT queries per list that made /lists cost 4N+ queries.
   */
  private async itemCountsByType(listIds: string[]) {
    const map = new Map<string, { shows: number; movies: number }>();
    if (!listIds.length) return map;
    const rows = await this.prisma.$queryRaw<{ listId: string; type: string; c: number }[]>`
      SELECT cli.list_id AS "listId", m.type, COUNT(*)::int AS c
      FROM custom_list_items cli
      JOIN media_items m ON m.id = cli.media_id
      WHERE cli.list_id IN (${Prisma.join(listIds)})
        AND NOT EXISTS (
          SELECT 1 FROM media_canonical_links mcl
          WHERE mcl.source_media_id = cli.media_id
            AND mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
        )
      GROUP BY cli.list_id, m.type
    `;
    for (const r of rows) {
      const e = map.get(r.listId) ?? { shows: 0, movies: 0 };
      if (r.type === 'SHOW') e.shows = r.c;
      else if (r.type === 'MOVIE') e.movies = r.c;
      map.set(r.listId, e);
    }
    return map;
  }

  private async getCover(listId: string): Promise<string | null> {
    const items = await this.prisma.customListItem.findMany({
      where: {
        listId,
        media: {
          OR: [
            { canonicalSource: { is: null } },
            { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
          ],
        },
      },
      include: { media: { select: { posterUrl: true, backdropUrl: true } } },
      take: 20,
    });
    if (!items.length) return null;
    const random = items[Math.floor(Math.random() * items.length)];
    return random.media?.backdropUrl || random.media?.posterUrl || null;
  }

  private async formatList(list: any, userId?: string) {
    const [showCount, movieCount, likeCount, subCount] = await Promise.all([
      this.prisma.customListItem
        .count({
          where: {
            listId: list.id,
            media: {
              type: 'SHOW',
              OR: [
                { canonicalSource: { is: null } },
                { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
              ],
            },
          },
        })
        .catch(() => 0),
      this.prisma.customListItem
        .count({
          where: {
            listId: list.id,
            media: {
              type: 'MOVIE',
              OR: [
                { canonicalSource: { is: null } },
                { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
              ],
            },
          },
        })
        .catch(() => 0),
      this.prisma.listLike.count({ where: { listId: list.id } }).catch(() => 0),
      this.prisma.listSubscription.count({ where: { listId: list.id } }).catch(() => 0),
    ]);

    let isLiked = false;
    let isSubscribed = false;
    let notifyOnAdd = false;
    if (userId) {
      try {
        const [like, sub] = await Promise.all([
          this.prisma.listLike.findUnique({
            where: { userId_listId: { userId, listId: list.id } },
          }),
          this.prisma.listSubscription.findUnique({
            where: { userId_listId: { userId, listId: list.id } },
          }),
        ]);
        isLiked = !!like;
        isSubscribed = !!sub;
        notifyOnAdd = sub?.notifyOnAdd ?? false;
      } catch {}
    }

    return {
      id: list.id,
      title: list.title,
      description: list.description,
      coverUrl: list.coverUrl,
      visibility: list.visibility,
      ownerId: list.userId,
      ownerUsername: list.user?.username ?? null,
      ownerAvatar: list.user?.profile?.avatarUrl ?? null,
      showCount,
      movieCount,
      likeCount,
      subCount,
      isLiked,
      isSubscribed,
      notifyOnAdd,
      isOwner: userId === list.userId,
      createdAt: list.createdAt?.toISOString(),
      updatedAt: list.updatedAt?.toISOString(),
    };
  }

  async list(userId: string, mediaId?: string) {
    if (mediaId) mediaId = await this.canonicalMediaId(mediaId);
    const lists = await this.prisma.customList.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { likes: true, subscriptions: true } },
        items: {
          where: {
            media: {
              OR: [
                { canonicalSource: { is: null } },
                { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
              ],
            },
          },
          take: 1,
          include: { media: { select: { posterUrl: true, backdropUrl: true } } },
        },
      },
    });

    // One GROUP BY for all show/movie counts (was 2 COUNT queries per list).
    const typeCounts = await this.itemCountsByType(lists.map((l) => l.id));
    // Optional membership annotation for the add-to-list picker (media detail ⋯ menu):
    // which of the user's lists already contain this media + the item id for removal.
    const itemIdByList = new Map<string, string>();
    if (mediaId && lists.length) {
      const membership = await this.prisma.customListItem.findMany({
        where: { listId: { in: lists.map((l) => l.id) }, mediaId },
        select: { id: true, listId: true },
      });
      for (const m of membership) itemIdByList.set(m.listId, m.id);
    }
    return lists.map((l) => {
      const c = typeCounts.get(l.id) ?? { shows: 0, movies: 0 };
      const cover =
        l.coverUrl || l.items[0]?.media?.backdropUrl || l.items[0]?.media?.posterUrl || null;
      return {
        id: l.id,
        title: l.title,
        description: l.description,
        coverUrl: cover,
        visibility: l.visibility,
        showCount: c.shows,
        movieCount: c.movies,
        likeCount: l._count.likes,
        subCount: l._count.subscriptions,
        updatedAt: l.updatedAt.toISOString(),
        ...(mediaId
          ? { containsMedia: itemIdByList.has(l.id), itemId: itemIdByList.get(l.id) ?? null }
          : {}),
      };
    });
  }

  async followedLists(userId: string) {
    const subs = await this.prisma.listSubscription.findMany({
      where: { userId },
      include: {
        list: {
          include: {
            user: { include: { profile: true } },
            _count: { select: { items: true, likes: true, subscriptions: true } },
            items: {
              where: {
                media: {
                  OR: [
                    { canonicalSource: { is: null } },
                    { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
                  ],
                },
              },
              take: 1,
              include: { media: { select: { posterUrl: true, backdropUrl: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // One GROUP BY for all show/movie counts (was 2 COUNT queries per list).
    const typeCounts = await this.itemCountsByType(subs.map((s) => s.list.id));
    return subs.map((s) => {
      const l = s.list;
      const c = typeCounts.get(l.id) ?? { shows: 0, movies: 0 };
      const cover =
        l.coverUrl || l.items[0]?.media?.backdropUrl || l.items[0]?.media?.posterUrl || null;
      return {
        id: l.id,
        title: l.title,
        description: l.description,
        coverUrl: cover,
        visibility: l.visibility,
        ownerId: l.userId,
        ownerUsername: l.user?.username ?? null,
        showCount: c.shows,
        movieCount: c.movies,
        likeCount: l._count.likes,
        subCount: l._count.subscriptions,
        notifyOnAdd: s.notifyOnAdd,
        updatedAt: l.updatedAt.toISOString(),
      };
    });
  }

  async get(id: string, userId?: string) {
    const list = await this.prisma.customList.findUnique({
      where: { id },
      include: {
        user: { include: { profile: true } },
      },
    });
    if (!list) throw new NotFoundException('List not found');
    if (list.visibility === ListVisibility.PRIVATE && userId !== list.userId) {
      throw new NotFoundException('List not found');
    }
    return this.formatList(list, userId);
  }

  async getItems(id: string, userId: string | undefined, page = 1, pageSize = 20) {
    const list = await this.prisma.customList.findUnique({ where: { id } });
    if (!list) throw new NotFoundException('List not found');
    if (list.visibility === ListVisibility.PRIVATE && userId !== list.userId) {
      throw new NotFoundException('List not found');
    }

    // The route is authenticated, but retain a non-matching sentinel so a future
    // internal caller without a viewer cannot accidentally expose another user's state.
    const viewerId = userId ?? '__no_viewer__';
    const [items, total] = await Promise.all([
      this.prisma.customListItem.findMany({
        where: {
          listId: id,
          media: {
            OR: [
              { canonicalSource: { is: null } },
              { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
            ],
          },
        },
        include: {
          media: {
            include: {
              show: { select: { yearStart: true } },
              movie: { select: { releaseYear: true } },
              watchlist: { where: { userId: viewerId }, select: { id: true } },
              movieStatuses: {
                where: { userId: viewerId },
                select: { watched: true },
              },
            },
          },
        },
        orderBy: { order: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.customListItem.count({
        where: {
          listId: id,
          media: {
            OR: [
              { canonicalSource: { is: null } },
              { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
            ],
          },
        },
      }),
    ]);

    return {
      items: items.map((i) => ({
        id: i.id,
        mediaId: i.mediaId,
        mediaType: i.media.type,
        title: i.media.title,
        posterUrl: i.media.posterUrl,
        backdropUrl: i.media.backdropUrl,
        rating: i.media.rating ?? null,
        inWatchlist: i.media.watchlist.length > 0,
        watched: i.media.type === 'MOVIE' && (i.media.movieStatuses[0]?.watched ?? false),
        year:
          i.media.type === 'SHOW'
            ? (i.media.show?.yearStart ?? null)
            : (i.media.movie?.releaseYear ?? null),
      })),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  async create(
    userId: string,
    dto: { title: string; description?: string; visibility?: string; items?: string[] },
  ) {
    const list = await this.prisma.customList.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description,
        visibility: (dto.visibility as ListVisibility) ?? ListVisibility.PRIVATE,
        ...(dto.items?.length
          ? { items: { create: dto.items.map((mediaId, order) => ({ mediaId, order })) } }
          : {}),
      },
    });

    // Auto-subscribe owner to their own list
    await this.prisma.listSubscription
      .create({
        data: { userId, listId: list.id, notifyOnAdd: false },
      })
      .catch(() => {});

    // Set cover from first item
    if (dto.items?.length) {
      const cover = await this.getCover(list.id);
      if (cover)
        await this.prisma.customList.update({ where: { id: list.id }, data: { coverUrl: cover } });
    }

    return this.get(list.id, userId);
  }

  async update(userId: string, id: string, dto: any) {
    const list = await this.prisma.customList.findUnique({ where: { id } });
    if (!list || list.userId !== userId) throw new NotFoundException('List not found');
    await this.prisma.customList.update({ where: { id }, data: dto });
    return this.get(id, userId);
  }

  async remove(userId: string, id: string) {
    await this.prisma.customList.deleteMany({ where: { id, userId } });
    return { ok: true };
  }

  async addItem(userId: string, id: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const list = await this.prisma.customList.findUnique({ where: { id } });
    if (!list || list.userId !== userId) throw new NotFoundException('List not found');

    const item = await this.prisma.customListItem.upsert({
      where: { listId_mediaId: { listId: id, mediaId } },
      create: { listId: id, mediaId },
      update: {},
    });

    // Update cover if none set
    if (!list.coverUrl) {
      const cover = await this.getCover(id);
      if (cover) await this.prisma.customList.update({ where: { id }, data: { coverUrl: cover } });
    }

    // Notify subscribers with bell ON
    const subs = await this.prisma.listSubscription.findMany({
      where: { listId: id, notifyOnAdd: true, userId: { not: userId } },
    });
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: { title: true, posterUrl: true },
    });
    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    for (const sub of subs) {
      await this.notifications
        .createForUser(sub.userId, {
          category: 'LIST_UPDATE' as any,
          title: `${list.title} updated`,
          body: `${owner?.username} added ${media?.title} to the list`,
          imageUrl: media?.posterUrl ?? null,
          link: `tvwatchtime://list/${id}`,
          dedupeKey: `list:${id}:${mediaId}`,
          push: true,
        })
        .catch(() => {});
    }

    return { ok: true, itemId: item.id };
  }

  async removeItem(userId: string, id: string, itemId: string) {
    await this.prisma.customListItem.deleteMany({ where: { id: itemId, list: { userId } } });
    return { ok: true };
  }

  async toggleLike(userId: string, id: string) {
    const existing = await this.prisma.listLike.findUnique({
      where: { userId_listId: { userId, listId: id } },
    });
    if (existing) {
      await this.prisma.listLike.delete({ where: { id: existing.id } });
      return { liked: false };
    }
    await this.prisma.listLike.create({ data: { userId, listId: id } }).catch(() => {});
    return { liked: true };
  }

  async toggleSubscribe(userId: string, id: string) {
    const existing = await this.prisma.listSubscription.findUnique({
      where: { userId_listId: { userId, listId: id } },
    });
    if (existing) {
      await this.prisma.listSubscription.delete({ where: { id: existing.id } });
      return { subscribed: false };
    }
    await this.prisma.listSubscription
      .create({ data: { userId, listId: id, notifyOnAdd: false } })
      .catch(() => {});
    return { subscribed: true };
  }

  async toggleNotify(userId: string, id: string) {
    const sub = await this.prisma.listSubscription.findUnique({
      where: { userId_listId: { userId, listId: id } },
    });
    if (!sub) throw new NotFoundException('Not subscribed to this list');
    const updated = await this.prisma.listSubscription.update({
      where: { id: sub.id },
      data: { notifyOnAdd: !sub.notifyOnAdd },
    });
    return { notifyOnAdd: updated.notifyOnAdd };
  }
}
