import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ContactReason } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import { paginate } from '../common/dto/pagination.dto';
import type { CreateContactThreadDto, CreateContactMessageDto } from './dto/contact.dto';

const MAX_OPEN_THREADS = 5;

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  // ---------------- User side ----------------

  /** Threads the user can see: only those the admin has replied to. Most recent first. */
  async listForUser(userId: string, page = 1, pageSize = 20) {
    const where = { userId, adminReplied: true };
    const [rows, total] = await Promise.all([
      this.prisma.contactThread.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      }),
      this.prisma.contactThread.count({ where }),
    ]);
    const items = rows.map((t) => this.mapThreadForUser(t));
    return paginate(items, page, pageSize, total);
  }

  async create(userId: string, dto: CreateContactThreadDto) {
    const openCount = await this.prisma.contactThread.count({ where: { userId, status: 'OPEN' } });
    if (openCount >= MAX_OPEN_THREADS) {
      throw new BadRequestException(
        `You already have ${MAX_OPEN_THREADS} open contact threads. Please continue an existing one.`,
      );
    }
    const now = new Date();
    const thread = await this.prisma.contactThread.create({
      data: {
        userId,
        reason: dto.reason,
        subject: dto.subject.trim(),
        status: 'OPEN',
        adminReplied: false,
        lastMessageAt: now,
        messages: {
          create: { authorRole: 'USER', authorId: userId, body: dto.body.trim() },
        },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return this.mapThreadDetail(thread);
  }

  async getForUser(userId: string, id: string) {
    const thread = await this.prisma.contactThread.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!thread || thread.userId !== userId) throw new NotFoundException('Thread not found');
    // Mark user-side read.
    await this.prisma.contactThread.update({ where: { id }, data: { userReadAt: new Date() } });
    return this.mapThreadDetail(thread);
  }

  async replyAsUser(userId: string, id: string, dto: CreateContactMessageDto) {
    const thread = await this.prisma.contactThread.findUnique({ where: { id } });
    if (!thread || thread.userId !== userId) throw new NotFoundException('Thread not found');
    const now = new Date();
    const wasClosed = thread.status === 'CLOSED';
    await this.prisma.contactMessage.create({
      data: { threadId: id, authorRole: 'USER', authorId: userId, body: dto.body.trim() },
    });
    await this.prisma.contactThread.update({
      where: { id },
      data: { lastMessageAt: now, status: 'OPEN', closedAt: wasClosed ? null : undefined },
    });
    return { ok: true, reopened: wasClosed };
  }

  // ---------------- Admin side ----------------

  async listForAdmin(opts: {
    status?: string;
    reason?: ContactReason;
    unread?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 20, 100);
    const where: any = {};
    if (opts.status) where.status = opts.status;
    if (opts.reason) where.reason = opts.reason;
    // `unread` is applied in JS below (admin unread = a USER message after adminReadAt).
    const [rows, total] = await Promise.all([
      this.prisma.contactThread.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, username: true, profile: { select: { avatarUrl: true } } } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      }),
      this.prisma.contactThread.count({ where }),
    ]);
    let items = rows.map((t) => this.mapThreadForAdmin(t));
    if (opts.unread) items = items.filter((t: any) => t.unreadForAdmin);
    return paginate(items, page, pageSize, opts.unread ? items.length : total);
  }

  async getForAdmin(id: string) {
    const thread = await this.prisma.contactThread.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            profile: { select: { avatarUrl: true } },
          },
        },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    await this.prisma.contactThread.update({ where: { id }, data: { adminReadAt: new Date() } });
    return this.mapThreadDetail(thread, true);
  }

  async replyAsAdmin(adminId: string, id: string, dto: CreateContactMessageDto) {
    const thread = await this.prisma.contactThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Thread not found');
    const now = new Date();
    const wasClosed = thread.status === 'CLOSED';
    await this.prisma.contactMessage.create({
      data: { threadId: id, authorRole: 'ADMIN', authorId: adminId, body: dto.body.trim() },
    });
    await this.prisma.contactThread.update({
      where: { id },
      data: {
        lastMessageAt: now,
        adminReplied: true,
        status: 'OPEN',
        closedAt: wasClosed ? null : undefined,
      },
    });

    // Notify the user to check the Contact section.
    try {
      await this.notifications.createForUser(thread.userId, {
        category: 'CONTACT',
        title: '💬 New reply to your message',
        body: 'You have a new reply — open Contact in Settings to view it.',
        link: 'tvwatchtime://contact',
        dedupeKey: `contact:${thread.id}`,
        push: true,
      });
    } catch (e) {
      this.logger.warn(`Failed to notify user for contact thread ${id}: ${(e as Error).message}`);
    }
    return { ok: true };
  }

  async close(adminId: string, id: string) {
    const thread = await this.prisma.contactThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Thread not found');
    await this.prisma.contactThread.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date(), closedBy: adminId },
    });
    return { ok: true, status: 'CLOSED' };
  }

  async reopen(adminId: string, id: string) {
    const thread = await this.prisma.contactThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Thread not found');
    await this.prisma.contactThread.update({
      where: { id },
      data: { status: 'OPEN', closedAt: null, closedBy: null },
    });
    return { ok: true, status: 'OPEN' };
  }

  // ---------------- Mappers ----------------

  private mapThreadForUser(t: any) {
    const last = t.messages?.[0];
    return {
      id: t.id,
      reason: t.reason,
      subject: t.subject,
      status: t.status,
      lastMessageAt: t.lastMessageAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      lastMessagePreview: last ? last.body : null,
      unreadForUser: this.hasUnreadAdmin(t),
    };
  }

  private mapThreadForAdmin(t: any) {
    const last = t.messages?.[0];
    return {
      id: t.id,
      reason: t.reason,
      subject: t.subject,
      status: t.status,
      adminReplied: t.adminReplied,
      lastMessageAt: t.lastMessageAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      lastMessagePreview: last ? last.body : null,
      user: t.user
        ? { id: t.user.id, username: t.user.username, avatarUrl: t.user.profile?.avatarUrl ?? null }
        : null,
      unreadForAdmin: this.hasUnreadUser(t),
    };
  }

  private mapThreadDetail(t: any, isAdmin = false) {
    return {
      id: t.id,
      reason: t.reason,
      subject: t.subject,
      status: t.status,
      adminReplied: t.adminReplied,
      createdAt: t.createdAt.toISOString(),
      lastMessageAt: t.lastMessageAt.toISOString(),
      messages: (t.messages ?? []).map((m: any) => ({
        id: m.id,
        authorRole: m.authorRole,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
      user:
        isAdmin && t.user
          ? {
              id: t.user.id,
              username: t.user.username,
              email: t.user.email ?? null,
              avatarUrl: t.user.profile?.avatarUrl ?? null,
            }
          : undefined,
    };
  }

  /** Unread for user = an ADMIN message newer than userReadAt (or user never read). */
  private hasUnreadAdmin(t: any): boolean {
    if (!t.messages) return false;
    const readAt = t.userReadAt ? new Date(t.userReadAt).getTime() : 0;
    return t.messages.some(
      (m: any) => m.authorRole === 'ADMIN' && new Date(m.createdAt).getTime() > readAt,
    );
  }

  /** Unread for admin = a USER message newer than adminReadAt (or admin never read). */
  private hasUnreadUser(t: any): boolean {
    if (!t.messages) return false;
    const readAt = t.adminReadAt ? new Date(t.adminReadAt).getTime() : 0;
    return t.messages.some(
      (m: any) => m.authorRole === 'USER' && new Date(m.createdAt).getTime() > readAt,
    );
  }
}
