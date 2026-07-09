import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationScheduler } from '../notifications/notification.scheduler';
import { AdminService } from './admin.service';
import { CronExpression } from '@nestjs/schedule';

interface JobHandler {
  label: string;
  defaultSchedule: string;
  fn: () => Promise<void>;
}

const DEFAULTS: { name: string; label: string; schedule: string }[] = [
  { name: 'episode_notifications', label: 'Episode Notifications', schedule: CronExpression.EVERY_HOUR },
  { name: 'watchlist_reminders', label: 'Watchlist Reminders', schedule: '0 22 * * *' },
  { name: 'tvmaze_airtimes', label: 'TVmaze Air Time Refresh', schedule: '0 7 * * *' },
  { name: 'push_dispatch', label: 'Push Notification Dispatch', schedule: CronExpression.EVERY_5_MINUTES },
];

@Injectable()
export class CronManagerService implements OnModuleInit {
  private readonly logger = new Logger(CronManagerService.name);
  private handlers = new Map<string, JobHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
    private readonly notificationScheduler: NotificationScheduler,
    private readonly adminService: AdminService,
  ) {}

  async onModuleInit() {
    // Register handlers
    this.handlers.set('episode_notifications', { label: 'Episode Notifications', defaultSchedule: CronExpression.EVERY_HOUR, fn: () => this.notificationScheduler.scheduleEpisodeNotifications() });
    this.handlers.set('watchlist_reminders', { label: 'Watchlist Reminders', defaultSchedule: '0 22 * * *', fn: () => this.notificationScheduler.watchlistReminders() });
    this.handlers.set('tvmaze_airtimes', { label: 'TVmaze Air Time Refresh', defaultSchedule: '0 7 * * *', fn: () => this.notificationScheduler.refreshAirtimes() });
    this.handlers.set('push_dispatch', { label: 'Push Notification Dispatch', defaultSchedule: CronExpression.EVERY_5_MINUTES, fn: async () => { /* handled by PushService cron directly */ } });

    // Scheduled hydration runner — runs every hour, executes enabled scheduled hydrations whose cron matches
    this.handlers.set('scheduled_hydrations', { label: 'Scheduled Hydrations', defaultSchedule: CronExpression.EVERY_HOUR, fn: () => this.runScheduledHydrations() });

    // Seed defaults
    for (const d of DEFAULTS) {
      await this.prisma.cronJob.upsert({
        where: { name: d.name },
        create: { name: d.name, label: d.label, schedule: d.schedule, enabled: true },
        update: {},
      });
    }

    // Schedule all enabled jobs from DB
    const jobs = await this.prisma.cronJob.findMany();
    for (const job of jobs) {
      if (job.enabled) this.scheduleJob(job);
    }
    this.logger.log(`Loaded ${jobs.length} cron jobs from database`);
  }

  private scheduleJob(job: CronJob) {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      this.logger.warn(`No handler for cron job: ${job.name}`);
      return;
    }

    try {
      // Delete existing if re-scheduling
      if (this.scheduler.doesExist('cron', job.name)) {
        this.scheduler.deleteCronJob(job.name);
      }
    } catch { /* doesn't exist yet */ }

    const cron = require('node-cron');
    const task = cron.schedule(job.schedule, () => this.executeJob(job.name), { scheduled: false });
    this.scheduler.addCronJob(job.name, task as any);
    task.start();
    this.logger.debug(`Scheduled "${job.name}" with: ${job.schedule}`);
  }

  private async executeJob(name: string) {
    const handler = this.handlers.get(name);
    if (!handler) return;

    const job = await this.prisma.cronJob.findUnique({ where: { name } });
    if (!job || !job.enabled) return;

    const startedAt = new Date();
    this.logger.log(`Running cron job: ${job.label}`);

    try {
      await handler.fn();
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await this.prisma.cronJob.update({
        where: { name },
        data: { lastRunAt: startedAt, lastStatus: 'success', lastError: null, lastDurationMs: durationMs, runs: { increment: 1 } },
      });
      await this.prisma.cronJobRun.create({
        data: { jobId: job.id, status: 'success', durationMs, startedAt, finishedAt },
      });
    } catch (e) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const error = (e as Error).message?.slice(0, 500);

      await this.prisma.cronJob.update({
        where: { name },
        data: { lastRunAt: startedAt, lastStatus: 'failed', lastError: error, lastDurationMs: durationMs, runs: { increment: 1 } },
      });
      await this.prisma.cronJobRun.create({
        data: { jobId: job.id, status: 'failed', error, durationMs, startedAt, finishedAt },
      });
      this.logger.error(`Cron job "${job.label}" failed: ${error}`);
    }
  }

  private async runScheduledHydrations() {
    await this.adminService.runScheduledHydrations();
  }

  // ---------------- Admin API ----------------
  async getAll() {
    return this.prisma.cronJob.findMany({ orderBy: { name: 'asc' } });
  }

  async getHistory(name: string, page = 1, pageSize = 20) {
    const job = await this.prisma.cronJob.findUnique({ where: { name } });
    if (!job) return { items: [], total: 0 };
    const [items, total] = await Promise.all([
      this.prisma.cronJobRun.findMany({ where: { jobId: job.id }, orderBy: { startedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.cronJobRun.count({ where: { jobId: job.id } }),
    ]);
    return { items, total, page, pageSize };
  }

  async update(adminId: string, name: string, data: { schedule?: string; enabled?: boolean }) {
    const job = await this.prisma.cronJob.update({ where: { name }, data });
    // Re-schedule or delete
    try { this.scheduler.deleteCronJob(name); } catch {}
    if (job.enabled) this.scheduleJob(job);
    this.logger.log(`Cron job "${name}" updated: schedule=${job.schedule} enabled=${job.enabled}`);
    return job;
  }

  async triggerNow(adminId: string, name: string) {
    await this.executeJob(name);
    return { ok: true };
  }
}
