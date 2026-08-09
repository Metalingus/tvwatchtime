import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ListSource, NotificationCategory, Prisma } from '@prisma/client';
import { FeedItemDto, FeedPageDto } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';

const CANONICAL_VISIBLE_MEDIA = {
  OR: [
    { canonicalSource: { is: null } },
    { canonicalSource: { is: { status: { not: 'ACTIVE' as const } } } },
  ],
} satisfies Prisma.MediaItemWhereInput;

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
      where: { userId, media: CANONICAL_VISIBLE_MEDIA },
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
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    return u?.username ?? 'someone';
  }

  // ---- Activity feed (GET /feed) ----

  /** Encode/decode the (timestamp, id) cursor — newest-first pagination. */
  private encodeFeedCursor(time: Date, id: string) {
    return Buffer.from(JSON.stringify([time.getTime(), id])).toString('base64url');
  }

  private decodeFeedCursor(cursor: string): { time: Date; id: string } {
    try {
      const [ms, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (typeof ms !== 'number' || typeof id !== 'string') throw new Error('bad shape');
      return { time: new Date(ms), id };
    } catch {
      throw new BadRequestException('Invalid feed cursor');
    }
  }

  /**
   * Unified activity feed: the viewer + everyone they follow, merged across the
   * live activity tables (watch history, watchlist, favorites, ratings, reactions,
   * comments). Import-sourced rows (bulk imports) are excluded — they aren't
   * "activity". Merged in memory and cursor-paginated by (timestamp, id), newest
   * first. The dormant Activity model is intentionally NOT used.
   */
  async getFeed(
    userId: string,
    cursor?: string,
    limit = 20,
    audienceOverride?: string[],
  ): Promise<FeedPageDto> {
    const lim = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
    const cur = cursor ? this.decodeFeedCursor(cursor) : null;

    // Audience: self + followings, minus users the viewer blocked (same rule as
    // the comments feed). Followings' comments are public on media pages, so
    // private profiles don't hide feed rows.
    const [follows, blocked] = audienceOverride
      ? [[], []]
      : await Promise.all([
          this.prisma.follow.findMany({
            where: { followerId: userId },
            select: { targetId: true },
          }),
          this.prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
        ]);
    const blockedIds = new Set(blocked.map((b) => b.blockedId));
    const audience =
      audienceOverride ??
      [userId, ...follows.map((f) => f.targetId)].filter((id) => !blockedIds.has(id));

    const take = lim + 1;
    // lte (not lt) at the DB level: rows sharing the cursor's exact timestamp are
    // filtered by id in memory below (strict (time, id) ordering).
    const before = cur ? { lte: cur.time } : undefined;
    const manualOnly = { OR: [{ source: ListSource.MANUAL }, { source: null }] };
    const mediaInclude = { show: true, movie: true } as const;
    const activeCanonicalSourceIds = (
      await this.prisma.mediaCanonicalLink.findMany({
        where: { status: 'ACTIVE' },
        select: { sourceMediaId: true },
      })
    ).map((row) => row.sourceMediaId);

    const [history, watchlist, favorites, ratings, reactions, commentIdRows] = await Promise.all([
      this.prisma.watchHistory.findMany({
        where: {
          userId: { in: audience },
          media: CANONICAL_VISIBLE_MEDIA,
          ...(before ? { watchedAt: before } : {}),
        },
        orderBy: { watchedAt: 'desc' },
        take,
        include: { media: { include: mediaInclude } },
      }),
      this.prisma.watchlistItem.findMany({
        where: {
          userId: { in: audience },
          media: CANONICAL_VISIBLE_MEDIA,
          ...(before ? { createdAt: before } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
        include: { media: { include: mediaInclude } },
      }),
      this.prisma.favorite.findMany({
        where: {
          userId: { in: audience },
          media: CANONICAL_VISIBLE_MEDIA,
          ...(before ? { createdAt: before } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
        include: { media: { include: mediaInclude } },
      }),
      this.prisma.rating.findMany({
        where: {
          userId: { in: audience },
          ...manualOnly,
          AND: [
            {
              OR: [
                {
                  mediaId: {
                    not: null,
                    ...(activeCanonicalSourceIds.length ? { notIn: activeCanonicalSourceIds } : {}),
                  },
                },
                {
                  episodeId: { not: null },
                  episode: { season: { show: { media: CANONICAL_VISIBLE_MEDIA } } },
                },
              ],
            },
          ],
          ...(before ? { createdAt: before } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.reaction.findMany({
        where: {
          userId: { in: audience },
          ...manualOnly,
          AND: [
            {
              OR: [
                {
                  mediaId: {
                    not: null,
                    ...(activeCanonicalSourceIds.length ? { notIn: activeCanonicalSourceIds } : {}),
                  },
                },
                {
                  episodeId: { not: null },
                  episode: { season: { show: { media: CANONICAL_VISIBLE_MEDIA } } },
                },
              ],
            },
          ],
          ...(before ? { createdAt: before } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT c.id
        FROM comments c
        WHERE c.user_id IN (${Prisma.join(audience)})
          AND (c.source = 'MANUAL'::"ListSource" OR c.source IS NULL)
          AND c.thread_type IN (
            'SHOW'::"CommentThreadType",
            'MOVIE'::"CommentThreadType",
            'EPISODE'::"CommentThreadType"
          )
          AND c.parent_id IS NULL
          AND c.external_review_id IS NULL
          AND c.hidden = false
          AND c.admin_deleted = false
          AND c.deleted_by_user = false
          ${before ? Prisma.sql`AND c.created_at <= ${before.lte}` : Prisma.empty}
          AND NOT EXISTS (
            SELECT 1
            FROM media_canonical_links mcl
            WHERE mcl.status = 'ACTIVE'::"MediaCanonicalStatus"
              AND (
                (c.thread_type = 'SHOW'::"CommentThreadType" AND mcl.source_media_id = c.thread_id)
                OR (
                  c.thread_type = 'EPISODE'::"CommentThreadType"
                  AND EXISTS (
                    SELECT 1 FROM media_canonical_copies mcc
                    WHERE mcc.link_id = mcl.id
                      AND mcc.entity_type = 'EPISODE'
                      AND mcc.source_id = c.thread_id
                  )
                )
              )
          )
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${take}
      `),
    ]);
    const commentIds = commentIdRows.map((row) => row.id);
    const comments = commentIds.length
      ? await this.prisma.comment.findMany({
          where: { id: { in: commentIds } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : [];

    // Resolve media for the sources without a media relation (ratings, reactions,
    // comments): direct media ids plus episode-scoped rows via episode → season → show.
    const mediaIds = new Set<string>();
    const episodeIds = new Set<string>();
    for (const r of ratings) {
      if (r.mediaId) mediaIds.add(r.mediaId);
      else if (r.episodeId) episodeIds.add(r.episodeId);
    }
    for (const r of reactions) {
      if (r.mediaId) mediaIds.add(r.mediaId);
      else if (r.episodeId) episodeIds.add(r.episodeId);
    }
    for (const c of comments) {
      if (c.threadType === 'EPISODE') episodeIds.add(c.threadId);
      else mediaIds.add(c.threadId);
    }

    const [extraMedia, episodes, users] = await Promise.all([
      mediaIds.size
        ? this.prisma.mediaItem.findMany({
            where: { id: { in: [...mediaIds] }, ...CANONICAL_VISIBLE_MEDIA },
            include: mediaInclude,
          })
        : [],
      episodeIds.size
        ? this.prisma.episode.findMany({
            where: {
              id: { in: [...episodeIds] },
              season: { show: { media: CANONICAL_VISIBLE_MEDIA } },
            },
            include: {
              season: { include: { show: { include: { media: { include: mediaInclude } } } } },
            },
          })
        : [],
      this.prisma.user.findMany({
        where: { id: { in: audience } },
        select: {
          id: true,
          username: true,
          profile: { select: { displayName: true, avatarUrl: true } },
        },
      }),
    ]);

    type MediaRow = {
      id: string;
      type: 'SHOW' | 'MOVIE';
      title: string;
      posterUrl: string | null;
      show: { yearStart: number | null } | null;
      movie: { releaseYear: number | null } | null;
    };
    const mediaById = new Map<string, MediaRow>();
    const toFeedMedia = (m: MediaRow): FeedItemDto['media'] => ({
      id: m.id,
      type: m.type,
      title: m.title,
      posterUrl: m.posterUrl,
      year: m.type === 'SHOW' ? (m.show?.yearStart ?? null) : (m.movie?.releaseYear ?? null),
    });
    for (const m of extraMedia) mediaById.set(m.id, m as MediaRow);
    for (const h of history) mediaById.set(h.media.id, h.media as MediaRow);
    for (const w of watchlist) mediaById.set(w.media.id, w.media as MediaRow);
    for (const f of favorites) mediaById.set(f.media.id, f.media as MediaRow);

    const episodeById = new Map(
      episodes.map((e) => [
        e.id,
        {
          seasonNumber: e.season.number,
          episodeNumber: e.number,
          media: e.season.show.media as MediaRow,
        },
      ]),
    );
    const userById = new Map(
      users.map((u) => [
        u.id,
        {
          id: u.id,
          username: u.username,
          displayName: u.profile?.displayName ?? null,
          avatarUrl: u.profile?.avatarUrl ?? null,
        },
      ]),
    );

    // Merge all sources into candidate feed items (media must resolve, else skip).
    const candidates: { id: string; userId: string; time: Date; item: FeedItemDto }[] = [];
    const push = (
      prefix: string,
      rowId: string,
      rowUserId: string,
      time: Date,
      build: (base: FeedItemDto) => void,
      media?: MediaRow | null,
    ) => {
      const user = userById.get(rowUserId);
      if (!user || !media) return;
      const item: FeedItemDto = {
        id: `${prefix}:${rowId}`,
        user,
        type: 'WATCHED',
        media: toFeedMedia(media),
        createdAt: time.toISOString(),
      };
      build(item);
      candidates.push({ id: item.id, userId: rowUserId, time, item });
    };

    for (const h of history) {
      push(
        'wh',
        h.id,
        h.userId,
        h.watchedAt,
        (item) => {
          item.type = 'WATCHED';
          if (h.mediaType === 'SHOW' && h.seasonNumber != null && h.episodeNumber != null)
            item.detail = { seasonNumber: h.seasonNumber, episodeNumber: h.episodeNumber };
        },
        h.media as MediaRow,
      );
    }
    for (const w of watchlist) {
      push(
        'wl',
        w.id,
        w.userId,
        w.createdAt,
        (item) => {
          item.type = 'WATCHLISTED';
        },
        w.media as MediaRow,
      );
    }
    for (const f of favorites) {
      push(
        'fav',
        f.id,
        f.userId,
        f.createdAt,
        (item) => {
          item.type = 'FAVORITED';
        },
        f.media as MediaRow,
      );
    }
    for (const r of ratings) {
      const ep = r.episodeId ? episodeById.get(r.episodeId) : undefined;
      const media = r.mediaId ? mediaById.get(r.mediaId) : ep?.media;
      push(
        'rat',
        r.id,
        r.userId,
        r.createdAt,
        (item) => {
          item.type = 'RATED';
          item.detail = {
            rating: r.rating,
            ...(ep ? { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber } : {}),
          };
        },
        media,
      );
    }
    for (const r of reactions) {
      const ep = r.episodeId ? episodeById.get(r.episodeId) : undefined;
      const media = r.mediaId ? mediaById.get(r.mediaId) : ep?.media;
      push(
        'rea',
        r.id,
        r.userId,
        r.createdAt,
        (item) => {
          item.type = 'REACTED';
          item.detail = {
            reaction: r.reaction,
            ...(ep ? { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber } : {}),
          };
        },
        media,
      );
    }
    for (const c of comments) {
      const ep = c.threadType === 'EPISODE' ? episodeById.get(c.threadId) : undefined;
      const media = c.threadType === 'EPISODE' ? ep?.media : mediaById.get(c.threadId);
      push(
        'com',
        c.id,
        c.userId,
        c.createdAt,
        (item) => {
          item.type = 'COMMENTED';
          if (c.isSpoiler) {
            // Spoiler: the excerpt is masked server-side; clients render the spoiler treatment.
            item.spoiler = true;
            item.detail = {
              commentId: c.id,
              ...(ep ? { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber } : {}),
            };
            return;
          }
          const excerpt = c.body.trim().slice(0, 140);
          const detail: FeedItemDto['detail'] = {
            commentId: c.id,
            ...(excerpt ? { excerpt } : {}),
            ...(ep ? { seasonNumber: ep.seasonNumber, episodeNumber: ep.episodeNumber } : {}),
          };
          item.detail = detail;
        },
        media,
      );
    }

    // Strict (time, id) cursor filter, newest-first sort, page slice.
    const filtered = cur
      ? candidates.filter(
          (c) => c.time < cur.time || (c.time.getTime() === cur.time.getTime() && c.id < cur.id),
        )
      : candidates;
    filtered.sort((a, b) =>
      a.time.getTime() === b.time.getTime()
        ? b.id < a.id
          ? -1
          : 1
        : b.time.getTime() - a.time.getTime(),
    );
    const page = filtered.slice(0, lim);
    const last = page[page.length - 1];
    return {
      items: page.map((p) => p.item),
      ...(filtered.length > lim && last
        ? { nextCursor: this.encodeFeedCursor(last.time, last.id) }
        : {}),
    };
  }

  async getUserFeed(
    viewerId: string,
    username: string,
    cursor?: string,
    limit = 20,
  ): Promise<FeedPageDto> {
    const target = await this.prisma.user.findFirst({
      where: { username: username.trim() },
      select: { id: true, profile: { select: { isPrivate: true } } },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.profile?.isPrivate && viewerId !== target.id) {
      const following = await this.prisma.follow.findUnique({
        where: { followerId_targetId: { followerId: viewerId, targetId: target.id } },
        select: { followerId: true },
      });
      if (!following) throw new ForbiddenException('This profile is private');
    }
    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: target.id },
          { blockerId: target.id, blockedId: viewerId },
        ],
      },
      select: { id: true },
    });
    if (blocked) throw new ForbiddenException('Profile unavailable');
    return this.getFeed(viewerId, cursor, limit, [target.id]);
  }
}
