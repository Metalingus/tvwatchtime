import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingService } from '../common/setting.service';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { AnnouncementService, resolveAction } from '../notifications/announcement.service';
import { BroadcastService } from '../notifications/broadcast.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
  CreateBroadcastDto,
} from '../notifications/dto/announcement.dto';
import { MediaType } from '@tvwatch/shared';

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
  ) {}

  // ---------------- Dashboard ----------------
  async getStats() {
    const [users, shows, movies, episodes, watchHistory, imports, notifications, suspendedUsers] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.mediaItem.count({ where: { type: 'SHOW' } }),
      this.prisma.mediaItem.count({ where: { type: 'MOVIE' } }),
      this.prisma.episode.count(),
      this.prisma.watchHistory.count(),
      this.prisma.import.count(),
      this.prisma.notification.count(),
      this.prisma.user.count({ where: { isSuspended: true } }),
    ]);

    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getTime() - 30 * 86400000);

    const [newToday, newWeek, newMonth, activeWeek, failedJobs, pendingJobs, tmdbLogs] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.user.count({ where: { createdAt: { gte: weekStart } } }),
      this.prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
      this.prisma.watchHistory.findMany({ where: { watchedAt: { gte: weekStart } }, select: { userId: true }, distinct: ['userId'] }).then((r) => r.length),
      this.prisma.hydrationJob.count({ where: { status: 'failed' } }),
      this.prisma.hydrationJob.count({ where: { status: { in: ['queued', 'running'] } } }),
      this.prisma.pushNotificationJob.count({ where: { status: 'FAILED' } }),
    ]);

    return { users, shows, movies, episodes, watchHistory, imports, notifications, suspendedUsers, newToday, newWeek, newMonth, activeWeek, failedJobs, pendingJobs, tmdbLogs };
  }

  async getCharts() {
    const days = 30;
    const start = new Date(Date.now() - days * 86400000);

    // User growth
    const usersByDay = (await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users WHERE created_at >= ${start}
      GROUP BY DATE(created_at) ORDER BY date`).map((d) => ({ date: String(d.date), count: Number(d.count) }));

    // Watch activity
    const watchByDay = (await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
      SELECT DATE(watched_at) as date, COUNT(*) as count
      FROM watch_history WHERE watched_at >= ${start}
      GROUP BY DATE(watched_at) ORDER BY date`).map((d) => ({ date: String(d.date), count: Number(d.count) }));

    // Media added
    const mediaByDay = (await this.prisma.$queryRaw<{ date: string; count: bigint }[]>`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM media_items WHERE created_at >= ${start}
      GROUP BY DATE(created_at) ORDER BY date`).map((d) => ({ date: String(d.date), count: Number(d.count) }));

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
  async getMedia(opts: { type?: string; search?: string; page?: number; pageSize?: number; status?: string }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 50, 200);
    const where: any = {};
    if (opts.type) where.type = opts.type;
    if (opts.search) where.title = { contains: opts.search, mode: 'insensitive' };
    if (opts.status) where.status = opts.status;

    const [items, total] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        include: { show: true, movie: true, externalIds: { select: { provider: true, value: true } }, _count: { select: { watchlist: true, favorites: true } } },
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
        show: { include: { seasons: { include: { _count: { select: { episodes: true } } }, orderBy: { number: 'asc' } } } },
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
    const where: any = {};
    if (opts.search) where.OR = [{ username: { contains: opts.search, mode: 'insensitive' } }, { email: { contains: opts.search, mode: 'insensitive' } }];
    if (opts.suspended === 'true') where.isSuspended = true;
    if (opts.suspended === 'false') where.isSuspended = false;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { profile: true, _count: { select: { showStatuses: true, watchHistory: true, comments: true } } },
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
        _count: { select: { showStatuses: true, movieStatuses: true, watchHistory: true, comments: true, commentLikes: true, favorites: true, watchlist: true, lists: true, notifications: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const recentActivity = await this.prisma.watchHistory.findMany({ where: { userId: id }, orderBy: { watchedAt: 'desc' }, take: 10, include: { media: { select: { title: true, posterUrl: true } } } });
    return { ...user, recentActivity };
  }

  async updateUser(adminId: string, userId: string, dto: { role?: string; isSuspended?: boolean }) {
    const data: any = {};
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.isSuspended !== undefined) data.isSuspended = dto.isSuspended;
    const updated = await this.prisma.user.update({ where: { id: userId }, data, select: { id: true, username: true, role: true, isSuspended: true } });
    await this.audit(adminId, 'update_user', 'user', userId, { role: dto.role, isSuspended: dto.isSuspended });
    return updated;
  }

  async sendTestPush(adminId: string, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    if (!user) throw new NotFoundException('User not found');
    const devices = await this.prisma.device.findMany({ where: { userId, active: true } });
    if (devices.length === 0) return { sent: false, devices: 0 };

    const expoToken = this.config.get<string>('push.expoAccessToken');
    if (!expoToken) return { sent: false, devices: devices.length, error: 'No Expo token configured' };

    const tokens = devices.filter((d) => d.token.startsWith('ExponentPushToken')).map((d) => d.token);
    if (tokens.length === 0) return { sent: false, devices: devices.length, error: 'No Expo push tokens' };

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${expoToken}` },
      body: JSON.stringify(tokens.map((to) => ({
        to,
        title: '🔔 Test Notification',
        body: `This is a test push from admin for ${user.username}`,
        data: { type: 'admin_test' },
        sound: 'default',
      }))),
    });

    await this.audit(adminId, 'test_push', 'user', userId, { devices: tokens.length, success: res.ok });
    return { sent: res.ok, devices: tokens.length };
  }

  // ---------------- Hydration Jobs ----------------
  async triggerHydration(adminId: string, type: string, options?: { tmdbId?: number; pages?: number }) {
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
    items = items.filter((i) => { if (seen.has(i.tmdbId)) return false; seen.add(i.tmdbId); return true; });

    // Create job
    const job = await this.prisma.hydrationJob.create({
      data: {
        type: type as any,
        status: 'running',
        triggeredBy: adminId,
        totalItems: items.length,
        startedAt: new Date(),
        items: { create: items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType, status: 'pending' })) },
      },
      include: { _count: { select: { items: true } } },
    });

    // Process items (async, don't await — let it run in background)
    this.processHydrationJob(job.id, type, adminId).catch((e) =>
      this.logger.error(`Hydration job ${job.id} failed: ${(e as Error).message}`),
    );

    await this.audit(adminId, 'trigger_hydration', 'job', job.id, { type, totalItems: items.length, estimatedApiCalls });
    return { jobId: job.id, totalItems: items.length, estimatedApiCalls, status: 'running' };
  }

  private async processHydrationJob(jobId: string, type: string, adminId: string) {
    const items = await this.prisma.hydrationJobItem.findMany({ where: { jobId, status: 'pending' } });
    let processed = 0, failed = 0, skipped = 0, apiCalls = 0;

    for (const item of items) {
      try {
        await this.prisma.hydrationJobItem.update({ where: { id: item.id }, data: { status: 'processing', processedAt: new Date() } });
        await this.prisma.hydrationJob.update({ where: { id: jobId }, data: { currentItem: `TMDb #${item.tmdbId} (${item.mediaType})`, processedItems: processed + failed + skipped } });

        let mediaId: string;
        if (item.mediaType === 'SHOW') {
          mediaId = await this.meta.ensureShowFull(item.tmdbId);
          apiCalls += 3;
        } else {
          mediaId = await this.meta.ensureMovieFull(item.tmdbId);
          apiCalls += 1;
        }

        await this.prisma.hydrationJobItem.update({ where: { id: item.id }, data: { status: 'done', mediaId, processedAt: new Date() } });
        processed++;
      } catch (e) {
        await this.prisma.hydrationJobItem.update({ where: { id: item.id }, data: { status: 'failed', errorMessage: (e as Error).message?.slice(0, 500) } });
        failed++;
      }
      await this.prisma.hydrationJob.update({ where: { id: jobId }, data: { processedItems: processed + failed + skipped, failedItems: failed, tmdbApiCalls: apiCalls } });
    }

    await this.prisma.hydrationJob.update({
      where: { id: jobId },
      data: { status: failed > 0 && processed === 0 ? 'failed' : 'completed', completedAt: new Date(), processedItems: processed + failed + skipped, failedItems: failed, tmdbApiCalls: apiCalls },
    });
    this.logger.log(`Hydration job ${jobId} (${type}): ${processed} done, ${failed} failed, ${apiCalls} API calls`);
  }

  async getJobs(opts: { page?: number; pageSize?: number; status?: string }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 20, 100);
    const where: any = {};
    if (opts.status) where.status = opts.status;
    const [jobs, total] = await Promise.all([
      this.prisma.hydrationJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.hydrationJob.count({ where }),
    ]);
    return { items: jobs, total, page, pageSize };
  }

  async getJobDetail(id: string) {
    const job = await this.prisma.hydrationJob.findUnique({ where: { id }, include: { items: { orderBy: { createdAt: 'asc' }, take: 200 } } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async cancelJob(adminId: string, jobId: string) {
    const job = await this.prisma.hydrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'running' && job.status !== 'queued') throw new BadRequestException('Job is not running');
    await this.prisma.hydrationJob.update({ where: { id: jobId }, data: { status: 'cancelled', completedAt: new Date() } });
    await this.prisma.hydrationJobItem.updateMany({ where: { jobId, status: { in: ['pending', 'processing'] } }, data: { status: 'skipped' } });
    await this.audit(adminId, 'cancel_job', 'job', jobId);
    return { ok: true, status: 'cancelled' };
  }

  async retryJob(adminId: string, jobId: string) {
    const job = await this.prisma.hydrationJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    // Reset failed items to pending
    await this.prisma.hydrationJobItem.updateMany({ where: { jobId, status: 'failed' }, data: { status: 'pending', errorMessage: null } });
    await this.prisma.hydrationJob.update({ where: { id: jobId }, data: { status: 'running', failedItems: 0, startedAt: new Date(), completedAt: null } });
    // Re-run
    this.processHydrationJob(jobId, job.type, adminId).catch((e) =>
      this.logger.error(`Retry job ${jobId} failed: ${(e as Error).message}`),
    );
    await this.audit(adminId, 'retry_job', 'job', jobId);
    return { ok: true, status: 'running' };
  }

  // ---------------- Logs / Audit ----------------
  async getAuditLogs(opts: { page?: number; pageSize?: number; action?: string; adminId?: string }) {
    const page = opts.page || 1;
    const pageSize = Math.min(opts.pageSize || 50, 200);
    const where: any = {};
    if (opts.action) where.action = { contains: opts.action, mode: 'insensitive' };
    if (opts.adminId) where.adminId = opts.adminId;
    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.adminAuditLog.count({ where }),
    ]);
    return { items: logs, total, page, pageSize };
  }

  async getAdmins() {
    return this.prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN', 'CONTENT_MANAGER', 'SUPPORT', 'VIEWER', 'MODERATOR'] } },
      select: { id: true, username: true, email: true, role: true, isSuspended: true, createdAt: true, profile: { select: { avatarUrl: true, displayName: true } } },
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

  async createScheduledHydration(data: { type: string; label: string; schedule: string; pages?: number; enabled?: boolean }) {
    return this.prisma.scheduledHydration.create({
      data: { type: data.type, label: data.label, schedule: data.schedule, pages: data.pages ?? 1, enabled: data.enabled ?? false },
    });
  }

  async updateScheduledHydration(id: string, data: { schedule?: string; pages?: number; enabled?: boolean }) {
    return this.prisma.scheduledHydration.update({ where: { id }, data });
  }

  async deleteScheduledHydration(id: string) {
    return this.prisma.scheduledHydration.delete({ where: { id } });
  }

  async triggerScheduledHydration(adminId: string, id: string) {
    const sched = await this.prisma.scheduledHydration.findUnique({ where: { id } });
    if (!sched) throw new NotFoundException('Scheduled hydration not found');
    const result = await this.triggerHydration(adminId, sched.type, { pages: sched.pages });
    await this.prisma.scheduledHydration.update({ where: { id }, data: { lastRunAt: new Date(), lastJobId: result.jobId } });
    return result;
  }

  /** Called by cron manager — runs all enabled scheduled hydrations. */
  async runScheduledHydrations() {
    const enabled = await this.prisma.scheduledHydration.findMany({ where: { enabled: true } });
    for (const sched of enabled) {
      try {
        const result = await this.triggerHydration('system', sched.type, { pages: sched.pages });
        await this.prisma.scheduledHydration.update({ where: { id: sched.id }, data: { lastRunAt: new Date(), lastJobId: result.jobId } });
        this.logger.log(`Scheduled hydration "${sched.label}" triggered: ${result.totalItems} items`);
      } catch (e) {
        this.logger.error(`Scheduled hydration "${sched.label}" failed: ${(e as Error).message}`);
      }
    }
  }
  async getFeatureFlags() {
    const flags = await this.prisma.featureFlag.findMany();
    const defaults = [
      { key: 'comments_enabled', value: true },
      { key: 'public_profiles', value: true },
      { key: 'imports_enabled', value: true },
      { key: 'push_notifications', value: true },
      { key: 'recommendations', value: true },
    ];
    for (const d of defaults) {
      if (!flags.find((f) => f.key === d.key)) {
        await this.prisma.featureFlag.upsert({ where: { key: d.key }, create: d, update: {} });
      }
    }
    return this.prisma.featureFlag.findMany();
  }

  async updateFeatureFlag(adminId: string, key: string, value: boolean) {
    const flag = await this.prisma.featureFlag.upsert({ where: { key }, create: { key, value }, update: { value } });
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
    await this.audit(adminId, 'activate_announcement', 'announcement', id, { alsoPush, pushed: result.pushed });
    return result;
  }

  async deactivateAnnouncement(adminId: string, id: string) {
    const result = await this.announcements.deactivate(adminId, id);
    await this.audit(adminId, 'deactivate_announcement', 'announcement', id);
    return result;
  }

  async reshowAnnouncement(adminId: string, id: string) {
    const result = await this.announcements.bumpRevision(adminId, id);
    await this.audit(adminId, 'reshow_announcement', 'announcement', id, { revision: result.revision });
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
    await this.audit(adminId, 'create_broadcast', 'broadcast', broadcastId, { inApp: dto.inApp ?? false });
    return { broadcastId, status: 'queued' };
  }

  // ---------------- Audit helper ----------------
  private async audit(adminId: string, action: string, targetType?: string, targetId?: string, metadata?: any) {
    await this.prisma.adminAuditLog.create({ data: { adminId, action, targetType, targetId, metadata } });
  }
}
