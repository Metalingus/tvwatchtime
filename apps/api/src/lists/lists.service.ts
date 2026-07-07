import { Injectable, NotFoundException } from '@nestjs/common';
import { ListVisibility } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class ListsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const lists = await this.prisma.customList.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { items: true } } },
    });
    return lists.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      coverUrl: l.coverUrl,
      visibility: l.visibility,
      itemCount: l._count.items,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    }));
  }

  async get(id: string, userId?: string) {
    const list = await this.prisma.customList.findUnique({
      where: { id },
      include: { items: { include: { media: true }, orderBy: { order: 'asc' } } },
    });
    if (!list) throw new NotFoundException('List not found');
    if (list.visibility === ListVisibility.PRIVATE && userId && list.userId !== userId) {
      throw new NotFoundException('List not found');
    }
    return {
      id: list.id,
      title: list.title,
      description: list.description,
      coverUrl: list.coverUrl,
      visibility: list.visibility,
      itemCount: list.items.length,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
      items: list.items.map((i) => ({
        id: i.id,
        mediaType: i.media.type,
        mediaId: i.mediaId,
        title: i.media.title,
        posterUrl: i.media.posterUrl,
      })),
    };
  }

  async create(userId: string, dto: any) {
    const list = await this.prisma.customList.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description,
        coverUrl: dto.coverUrl,
        visibility: dto.visibility ?? ListVisibility.PRIVATE,
      },
    });
    return this.get(list.id, userId);
  }

  async update(userId: string, id: string, dto: any) {
    await this.prisma.customList.updateMany({ where: { id, userId }, data: dto });
    return this.get(id, userId);
  }

  async remove(userId: string, id: string) {
    await this.prisma.customList.deleteMany({ where: { id, userId } });
    return { ok: true };
  }

  async addItem(userId: string, id: string, mediaId: string) {
    const list = await this.prisma.customList.findUnique({ where: { id } });
    if (!list || list.userId !== userId) throw new NotFoundException('List not found');
    await this.prisma.customListItem.upsert({
      where: { listId_mediaId: { listId: id, mediaId } },
      create: { listId: id, mediaId },
      update: {},
    });
    return this.get(id, userId);
  }

  async removeItem(userId: string, id: string, itemId: string) {
    await this.prisma.customListItem.deleteMany({ where: { id: itemId, list: { userId } } });
    return { ok: true };
  }
}
