import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ANNOUNCEMENT_TARGETS,
  type AnnouncementAction,
  type AnnouncementActionParams,
  type AnnouncementDto,
  type AnnouncementTarget,
  type LocaleText,
  SUPPORTED_LOCALES,
} from '@tvwatch/shared';
import type { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto/announcement.dto';
import { BroadcastService } from './broadcast.service';

/** Navigation targets (actionType=navigate). Excludes 'none' and 'external'. */
const NAV_TARGETS = ANNOUNCEMENT_TARGETS.filter((t) => t !== 'none' && t !== 'external');
const NAV_TARGET_SET = new Set<string>(NAV_TARGETS);
const LOCALE_SET = new Set<string>(SUPPORTED_LOCALES.map((l) => l.code));
const ALLOWED_ICONS = new Set([
  'information-circle-outline',
  'megaphone-outline',
  'download-outline',
  'notifications-outline',
  'bulb-outline',
  'gift-outline',
  'star-outline',
  'trophy-outline',
  'flame-outline',
  'sparkles-outline',
  'calendar-outline',
  'pricetag-outline',
  'film-outline',
  'tv-outline',
  'list-outline',
  'people-outline',
  'chatbubble-outline',
  'warning-outline',
  'checkmark-circle-outline',
  'rocket-outline',
]);

@Injectable()
export class AnnouncementService {
  private readonly logger = new Logger(AnnouncementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: BroadcastService,
  ) {}

  // ---------------- Read ----------------

  /** Active announcement for the public endpoint (mobile banner). */
  async getActive(): Promise<AnnouncementDto | null> {
    const a = await this.prisma.announcement.findFirst({ where: { active: true } });
    return a ? this.toDto(a) : null;
  }

  async list() {
    const rows = await this.prisma.announcement.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({
      ...this.toDto(r),
      alsoPush: r.alsoPush,
      pushSentAt: r.pushSentAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async get(id: string) {
    const a = await this.prisma.announcement.findUnique({ where: { id } });
    if (!a) throw new NotFoundException('Announcement not found');
    return a;
  }

  // ---------------- Write ----------------

  async create(adminId: string, dto: CreateAnnouncementDto) {
    this.validateLocaleText(dto.title, 'title');
    this.validateLocaleText(dto.message, 'message');
    if (dto.actionLabel) this.validateLocaleText(dto.actionLabel, 'actionLabel', true);
    const icon = this.normalizeIcon(dto.icon);
    const actionTarget = this.validateAction(dto.actionTarget, dto.actionParams);

    const created = await this.prisma.announcement.create({
      data: {
        icon,
        title: dto.title,
        message: dto.message,
        actionLabel: (dto.actionLabel ?? null) as any,
        actionTarget,
        actionParams: (dto.actionParams ?? undefined) as any,
        placement: dto.placement ?? 'shows',
        alsoPush: dto.alsoPush ?? false,
        active: false, // activate explicitly
        createdBy: adminId,
      },
    });

    if (dto.active) {
      return this.activate(adminId, created.id, { alsoPush: dto.alsoPush ?? false });
    }
    return this.toDto(created);
  }

  async update(adminId: string, id: string, dto: UpdateAnnouncementDto) {
    const existing = await this.get(id);
    const data: any = {};
    if (dto.icon !== undefined) data.icon = this.normalizeIcon(dto.icon);
    if (dto.title !== undefined) {
      this.validateLocaleText(dto.title, 'title');
      data.title = dto.title;
    }
    if (dto.message !== undefined) {
      this.validateLocaleText(dto.message, 'message');
      data.message = dto.message;
    }
    if (dto.actionLabel !== undefined) {
      if (dto.actionLabel) this.validateLocaleText(dto.actionLabel, 'actionLabel', true);
      data.actionLabel = dto.actionLabel ?? null;
    }
    if (dto.actionTarget !== undefined || dto.actionParams !== undefined) {
      const target = dto.actionTarget !== undefined ? dto.actionTarget : existing.actionTarget;
      const params =
        dto.actionParams !== undefined ? dto.actionParams : (existing.actionParams as any);
      data.actionTarget = this.validateAction(target, params);
      data.actionParams = (params ?? null) as any;
    }
    if (dto.placement !== undefined) data.placement = dto.placement;
    if (dto.alsoPush !== undefined) data.alsoPush = dto.alsoPush;

    const updated = await this.prisma.announcement.update({ where: { id }, data });
    return this.toDto(updated);
  }

  async remove(adminId: string, id: string) {
    await this.get(id);
    await this.prisma.announcement.delete({ where: { id } });
    return { ok: true };
  }

  /** Set as the single active announcement. Optionally fire a one-shot broadcast push. */
  async activate(adminId: string, id: string, opts: { alsoPush?: boolean }) {
    const a = await this.get(id);
    await this.prisma.$transaction([
      this.prisma.announcement.updateMany({ where: { active: true }, data: { active: false } }),
      this.prisma.announcement.update({ where: { id }, data: { active: true } }),
    ]);

    let pushed = false;
    if (opts.alsoPush && a.pushSentAt === null) {
      const fresh = await this.prisma.announcement.findUnique({ where: { id } });
      if (fresh) {
        await this.broadcast.sendFromAnnouncement(fresh, { inApp: false, createdBy: adminId });
        await this.prisma.announcement.update({ where: { id }, data: { pushSentAt: new Date() } });
        pushed = true;
      }
    }
    const result = await this.prisma.announcement.findUnique({ where: { id } });
    return { ...this.toDto(result!), pushed };
  }

  async deactivate(adminId: string, id: string) {
    await this.get(id);
    await this.prisma.announcement.update({ where: { id }, data: { active: false } });
    return { ok: true };
  }

  /** Re-show the banner to everyone (bump revision). Does NOT re-push. */
  async bumpRevision(adminId: string, id: string) {
    await this.get(id);
    const updated = await this.prisma.announcement.update({
      where: { id },
      data: { revision: { increment: 1 } },
    });
    return this.toDto(updated);
  }

  /** Broadcast the active announcement's push now (even if already pushed before). */
  async sendPushNow(adminId: string, id: string) {
    const a = await this.get(id);
    await this.broadcast.sendFromAnnouncement(a, { inApp: false, createdBy: adminId });
    await this.prisma.announcement.update({ where: { id }, data: { pushSentAt: new Date() } });
    return { ok: true };
  }

  // ---------------- Validation helpers ----------------

  private validateLocaleText(map: any, field: string, allowEmpty = false) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new BadRequestException(`${field} must be an object of locale → string`);
    }
    const en = map.en;
    if (!allowEmpty && (typeof en !== 'string' || en.trim() === '')) {
      throw new BadRequestException(`${field}.en is required`);
    }
    for (const key of Object.keys(map)) {
      if (!LOCALE_SET.has(key)) {
        throw new BadRequestException(`${field}: unsupported locale "${key}"`);
      }
      if (typeof map[key] !== 'string') {
        throw new BadRequestException(`${field}.${key} must be a string`);
      }
    }
  }

  private normalizeIcon(icon?: string): string {
    const i = (icon ?? 'information-circle-outline').trim();
    return ALLOWED_ICONS.has(i) ? i : 'information-circle-outline';
  }

  /** Validate action target + params; returns the normalized target string (or null). */
  private validateAction(target: any, params: any): string | null {
    if (target === undefined || target === null || target === 'none') return 'none';
    if (typeof target !== 'string') throw new BadRequestException('actionTarget must be a string');
    if (target === 'external') {
      if (!params?.url || typeof params.url !== 'string') {
        throw new BadRequestException('actionParams.url is required for external action');
      }
      return 'external';
    }
    if (!NAV_TARGET_SET.has(target)) {
      throw new BadRequestException(
        `actionTarget must be one of: none, external, ${NAV_TARGETS.join(', ')}`,
      );
    }
    if (target === 'show' && !params?.showId) {
      throw new BadRequestException('actionParams.showId is required for show target');
    }
    if (target === 'list' && !params?.listId) {
      throw new BadRequestException('actionParams.listId is required for list target');
    }
    return target;
  }

  // ---------------- Mapper ----------------

  private toDto(a: any): AnnouncementDto {
    return {
      id: a.id,
      revision: a.revision,
      icon: a.icon,
      title: (a.title ?? {}) as LocaleText,
      message: (a.message ?? {}) as LocaleText,
      actionLabel: a.actionLabel ? (a.actionLabel as LocaleText) : null,
      action: resolveAction(a.actionTarget, a.actionParams as AnnouncementActionParams | null),
    };
  }
}

export function resolveAction(
  target: string | null,
  params: AnnouncementActionParams | null,
): AnnouncementAction {
  if (!target || target === 'none') return { type: 'none', target: 'none' };
  if (target === 'external')
    return { type: 'external', target: 'external', params: { url: params?.url } };
  return { type: 'navigate', target: target as AnnouncementTarget, params: params ?? {} };
}
