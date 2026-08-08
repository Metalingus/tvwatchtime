import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CommentThreadType, ListVisibility, NotificationCategory, Prisma } from '@prisma/client';
import { COMMENT_SPOILER_THRESHOLD } from '@tvwatch/shared';
import { ExternalReviewsService } from '../media-metadata/external-reviews.service';
import { isCommunityGroupId } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { mapPublicUser } from '../common/utils/mapper.util';
import { localized } from '../common/utils/localization.util';
import { paginate } from '../common/dto/pagination.dto';
import { NotificationService } from '../notifications/notification.service';
import { CommentImageService } from '../comment-images/comment-image.service';
import {
  CommentQueryDto,
  CreateCommentDto,
  RepliesQueryDto,
  UpdateCommentDto,
  isAllowedGiphyUrl,
  type CommentSort,
} from './dto/comment.dto';
import { TranslationService } from './translation.service';

/** Hard cap on reply nesting depth (top-level = 0) to prevent pathological threads. */
export const MAX_COMMENT_DEPTH = 25;

/** Children previewed per parent when a thread is fetched with depth=2. */
export const CHILD_PREVIEW_LIMIT = 10;

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly notifications: NotificationService,
    private readonly commentImages: CommentImageService,
    private readonly externalReviews?: ExternalReviewsService,
    @Optional() private readonly translations?: TranslationService,
  ) {}

  async list(userId: string, q: CommentQueryDto) {
    // Get blocked user IDs to filter out their comments
    const blocked = await this.prisma.block.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
    });
    const blockedIds = blocked.map((b) => b.blockedId);

    const where: any = {
      threadType: q.threadType,
      threadId: q.threadId,
      parentId: null,
      // Review replies behave like comment replies: they live INSIDE the review card,
      // never as top-level posts in the main feed (list + count stay clean).
      externalReviewId: null,
      hidden: false,
      adminDeleted: false,
      ...(blockedIds.length ? { userId: { notIn: blockedIds } } : {}),
    };
    const orderBy =
      q.resolvedSort === 'MOST_LIKED'
        ? { likesCount: 'desc' as const }
        : { createdAt: 'desc' as const };
    const page = q.page || 1;
    const pageSize = q.pageSize || 20;
    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { include: { profile: true } }, image: true },
      }),
      this.prisma.comment.count({ where }),
    ]);

    const authorIds = [...new Set(rows.map((r) => r.userId))];
    const counts = await this.authorCounts(authorIds);
    const likedIds = await this.likedIds(
      userId,
      rows.map((r) => r.id),
    );
    const spoilerReportedIds = await this.spoilerReportedIds(
      userId,
      rows.map((r) => r.id),
    );
    const mediaMap = await this.mediaRefs(rows.map((r) => r.mediaId).filter(Boolean) as string[]);
    const listMap = await this.listRefs(rows.map((r) => r.listId).filter(Boolean) as string[]);

    const items = rows.map((r) =>
      this.toDto(
        r,
        counts.get(r.userId)!,
        likedIds.has(r.id),
        {
          media: r.mediaId ? mediaMap.get(r.mediaId) : null,
          list: r.listId ? listMap.get(r.listId) : null,
        },
        spoilerReportedIds.has(r.id),
      ),
    );

    // Display context (title label + navigation ids) for the whole thread — the feed
    // header renders this instead of a generic "Comments" title.
    const thread =
      (
        await this.threadContexts([
          { id: 'thread', threadType: q.threadType, threadId: q.threadId },
        ])
      ).get('thread') ?? null;

    // TMDB reviews are first-class thread roots in this feed: merge them into the items
    // stream (page 1 only) after the lazy sync, sorted with the comments.
    const reviewable =
      q.threadType === 'SHOW' || q.threadType === 'MOVIE' || q.threadType === 'EPISODE';
    if (page === 1 && reviewable && this.externalReviews) {
      await this.externalReviews
        .ensureFreshForThread(q.threadType, q.threadId)
        .catch(() => undefined);
      const pseudo = await this.reviewPseudoItems(userId, q.threadType, q.threadId);
      if (pseudo.length) {
        const merged = [...items, ...pseudo];
        if (q.resolvedSort === 'MOST_LIKED') {
          merged.sort((a: any, b: any) => (b.likesCount ?? 0) - (a.likesCount ?? 0));
        } else {
          merged.sort(
            (a: any, b: any) => +new Date(b.createdAt as string) - +new Date(a.createdAt as string),
          );
        }
        return { ...paginate(merged, page, pageSize, total), thread };
      }
    }
    return { ...paginate(items, page, pageSize, total), thread };
  }

  async create(userId: string, dto: CreateCommentDto) {
    // Group threads only accept the curated community group slugs.
    if (dto.threadType === CommentThreadType.GROUP && !isCommunityGroupId(dto.threadId)) {
      throw new BadRequestException('Unknown group');
    }
    const canonicalThreadId = dto.threadId;

    // Replies nest to any depth (Reddit-style threads): the parent must exist,
    // live in the SAME thread, and not be a tombstone.
    let parent: any = null;
    if (dto.parentId) {
      parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Parent comment not found');
      if (parent.threadType !== dto.threadType || parent.threadId !== canonicalThreadId) {
        throw new BadRequestException('Reply must belong to the same thread as its parent');
      }
      if ((parent.depth ?? 0) >= MAX_COMMENT_DEPTH) {
        throw new BadRequestException('This thread is too deep to reply to');
      }
      if (parent.deletedByUser) {
        throw new BadRequestException('Cannot reply to a deleted comment');
      }
    }

    // Media card attachment: both fields together, must reference real media.
    const hasMedia = !!(dto.mediaType && dto.mediaId);
    if (!!dto.mediaType !== !!dto.mediaId) {
      throw new BadRequestException('Media attachment requires both mediaType and mediaId');
    }
    if (hasMedia) {
      const media = await this.prisma.mediaItem.findUnique({
        where: { id: dto.mediaId },
        select: { type: true },
      });
      if (!media || media.type !== dto.mediaType) throw new BadRequestException('Unknown media');
    }

    // List card attachment: must exist; only public lists or the commenter's own lists can be shared.
    if (dto.listId) {
      const list = await this.prisma.customList.findUnique({
        where: { id: dto.listId },
        select: { userId: true, visibility: true },
      });
      if (!list) throw new BadRequestException('Unknown list');
      if (list.visibility !== ListVisibility.PUBLIC && list.userId !== userId) {
        throw new ForbiddenException('You can only attach public lists or your own lists');
      }
    }

    // One attachment max per comment: image XOR gif XOR media card XOR list card.
    const attachmentCount =
      (dto.imageUrl ? 1 : 0) + (dto.gifUrl ? 1 : 0) + (hasMedia ? 1 : 0) + (dto.listId ? 1 : 0);
    if (attachmentCount > 1) {
      throw new BadRequestException('A comment can contain only one attachment');
    }

    // A comment must carry text, an uploaded image association, a GIPHY GIF, or a media/list card.
    const hasBody = !!(dto.body && dto.body.trim().length > 0);
    if (!hasBody && attachmentCount === 0) {
      throw new BadRequestException('Comment must contain text, an image, a GIF, or a media card');
    }
    if (dto.gifUrl && !isAllowedGiphyUrl(dto.gifUrl)) {
      throw new BadRequestException('Invalid GIF URL');
    }
    if (dto.externalReviewId && dto.parentId) {
      throw new BadRequestException('A reply can target either a comment or a review, not both');
    }
    if (dto.externalReviewId) {
      const review = await this.prisma.externalReview.findUnique({
        where: { id: dto.externalReviewId },
        select: { id: true },
      });
      if (!review) throw new BadRequestException('Unknown review');
    }

    const comment = await this.prisma.comment.create({
      data: {
        userId,
        parentId: dto.parentId,
        externalReviewId: dto.externalReviewId ?? null,
        depth: parent ? (parent.depth ?? 0) + 1 : 0,
        rootId: parent ? (parent.rootId ?? parent.id) : null,
        threadType: dto.threadType,
        threadId: canonicalThreadId,
        body: dto.body ?? '',
        imageUrl: dto.imageUrl,
        gifUrl: dto.gifUrl,
        mediaType: dto.mediaType,
        mediaId: dto.mediaId,
        listId: dto.listId,
        isSpoiler: !!dto.isSpoiler,
      },
      include: { user: { include: { profile: true } }, image: true },
    });
    if (dto.parentId) {
      await this.prisma.comment.update({
        where: { id: dto.parentId },
        data: { repliesCount: { increment: 1 } },
      });
      if (parent && parent.userId !== userId) {
        await this.notifications.createForUser(parent.userId, {
          category: NotificationCategory.COMMENT_REPLY,
          title: 'New reply to your comment',
          body: comment.body.slice(0, 80),
          link: `tvwatchtime://comment/${dto.parentId}?highlight=${dto.parentId}`,
          dedupeKey: `reply:${comment.id}`,
          push: true,
        });
      }
    }
    this.events.emit('comment.created', { userId });
    const c = (await this.authorCounts([userId])).get(userId)!;
    const mediaMap = await this.mediaRefs(comment.mediaId ? [comment.mediaId] : []);
    const listMap = await this.listRefs(comment.listId ? [comment.listId] : []);
    return this.toDto(comment, c, false, {
      media: comment.mediaId ? mediaMap.get(comment.mediaId) : null,
      list: comment.listId ? listMap.get(comment.listId) : null,
    });
  }

  /** Fetch a single comment by id (for the thread header). */
  async findOne(userId: string, commentId: string) {
    const blocked = await this.prisma.block.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
    });
    const blockedIds = blocked.map((b) => b.blockedId);

    const r = await this.prisma.comment.findUnique({
      where: { id: commentId },
      include: { user: { include: { profile: true } }, image: true },
    });
    if (!r || r.hidden || r.adminDeleted) throw new NotFoundException('Comment not found');
    if (blockedIds.includes(r.userId)) throw new NotFoundException('Comment not found');

    const c = (await this.authorCounts([r.userId])).get(r.userId)!;
    const liked = await this.likedIds(userId, [r.id]);
    const mediaMap = await this.mediaRefs(r.mediaId ? [r.mediaId] : []);
    const listMap = await this.listRefs(r.listId ? [r.listId] : []);
    const dto = this.toDto(r, c, liked.has(r.id), {
      media: r.mediaId ? mediaMap.get(r.mediaId) : null,
      list: r.listId ? listMap.get(r.listId) : null,
    });

    // Thread context (header title) + ancestor chain (root-first) so a deep-linked reply
    // (e.g. from "My Comments") shows its parents and names the thread.
    const context = (await this.threadContexts([r])).get(r.id) ?? null;

    // Review replies: the "parent" is a provider review, not a comment — attach it as a
    // pseudo-comment (kind='review') so the thread page can render it above the reply.
    let review: any = null;
    if (r.externalReviewId) {
      const er = await this.prisma.externalReview.findUnique({
        where: { id: r.externalReviewId },
      });
      if (er) {
        const [erLiked, erReplies] = await Promise.all([
          this.prisma.externalReviewLike.findUnique({
            where: {
              userId_externalReviewId: { userId, externalReviewId: er.id },
            },
          }),
          this.prisma.comment.count({
            where: {
              externalReviewId: er.id,
              deletedByUser: false,
              adminDeleted: false,
              hidden: false,
            },
          }),
        ]);
        review = this.toReviewDto(er, r.threadType, r.threadId, !!erLiked, erReplies);
      }
    }

    const ancestors: any[] = [];
    let cursor = r.parentId;
    const seen = new Set<string>([r.id]);
    while (cursor && ancestors.length < 10 && !seen.has(cursor)) {
      seen.add(cursor);
      const p = await this.prisma.comment.findUnique({
        where: { id: cursor },
        include: { user: { include: { profile: true } }, image: true },
      });
      if (!p || p.hidden || p.adminDeleted) break;
      ancestors.unshift(p);
      cursor = p.parentId;
    }
    if (!ancestors.length) return { ...dto, context, ancestors: [], review };

    const aCounts = await this.authorCounts([...new Set(ancestors.map((a) => a.userId))]);
    const aLiked = await this.likedIds(
      userId,
      ancestors.map((a) => a.id),
    );
    const aSpoiler = await this.spoilerReportedIds(
      userId,
      ancestors.map((a) => a.id),
    );
    const aMedia = await this.mediaRefs(
      ancestors.map((a) => a.mediaId).filter(Boolean) as string[],
    );
    const aLists = await this.listRefs(ancestors.map((a) => a.listId).filter(Boolean) as string[]);
    const ancestorDtos = ancestors.map((a) =>
      this.toDto(
        a,
        aCounts.get(a.userId)!,
        aLiked.has(a.id),
        {
          media: a.mediaId ? aMedia.get(a.mediaId) : null,
          list: a.listId ? aLists.get(a.listId) : null,
        },
        aSpoiler.has(a.id),
      ),
    );
    return { ...dto, context, ancestors: ancestorDtos, review };
  }

  /** Paginated list of the user's own comments (newest first) with thread context labels. */
  async listMine(userId: string, page = 1, pageSize = 20) {
    const where = { userId, deletedByUser: false };
    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { include: { profile: true } }, image: true },
      }),
      this.prisma.comment.count({ where }),
    ]);

    const contextMap = await this.threadContexts(rows);
    const c = (await this.authorCounts([userId])).get(userId)!;
    const liked = await this.likedIds(
      userId,
      rows.map((r) => r.id),
    );
    const mediaMap = await this.mediaRefs(rows.map((r) => r.mediaId).filter(Boolean) as string[]);
    const listMap = await this.listRefs(rows.map((r) => r.listId).filter(Boolean) as string[]);

    const items = rows.map((r) => ({
      ...this.toDto(r, c, liked.has(r.id), {
        media: r.mediaId ? mediaMap.get(r.mediaId) : null,
        list: r.listId ? listMap.get(r.listId) : null,
      }),
      context: contextMap.get(r.id) ?? null,
    }));
    return paginate(items, page, pageSize, total);
  }

  /** Batch-resolve display context (label + navigation ids) for the threads of the given comments. */
  private async threadContexts(
    rows: { id: string; threadType: CommentThreadType; threadId: string }[],
  ) {
    const map = new Map<string, any>();
    if (rows.length === 0) return map;
    const mediaIds = [
      ...new Set(
        rows
          .filter((r) => r.threadType === 'SHOW' || r.threadType === 'MOVIE')
          .map((r) => r.threadId),
      ),
    ];
    const episodeIds = [
      ...new Set(rows.filter((r) => r.threadType === 'EPISODE').map((r) => r.threadId)),
    ];

    const [mediaRows, episodeRows] = await Promise.all([
      mediaIds.length
        ? this.prisma.mediaItem.findMany({
            where: { id: { in: mediaIds } },
            include: { show: true, movie: true },
          })
        : [],
      episodeIds.length
        ? this.prisma.episode.findMany({
            where: { id: { in: episodeIds } },
            include: { season: { include: { show: { include: { media: true } } } } },
          })
        : [],
    ]);
    const mediaById = new Map(mediaRows.map((m) => [m.id, m]));
    const episodeById = new Map(episodeRows.map((e) => [e.id, e]));

    for (const r of rows) {
      if (r.threadType === 'GROUP') {
        // Group display names are localized client-side under `groups:names.<id>`.
        map.set(r.id, {
          threadType: r.threadType,
          threadId: r.threadId,
          label: r.threadId,
          groupId: r.threadId,
        });
        continue;
      }
      if (r.threadType === 'EPISODE') {
        const ep = episodeById.get(r.threadId);
        const media = ep?.season?.show?.media;
        const showTitle = media ? localized(media, 'titles', 'title') : null;
        const code = ep
          ? `S${String(ep.season?.number ?? 0).padStart(2, '0')}E${String(ep.number).padStart(2, '0')}`
          : '';
        map.set(r.id, {
          threadType: r.threadType,
          threadId: r.threadId,
          label: showTitle ? `${showTitle} · ${code}` : code,
          sublabel: ep ? (localized(ep, 'titles', 'title') ?? null) : null,
          mediaType: 'SHOW',
          mediaId: media?.id ?? null,
          episodeId: r.threadId,
        });
        continue;
      }
      const m = mediaById.get(r.threadId);
      map.set(r.id, {
        threadType: r.threadType,
        threadId: r.threadId,
        label: m ? (localized(m, 'titles', 'title') ?? '') : '',
        mediaType: r.threadType,
        mediaId: r.threadId,
      });
    }
    return map;
  }

  async replies(userId: string, commentId: string, q: RepliesQueryDto) {
    const blocked = await this.prisma.block.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
    });
    const blockedIds = blocked.map((b) => b.blockedId);

    const where: any = {
      parentId: commentId,
      hidden: false,
      adminDeleted: false,
      ...(blockedIds.length ? { userId: { notIn: blockedIds } } : {}),
    };
    const orderBy =
      q.resolvedSort === 'MOST_LIKED'
        ? { likesCount: 'desc' as const }
        : { createdAt: 'desc' as const };
    const page = q.page || 1;
    const pageSize = q.pageSize || 20;

    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { include: { profile: true } }, image: true },
      }),
      this.prisma.comment.count({ where }),
    ]);

    // depth=2: also return each direct child's first CHILD_PREVIEW_LIMIT children (same
    // sort), flat in the same items array. The client groups by parentId to build the
    // tree; `total` keeps counting direct children only.
    let children: typeof rows = [];
    if (q.depth === 2 && rows.length > 0) {
      children = await this.childPreview(
        rows.map((r) => r.id),
        blockedIds,
        q.resolvedSort,
      );
    }

    const allRows = [...rows, ...children];
    const authorIds = [...new Set(allRows.map((r) => r.userId))];
    const counts = await this.authorCounts(authorIds);
    const likedIds = await this.likedIds(
      userId,
      allRows.map((r) => r.id),
    );
    const mediaMap = await this.mediaRefs(
      allRows.map((r) => r.mediaId).filter(Boolean) as string[],
    );
    const listMap = await this.listRefs(allRows.map((r) => r.listId).filter(Boolean) as string[]);
    const items = allRows.map((r) =>
      this.toDto(r, counts.get(r.userId)!, likedIds.has(r.id), {
        media: r.mediaId ? mediaMap.get(r.mediaId) : null,
        list: r.listId ? listMap.get(r.listId) : null,
      }),
    );
    return paginate(items, page, pageSize, total);
  }

  /**
   * First CHILD_PREVIEW_LIMIT children of each given parent (visibility-filtered,
   * same sort as the parent page), ordered per parent by rank. Used by depth=2
   * replies so a thread page shows two layers without one query per comment.
   */
  private async childPreview(parentIds: string[], blockedIds: string[], sort: CommentSort) {
    const orderSql =
      sort === 'MOST_LIKED'
        ? Prisma.sql`ORDER BY likes_count DESC, created_at DESC, id`
        : Prisma.sql`ORDER BY created_at DESC, id`;
    const blockedSql = blockedIds.length
      ? Prisma.sql`AND user_id NOT IN (${Prisma.join(blockedIds)})`
      : Prisma.empty;
    const metas = await this.prisma.$queryRaw<{ id: string; parent_id: string }[]>`
      SELECT id, parent_id FROM (
        SELECT id, parent_id,
               ROW_NUMBER() OVER (PARTITION BY parent_id ${orderSql}) AS rn
        FROM comments
        WHERE parent_id IN (${Prisma.join(parentIds)})
          AND hidden = false
          AND admin_deleted = false
          ${blockedSql}
      ) t
      WHERE rn <= ${CHILD_PREVIEW_LIMIT}
      ORDER BY t.parent_id, t.rn
    `;
    if (metas.length === 0) return [];
    const rows = await this.prisma.comment.findMany({
      where: { id: { in: metas.map((m) => m.id) } },
      include: { user: { include: { profile: true } }, image: true },
    });
    // Re-apply the raw query's (parent, rank) ordering lost by the id-IN hydration.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return metas.map((m) => byId.get(m.id)!).filter(Boolean);
  }

  /** Distinct participants in a thread (for @mention suggestions). */
  async participants(threadType: string, threadId: string) {
    const rows = await this.prisma.comment.findMany({
      where: { threadType: threadType as any, threadId },
      select: { userId: true },
      distinct: ['userId'],
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      include: { profile: true },
    });
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      avatarUrl: u.profile?.avatarUrl ?? null,
    }));
  }

  async like(userId: string, commentId: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.hidden || comment.adminDeleted)
      throw new NotFoundException('Comment not found');
    if (comment.deletedByUser) throw new BadRequestException('Cannot like a deleted comment');
    try {
      await this.prisma.commentLike.create({ data: { userId, commentId } });
      await this.prisma.comment.update({
        where: { id: commentId },
        data: { likesCount: { increment: 1 } },
      });
      if (comment.userId !== userId) {
        await this.notifications.createForUser(comment.userId, {
          category: NotificationCategory.COMMENT_LIKE,
          title: 'Someone liked your comment',
          body: comment.body.slice(0, 80),
          link: `tvwatchtime://comment/${commentId}?highlight=${commentId}`,
          dedupeKey: `like:${userId}:${commentId}`,
          push: true,
        });
      }
    } catch {
      // already liked
    }
    return { liked: true };
  }

  async unlike(userId: string, commentId: string) {
    const deleted = await this.prisma.commentLike.deleteMany({ where: { userId, commentId } });
    if (deleted.count > 0) {
      await this.prisma.comment.update({
        where: { id: commentId },
        data: { likesCount: { decrement: 1 } },
      });
    }
    return { liked: false };
  }

  /** Edit an owned comment's body and/or attachments. */
  async update(userId: string, commentId: string, dto: UpdateCommentDto) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      include: { user: { include: { profile: true } }, image: true },
    });
    if (!comment || comment.hidden || comment.adminDeleted)
      throw new NotFoundException('Comment not found');
    if (comment.userId !== userId)
      throw new ForbiddenException('You can only edit your own comments');
    if (comment.deletedByUser) throw new BadRequestException('Cannot edit a deleted comment');

    const data: any = { editedAt: new Date() };

    if (dto.body !== undefined) {
      data.body = dto.body;
      data.language = null;
      data.translations = {};
    }

    // GIF handling: undefined = leave as-is, null = clear, string = replace.
    if (dto.gifUrl !== undefined) {
      if (dto.gifUrl !== null && !isAllowedGiphyUrl(dto.gifUrl)) {
        throw new BadRequestException('Invalid GIF URL');
      }
      data.gifUrl = dto.gifUrl;
    }

    // Image detach.
    if (dto.detachImage) {
      const existing = await this.prisma.commentImage.findUnique({ where: { commentId } });
      if (existing && existing.status !== 'deleted') {
        await this.commentImages.remove(userId, existing.id);
      }
    }

    // A comment may carry at most one visual attachment (image XOR gif). Detaching the
    // image while setting a GIF in the same call is allowed; setting a GIF while an image
    // is still attached is rejected.
    const willHaveGif = dto.gifUrl !== undefined ? dto.gifUrl !== null : !!comment.gifUrl;
    const willHaveImage = dto.detachImage
      ? false
      : !!comment.image &&
        comment.image.status !== 'deleted' &&
        comment.image.status !== 'rejected';
    if (willHaveGif && willHaveImage) {
      throw new BadRequestException('A comment cannot contain both an image and a GIF');
    }

    const nextBody = dto.body !== undefined ? dto.body : comment.body;
    const hasBody = !!(nextBody && nextBody.trim().length > 0);
    if (!hasBody && !willHaveGif && !willHaveImage) {
      throw new BadRequestException('Comment must contain text, an image, or a GIF');
    }

    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data,
      include: { user: { include: { profile: true } }, image: true },
    });
    const c = (await this.authorCounts([userId])).get(userId)!;
    const liked = await this.likedIds(userId, [commentId]);
    const mediaMap = await this.mediaRefs(updated.mediaId ? [updated.mediaId] : []);
    const listMap = await this.listRefs(updated.listId ? [updated.listId] : []);
    return this.toDto(updated, c, liked.has(commentId), {
      media: updated.mediaId ? mediaMap.get(updated.mediaId) : null,
      list: updated.listId ? listMap.get(updated.listId) : null,
    });
  }

  /** Owner soft-delete: tombstone. Body/attachments are hidden but the thread is preserved. */
  async softDelete(userId: string, commentId: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.hidden || comment.adminDeleted)
      throw new NotFoundException('Comment not found');
    if (comment.userId !== userId)
      throw new ForbiddenException('You can only delete your own comments');
    if (comment.deletedByUser) return { deleted: true };
    await this.prisma.comment.update({
      where: { id: commentId },
      data: { deletedByUser: true },
    });
    return { deleted: true };
  }

  async report(userId: string, commentId: string, reason: string) {
    await this.prisma.report.create({
      data: { reporterId: userId, commentId, reason: reason as any, status: 'OPEN' },
    });
    return { reported: true };
  }

  /**
   * Community spoiler flag: idempotent per (user, comment). The comment's spoilerCount
   * tallies flags; isSpoiler flips on at COMMENT_SPOILER_THRESHOLD (5). Authors flag
   * their own comments via the create-time isSpoiler flag instead.
   */
  async reportSpoiler(userId: string, commentId: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.hidden || comment.adminDeleted)
      throw new NotFoundException('Comment not found');
    if (comment.userId === userId)
      throw new BadRequestException('Mark your own comment as spoiler instead');

    const res = await this.prisma.commentSpoilerReport.createMany({
      data: [{ commentId, userId }],
      skipDuplicates: true,
    });
    if (res.count === 0) {
      return { reported: true, spoilerCount: comment.spoilerCount, isSpoiler: comment.isSpoiler };
    }
    const next = comment.spoilerCount + 1;
    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: {
        spoilerCount: { increment: 1 },
        ...(next >= COMMENT_SPOILER_THRESHOLD ? { isSpoiler: true } : {}),
      },
    });
    return { reported: true, spoilerCount: updated.spoilerCount, isSpoiler: updated.isSpoiler };
  }

  private async spoilerReportedIds(userId: string, commentIds: string[]) {
    if (commentIds.length === 0) return new Set<string>();
    const rows = await this.prisma.commentSpoilerReport.findMany({
      where: { userId, commentId: { in: commentIds } },
      select: { commentId: true },
    });
    return new Set(rows.map((r) => r.commentId));
  }

  /** Replies posted against an external (TMDB) review (chronological, capped). */
  async listExternalReviewReplies(userId: string, externalReviewId: string) {
    const rows = await this.prisma.comment.findMany({
      where: { externalReviewId, deletedByUser: false, adminDeleted: false, hidden: false },
      orderBy: { createdAt: 'asc' },
      take: 50,
      include: { user: { include: { profile: true } }, image: true },
    });
    const counts = await this.authorCounts([...new Set(rows.map((r) => r.userId))]);
    const liked = await this.likedIds(
      userId,
      rows.map((r) => r.id),
    );
    const spoilerReported = await this.spoilerReportedIds(
      userId,
      rows.map((r) => r.id),
    );
    const mediaMap = await this.mediaRefs(rows.map((r) => r.mediaId).filter(Boolean) as string[]);
    const listMap = await this.listRefs(rows.map((r) => r.listId).filter(Boolean) as string[]);
    return rows.map((r) =>
      this.toDto(
        r,
        counts.get(r.userId)!,
        liked.has(r.id),
        {
          media: r.mediaId ? mediaMap.get(r.mediaId) : null,
          list: r.listId ? listMap.get(r.listId) : null,
        },
        spoilerReported.has(r.id),
      ),
    );
  }

  /** Reviews as feed items: pseudo-comments (kind='review') merged into the main feed. */
  private async reviewPseudoItems(userId: string, threadType: any, threadId: string) {
    const rows = await this.prisma.externalReview.findMany({
      where: threadType === 'EPISODE' ? { episodeId: threadId } : { mediaId: threadId },
      orderBy: { reviewCreatedAt: 'desc' },
      take: 10,
    });
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [likes, replyCounts] = await Promise.all([
      this.prisma.externalReviewLike.findMany({
        where: { userId, externalReviewId: { in: ids } },
        select: { externalReviewId: true },
      }),
      this.prisma.comment.groupBy({
        by: ['externalReviewId'],
        where: {
          externalReviewId: { in: ids },
          deletedByUser: false,
          adminDeleted: false,
          hidden: false,
        },
        _count: { _all: true },
      }),
    ]);
    const likedSet = new Set(likes.map((l: any) => l.externalReviewId));
    const countMap = new Map(replyCounts.map((r: any) => [r.externalReviewId, r._count._all]));
    return rows.map((r) =>
      this.toReviewDto(r, threadType, threadId, likedSet.has(r.id), countMap.get(r.id) ?? 0),
    );
  }

  /** Map a stored provider review to a feed/thread-root pseudo-comment DTO. */
  private toReviewDto(
    r: any,
    threadType: any,
    threadId: string,
    likedByMe: boolean,
    repliesCount: number,
  ) {
    return {
      id: `review:${r.id}`, // prefixed — can never collide with a comment id
      parentId: null,
      depth: 0,
      threadType,
      threadId,
      author: {
        id: r.id,
        username: r.author,
        avatarUrl: r.avatarUrl,
        bio: null,
        createdAt: r.reviewCreatedAt,
        _followersCount: 0,
        _followingCount: 0,
        _commentsCount: 0,
      },
      body: r.content,
      content: this.translatable(r.content, r.translations, r.language, 'html'),
      imageUrl: null,
      gifUrl: null,
      image: null,
      media: null,
      list: null,
      likesCount: r.likesCount,
      repliesCount,
      likedByMe,
      reportedByMe: false,
      isSpoiler: false,
      spoilerCount: 0,
      spoilerReportedByMe: false,
      deletedByUser: false,
      isEdited: false,
      editedAt: null,
      createdAt: r.reviewCreatedAt.toISOString(),
      kind: 'review',
      provider: 'TMDB',
      reviewId: r.id,
      reviewUrl: r.url,
      reviewRating: r.rating,
    };
  }

  /** Thread header for a provider review (id, counts, likedByMe). */
  async getExternalReview(userId: string, id: string) {
    const r = await this.prisma.externalReview.findUnique({
      where: { id },
      include: { media: { select: { type: true } } },
    });
    if (!r) throw new NotFoundException('Review not found');
    const [liked, repliesCount] = await Promise.all([
      this.prisma.externalReviewLike.findUnique({
        where: { userId_externalReviewId: { userId, externalReviewId: id } },
      }),
      this.prisma.comment.count({
        where: { externalReviewId: id, deletedByUser: false, adminDeleted: false, hidden: false },
      }),
    ]);
    const threadType = r.episodeId ? 'EPISODE' : (r.media?.type ?? 'SHOW');
    const threadId = r.episodeId ?? r.mediaId;
    // Display context so the review thread page can title itself with the media name.
    const context =
      (
        await this.threadContexts([
          { id: 'review', threadType: threadType as any, threadId: threadId! },
        ])
      ).get('review') ?? null;
    return {
      id: r.id,
      provider: r.provider,
      author: r.author,
      username: r.username,
      avatarUrl: r.avatarUrl,
      rating: r.rating,
      content: r.content,
      translatableContent: this.translatable(r.content, r.translations, r.language, 'html'),
      url: r.url,
      createdAt: r.reviewCreatedAt,
      repliesCount,
      likesCount: r.likesCount,
      likedByMe: !!liked,
      // The thread this review belongs to (for the reply composer).
      threadType,
      threadId,
      context,
    };
  }

  /** Like/unlike a provider review (denormalized tally on the review row). */
  async likeExternalReview(userId: string, id: string) {
    await this.prisma.externalReviewLike.createMany({
      data: [{ userId, externalReviewId: id }],
      skipDuplicates: true,
    });
    const likesCount = await this.prisma.externalReviewLike.count({
      where: { externalReviewId: id },
    });
    await this.prisma.externalReview.update({ where: { id }, data: { likesCount } });
    return { liked: true, likesCount };
  }

  async unlikeExternalReview(userId: string, id: string) {
    await this.prisma.externalReviewLike.deleteMany({ where: { userId, externalReviewId: id } });
    const likesCount = await this.prisma.externalReviewLike.count({
      where: { externalReviewId: id },
    });
    await this.prisma.externalReview.update({ where: { id }, data: { likesCount } });
    return { liked: false, likesCount };
  }

  /** Map a Prisma comment row (with user + image includes) to the public DTO. */
  private toDto(
    r: any,
    counts: any,
    likedByMe: boolean,
    refs?: { media?: any; list?: any },
    spoilerReportedByMe = false,
  ) {
    const tombstone = !!r.deletedByUser;
    const image = r.image
      ? {
          id: r.image.id,
          status: r.image.status,
          width: r.image.width,
          height: r.image.height,
          blurhash: r.image.blurhash,
        }
      : null;
    return {
      id: r.id,
      parentId: r.parentId,
      depth: r.depth ?? 0,
      threadType: r.threadType,
      threadId: r.threadId,
      author: mapPublicUser({ ...r.user, ...counts }),
      body: tombstone ? '' : r.body,
      content: this.translatable(
        tombstone ? '' : r.body,
        tombstone ? {} : r.translations,
        tombstone ? null : r.language,
      ),
      imageUrl: tombstone ? null : r.imageUrl,
      gifUrl: tombstone ? null : r.gifUrl,
      image: tombstone ? null : image,
      media: tombstone ? null : (refs?.media ?? null),
      list: tombstone ? null : (refs?.list ?? null),
      likesCount: r.likesCount,
      repliesCount: r.repliesCount,
      likedByMe,
      reportedByMe: false,
      isSpoiler: !!r.isSpoiler,
      spoilerCount: r.spoilerCount ?? 0,
      spoilerReportedByMe,
      deletedByUser: tombstone,
      isEdited: !!r.editedAt,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private translatable(
    original: string,
    translations: unknown,
    language?: string | null,
    format: 'plain' | 'html' = 'plain',
  ) {
    return (
      this.translations?.content(original, translations, language, format) ?? {
        original,
        format,
        sourceLanguage: language ?? null,
        eligible: false,
        translation: null,
      }
    );
  }

  /** Resolve media_items rows into the card shape shown inside comments (localized title). */
  private async mediaRefs(mediaIds: string[]) {
    const map = new Map<string, any>();
    const ids = [...new Set(mediaIds)];
    if (ids.length === 0) return map;
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      include: { show: true, movie: true },
    });
    for (const m of rows) {
      map.set(m.id, {
        mediaType: m.type,
        mediaId: m.id,
        title: localized(m, 'titles', 'title'),
        posterUrl: m.posterUrl ?? null,
        year: m.type === 'SHOW' ? (m.show?.yearStart ?? null) : (m.movie?.releaseYear ?? null),
      });
    }
    return map;
  }

  /** Resolve custom_lists rows into the card shape shown inside comments. */
  private async listRefs(listIds: string[]) {
    const map = new Map<string, any>();
    const ids = [...new Set(listIds)];
    if (ids.length === 0) return map;
    // Counts via GROUP BY — the old code loaded every item (with media) of each
    // attached list just to count SHOW vs MOVIE.
    const [rows, counts] = await Promise.all([
      this.prisma.customList.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true, coverUrl: true },
      }),
      this.prisma.$queryRaw<{ listId: string; type: string; c: number }[]>`
        SELECT cli.list_id AS "listId", m.type, COUNT(*)::int AS c
        FROM custom_list_items cli
        JOIN media_items m ON m.id = cli.media_id
        WHERE cli.list_id IN (${Prisma.join(ids)})
        GROUP BY cli.list_id, m.type
      `,
    ]);
    const byList = new Map<string, { shows: number; movies: number }>();
    for (const r of counts) {
      const e = byList.get(r.listId) ?? { shows: 0, movies: 0 };
      if (r.type === 'SHOW') e.shows = r.c;
      else if (r.type === 'MOVIE') e.movies = r.c;
      byList.set(r.listId, e);
    }
    for (const l of rows) {
      const c = byList.get(l.id) ?? { shows: 0, movies: 0 };
      map.set(l.id, {
        id: l.id,
        title: l.title,
        coverUrl: l.coverUrl ?? null,
        showCount: c.shows,
        movieCount: c.movies,
      });
    }
    return map;
  }

  private async authorCounts(userIds: string[]) {
    const map = new Map<string, any>();
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return map;
    // 3 GROUP BY queries for the whole author set — the old loop ran 3 COUNTs PER
    // AUTHOR (up to ~60 queries for a 20-comment page).
    const [followers, following, comments] = await Promise.all([
      this.prisma.follow.groupBy({
        by: ['targetId'],
        where: { targetId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.follow.groupBy({
        by: ['followerId'],
        where: { followerId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.comment.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _count: { _all: true },
      }),
    ]);
    const f1 = new Map(followers.map((r) => [r.targetId, r._count._all]));
    const f2 = new Map(following.map((r) => [r.followerId, r._count._all]));
    const c = new Map(comments.map((r) => [r.userId, r._count._all]));
    for (const id of ids) {
      map.set(id, {
        _followersCount: f1.get(id) ?? 0,
        _followingCount: f2.get(id) ?? 0,
        _commentsCount: c.get(id) ?? 0,
      });
    }
    return map;
  }

  private async likedIds(userId: string, commentIds: string[]) {
    if (commentIds.length === 0) return new Set<string>();
    const likes = await this.prisma.commentLike.findMany({
      where: { userId, commentId: { in: commentIds } },
      select: { commentId: true },
    });
    return new Set(likes.map((l) => l.commentId));
  }
}
