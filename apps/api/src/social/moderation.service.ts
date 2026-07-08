import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ReportTargetType } from '@prisma/client';

@Injectable()
export class ModerationService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Block / Unblock ----
  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) throw new BadRequestException('Cannot block yourself');
    const existing = await this.prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    });
    if (existing) return { blocked: true };
    await this.prisma.block.create({ data: { blockerId, blockedId } });
    // Also unfollow if following
    await this.prisma.follow.deleteMany({ where: { followerId: blockerId, targetId: blockedId } });
    return { blocked: true };
  }

  async unblock(blockerId: string, blockedId: string) {
    await this.prisma.block.deleteMany({ where: { blockerId, blockedId } });
    return { blocked: false };
  }

  async getBlockedUsers(userId: string) {
    const blocks = await this.prisma.block.findMany({
      where: { blockerId: userId },
      include: { blocked: { include: { profile: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return blocks.map((b) => ({
      id: b.blocked.id,
      username: b.blocked.username,
      displayName: b.blocked.profile?.displayName ?? null,
      avatarUrl: b.blocked.profile?.avatarUrl ?? null,
      blockedAt: b.createdAt,
    }));
  }

  async getBlockedIds(userId: string): Promise<Set<string>> {
    const blocks = await this.prisma.block.findMany({
      where: { blockerId: userId },
      select: { blockedId: true },
    });
    return new Set(blocks.map((b) => b.blockedId));
  }

  // ---- Report ----
  async report(userId: string, dto: { targetType: ReportTargetType; targetId: string; reason: string; note?: string }) {
    // Validate target exists
    if (dto.targetType === ReportTargetType.COMMENT) {
      const comment = await this.prisma.comment.findUnique({ where: { id: dto.targetId } });
      if (!comment) throw new NotFoundException('Comment not found');
      const existing = await this.prisma.report.findFirst({
        where: { reporterId: userId, commentId: dto.targetId },
      });
      if (existing) return { reported: true };
      await this.prisma.report.create({
        data: { reporterId: userId, targetType: ReportTargetType.COMMENT, commentId: dto.targetId, reason: dto.reason as any, note: dto.note },
      });
    } else if (dto.targetType === ReportTargetType.IMAGE) {
      const image = await this.prisma.commentImage.findUnique({ where: { id: dto.targetId } });
      if (!image) throw new NotFoundException('Image not found');
      const existing = await this.prisma.report.findFirst({
        where: { reporterId: userId, commentImageId: dto.targetId },
      });
      if (existing) return { reported: true };
      await this.prisma.report.create({
        data: { reporterId: userId, targetType: ReportTargetType.IMAGE, commentImageId: dto.targetId, reason: dto.reason as any, note: dto.note },
      });
    } else if (dto.targetType === ReportTargetType.USER) {
      const user = await this.prisma.user.findUnique({ where: { id: dto.targetId } });
      if (!user) throw new NotFoundException('User not found');
      const existing = await this.prisma.report.findFirst({
        where: { reporterId: userId, reportedUserId: dto.targetId },
      });
      if (existing) return { reported: true };
      await this.prisma.report.create({
        data: { reporterId: userId, targetType: ReportTargetType.USER, reportedUserId: dto.targetId, reason: dto.reason as any, note: dto.note },
      });
    }
    return { reported: true };
  }

  // ---- Admin: Reported Comments ----
  async reportedComments(page = 1, pageSize = 20) {
    const [total, reports] = await Promise.all([
      this.prisma.report.count({ where: { targetType: ReportTargetType.COMMENT, status: 'OPEN' } }),
      this.prisma.report.findMany({
        where: { targetType: ReportTargetType.COMMENT, status: 'OPEN' },
        include: {
          comment: { include: { user: { include: { profile: true } }, image: true } },
          reporter: { include: { profile: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // Group by commentId and count reports
    const grouped = new Map<string, any>();
    for (const r of reports) {
      if (!r.comment) continue;
      const cid = r.comment.id;
      if (!grouped.has(cid)) {
        grouped.set(cid, {
          comment: r.comment,
          reportCount: 0,
          reasons: [] as string[],
        });
      }
      const g = grouped.get(cid)!;
      g.reportCount++;
      if (!g.reasons.includes(r.reason)) g.reasons.push(r.reason);
    }

    return { items: [...grouped.values()], page, pageSize, total };
  }

  async reportedImages(page = 1, pageSize = 20) {
    const [total, reports] = await Promise.all([
      this.prisma.report.count({ where: { targetType: ReportTargetType.IMAGE, status: 'OPEN' } }),
      this.prisma.report.findMany({
        where: { targetType: ReportTargetType.IMAGE, status: 'OPEN' },
        include: {
          commentImage: { include: { comment: { include: { user: { include: { profile: true } } } } } },
          reporter: { include: { profile: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const grouped = new Map<string, any>();
    for (const r of reports) {
      if (!r.commentImage) continue;
      const iid = r.commentImage.id;
      if (!grouped.has(iid)) {
        grouped.set(iid, {
          image: r.commentImage,
          reportCount: 0,
          reasons: [] as string[],
        });
      }
      const g = grouped.get(iid)!;
      g.reportCount++;
      if (!g.reasons.includes(r.reason)) g.reasons.push(r.reason);
    }

    return { items: [...grouped.values()], page, pageSize, total };
  }

  async reportedUsers(page = 1, pageSize = 20) {
    // Get users who have OPEN reports against them
    const userIds = await this.prisma.report.findMany({
      where: { targetType: ReportTargetType.USER, status: 'OPEN' },
      select: { reportedUserId: true },
      distinct: ['reportedUserId'],
    });

    const ids = userIds.map((r) => r.reportedUserId).filter(Boolean) as string[];
    if (!ids.length) return { items: [], page, pageSize, total: 0 };

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      include: { profile: true },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // Get report counts + deleted comment counts via separate queries (Prisma _count doesn't support where filters)
    const [reportCounts, deletedCountsRaw] = await Promise.all([
      this.prisma.report.groupBy({
        by: ['reportedUserId'],
        where: { reportedUserId: { in: ids }, status: 'OPEN' },
        _count: true,
      }),
      this.prisma.comment.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, adminDeleted: true },
        _count: true,
      }),
    ]);

    const reportMap = new Map(reportCounts.map((r) => [r.reportedUserId, r._count]));
    const deletedMap = new Map(deletedCountsRaw.map((r) => [r.userId, r._count]));

    const items = users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.profile?.displayName ?? null,
      avatarUrl: u.profile?.avatarUrl ?? null,
      reportCount: reportMap.get(u.id) ?? 0,
      deletedCommentCount: deletedMap.get(u.id) ?? 0,
    }));

    items.sort((a, b) => b.reportCount - a.reportCount);

    return { items, page, pageSize, total: ids.length };
  }

  // ---- Admin: Actions ----
  async deleteComment(commentId: string) {
    await this.prisma.comment.update({
      where: { id: commentId },
      data: { adminDeleted: true, hidden: true },
    });
    // Resolve all open reports for this comment
    await this.prisma.report.updateMany({
      where: { commentId, status: 'OPEN' },
      data: { status: 'RESOLVED' },
    });
    return { deleted: true };
  }

  async dismissReports(targetType: ReportTargetType, targetId: string) {
    const where: any = { status: 'OPEN' };
    if (targetType === ReportTargetType.COMMENT) where.commentId = targetId;
    else if (targetType === ReportTargetType.IMAGE) where.commentImageId = targetId;
    else where.reportedUserId = targetId;

    await this.prisma.report.updateMany({ where, data: { status: 'DISMISSED' } });
    return { dismissed: true };
  }
}
