import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CommentThreadType, NotificationCategory } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { mapPublicUser } from '../common/utils/mapper.util';
import { paginate } from '../common/dto/pagination.dto';
import { NotificationService } from '../notifications/notification.service';
import { CommentQueryDto, CreateCommentDto, isAllowedGiphyUrl } from './dto/comment.dto';

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly notifications: NotificationService,
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
      hidden: false,
      adminDeleted: false,
      ...(blockedIds.length ? { userId: { notIn: blockedIds } } : {}),
    };
    const orderBy =
      q.sort === 'MOST_LIKED' ? { likesCount: 'desc' as const } : { createdAt: 'desc' as const };
    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where,
        orderBy,
        skip: ((q.page || 1) - 1) * (q.pageSize || 20),
        take: q.pageSize,
        include: { user: { include: { profile: true } }, image: true },
      }),
      this.prisma.comment.count({ where }),
    ]);

    const authorIds = [...new Set(rows.map((r) => r.userId))];
    const counts = await this.authorCounts(authorIds);
    const likedIds = await this.likedIds(userId, rows.map((r) => r.id));

    const items = rows.map((r) => {
      const c = counts.get(r.userId)!;
      return {
        id: r.id,
        parentId: r.parentId,
        threadType: r.threadType,
        threadId: r.threadId,
        author: mapPublicUser({ ...r.user, ...c }),
        body: r.body,
        imageUrl: r.imageUrl,
        gifUrl: r.gifUrl,
        image: r.image ? { id: r.image.id, status: r.image.status, width: r.image.width, height: r.image.height, blurhash: r.image.blurhash } : null,
        likesCount: r.likesCount,
        repliesCount: r.repliesCount,
        likedByMe: likedIds.has(r.id),
        reportedByMe: false,
        createdAt: r.createdAt.toISOString(),
      };
    });
    return paginate(items, q.page, q.pageSize, total);
  }

  async create(userId: string, dto: CreateCommentDto) {
    // Enforce a single level of replies: a reply's parent must be top-level.
    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Parent comment not found');
      if (parent.parentId) {
        throw new BadRequestException('You can only reply to top-level comments');
      }
    }

    // A comment must carry text, an uploaded image association, or a GIPHY GIF.
    const hasBody = !!(dto.body && dto.body.trim().length > 0);
    if (!hasBody && !dto.imageUrl && !dto.gifUrl) {
      throw new BadRequestException('Comment must contain text, an image, or a GIF');
    }
    // A comment may have at most one visual attachment (image XOR gif).
    if (dto.imageUrl && dto.gifUrl) {
      throw new BadRequestException('A comment cannot contain both an image and a GIF');
    }
    if (dto.gifUrl && !isAllowedGiphyUrl(dto.gifUrl)) {
      throw new BadRequestException('Invalid GIF URL');
    }

    const comment = await this.prisma.comment.create({
      data: {
        userId,
        parentId: dto.parentId,
        threadType: dto.threadType,
        threadId: dto.threadId,
        body: dto.body ?? '',
        imageUrl: dto.imageUrl,
        gifUrl: dto.gifUrl,
      },
      include: { user: { include: { profile: true } }, image: true },
    });
    if (dto.parentId) {
      await this.prisma.comment.update({
        where: { id: dto.parentId },
        data: { repliesCount: { increment: 1 } },
      });
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (parent && parent.userId !== userId) {
        await this.notifications.createForUser(parent.userId, {
          category: NotificationCategory.COMMENT_REPLY,
          title: 'New reply to your comment',
          body: comment.body.slice(0, 80),
          link: `tvwatchtime://comment/${comment.id}`,
          dedupeKey: `reply:${comment.id}`,
          push: true,
        });
      }
    }
    this.events.emit('comment.created', { userId });
    const c = (await this.authorCounts([userId])).get(userId)!;
    return {
      id: comment.id,
      parentId: comment.parentId,
      threadType: comment.threadType,
      threadId: comment.threadId,
      author: mapPublicUser({ ...comment.user, ...c }),
      body: comment.body,
      imageUrl: comment.imageUrl,
      gifUrl: comment.gifUrl,
      likesCount: 0,
      repliesCount: 0,
      likedByMe: false,
      reportedByMe: false,
      createdAt: comment.createdAt.toISOString(),
    };
  }

  async replies(userId: string, commentId: string) {
    const blocked = await this.prisma.block.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
    });
    const blockedIds = blocked.map((b) => b.blockedId);

    const rows = await this.prisma.comment.findMany({
      where: {
        parentId: commentId,
        hidden: false,
        adminDeleted: false,
        ...(blockedIds.length ? { userId: { notIn: blockedIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: { user: { include: { profile: true } }, image: true },
    });
    const authorIds = [...new Set(rows.map((r) => r.userId))];
    const counts = await this.authorCounts(authorIds);
    const likedIds = await this.likedIds(userId, rows.map((r) => r.id));
    return rows.map((r) => {
      const c = counts.get(r.userId)!;
      return {
        id: r.id,
        parentId: r.parentId,
        threadType: r.threadType,
        threadId: r.threadId,
        author: mapPublicUser({ ...r.user, ...c }),
        body: r.body,
        imageUrl: r.imageUrl,
        gifUrl: r.gifUrl,
        likesCount: r.likesCount,
        repliesCount: 0,
        likedByMe: likedIds.has(r.id),
        reportedByMe: false,
        createdAt: r.createdAt.toISOString(),
      };
    });
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
    if (!comment) throw new NotFoundException('Comment not found');
    try {
      await this.prisma.commentLike.create({ data: { userId, commentId } });
      await this.prisma.comment.update({ where: { id: commentId }, data: { likesCount: { increment: 1 } } });
      if (comment.userId !== userId) {
        await this.notifications.createForUser(comment.userId, {
          category: NotificationCategory.COMMENT_LIKE,
          title: 'Someone liked your comment',
          body: comment.body.slice(0, 80),
          link: `tvwatchtime://comment/${commentId}`,
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
      await this.prisma.comment.update({ where: { id: commentId }, data: { likesCount: { decrement: 1 } } });
    }
    return { liked: false };
  }

  async report(userId: string, commentId: string, reason: string) {
    await this.prisma.report.create({ data: { reporterId: userId, commentId, reason: reason as any, status: 'OPEN' } });
    return { reported: true };
  }

  private async authorCounts(userIds: string[]) {
    const map = new Map<string, any>();
    for (const id of userIds) {
      const [followersCount, followingCount, commentsCount] = await Promise.all([
        this.prisma.follow.count({ where: { targetId: id } }),
        this.prisma.follow.count({ where: { followerId: id } }),
        this.prisma.comment.count({ where: { userId: id } }),
      ]);
      map.set(id, { _followersCount: followersCount, _followingCount: followingCount, _commentsCount: commentsCount });
    }
    return map;
  }

  private async likedIds(userId: string, commentIds: string[]) {
    if (commentIds.length === 0) return new Set<string>();
    const likes = await this.prisma.commentLike.findMany({ where: { userId, commentId: { in: commentIds } }, select: { commentId: true } });
    return new Set(likes.map((l) => l.commentId));
  }
}
