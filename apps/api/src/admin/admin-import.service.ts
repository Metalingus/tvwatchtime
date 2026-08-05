import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { ImportService } from '../import/import.service';
import { AdminService } from './admin.service';

type ItemFilters = {
  status?: string;
  entity?: string;
  page?: number;
  pageSize?: number;
};

@Injectable()
export class AdminImportService {
  private readonly logger = new Logger(AdminImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly imports: ImportService,
    private readonly admin: AdminService,
  ) {}

  async list(opts: { search?: string; status?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(Math.max(1, opts.pageSize || 50), 200);
    const where: any = {};
    if (opts.status) where.status = opts.status.toUpperCase();
    if (opts.search?.trim()) {
      const search = opts.search.trim();
      where.OR = [
        { originalFilename: { contains: search, mode: 'insensitive' } },
        { user: { username: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.import.findMany({
        where,
        select: {
          id: true,
          userId: true,
          sourceType: true,
          format: true,
          originalFilename: true,
          status: true,
          progress: true,
          totalFiles: true,
          totalRows: true,
          matchedCount: true,
          unmatchedCount: true,
          duplicateCount: true,
          needsReviewCount: true,
          errorMessage: true,
          createdAt: true,
          updatedAt: true,
          processedAt: true,
          completedAt: true,
          user: {
            select: {
              id: true,
              username: true,
              email: true,
              profile: { select: { displayName: true, avatarUrl: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.import.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async detail(importId: string) {
    const owner = await this.owner(importId);
    const status = await this.imports.getStatus(owner.userId, importId);
    if (!status) throw new NotFoundException('Import not found');
    const {
      storageKey: _storageKey,
      ownerExternalId: _ownerExternalId,
      ...safeStatus
    } = status as any;
    return { ...safeStatus, user: owner.user };
  }

  async items(importId: string, filters: ItemFilters) {
    const owner = await this.owner(importId);
    const result = await this.imports.getItems(owner.userId, importId, {
      status: filters.status,
      entity: filters.entity,
      page: filters.page,
      pageSize: filters.pageSize,
    });
    return {
      ...result,
      // normalizedData is the review contract. Raw provider rows can contain unrelated private
      // archive fields and are not needed by the admin review UI.
      items: result.items.map(({ rawData: _rawData, ...item }: any) => item),
    };
  }

  async patchItem(
    adminId: string,
    importId: string,
    itemId: string,
    dto: { matchedMediaId?: string; userResolution?: string },
  ) {
    if (!dto.matchedMediaId && dto.userResolution !== 'skip') {
      throw new BadRequestException('matchedMediaId or userResolution=skip is required');
    }
    const owner = await this.owner(importId);
    const result = await this.imports.patchItem(owner.userId, importId, itemId, dto);
    await this.audit(adminId, 'admin_import_item_resolve', importId, {
      userId: owner.userId,
      itemId,
      matchedMediaId: dto.matchedMediaId,
      resolution: dto.userResolution,
    });
    return result;
  }

  async autoResolve(
    adminId: string,
    importId: string,
    filters: { status?: string; entity?: string },
  ) {
    const owner = await this.owner(importId);
    const result = await this.imports.resolveByName(owner.userId, importId, filters);
    await this.audit(adminId, 'admin_import_auto_resolve', importId, {
      userId: owner.userId,
      status: filters.status,
      entity: filters.entity,
      result,
    });
    return result;
  }

  async confirm(adminId: string, importId: string) {
    const owner = await this.owner(importId);
    const result = await this.imports.confirm(owner.userId, importId);
    await this.audit(adminId, 'admin_import_confirm', importId, {
      userId: owner.userId,
      created: result.created,
      skipped: result.skipped,
    });
    return result;
  }

  private async owner(importId: string) {
    const owner = await this.prisma.import.findUnique({
      where: { id: importId },
      select: {
        userId: true,
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            profile: { select: { displayName: true, avatarUrl: true } },
          },
        },
      },
    });
    if (!owner) throw new NotFoundException('Import not found');
    return owner;
  }

  private async audit(
    adminId: string,
    action: string,
    importId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.admin.audit(adminId, action, 'import', importId, metadata).catch((error) => {
      this.logger.error(`Could not audit ${action} for import ${importId}: ${error.message}`);
    });
  }
}
