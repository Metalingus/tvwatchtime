import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationCategory } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PushService } from './push.service';
import { dbLangToDto } from '../common/utils/mapper.util';
import {
  announcementActionToRoute,
  type AnnouncementAction,
  type AnnouncementActionParams,
  type AnnouncementTarget,
  type LocaleText,
} from '@tvwatch/shared';
import { resolveAction } from './announcement.service';
import type { CreateBroadcastDto } from './dto/announcement.dto';

const DEFAULT_CATEGORY: NotificationCategory = 'ANNOUNCEMENT';
const PAGE_SIZE = 500;

export interface BroadcastInput {
  title: LocaleText;
  body?: LocaleText;
  action?: AnnouncementAction;
  inApp: boolean;
  category?: NotificationCategory;
  createdBy: string;
}

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly config: ConfigService,
  ) {}

  /** Fan out a broadcast push (and optionally in-app notifications) to all users.
   *  Runs synchronously within the request for small audiences; for large ones the
   *  caller should not await (admin endpoints fire-and-forget). Returns the broadcast id. */
  async send(input: BroadcastInput): Promise<string> {
    const category = (input.category as NotificationCategory) || DEFAULT_CATEGORY;
    const broadcast = await this.prisma.broadcast.create({
      data: {
        title: input.title as any,
        body: (input.body ?? null) as any,
        category,
        actionType: input.action?.type ?? null,
        actionTarget: (input.action?.target as string) ?? null,
        actionParams: (input.action?.params ?? null) as any,
        inApp: input.inApp,
        status: 'running',
        startedAt: new Date(),
        createdBy: input.createdBy,
      },
    });

    // Fire-and-forget the actual fan-out so the admin request returns immediately.
    this.fanOut(broadcast.id, input, category).catch((e) => {
      this.logger.error(`Broadcast ${broadcast.id} failed: ${(e as Error).message}`);
    });
    return broadcast.id;
  }

  /** Send a broadcast from an existing announcement record. */
  async sendFromAnnouncement(
    a: { id: string; title: any; message: any; actionTarget: string | null; actionParams: any },
    opts: { inApp: boolean; createdBy: string },
  ): Promise<string> {
    return this.send({
      title: a.title as LocaleText,
      body: a.message as LocaleText,
      action: resolveAction(a.actionTarget, a.actionParams as AnnouncementActionParams | null),
      inApp: opts.inApp,
      createdBy: opts.createdBy,
    });
  }

  async list() {
    return this.prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async get(id: string) {
    return this.prisma.broadcast.findUnique({ where: { id } });
  }

  // ---------------- internals ----------------

  private async fanOut(broadcastId: string, input: BroadcastInput, category: NotificationCategory) {
    let totalRecipients = 0;
    let sent = 0;
    let failed = 0;
    let inAppRows = 0;

    const pushData = {
      category,
      actionType: input.action?.type,
      actionTarget: input.action?.target as AnnouncementTarget | undefined,
      actionParams: input.action?.params,
      broadcastId,
    };
    const link = announcementActionToRoute(input.action);

    try {
      let page = 0;
      // Iterate users in pages to keep memory bounded.
      while (true) {
        const users = await this.prisma.user.findMany({
          where: input.inApp ? {} : { devices: { some: { active: true } } },
          skip: page * PAGE_SIZE,
          take: PAGE_SIZE,
          orderBy: { id: 'asc' },
          select: {
            id: true,
            profile: { select: { languagePreference: true } },
            devices: { where: { active: true } },
          },
        });
        if (users.length === 0) break;

        // ---- Push fan-out: group this page's devices by resolved locale ----
        const byLocale = new Map<
          string,
          {
            id: string;
            token: string;
            platform: string;
            pushP256dh: string | null;
            pushAuth: string | null;
          }[]
        >();
        const pushUserIds: string[] = [];
        for (const u of users) {
          const lp = u.profile?.languagePreference;
          const locale = lp ? dbLangToDto(lp) : 'system';
          const lang = locale === 'system' ? 'en' : locale;
          if (u.devices.length > 0) pushUserIds.push(u.id);
          for (const d of u.devices) {
            const arr = byLocale.get(lang) ?? [];
            arr.push({
              id: d.id,
              token: d.token,
              platform: d.platform,
              pushP256dh: d.pushP256dh,
              pushAuth: d.pushAuth,
            });
            byLocale.set(lang, arr);
          }
        }
        totalRecipients += pushUserIds.length;

        for (const [lang, devices] of byLocale) {
          const msg = {
            title: pickLocale(input.title, lang),
            body: input.body ? pickLocale(input.body, lang) : undefined,
            data: pushData,
          };
          const res = await this.push.sendToDevices(devices, msg);
          sent += res.sent;
          failed += res.failed;
        }

        // ---- In-app fan-out (optional): respect per-user ANNOUNCEMENT in-app pref ----
        if (input.inApp) {
          const prefs = await this.prisma.notificationPreference.findMany({
            where: { userId: { in: users.map((u) => u.id) } },
            select: { userId: true, preferences: true },
          });
          const prefMap = new Map<string, any>(prefs.map((p) => [p.userId, p.preferences]));
          const rows: any[] = [];
          for (const u of users) {
            const pref = prefMap.get(u.id);
            const catPref = pref?.ANNOUNCEMENT;
            if (catPref && catPref.inApp === false) continue; // opted out
            const lp = dbLangToDto(u.profile?.languagePreference);
            const lang = lp === 'system' ? 'en' : lp;
            rows.push({
              userId: u.id,
              category,
              channel: 'IN_APP',
              title: pickLocale(input.title, lang),
              body: input.body ? pickLocale(input.body, lang) : null,
              link,
              dedupeKey: `broadcast:${broadcastId}`,
            });
          }
          if (rows.length > 0) {
            // createMany skips the unique dedupeKey on conflict for users who already got one
            for (let i = 0; i < rows.length; i += 5000) {
              const chunk = rows.slice(i, i + 5000);
              const r = await this.prisma.notification.createMany({
                data: chunk,
                skipDuplicates: true,
              });
              inAppRows += r.count;
            }
          }
          totalRecipients += rows.length;
        }

        // Persist progress so the admin UI can poll.
        await this.prisma.broadcast.update({
          where: { id: broadcastId },
          data: { totalRecipients, sentCount: sent + inAppRows, failedCount: failed },
        });
        page++;
      }

      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          totalRecipients,
          sentCount: sent + inAppRows,
          failedCount: failed,
        },
      });
      this.logger.log(
        `Broadcast ${broadcastId} complete: ${sent} pushed, ${inAppRows} in-app, ${failed} failed, ${totalRecipients} recipients`,
      );
    } catch (e) {
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          error: (e as Error).message?.slice(0, 500),
          totalRecipients,
          sentCount: sent + inAppRows,
          failedCount: failed,
        },
      });
      this.logger.error(`Broadcast ${broadcastId} failed: ${(e as Error).message}`);
    }
  }
}

/** Pick a locale's text, falling back to English, then to the first available value. */
function pickLocale(map: LocaleText | undefined | null, lang: string): string {
  if (!map) return '';
  if (typeof map[lang] === 'string' && map[lang].trim() !== '') return map[lang];
  if (typeof map.en === 'string') return map.en;
  const first = Object.values(map).find((v) => typeof v === 'string' && v.trim() !== '');
  return first ?? '';
}
