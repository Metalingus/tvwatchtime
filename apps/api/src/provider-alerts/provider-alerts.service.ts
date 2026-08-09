import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ProviderOfferType } from '@prisma/client';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationService } from '../notifications/notification.service';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbClient } from '../media-metadata/providers/tmdb.client';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { requestOfferCountry } from '../common/utils/mapper.util';
import { utcFromZoned, zonedParts } from '../common/utils/timezone.util';

/** Next 15:00 wall-clock in the user's timezone (tomorrow when today's already passed). */
function nextThreePm(tz: string | null, now: Date): Date {
  if (!tz) {
    const d = new Date(now);
    d.setHours(15, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const p = zonedParts(now, tz);
  let t = utcFromZoned(tz, p.year, p.month, p.day, 15, 0);
  if (t <= now) t = utcFromZoned(tz, p.year, p.month, p.day + 1, 15, 0);
  return t;
}

const OFFER_KEY: Record<ProviderOfferType, 'stream' | 'rent' | 'buy'> = {
  STREAM: 'stream',
  RENT: 'rent',
  BUY: 'buy',
};

@Injectable()
export class ProviderAlertsService {
  private readonly logger = new Logger(ProviderAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbClient,
    private readonly canonicalization?: MediaCanonicalizationService,
  ) {}

  private async canonicalMediaId(mediaId: string) {
    return this.canonicalization?.resolveMediaId(mediaId) ?? mediaId;
  }

  // ---------------- Picker catalog ----------------

  /** Providers available in `country` (US fallback) for the alert picker. */
  async catalog(country?: string) {
    const wanted = (country ?? requestOfferCountry()).toUpperCase();
    let rows = await this.prisma.watchProviderCatalog.findMany({
      where: { country: wanted },
      orderBy: { displayPriority: 'asc' },
      take: 60,
    });
    if (rows.length === 0 && wanted !== 'US') {
      rows = await this.prisma.watchProviderCatalog.findMany({
        where: { country: 'US' },
        orderBy: { displayPriority: 'asc' },
        take: 60,
      });
    }
    return rows.map((r) => ({ id: r.tmdbId, name: r.name, logoUrl: r.logoUrl }));
  }

  // ---------------- Alert CRUD ----------------

  async getAlerts(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const rows = await this.prisma.watchProviderAlert.findMany({
      where: { userId, mediaId },
    });
    return rows.map((a) => ({
      offerType: a.offerType,
      country: a.country,
      providerIds: a.providerIds,
      active: a.active,
      notifiedAt: a.notifiedAt?.toISOString() ?? null,
    }));
  }

  async upsertAlert(
    userId: string,
    mediaId: string,
    offerType: ProviderOfferType,
    providerIds: number[],
    country?: string,
  ) {
    mediaId = await this.canonicalMediaId(mediaId);
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: { id: true },
    });
    if (!media) throw new NotFoundException('Media not found');
    const resolvedCountry = (country ?? requestOfferCountry()).toUpperCase();
    await this.prisma.watchProviderAlert.upsert({
      where: { userId_mediaId_offerType: { userId, mediaId, offerType } },
      // Re-arming after a previous notification resets active/notifiedAt.
      create: { userId, mediaId, offerType, country: resolvedCountry, providerIds },
      update: { providerIds, country: resolvedCountry, active: true, notifiedAt: null },
    });
    return this.getAlerts(userId, mediaId);
  }

  async removeAlert(userId: string, mediaId: string, offerType: ProviderOfferType) {
    mediaId = await this.canonicalMediaId(mediaId);
    await this.prisma.watchProviderAlert.deleteMany({ where: { userId, mediaId, offerType } });
    return this.getAlerts(userId, mediaId);
  }

  // ---------------- Catalog sync (weekly cron) ----------------

  /** Full regional provider catalog from TMDB /watch/providers/{movie,tv} per region. */
  async syncCatalog() {
    if (!this.tmdb.enabled) return { skipped: 'tmdb disabled' };
    const regionsRes = await this.tmdb.get<{ results?: { iso_3166_1: string }[] }>(
      '/watch/providers/regions',
    );
    const regions = (regionsRes.results ?? [])
      .map((r) => r.iso_3166_1)
      .filter((c) => /^[A-Z]{2}$/.test(c));
    let upserted = 0;
    let regionCount = 0;
    for (const country of regions) {
      try {
        type Row = {
          provider_id: number;
          provider_name: string;
          logo_path?: string;
          display_priority?: number;
        };
        const [movie, tv] = await Promise.all([
          this.tmdb.get<{ results?: Row[] }>('/watch/providers/movie', { watch_region: country }),
          this.tmdb.get<{ results?: Row[] }>('/watch/providers/tv', { watch_region: country }),
        ]);
        // Merge movie+tv listings, keeping the best (lowest) display priority.
        const merged = new Map<
          number,
          { name: string; logoUrl: string | null; priority: number }
        >();
        for (const p of [...(movie.results ?? []), ...(tv.results ?? [])]) {
          if (!p.provider_name) continue;
          const existing = merged.get(p.provider_id);
          const priority = p.display_priority ?? 999;
          if (!existing || priority < existing.priority) {
            merged.set(p.provider_id, {
              name: p.provider_name,
              logoUrl: this.tmdb.img(p.logo_path, 'w92'),
              priority,
            });
          }
        }
        const seenIds: number[] = [];
        for (const [tmdbId, p] of merged) {
          seenIds.push(tmdbId);
          await this.prisma.watchProviderCatalog.upsert({
            where: { tmdbId_country: { tmdbId, country } },
            create: {
              tmdbId,
              country,
              name: p.name,
              logoUrl: p.logoUrl,
              displayPriority: p.priority,
            },
            update: { name: p.name, logoUrl: p.logoUrl ?? undefined, displayPriority: p.priority },
          });
          upserted++;
        }
        // Providers gone from the region are stale — remove them.
        await this.prisma.watchProviderCatalog.deleteMany({
          where: { country, tmdbId: { notIn: seenIds.length ? seenIds : [-1] } },
        });
        regionCount++;
      } catch (e) {
        this.logger.warn(`catalog sync failed for ${country}: ${(e as Error).message}`);
      }
    }
    return { regions: regionCount, upserted };
  }

  // ---------------- Daily alert check ----------------

  /** Match active alerts against each media's current offers; notify once (15:00 user tz). */
  async checkAlerts() {
    const now = new Date();
    const staleMs = 24 * 60 * 60 * 1000;
    const alerts = await this.prisma.watchProviderAlert.findMany({
      where: {
        active: true,
        media: {
          OR: [
            { canonicalSource: { is: null } },
            { canonicalSource: { is: { status: { not: 'ACTIVE' } } } },
          ],
        },
      },
      include: {
        media: {
          select: {
            id: true,
            type: true,
            title: true,
            posterUrl: true,
            watchProviders: true,
            metadataRefreshedAt: true,
            externalIds: { select: { provider: true, value: true } },
          },
        },
      },
      take: 2000,
    });
    if (alerts.length === 0) return { checked: 0, matched: 0, notified: 0, rehydrated: 0 };

    // Rehydrate stale media first so matching uses fresh offers (bounded per run).
    const staleMedia = new Map<string, (typeof alerts)[number]['media']>();
    for (const a of alerts) {
      const refreshed = a.media.metadataRefreshedAt?.getTime() ?? 0;
      if (now.getTime() - refreshed > staleMs) staleMedia.set(a.mediaId, a.media);
    }
    let rehydrated = 0;
    for (const [mediaId, media] of [...staleMedia].slice(0, 25)) {
      const tmdbExt = media.externalIds.find((e) => e.provider === 'TMDB');
      if (!tmdbExt) continue;
      try {
        if (media.type === MediaType.SHOW) {
          await this.meta.ensureShowFull(Number(tmdbExt.value), undefined, {
            skipAiredSeasons: true,
          });
        } else {
          await this.meta.ensureMovieFull(Number(tmdbExt.value));
        }
        rehydrated++;
      } catch (e) {
        this.logger.debug(`alert rehydrate skipped for ${mediaId}: ${(e as Error).message}`);
      }
    }
    // Re-read blobs for rehydrated media.
    const freshBlobs = new Map<string, any>();
    if (rehydrated > 0) {
      const fresh = await this.prisma.mediaItem.findMany({
        where: { id: { in: [...staleMedia.keys()].slice(0, 25) } },
        select: { id: true, watchProviders: true },
      });
      for (const f of fresh) freshBlobs.set(f.id, f.watchProviders);
    }

    const blobOf = (mediaId: string, fallback: any) => freshBlobs.get(mediaId) ?? fallback;

    // First pass: find matches, then batch-load timezones for those users.
    const matched: { alert: (typeof alerts)[number]; names: string[] }[] = [];
    for (const alert of alerts) {
      const blob = blobOf(alert.mediaId, alert.media.watchProviders) as Record<string, any> | null;
      const entry = blob?.[alert.country] ?? null;
      const list: { id: number; name: string }[] = entry?.[OFFER_KEY[alert.offerType]] ?? [];
      const hits = alert.providerIds.length
        ? list.filter((p) => alert.providerIds.includes(p.id))
        : list;
      if (hits.length > 0) {
        matched.push({ alert, names: hits.map((h) => h.name) });
      }
    }
    if (matched.length === 0) {
      return { checked: alerts.length, matched: 0, notified: 0, rehydrated };
    }

    const userIds = [...new Set(matched.map((m) => m.alert.userId))];
    const [devices, prefs] = await Promise.all([
      this.prisma.device.findMany({
        where: { userId: { in: userIds }, active: true, timezone: { not: null } },
        select: { userId: true, timezone: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.notificationPreference.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, timezone: true },
      }),
    ]);
    const tzByUser = new Map<string, string>();
    for (const p of prefs) if (p.timezone) tzByUser.set(p.userId, p.timezone);
    for (const d of devices) {
      if (d.timezone && !tzByUser.has(d.userId)) tzByUser.set(d.userId, d.timezone);
    }

    let notified = 0;
    for (const { alert, names } of matched) {
      const verb =
        alert.offerType === 'STREAM'
          ? 'is now streaming'
          : alert.offerType === 'RENT'
            ? 'is now available to rent'
            : 'is now available to buy';
      const shown = names.slice(0, 3).join(', ');
      const suffix = names.length > 3 ? ` and ${names.length - 3} more` : '';
      const link =
        alert.media.type === MediaType.SHOW
          ? `tvwatchtime://show/${alert.mediaId}`
          : `tvwatchtime://movie/${alert.mediaId}`;
      await this.notifications.createForUser(alert.userId, {
        category: 'PROVIDER_ALERT',
        title: `▶️ ${alert.media.title} ${verb}`,
        body: `Available on ${shown}${suffix} (${alert.country})`,
        imageUrl: alert.media.posterUrl,
        link,
        dedupeKey: `provider-alert:${alert.id}`,
        push: true,
        pushAt: nextThreePm(tzByUser.get(alert.userId) ?? null, now),
      });
      // One-shot: disable so tomorrow's run doesn't re-notify.
      await this.prisma.watchProviderAlert.update({
        where: { id: alert.id },
        data: { active: false, notifiedAt: now },
      });
      notified++;
    }
    return { checked: alerts.length, matched: matched.length, notified, rehydrated };
  }
}
