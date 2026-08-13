import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { ExternalProvider, MediaCanonicalStatus, ProviderEntityKind } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingService } from '../common/setting.service';
import { RedisService } from '../common/redis/redis.service';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { MetadataBackfillService } from '../media-metadata/metadata-backfill.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { ProviderConfigService } from '../media-metadata/providers/shared/provider-config.service';
import { AnnouncementService, resolveAction } from '../notifications/announcement.service';
import { BroadcastService } from '../notifications/broadcast.service';
import { PushService } from '../notifications/push.service';
import { ContactService } from '../contact/contact.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
  CreateBroadcastDto,
} from '../notifications/dto/announcement.dto';
import { MediaType } from '@tvwatch/shared';
import { UsersService } from '../users/users.service';
import { isDeletedUserAccount } from '../users/lib/deleted-user';

export type HydrationIssueKind =
  'authority_conflict' | 'provider_transient' | 'provider_missing' | 'data_conflict' | 'unknown';

export function classifyHydrationIssue(message?: string | null): {
  kind: HydrationIssueKind;
  retryable: boolean;
} | null {
  if (!message) return null;
  if (
    /structure|remap|belongs to another show|provider mismatch|multiple active|no proven .* target|canonical/i.test(
      message,
    )
  ) {
    return { kind: 'authority_conflict', retryable: false };
  }
  if (/\b404\b|not found|no longer exists|deleted/i.test(message)) {
    return { kind: 'provider_missing', retryable: false };
  }
  if (/\bP2002\b|unique constraint|duplicate key|identity conflict/i.test(message)) {
    return { kind: 'data_conflict', retryable: false };
  }
  if (
    /\b429\b|rate.?limit|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|\b50[0234]\b|circuit.*open|temporar|fetch failed|socket|network/i.test(
      message,
    )
  ) {
    return { kind: 'provider_transient', retryable: true };
  }
  return { kind: 'unknown', retryable: false };
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly settings: SettingService,
    private readonly config: ConfigService,
    private readonly announcements: AnnouncementService,
    private readonly broadcasts: BroadcastService,
    private readonly push: PushService,
    private readonly contact: ContactService,
    private readonly providerConfig: ProviderConfigService,
    private readonly redis: RedisService,
    private readonly users: UsersService,
    private readonly metadataBackfill?: MetadataBackfillService,
    private readonly events?: EventEmitter2,
    private readonly canonical?: MediaCanonicalizationService,
  ) {}

  // ---------------- Provider status (multi-provider metrics console) ----------------
  /** Per-provider resilience config + circuit-breaker state + daily metrics. Secrets never included. */
  async getProviderStatus() {
    const today = new Date().toISOString().slice(0, 10);
    const cfgs: Record<string, ReturnType<ProviderConfigService['tmdb']>> = {
      tmdb: this.providerConfig.tmdb(),
      tvdb: this.providerConfig.tvdb(),
      kitsu: this.providerConfig.kitsu(),
      jikan: this.providerConfig.jikan(),
    } as any;
    const out: any[] = [];
    for (const tag of Object.keys(cfgs)) {
      const cfg = await cfgs[tag];
      const cbOpen = await this.redis.get<number>(`CB:${tag}:open`);
      let metrics: Record<string, string> = {};
      try {
        metrics = (await (this.redis.client as any).hgetall(`M:${tag}:${today}`)) ?? {};
      } catch {
        metrics = {};
      }
      out.push({
        tag,
        enabled: cfg.enabled,
        baseUrl: cfg.baseUrl ?? null,
        rps: cfg.rps,
        rpm: cfg.rpm,
        concurrency: cfg.concurrency,
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
        backoffBaseMs: cfg.backoffBaseMs,
        backoffMaxMs: cfg.backoffMaxMs,
        cacheTtlSec: cfg.cacheTtlSec,
        negativeCacheTtlSec: cfg.negativeCacheTtlSec,
        circuitOpen: cbOpen !== null,
        metrics,
      });
    }
    return out;
  }

  // ---------------- Dashboard ----------------
  async getStats() {
    const [users, shows, movies, episodes, watchHistory, imports, notifications, suspendedUsers] =
      await Promise.all([
        this.prisma.user.count({ where: { isShadow: false } }),
        this.prisma.mediaItem.count({ where: { type: 'SHOW' } }),
        this.prisma.mediaItem.count({ where: { type: 'MOVIE' } }),
        this.prisma.episode.count({ where: { structureState: 'ACTIVE' } }),
        this.prisma.watchHistory.count(),
        this.prisma.import.count(),
        this.prisma.notification.count(),
        this.prisma.user.count({ where: { isSuspended: true, isShadow: false } }),
      ]);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getTime() - 30 * 86400000);

    const [newToday, newWeek, newMonth, activeWeek, failedJobs, pendingJobs, tmdbLogs] =
      await Promise.all([
        this.prisma.user.count({ where: { createdAt: { gte: todayStart }, isShadow: false } }),
        this.prisma.user.count({ where: { createdAt: { gte: weekStart }, isShadow: false } }),
        this.prisma.user.count({ where: { createdAt: { gte: monthStart }, isShadow: false } }),
        this.prisma.watchHistory
          .findMany({
            where: { watchedAt: { gte: weekStart } },
            select: { userId: true },
            distinct: ['userId'],
          })
          .then((r) => r.length),
        this.prisma.hydrationJob.count({ where: { status: 'failed' } }),
        this.prisma.hydrationJob.count({ where: { status: { in: ['queued', 'running'] } } }),
        this.prisma.pushNotificationJob.count({ where: { status: 'FAILED' } }),
      ]);

    return {
      users,
      shows,
      movies,
      episodes,
      watchHistory,
      imports,
      notifications,
      suspendedUsers,
      newToday,
      newWeek,
      newMonth,
      activeWeek,
      failedJobs,
      pendingJobs,
      tmdbLogs,
    };
  }

  async getCharts() {
    const days = 30;
    const start = new Date(Date.now() - days * 86400000);

    // User growth
    const usersByDay = (
      await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users WHERE created_at >= ${start} AND is_shadow = false
      GROUP BY DATE(created_at) ORDER BY date`
    ).map((d) => ({ date: String(d.date), count: Number(d.count) }));

    // Watch activity
    const watchByDay = (
      await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
      SELECT DATE(watched_at) as date, COUNT(*) as count
      FROM watch_history WHERE watched_at >= ${start}
      GROUP BY DATE(watched_at) ORDER BY date`
    ).map((d) => ({ date: String(d.date), count: Number(d.count) }));

    // Media added
    const mediaByDay = (
      await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM media_items WHERE created_at >= ${start}
      GROUP BY DATE(created_at) ORDER BY date`
    ).map((d) => ({ date: String(d.date), count: Number(d.count) }));

    // Most tracked shows
    const topShows = await this.prisma.mediaItem.findMany({
      where: { type: 'SHOW' },
      orderBy: { addedCount: 'desc' },
      take: 10,
      select: { id: true, title: true, posterUrl: true, addedCount: true },
    });

    return { usersByDay, watchByDay, mediaByDay, topShows };
  }

  // ---------------- Media ----------------
  async getMedia(opts: {
    type?: string;
    search?: string;
    page?: number;
    pageSize?: number;
    status?: string;
  }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 50, 200);
    const where: any = {};
    if (opts.type) where.type = opts.type;
    if (opts.search) where.title = { contains: opts.search, mode: 'insensitive' };
    if (opts.status) where.status = opts.status;

    const [items, total] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        include: {
          show: true,
          movie: true,
          externalIds: { select: { provider: true, value: true } },
          _count: { select: { watchlist: true, favorites: true } },
        },
        orderBy: { popularity: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.mediaItem.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getMediaDetail(id: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id },
      include: {
        show: {
          include: {
            seasons: {
              include: { _count: { select: { episodes: true } } },
              orderBy: { number: 'asc' },
            },
          },
        },
        movie: true,
        genres: { include: { genre: true } },
        providers: { include: { provider: true } },
        cast: { include: { castMember: true }, take: 20, orderBy: { sortOrder: 'asc' } },
        externalIds: true,
        _count: { select: { watchlist: true, favorites: true, watchHistory: true } },
      },
    });
    if (!media) throw new NotFoundException('Media not found');
    return media;
  }

  // ---------------- Users ----------------
  async getUsers(opts: { search?: string; page?: number; pageSize?: number; suspended?: string }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 50, 200);
    const where: any = { isShadow: false };
    if (opts.search)
      where.OR = [
        { username: { contains: opts.search, mode: 'insensitive' } },
        { email: { contains: opts.search, mode: 'insensitive' } },
      ];
    if (opts.suspended === 'true') where.isSuspended = true;
    if (opts.suspended === 'false') where.isSuspended = false;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: {
          profile: true,
          _count: {
            select: { showStatuses: true, movieStatuses: true, watchHistory: true, comments: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: users, total, page, pageSize };
  }

  async getUserDetail(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        profile: true,
        authProviders: true,
        devices: true,
        _count: {
          select: {
            showStatuses: true,
            movieStatuses: true,
            watchHistory: true,
            comments: true,
            commentLikes: true,
            favorites: true,
            watchlist: true,
            lists: true,
            notifications: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const recentActivity = await this.prisma.watchHistory.findMany({
      where: { userId: id },
      orderBy: { watchedAt: 'desc' },
      take: 10,
      include: { media: { select: { title: true, posterUrl: true } } },
    });
    return { ...user, recentActivity };
  }

  async updateUser(adminId: string, userId: string, dto: { role?: string; isSuspended?: boolean }) {
    const data: any = {};
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.isSuspended !== undefined) data.isSuspended = dto.isSuspended;
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, username: true, role: true, isSuspended: true },
    });
    await this.audit(adminId, 'update_user', 'user', userId, {
      role: dto.role,
      isSuspended: dto.isSuspended,
    });
    if (dto.isSuspended !== undefined) {
      this.events?.emit('leaderboard.user-changed', { userId });
    }
    return updated;
  }

  async deleteUser(adminId: string, userId: string, confirmUsername: string) {
    if (adminId === userId) throw new BadRequestException('You cannot delete your own account');

    const [actor, target] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: adminId }, select: { role: true } }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, email: true, role: true, isShadow: true },
      }),
    ]);
    if (!actor) throw new ForbiddenException('Admin account not found');
    if (!target) throw new NotFoundException('User not found');
    if (target.isShadow || isDeletedUserAccount(target)) {
      throw new BadRequestException('Deleted or shadow users cannot be deleted from this action');
    }
    if (target.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('SUPER_ADMIN accounts cannot be deleted');
    }
    if (target.role !== 'USER' && actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a SUPER_ADMIN can delete a staff account');
    }
    if (confirmUsername !== target.username) {
      throw new BadRequestException('Username confirmation does not match');
    }

    const audit = await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: 'delete_user',
        targetType: 'user',
        targetId: userId,
        metadata: { username: target.username, targetRole: target.role, status: 'started' },
      },
    });
    let preserved: Awaited<ReturnType<UsersService['deleteUserAccount']>>;
    try {
      preserved = await this.users.deleteUserAccount(userId);
    } catch (e) {
      await this.prisma.adminAuditLog
        .update({
          where: { id: audit.id },
          data: {
            metadata: {
              username: target.username,
              targetRole: target.role,
              status: 'failed',
              error: (e as Error).message?.slice(0, 500),
            },
          },
        })
        .catch(() => undefined);
      throw e;
    }
    await this.prisma.adminAuditLog
      .update({
        where: { id: audit.id },
        data: {
          metadata: {
            username: target.username,
            targetRole: target.role,
            status: 'completed',
            preserved,
          },
        },
      })
      .catch((e) =>
        this.logger.error(
          `Could not finalize delete_user audit ${audit.id}: ${(e as Error).message}`,
        ),
      );
    return { ok: true, preserved };
  }

  async sendTestPush(adminId: string, userId: string, dto?: { movieId?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const movieId = dto?.movieId?.trim();
    const movie = movieId
      ? await this.prisma.mediaItem.findFirst({
          where: { id: movieId, type: 'MOVIE' },
          select: { id: true, title: true },
        })
      : null;
    if (movieId && !movie) throw new NotFoundException('Movie not found');

    const devices = await this.prisma.device.findMany({ where: { userId, active: true } });
    if (devices.length === 0) return { sent: false, devices: 0 };

    // Route through the same delivery pipeline broadcasts/announcements use
    // (web push, FCM, Expo, relay) — the old Expo-only fetch could never surface
    // web-push failures, so a "successful" test proved nothing for web devices.
    const result = await this.push.sendToDevices(devices, {
      title: movie ? 'Test Movie Notification' : '🔔 Test Notification',
      body: movie
        ? `Tap to open ${movie.title}`
        : `This is a test push from admin for ${user.username}`,
      data: movie
        ? { type: 'admin_test', link: `tvwatchtime://movie/${movie.id}` }
        : { type: 'admin_test' },
    });

    await this.audit(adminId, 'test_push', 'user', userId, {
      devices: devices.length,
      pushed: result.sent,
      failed: result.failed,
      movieId: movie?.id,
    });
    return {
      sent: result.sent > 0,
      devices: devices.length,
      pushed: result.sent,
      failed: result.failed,
      movie,
    };
  }

  // ---------------- Hydration Jobs ----------------
  async triggerHydration(
    adminId: string,
    type: string,
    options?: { tmdbId?: number; pages?: number; railSnapshot?: boolean },
  ) {
    if (!this.tmdb.enabled) throw new BadRequestException('TMDb API key not configured');

    let items: { tmdbId: number; mediaType: string }[] = [];
    let estimatedApiCalls = 0;
    const maxPages = Math.min(options?.pages || 1, 10); // cap at 10 pages = 200 items

    switch (type) {
      case 'trending_shows': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.trendingShows('week', p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'SHOW' })));
        }
        estimatedApiCalls = items.length * 4;
        break;
      }
      case 'trending_movies': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.trendingMovies('week', p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'MOVIE' })));
        }
        estimatedApiCalls = items.length;
        break;
      }
      case 'popular_shows': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.discoverShows({ sort: 'popularity.desc', page: p });
          items.push(...res.items.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'SHOW' })));
        }
        estimatedApiCalls = items.length * 4;
        break;
      }
      case 'popular_movies': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.discoverMovies({ sort: 'popularity.desc', page: p });
          items.push(...res.items.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'MOVIE' })));
        }
        estimatedApiCalls = items.length;
        break;
      }
      case 'top_rated_shows': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.topRatedShows(p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'SHOW' })));
        }
        estimatedApiCalls = items.length * 4;
        break;
      }
      case 'top_rated_movies': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.topRatedMovies(p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'MOVIE' })));
        }
        estimatedApiCalls = items.length;
        break;
      }
      case 'upcoming_movies': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.upcomingMovies(p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'MOVIE' })));
        }
        estimatedApiCalls = items.length;
        break;
      }
      case 'now_playing_movies': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.nowPlayingMovies(p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'MOVIE' })));
        }
        estimatedApiCalls = items.length;
        break;
      }
      case 'airing_today': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.airingToday(p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'SHOW' })));
        }
        estimatedApiCalls = items.length * 4;
        break;
      }
      case 'on_the_air': {
        for (let p = 1; p <= maxPages; p++) {
          const res = await this.tmdb.onTheAir(p);
          items.push(...res.map((i) => ({ tmdbId: i.tmdbId, mediaType: 'SHOW' })));
        }
        estimatedApiCalls = items.length * 4;
        break;
      }
      case 'single_show': {
        if (!options?.tmdbId) throw new BadRequestException('tmdbId required for single_show');
        items = [{ tmdbId: options.tmdbId, mediaType: 'SHOW' }];
        estimatedApiCalls = 4;
        break;
      }
      case 'single_movie': {
        if (!options?.tmdbId) throw new BadRequestException('tmdbId required for single_movie');
        items = [{ tmdbId: options.tmdbId, mediaType: 'MOVIE' }];
        estimatedApiCalls = 1;
        break;
      }
      default:
        throw new BadRequestException(`Unknown hydration type: ${type}`);
    }

    // Deduplicate by tmdbId
    const seen = new Set<number>();
    items = items.filter((i) => {
      if (seen.has(i.tmdbId)) return false;
      seen.add(i.tmdbId);
      return true;
    });

    // Create job
    const job = await this.prisma.hydrationJob.create({
      data: {
        type: type as any,
        status: 'running',
        triggeredBy: adminId,
        railSnapshot: options?.railSnapshot ?? false,
        totalItems: items.length,
        startedAt: new Date(),
        items: {
          create: items.map((i, index) => ({
            tmdbId: i.tmdbId,
            mediaType: i.mediaType,
            rank: index + 1,
            status: 'pending',
          })),
        },
      },
      include: { _count: { select: { items: true } } },
    });

    // Process items (async, don't await — let it run in background)
    this.processHydrationJob(job.id, type, adminId, options?.railSnapshot ?? false).catch((e) =>
      this.logger.error(`Hydration job ${job.id} failed: ${(e as Error).message}`),
    );

    await this.audit(adminId, 'trigger_hydration', 'job', job.id, {
      type,
      totalItems: items.length,
      estimatedApiCalls,
    });
    return { jobId: job.id, totalItems: items.length, estimatedApiCalls, status: 'running' };
  }

  private async processHydrationJob(
    jobId: string,
    type: string,
    adminId: string,
    railSnapshot = false,
  ) {
    const [items, startingCounts, jobState] = await Promise.all([
      this.prisma.hydrationJobItem.findMany({ where: { jobId, status: 'pending' } }),
      this.hydrationItemStatusCounts(jobId),
      this.prisma.hydrationJob.findUnique({
        where: { id: jobId },
        select: { totalItems: true, tmdbApiCalls: true },
      }),
    ]);
    if (!jobState) throw new NotFoundException('Hydration job not found');
    const preexistingRailMediaIds = railSnapshot
      ? await this.preexistingRailMediaIds(items)
      : new Map<string, string>();

    let processed = startingCounts.done,
      fallback = startingCounts.fallback,
      failed = startingCounts.failed,
      skipped = startingCounts.skipped,
      apiCalls = jobState.tmdbApiCalls;

    for (const item of items) {
      const fallbackSourceMediaId = preexistingRailMediaIds.get(
        this.hydrationItemIdentityKey(item),
      );
      try {
        await this.prisma.hydrationJobItem.update({
          where: { id: item.id },
          data: { status: 'processing', processedAt: new Date() },
        });
        await this.prisma.hydrationJob.update({
          where: { id: jobId },
          data: {
            currentItem: `TMDb #${item.tmdbId} (${item.mediaType})`,
            processedItems: processed + fallback + failed + skipped,
          },
        });

        let mediaId: string;
        if (item.mediaType === 'SHOW') {
          mediaId = await this.meta.ensureShowFull(item.tmdbId);
          apiCalls += 3;
          // Anime rule: an anime show must NEVER stay TMDB-structured. The show is now
          // hydrated (genres/keywords persisted), so check the REAL signals (classification
          // verdict / anime keyword / Animation genre) and hand it to the anime repair —
          // it resolves the TVDB id, force-hydrates from TVDB, and remaps the structure.
          if (this.metadataBackfill) {
            const row = await this.prisma.mediaItem.findUnique({
              where: { id: mediaId },
              select: {
                contentClassification: true,
                show: { select: { keywords: true } },
                genres: { select: { genre: { select: { slug: true, name: true } } } },
              },
            });
            if (row && this.metadataBackfill.isAnimeMedia(row)) {
              await this.metadataBackfill.fixAnimeShowFromTvdb(mediaId).catch(() => undefined);
            }
          }
        } else {
          mediaId = await this.meta.ensureMovieFull(item.tmdbId);
          apiCalls += 1;
        }

        await this.prisma.hydrationJobItem.update({
          where: { id: item.id },
          data: { status: 'done', mediaId, processedAt: new Date() },
        });
        processed++;
      } catch (e) {
        const errorMessage = ((e as Error).message || String(e)).slice(0, 500);
        // Resolve and validate only after a failure. The source id came from one bulk snapshot
        // taken before any hydration began, so a partially-created row can never qualify.
        const safeFallback = fallbackSourceMediaId
          ? await this.findSafeRailFallbackMedia(item, fallbackSourceMediaId).catch(() => null)
          : null;
        if (safeFallback) {
          await this.prisma.hydrationJobItem.update({
            where: { id: item.id },
            data: {
              status: 'fallback',
              mediaId: safeFallback.id,
              errorMessage,
              processedAt: new Date(),
            },
          });
          fallback++;
          this.logger.warn(
            `Hydration job ${jobId}: retained existing ${safeFallback.title} (${safeFallback.id}) for TMDb #${item.tmdbId}; refresh failed: ${errorMessage}`,
          );
        } else {
          await this.prisma.hydrationJobItem.update({
            where: { id: item.id },
            data: { status: 'failed', errorMessage, processedAt: new Date() },
          });
          failed++;
        }
      }
      await this.prisma.hydrationJob.update({
        where: { id: jobId },
        data: {
          processedItems: processed + fallback + failed + skipped,
          failedItems: failed,
          skippedItems: skipped,
          tmdbApiCalls: apiCalls,
        },
      });
    }

    const terminalItems = processed + fallback + failed + skipped;
    await this.prisma.hydrationJob.update({
      where: { id: jobId },
      data: {
        // A rail activates only when every rank resolves. A failed refresh may reuse an
        // exact pre-existing canonical row, but unresolved/new titles remain fail-closed.
        status: railSnapshot
          ? processed + fallback > 0 && failed === 0 && terminalItems >= jobState.totalItems
            ? 'completed'
            : 'failed'
          : failed > 0 && processed + fallback === 0
            ? 'failed'
            : 'completed',
        completedAt: new Date(),
        processedItems: terminalItems,
        failedItems: failed,
        skippedItems: skipped,
        tmdbApiCalls: apiCalls,
        currentItem: null,
      },
    });
    this.logger.log(
      `Hydration job ${jobId} (${type}): ${processed} done, ${fallback} safe fallback, ${failed} failed, ${apiCalls} recorded API calls`,
    );
  }

  private async hydrationItemStatusCounts(jobId: string) {
    const rows = await this.prisma.hydrationJobItem.groupBy({
      by: ['status'],
      where: { jobId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row._count._all;
    return {
      done: counts.done ?? 0,
      fallback: counts.fallback ?? 0,
      failed: counts.failed ?? 0,
      skipped: counts.skipped ?? 0,
      pending: counts.pending ?? 0,
      processing: counts.processing ?? 0,
    };
  }

  private hydrationItemIdentityKey(item: { tmdbId: number; mediaType: string }) {
    return `${item.mediaType}:${item.tmdbId}`;
  }

  private async preexistingRailMediaIds(items: { tmdbId: number; mediaType: string }[]) {
    const showValues = items
      .filter((item) => item.mediaType === 'SHOW')
      .map((item) => String(item.tmdbId));
    const movieValues = items
      .filter((item) => item.mediaType !== 'SHOW')
      .map((item) => String(item.tmdbId));
    const identityFilters = [
      ...(showValues.length
        ? [{ providerEntityKind: ProviderEntityKind.SERIES, value: { in: showValues } }]
        : []),
      ...(movieValues.length
        ? [{ providerEntityKind: ProviderEntityKind.MOVIE, value: { in: movieValues } }]
        : []),
    ];
    if (identityFilters.length === 0) return new Map<string, string>();
    const externals = await this.prisma.externalId.findMany({
      where: { provider: ExternalProvider.TMDB, OR: identityFilters },
      select: { mediaId: true, value: true, providerEntityKind: true },
    });
    return new Map(
      externals.map((external) => [
        `${external.providerEntityKind === ProviderEntityKind.SERIES ? 'SHOW' : 'MOVIE'}:${external.value}`,
        external.mediaId,
      ]),
    );
  }

  private async findSafeRailFallbackMedia(
    item: { tmdbId: number; mediaType: string },
    sourceMediaId: string,
  ) {
    const expectedType = item.mediaType === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;
    const mediaId = this.canonical
      ? await this.canonical.resolveMediaId(sourceMediaId)
      : sourceMediaId;
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        title: true,
        type: true,
        canonicalSource: { select: { status: true } },
      },
    });
    if (
      !media ||
      media.type !== expectedType ||
      media.canonicalSource?.status === MediaCanonicalStatus.ACTIVE
    ) {
      return null;
    }
    return { id: media.id, title: media.title };
  }

  async getJobs(opts: { page?: number; pageSize?: number; status?: string }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 20, 100);
    const where: any = {};
    if (opts.status) where.status = opts.status;
    const [jobs, total] = await Promise.all([
      this.prisma.hydrationJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { items: { where: { status: 'fallback' } } } },
        },
      }),
      this.prisma.hydrationJob.count({ where }),
    ]);
    return {
      items: jobs.map(({ _count, ...job }) => ({ ...job, warningItems: _count.items })),
      total,
      page,
      pageSize,
    };
  }

  async getJobDetail(id: string) {
    const job = await this.prisma.hydrationJob.findUnique({
      where: { id },
      include: { items: { orderBy: { createdAt: 'asc' }, take: 200 } },
    });
    if (!job) throw new NotFoundException('Job not found');
    const issueItems = job.items.filter(
      (item) => item.status === 'failed' || item.status === 'fallback',
    );
    const directMediaIds = [
      ...new Set(issueItems.flatMap((item) => (item.mediaId ? [item.mediaId] : []))),
    ];
    const showValues = issueItems
      .filter((item) => item.mediaType === 'SHOW')
      .map((item) => String(item.tmdbId));
    const movieValues = issueItems
      .filter((item) => item.mediaType !== 'SHOW')
      .map((item) => String(item.tmdbId));
    const identityFilters = [
      ...(showValues.length
        ? [{ providerEntityKind: ProviderEntityKind.SERIES, value: { in: showValues } }]
        : []),
      ...(movieValues.length
        ? [{ providerEntityKind: ProviderEntityKind.MOVIE, value: { in: movieValues } }]
        : []),
    ];
    const [mediaRows, externalRows] = await Promise.all([
      directMediaIds.length
        ? this.prisma.mediaItem.findMany({
            where: { id: { in: directMediaIds } },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
      identityFilters.length
        ? this.prisma.externalId.findMany({
            where: { provider: ExternalProvider.TMDB, OR: identityFilters },
            select: {
              value: true,
              providerEntityKind: true,
              media: { select: { id: true, title: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const titlesByMediaId = new Map(mediaRows.map((media) => [media.id, media.title]));
    const titlesByIdentity = new Map(
      externalRows.map((external) => [
        `${external.providerEntityKind}:${external.value}`,
        external.media.title,
      ]),
    );
    const failureSummary: Record<string, number> = {};
    const items = job.items.map((item) => {
      const issue = classifyHydrationIssue(item.errorMessage);
      if (issue) failureSummary[issue.kind] = (failureSummary[issue.kind] ?? 0) + 1;
      const entityKind =
        item.mediaType === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
      return {
        ...item,
        title:
          (item.mediaId ? titlesByMediaId.get(item.mediaId) : undefined) ??
          titlesByIdentity.get(`${entityKind}:${item.tmdbId}`) ??
          null,
        issue,
      };
    });
    return { ...job, items, failureSummary };
  }

  async cancelJob(adminId: string, jobId: string) {
    const job = await this.prisma.hydrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'running' && job.status !== 'queued')
      throw new BadRequestException('Job is not running');
    await this.prisma.hydrationJob.update({
      where: { id: jobId },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    await this.prisma.hydrationJobItem.updateMany({
      where: { jobId, status: { in: ['pending', 'processing'] } },
      data: { status: 'skipped' },
    });
    await this.audit(adminId, 'cancel_job', 'job', jobId);
    return { ok: true, status: 'cancelled' };
  }

  async retryJob(adminId: string, jobId: string) {
    const job = await this.prisma.hydrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    // Reset failed items to pending
    const reset = await this.prisma.hydrationJobItem.updateMany({
      where: { jobId, status: 'failed' },
      data: { status: 'pending', errorMessage: null },
    });
    if (reset.count === 0) throw new BadRequestException('Job has no failed items to retry');
    const counts = await this.hydrationItemStatusCounts(jobId);
    await this.prisma.hydrationJob.update({
      where: { id: jobId },
      data: {
        status: 'running',
        processedItems: counts.done + counts.fallback + counts.skipped,
        failedItems: 0,
        skippedItems: counts.skipped,
        currentItem: null,
        startedAt: new Date(),
        completedAt: null,
      },
    });
    // Re-run
    this.processHydrationJob(jobId, job.type, adminId, job.railSnapshot).catch((e) =>
      this.logger.error(`Retry job ${jobId} failed: ${(e as Error).message}`),
    );
    await this.audit(adminId, 'retry_job', 'job', jobId);
    return { ok: true, status: 'running' };
  }

  // ---------------- Logs / Audit ----------------
  async getAuditLogs(opts: {
    page?: number;
    pageSize?: number;
    action?: string;
    adminId?: string;
  }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 50, 200);
    const where: any = {};
    if (opts.action) where.action = { contains: opts.action, mode: 'insensitive' };
    if (opts.adminId) where.adminId = opts.adminId;
    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);
    return { items: logs, total, page, pageSize };
  }

  async getAdmins() {
    return this.prisma.user.findMany({
      where: {
        role: { in: ['SUPER_ADMIN', 'ADMIN', 'CONTENT_MANAGER', 'SUPPORT', 'VIEWER', 'MODERATOR'] },
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isSuspended: true,
        createdAt: true,
        profile: { select: { avatarUrl: true, displayName: true } },
      },
      orderBy: { role: 'desc' },
    });
  }

  // ---------------- Settings ----------------
  async getSettings() {
    return this.settings.getAll();
  }

  async updateSetting(adminId: string, key: string, value: string, encrypted: boolean) {
    await this.settings.set(key, value, encrypted);
    await this.audit(adminId, 'update_setting', 'setting', key, { encrypted });
    return { ok: true };
  }

  async getSettingValue(key: string) {
    return { key, value: await this.settings.getDecrypted(key) };
  }

  // ---------------- Scheduled Hydration ----------------
  async getScheduledHydrations() {
    return this.prisma.scheduledHydration.findMany({ orderBy: { type: 'asc' } });
  }

  async createScheduledHydration(data: {
    type: string;
    label: string;
    schedule: string;
    timezone?: string | null;
    pages?: number;
    enabled?: boolean;
  }) {
    return this.prisma.scheduledHydration.create({
      data: {
        type: data.type,
        label: data.label,
        schedule: data.schedule,
        timezone: data.timezone ?? null,
        pages: data.pages ?? 1,
        enabled: data.enabled ?? false,
      },
    });
  }

  async updateScheduledHydration(
    id: string,
    data: { schedule?: string; pages?: number; enabled?: boolean; timezone?: string | null },
  ) {
    return this.prisma.scheduledHydration.update({ where: { id }, data });
  }

  async deleteScheduledHydration(id: string) {
    return this.prisma.scheduledHydration.delete({ where: { id } });
  }

  async triggerScheduledHydration(adminId: string, id: string) {
    const sched = await this.prisma.scheduledHydration.findUnique({ where: { id } });
    if (!sched) throw new NotFoundException('Scheduled hydration not found');
    const result = await this.triggerHydration(adminId, sched.type, {
      pages: sched.pages,
      railSnapshot: true,
    });
    await this.prisma.scheduledHydration.update({
      where: { id },
      data: { lastRunAt: new Date(), lastJobId: result.jobId },
    });
    return result;
  }

  async getFeatureFlags() {
    const flags = await this.prisma.featureFlag.findMany();
    const defaults = [
      { key: 'comments_enabled', value: true },
      { key: 'public_profiles', value: true },
      { key: 'imports_enabled', value: true },
      { key: 'push_notifications', value: true },
      { key: 'recommendations', value: true },
      { key: 'onboarding_enabled', value: true },
    ];
    for (const d of defaults) {
      if (!flags.find((f) => f.key === d.key)) {
        await this.prisma.featureFlag.upsert({ where: { key: d.key }, create: d, update: {} });
      }
    }
    return this.prisma.featureFlag.findMany();
  }

  async updateFeatureFlag(adminId: string, key: string, value: boolean) {
    const flag = await this.prisma.featureFlag.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    await this.audit(adminId, 'update_feature_flag', 'feature_flag', key, { value });
    return flag;
  }

  // ---------------- Announcements ----------------
  async listAnnouncements() {
    return this.announcements.list();
  }

  async createAnnouncement(adminId: string, dto: CreateAnnouncementDto) {
    const result = await this.announcements.create(adminId, dto);
    await this.audit(adminId, 'create_announcement', 'announcement', result.id);
    return result;
  }

  async updateAnnouncement(adminId: string, id: string, dto: UpdateAnnouncementDto) {
    const result = await this.announcements.update(adminId, id, dto);
    await this.audit(adminId, 'update_announcement', 'announcement', id);
    return result;
  }

  async deleteAnnouncement(adminId: string, id: string) {
    const result = await this.announcements.remove(adminId, id);
    await this.audit(adminId, 'delete_announcement', 'announcement', id);
    return result;
  }

  async activateAnnouncement(adminId: string, id: string, alsoPush: boolean) {
    const result = await this.announcements.activate(adminId, id, { alsoPush });
    await this.audit(adminId, 'activate_announcement', 'announcement', id, {
      alsoPush,
      pushed: result.pushed,
    });
    return result;
  }

  async deactivateAnnouncement(adminId: string, id: string) {
    const result = await this.announcements.deactivate(adminId, id);
    await this.audit(adminId, 'deactivate_announcement', 'announcement', id);
    return result;
  }

  async reshowAnnouncement(adminId: string, id: string) {
    const result = await this.announcements.bumpRevision(adminId, id);
    await this.audit(adminId, 'reshow_announcement', 'announcement', id, {
      revision: result.revision,
    });
    return result;
  }

  async sendAnnouncementPush(adminId: string, id: string) {
    const result = await this.announcements.sendPushNow(adminId, id);
    await this.audit(adminId, 'send_announcement_push', 'announcement', id);
    return result;
  }

  // ---------------- Broadcasts ----------------
  async listBroadcasts() {
    return this.broadcasts.list();
  }

  async getBroadcast(id: string) {
    const b = await this.broadcasts.get(id);
    if (!b) throw new NotFoundException('Broadcast not found');
    return b;
  }

  async createBroadcast(adminId: string, dto: CreateBroadcastDto) {
    const action = resolveAction(dto.actionTarget ?? 'none', dto.actionParams as any);
    const broadcastId = await this.broadcasts.send({
      title: dto.title as any,
      body: (dto.body ?? undefined) as any,
      action,
      inApp: dto.inApp ?? false,
      category: (dto.category as any) ?? 'ANNOUNCEMENT',
      createdBy: adminId,
    });
    await this.audit(adminId, 'create_broadcast', 'broadcast', broadcastId, {
      inApp: dto.inApp ?? false,
    });
    return { broadcastId, status: 'queued' };
  }

  // ---------------- Contact threads ----------------
  async listContacts(opts: {
    status?: string;
    reason?: any;
    unread?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    return this.contact.listForAdmin(opts);
  }

  async getContact(id: string) {
    return this.contact.getForAdmin(id);
  }

  async replyContact(adminId: string, id: string, body: string) {
    const res = await this.contact.replyAsAdmin(adminId, id, { body });
    await this.audit(adminId, 'contact_reply', 'contact_thread', id);
    return res;
  }

  async closeContact(adminId: string, id: string) {
    const res = await this.contact.close(adminId, id);
    await this.audit(adminId, 'contact_close', 'contact_thread', id);
    return res;
  }

  async reopenContact(adminId: string, id: string) {
    const res = await this.contact.reopen(adminId, id);
    await this.audit(adminId, 'contact_reopen', 'contact_thread', id);
    return res;
  }

  // ---------------- Audit helper ----------------
  async audit(
    adminId: string,
    action: string,
    targetType?: string,
    targetId?: string,
    metadata?: any,
  ) {
    await this.prisma.adminAuditLog.create({
      data: { adminId, action, targetType, targetId, metadata },
    });
  }
}
