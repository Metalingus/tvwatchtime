import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CommentThreadType, NotificationCategory } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { mapPublicUser } from '../common/utils/mapper.util';
import { paginate } from '../common/dto/pagination.dto';
import { NotificationService } from '../notifications/notification.service';
import { CommentImageService } from '../comment-images/comment-image.service';
import { CommentQueryDto, CreateCommentDto, RepliesQueryDto, UpdateCommentDto, isAllowedGiphyUrl } from './dto/comment.dto';

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly notifications: NotificationService,
    private readonly commentImages: CommentImageService,
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
      q.resolvedSort === 'MOST_LIKED' ? { likesCount: 'desc' as const } : { createdAt: 'desc' as const };
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
    const likedIds = await this.likedIds(userId, rows.map((r) => r.id));

    const items = rows.map((r) => this.toDto(r, counts.get(r.userId)!, likedIds.has(r.id)));
    return paginate(items, page, pageSize, total);
  }

  async create(userId: string, dto: CreateCommentDto) {
    // Enforce a single level of replies: a reply's parent must be top-level.
    let parent: any = null;
    if (dto.parentId) {
      parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Parent comment not found');
      if (parent.parentId) {
        throw new BadRequestException('You can only reply to top-level comments');
      }
      if (parent.deletedByUser) {
        throw new BadRequestException('Cannot reply to a deleted comment');
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
    return this.toDto(comment, c, false);
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
    return this.toDto(r, c, liked.has(r.id));
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
      q.resolvedSort === 'MOST_LIKED' ? { likesCount: 'desc' as const } : { createdAt: 'desc' as const };
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
    const likedIds = await this.likedIds(userId, rows.map((r) => r.id));
    const items = rows.map((r) => this.toDto(r, counts.get(r.userId)!, likedIds.has(r.id)));
    return paginate(items, page, pageSize, total);
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
    if (!comment || comment.hidden || comment.adminDeleted) throw new NotFoundException('Comment not found');
    if (comment.deletedByUser) throw new BadRequestException('Cannot like a deleted comment');
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

  /** Edit an owned comment's body and/or attachments. */
  async update(userId: string, commentId: string, dto: UpdateCommentDto) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      include: { user: { include: { profile: true } }, image: true },
    });
    if (!comment || comment.hidden || comment.adminDeleted) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new ForbiddenException('You can only edit your own comments');
    if (comment.deletedByUser) throw new BadRequestException('Cannot edit a deleted comment');

    const data: any = { editedAt: new Date() };

    if (dto.body !== undefined) {
      data.body = dto.body;
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
    const willHaveImage = dto.detachImage ? false : !!comment.image && comment.image.status !== 'deleted' && comment.image.status !== 'rejected';
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
    return this.toDto(updated, c, liked.has(commentId));
  }

  /** Owner soft-delete: tombstone. Body/attachments are hidden but the thread is preserved. */
  async softDelete(userId: string, commentId: string) {
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment || comment.hidden || comment.adminDeleted) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new ForbiddenException('You can only delete your own comments');
    if (comment.deletedByUser) return { deleted: true };
    await this.prisma.comment.update({
      where: { id: commentId },
      data: { deletedByUser: true },
    });
    return { deleted: true };
  }

  async report(userId: string, commentId: string, reason: string) {
    await this.prisma.report.create({ data: { reporterId: userId, commentId, reason: reason as any, status: 'OPEN' } });
    return { reported: true };
  }

  /** Map a Prisma comment row (with user + image includes) to the public DTO. */
  private toDto(r: any, counts: any, likedByMe: boolean) {
    const tombstone = !!r.deletedByUser;
    const image = r.image
      ? { id: r.image.id, status: r.image.status, width: r.image.width, height: r.image.height, blurhash: r.image.blurhash }
      : null;
    return {
      id: r.id,
      parentId: r.parentId,
      threadType: r.threadType,
      threadId: r.threadId,
      author: mapPublicUser({ ...r.user, ...counts }),
      body: tombstone ? '' : r.body,
      imageUrl: tombstone ? null : r.imageUrl,
      gifUrl: tombstone ? null : r.gifUrl,
      image: tombstone ? null : image,
      likesCount: r.likesCount,
      repliesCount: r.repliesCount,
      likedByMe,
      reportedByMe: false,
      deletedByUser: tombstone,
      isEdited: !!r.editedAt,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
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
