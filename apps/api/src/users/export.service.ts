import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly exportDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.exportDir = path.join(process.cwd(), 'storage', 'exports');
  }

  async requestExport(userId: string): Promise<{ downloadUrl: string; expiresAt: string }> {
    const data = await this.gatherUserData(userId);
    const token = crypto.randomBytes(32).toString('hex');
    const fileName = `${userId}_${Date.now()}.json`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await fs.mkdir(this.exportDir, { recursive: true });
    await fs.writeFile(path.join(this.exportDir, fileName), JSON.stringify(data, null, 2));

    await this.prisma.dataExport.create({
      data: { userId, token, fileName, status: 'ready', expiresAt },
    });

    const baseUrl = this.config.get<string>('api.baseUrl') || '';
    return {
      downloadUrl: `${baseUrl}/me/export-download?token=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async downloadExport(token: string): Promise<{ buffer: Buffer; fileName: string }> {
    const record = await this.prisma.dataExport.findUnique({ where: { token } });
    if (!record || record.status !== 'ready') throw new NotFoundException('Export not found');
    if (record.expiresAt < new Date()) throw new NotFoundException('Export has expired');

    const filePath = path.join(this.exportDir, record.fileName);
    try {
      const buffer = await fs.readFile(filePath);
      return { buffer, fileName: 'tvwatchtime-export.json' };
    } catch {
      throw new NotFoundException('Export file no longer available');
    }
  }

  async cleanupExpired(): Promise<number> {
    const expired = await this.prisma.dataExport.findMany({
      where: { expiresAt: { lt: new Date() }, status: 'ready' },
    });
    for (const record of expired) {
      try {
        await fs.unlink(path.join(this.exportDir, record.fileName));
      } catch {}
    }
    if (expired.length) {
      await this.prisma.dataExport.updateMany({
        where: { id: { in: expired.map((e) => e.id) } },
        data: { status: 'expired' },
      });
    }
    return expired.length;
  }

  private async gatherUserData(userId: string) {
    const [user, watchHistory, ratings, watchlist, favorites, comments, badges] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { profile: true },
      }),
      this.prisma.watchHistory.findMany({
        where: { userId },
        include: { media: { select: { title: true, type: true } } },
        orderBy: { watchedAt: 'desc' },
      }),
      this.prisma.$queryRaw`
        SELECT m.title, 'SHOW' as type, ues.rating
        FROM user_episode_status ues
        JOIN episodes e ON ues.episode_id = e.id
        JOIN seasons s ON e.season_id = s.id
        JOIN shows sh ON s.show_id = sh.id
        JOIN media_items m ON sh.media_id = m.id
        WHERE ues.user_id = ${userId} AND ues.rating IS NOT NULL
      `.catch(() => []),
      this.prisma.watchlistItem.findMany({
        where: { userId },
        include: { media: { select: { title: true, type: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.favorite.findMany({
        where: { userId },
        include: { media: { select: { title: true, type: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.comment.findMany({
        where: { userId },
        select: { body: true, threadType: true, threadId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.userBadge.findMany({
        where: { userId, unlocked: true },
        include: { badge: { select: { name: true, icon: true } } },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      user: {
        username: user?.username,
        displayName: user?.profile?.displayName ?? null,
        bio: user?.profile?.bio ?? null,
        createdAt: user?.createdAt?.toISOString(),
      },
      watchHistory: watchHistory.map((w) => ({
        title: w.media?.title,
        type: w.mediaType,
        seasonNumber: w.seasonNumber,
        episodeNumber: w.episodeNumber,
        watchedAt: w.watchedAt?.toISOString(),
        runtimeMinutes: w.runtimeMinutes,
      })),
      ratings: ratings,
      watchlist: watchlist.map((w) => ({
        title: w.media?.title,
        type: w.media?.type,
        addedAt: w.createdAt?.toISOString(),
      })),
      favorites: favorites.map((f) => ({
        title: f.media?.title,
        type: f.media?.type,
        addedAt: f.createdAt?.toISOString(),
      })),
      comments: comments.map((c) => ({
        body: c.body,
        threadType: c.threadType,
        threadId: c.threadId,
        createdAt: c.createdAt?.toISOString(),
      })),
      badges: badges.map((b) => ({
        name: b.badge?.name,
        icon: b.badge?.icon,
        unlockedAt: b.unlockedAt?.toISOString(),
      })),
    };
  }
}
