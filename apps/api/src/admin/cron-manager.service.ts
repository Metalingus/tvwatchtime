import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { NotificationScheduler } from '../notifications/notification.scheduler';
import { MetadataBackfillService } from '../media-metadata/metadata-backfill.service';
import { IdentityHealthAuditService } from '../media-metadata/identity-health-audit.service';
import { IdentityMaintenanceService } from '../media-metadata/identity-maintenance.service';
import { AdminService } from './admin.service';
import { ProviderAlertsService } from '../provider-alerts/provider-alerts.service';
import { IntegrationsService } from '../integrations/integrations.service';

/** An admin-editable job option; values are validated against this spec. */
export type JobOptionSpec =
  | { key: string; label: string; help?: string; type: 'boolean'; default: boolean }
  | {
      key: string;
      label: string;
      help?: string;
      type: 'number';
      default: number;
      min: number;
      max: number;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: 'select';
      default: string;
      choices: string[];
    };

export interface JobContext {
  /** The job's options, resolved against their defaults. */
  config: Record<string, any>;
  /** The latest run's stored result (resumable jobs read their cursors from it). */
  previous: Record<string, unknown> | null;
}

interface JobHandler {
  label: string;
  description: string;
  defaultSchedule: string;
  defaultEnabled?: boolean;
  options?: JobOptionSpec[];
  /** Run history kept per job (the identity audit keeps a long trend). */
  retentionDays?: number;
  fn: (ctx: JobContext) => Promise<unknown>;
}

const CRON_RESULT_BUDGET = 2000;
/** The run lock is short and renewed while the run is alive, so a crashed or restarted
 * process frees it within LOCK_TTL_MS instead of blocking the job for hours. */
const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_RENEW_MS = 30 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const LOCK_PREFIX = 'cron:lock:';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const RENEW_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

/**
 * Bound a handler's outcome summary to the CronJobRun.result size budget WITHOUT
 * breaking JSON: full payload when it fits, otherwise the scalar summary fields plus
 * a truncation marker (array payloads like per-title lists are dropped, counts kept).
 */
export function safeCronResultSummary(result: object): Record<string, unknown> {
  const json = JSON.stringify(result);
  if (json.length <= CRON_RESULT_BUDGET) return result as Record<string, unknown>;
  const compact: Record<string, unknown> = { truncated: true };
  for (const [k, v] of Object.entries(result)) {
    if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      compact[k] = v;
    }
  }
  if (JSON.stringify(compact).length <= CRON_RESULT_BUDGET) return compact;
  return { truncated: true };
}

/** Stored options resolved against the spec: unknown keys dropped, invalid values defaulted. */
export function resolveJobConfig(
  specs: JobOptionSpec[] = [],
  stored: unknown,
): Record<string, any> {
  const raw =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const config: Record<string, any> = {};
  for (const spec of specs) {
    const value = raw[spec.key];
    if (spec.type === 'boolean')
      config[spec.key] = typeof value === 'boolean' ? value : spec.default;
    else if (spec.type === 'number')
      config[spec.key] =
        typeof value === 'number' && Number.isFinite(value)
          ? Math.min(spec.max, Math.max(spec.min, Math.trunc(value)))
          : spec.default;
    else
      config[spec.key] =
        typeof value === 'string' && spec.choices.includes(value) ? value : spec.default;
  }
  return config;
}

/** Strict validation of an admin edit; rejects unknown keys and out-of-range values. */
export function validateJobConfig(
  specs: JobOptionSpec[] = [],
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('config must be an object');
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const spec = byKey.get(key);
    if (!spec) throw new BadRequestException(`Unknown option "${key}"`);
    const valid =
      spec.type === 'boolean'
        ? typeof value === 'boolean'
        : spec.type === 'number'
          ? typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= spec.min &&
            value <= spec.max
          : typeof value === 'string' && spec.choices.includes(value);
    if (!valid) {
      const expected =
        spec.type === 'number'
          ? `an integer ${spec.min}–${spec.max}`
          : spec.type === 'select'
            ? spec.choices.join(' | ')
            : 'true or false';
      throw new BadRequestException(`Option "${spec.label}" must be ${expected}`);
    }
    config[key] = value;
  }
  return config;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class CronManagerService implements OnModuleInit {
  private readonly logger = new Logger(CronManagerService.name);
  private handlers = new Map<string, JobHandler>();
  /** Registered dynamic per-row hydration jobs: rowId → `${schedule}|${timezone}`. */
  private hydrationJobs = new Map<string, string>();
  /** Jobs running in this process (the Redis lock covers other instances). */
  private readonly running = new Set<string>();
  /** Lock renewal timers of this process's running jobs. */
  private readonly lockRenewals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly instanceId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
    private readonly notificationScheduler: NotificationScheduler,
    private readonly adminService: AdminService,
    private readonly metadataBackfill: MetadataBackfillService,
    private readonly providerAlerts: ProviderAlertsService,
    private readonly integrations: IntegrationsService,
    private readonly config: ConfigService,
    @Optional() private readonly identityAudit?: IdentityHealthAuditService,
    @Optional() private readonly identityMaintenance?: IdentityMaintenanceService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  private registerHandlers() {
    // ---- Data identity ----
    this.handlers.set('identity_maintenance', {
      label: 'Identity maintenance',
      description:
        'Fixes media identity automatically, users first: verified repair of inconsistent ids, missing TMDB/TVDB ids and proven duplicate merges (copy-only), mixed episode graphs, and the episode-list source of each show. Each run stops at its time budget and resumes where it left off.',
      defaultSchedule: '*/30 1-6 * * *',
      // Seeded off: enabling it is the one deliberate production step.
      defaultEnabled: false,
      options: [
        {
          key: 'mode',
          label: 'Mode',
          help: 'dry-run reports what would change without writing anything',
          type: 'select',
          default: 'apply',
          choices: ['apply', 'dry-run'],
        },
        {
          key: 'repairSweep',
          label: 'Repair inconsistent ids',
          help: 'Type mismatches, wrong-kind ids, several ids from one provider (verified plans only)',
          type: 'boolean',
          default: true,
        },
        {
          key: 'backlog',
          label: 'Fill missing ids and merge proven duplicates',
          type: 'boolean',
          default: true,
        },
        {
          key: 'structure',
          label: 'Repair episode structure',
          help: 'Mixed TMDB/TVDB episode graphs, anime still on TMDB episodes, and each show’s episode-list source',
          type: 'boolean',
          default: true,
        },
        {
          key: 'watchforge',
          label: 'Use WatchForge when TMDB and TVDB cannot decide',
          help: 'Spends only the backlog share of the daily quota',
          type: 'boolean',
          default: true,
        },
        {
          key: 'maxMinutes',
          label: 'Time budget per run (minutes)',
          help: 'Keep it below the interval between runs',
          type: 'number',
          default: 25,
          min: 5,
          max: 55,
        },
        {
          key: 'sweepBatch',
          label: 'Max verified repairs per run',
          type: 'number',
          default: 25,
          min: 1,
          max: 200,
        },
      ],
      fn: async ({ config, previous }) => {
        if (!this.identityMaintenance) throw new Error('Identity maintenance unavailable');
        return this.identityMaintenance.run(
          {
            mode: config.mode,
            repairSweep: config.repairSweep,
            backlog: config.backlog,
            structure: config.structure,
            watchforge: config.watchforge,
            maxMinutes: config.maxMinutes,
            sweepBatch: config.sweepBatch,
          },
          previous,
        );
      },
    });
    // Read-only snapshot; its CronJobRun.result history is the identity cleanup scoreboard.
    this.handlers.set('identity_audit', {
      label: 'Identity health audit',
      description:
        'Read-only daily snapshot of identity defects (duplicates, wrong ids, unknown episode structure). Feeds the Data identity scoreboard on Metadata Health.',
      defaultSchedule: '0 7 * * *',
      retentionDays: 400,
      fn: async () => {
        if (!this.identityAudit) throw new Error('Identity audit unavailable');
        return this.identityAudit.run();
      },
    });

    // ---- Metadata freshness and completeness ----
    this.handlers.set('tmdb_changes', {
      label: 'TMDB changes sync',
      description:
        'Re-hydrates every title TMDB reports as changed since the last run. Gaps longer than TMDB’s 14-day limit are replayed window by window.',
      defaultSchedule: '0 5 * * *',
      fn: () => this.metadataBackfill.syncTmdbChanges(),
    });
    const tvdbBatch = this.config.get<number>('jobs.tvdbScheduleRefreshBatchSize') ?? 100;
    this.handlers.set('tvdb_schedule_refresh', {
      label: 'TVDB schedule refresh',
      description:
        'Refreshes airing TVDB-owned shows that users track or watchlist, so new episodes and air dates appear (TMDB-owned shows are covered by the TMDB changes sync).',
      defaultSchedule: '45 * * * *',
      options: [
        {
          key: 'batchSize',
          label: 'Shows per run',
          type: 'number',
          default: Number.isFinite(tvdbBatch) ? Math.max(1, Math.min(tvdbBatch, 1000)) : 100,
          min: 1,
          max: 1000,
        },
      ],
      fn: ({ config }) => this.metadataBackfill.refreshTrackedTvdbSchedules(config.batchSize),
    });
    this.handlers.set('metadata_completeness', {
      label: 'Metadata completeness',
      description:
        'Fills fields older hydrations left empty and keeps supplements fresh: ratings, recommendations, TVDB character ids, movie countries, and merges duplicate cast entries. Each step skips rows it already checked.',
      defaultSchedule: '20 * * * *',
      options: [
        { key: 'ratings', label: 'Ratings', type: 'boolean', default: true },
        { key: 'recommendations', label: 'Recommendations', type: 'boolean', default: true },
        {
          key: 'characterIds',
          label: 'TVDB character ids (character votes)',
          type: 'boolean',
          default: true,
        },
        { key: 'movieCountries', label: 'Movie countries', type: 'boolean', default: true },
        { key: 'castDedup', label: 'Merge duplicate cast', type: 'boolean', default: true },
        {
          key: 'batchSize',
          label: 'Titles per step per run',
          type: 'number',
          default: 200,
          min: 10,
          max: 2000,
        },
      ],
      fn: ({ config }) => this.runMetadataCompleteness(config),
    });
    this.handlers.set('english_content_verify', {
      label: 'English content repair',
      description:
        'Re-hydrates titles whose base title or visible text is not English, and verifies the result against the provider. Unfixable rows are parked for a week; verified rows for a month.',
      defaultSchedule: '0 */6 * * *',
      options: [
        {
          key: 'baseRepair',
          label: 'Titles stored with a non-English base',
          type: 'boolean',
          default: true,
        },
        {
          key: 'contentVerify',
          label: 'Titles showing non-English text',
          type: 'boolean',
          default: true,
        },
        {
          key: 'batchSize',
          label: 'Titles per step per run',
          type: 'number',
          default: 500,
          min: 10,
          max: 2000,
        },
      ],
      fn: async ({ config }) => {
        const result: Record<string, number> = {};
        if (config.baseRepair) {
          const base = await this.metadataBackfill.repairNonEnglishBase(config.batchSize);
          result.baseChecked = base.processed;
          result.baseFixed = base.succeeded;
          result.baseFailed = base.failed;
        }
        if (config.contentVerify) {
          const content = await this.metadataBackfill.repairNonEnglishContent(config.batchSize);
          result.contentChecked = content.processed;
          result.contentVerified = content.verified;
          result.contentFixed = content.fixed;
          result.contentFailed = content.failed;
        }
        return result;
      },
    });

    // ---- Users ----
    this.handlers.set('episode_notifications', {
      label: 'Episode notifications',
      description:
        'Queues “airs today” pushes in each user’s local day. Must run hourly: a daily run misses users in far-off timezones.',
      defaultSchedule: '0 * * * *',
      fn: () => this.notificationScheduler.scheduleEpisodeNotifications(),
    });
    this.handlers.set('watchlist_reminders', {
      label: 'Watchlist reminders',
      description: 'Sends one rotating reminder about an unstarted watchlist show.',
      defaultSchedule: '0 22 * * *',
      fn: () => this.notificationScheduler.watchlistReminders(),
    });
    this.handlers.set('provider_alerts_check', {
      label: 'Watch provider alerts',
      description:
        'Notifies users when a title they set an alert on becomes available on a streaming service.',
      defaultSchedule: '0 8 * * *',
      fn: () => this.providerAlerts.checkAlerts(),
    });
    this.handlers.set('watch_provider_catalog_sync', {
      label: 'Watch provider catalog sync',
      description: 'Refreshes the list of streaming services per region from TMDB.',
      defaultSchedule: '0 3 * * 1',
      fn: () => this.providerAlerts.syncCatalog(),
    });
    this.handlers.set('inbound_integrations', {
      label: 'Media server sync',
      description:
        'Imports new plays from connected Plex, Jellyfin and Emby accounts whose last sync is stale.',
      defaultSchedule: '15 */6 * * *',
      fn: () => this.integrations.syncDue(),
    });
  }

  /** Legacy catch-up and freshness steps, each bounded and each skipping checked rows. */
  private async runMetadataCompleteness(config: Record<string, any>) {
    const n = config.batchSize as number;
    const result: Record<string, number | string> = {};
    const failures: string[] = [];
    const step = async (name: string, enabled: boolean, fn: () => Promise<void>) => {
      if (!enabled) return;
      try {
        await fn();
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`.slice(0, 160));
      }
    };
    await step('ratings', config.ratings, async () => {
      const r = await this.metadataBackfill.backfillRatings(n);
      result.ratingsFilled = r.succeeded;
      result.ratingsFailed = r.failed;
    });
    await step('recommendations', config.recommendations, async () => {
      const r = await this.metadataBackfill.repairRecommendations(n);
      result.recommendationsFilled = r.succeeded;
      result.recommendationsFailed = r.failed;
    });
    await step('characterIds', config.characterIds, async () => {
      const r = await this.metadataBackfill.backfillCharacterIds(n);
      result.characterIdsFilled = r.succeeded;
      result.characterIdsFailed = r.failed;
    });
    await step('movieCountries', config.movieCountries, async () => {
      const r = await this.metadataBackfill.repairMovieCountries(n);
      result.countriesFilled = r.succeeded;
      result.countriesFailed = r.failed;
    });
    await step('castDedup', config.castDedup, async () => {
      // Bounded automatic repair: merges HIGH-confidence duplicate cast groups only (votes
      // re-pointed before any delete); medium-confidence groups stay for manual review.
      const r = await this.metadataBackfill.repairCastDuplicates({ mode: 'repair', limit: n });
      result.castTitlesScanned = r.processed;
      result.castMerged = r.merged;
    });
    if (failures.length) result.failedSteps = failures.join(' | ').slice(0, 500);
    return result;
  }

  async onModuleInit() {
    this.registerHandlers();

    // Seed every handler's row; admins own schedule, timezone, enabled state and options.
    for (const [name, handler] of this.handlers) {
      await this.prisma.cronJob.upsert({
        where: { name },
        create: {
          name,
          label: handler.label,
          schedule: handler.defaultSchedule,
          enabled: handler.defaultEnabled ?? true,
        },
        update: { label: handler.label },
      });
    }

    // Schedule all enabled jobs from DB
    const jobs = await this.prisma.cronJob.findMany();
    for (const job of jobs) {
      if (job.enabled) this.scheduleJob(job);
    }
    this.logger.log(`Loaded ${jobs.length} cron jobs from database`);

    // Dynamic per-row hydration schedules: sync now, then re-sync hourly (covers edits
    // made in the Auto Hydrations page without an API restart).
    await this.syncHydrationSchedules().catch((e) =>
      this.logger.warn(`hydration schedule sync failed: ${(e as Error).message}`),
    );
    setInterval(
      () =>
        this.syncHydrationSchedules().catch((e) =>
          this.logger.warn(`hydration schedule sync failed: ${(e as Error).message}`),
        ),
      60 * 60 * 1000,
    ).unref();
  }

  /**
   * Each enabled ScheduledHydration row gets its OWN node-cron job (schedule + timezone).
   * Replaces the old behavior where every enabled row fired unconditionally every hour.
   * Rows edited/added/disabled in the admin UI are picked up on the next sync.
   */
  async syncHydrationSchedules(): Promise<{ scheduled: number; removed: number }> {
    const rows = await this.prisma.scheduledHydration.findMany();
    const enabled = rows.filter((r) => r.enabled);
    let scheduled = 0;
    let removed = 0;

    const wanted = new Map(enabled.map((r) => [r.id, `${r.schedule}|${r.timezone ?? ''}`]));
    for (const row of enabled) {
      const key = `hydration_${row.id}`;
      const sig = wanted.get(row.id)!;
      if (this.hydrationJobs.get(row.id) === sig) continue; // unchanged
      try {
        if (this.scheduler.doesExist('cron', key)) this.scheduler.deleteCronJob(key);
      } catch {
        /* not registered yet */
      }
      const cron = require('node-cron');
      const task = cron.schedule(
        row.schedule,
        () =>
          this.executeHydrationRow(row.id).catch((e) =>
            this.logger.error(`Scheduled hydration ${row.label} failed: ${(e as Error).message}`),
          ),
        { scheduled: false, timezone: row.timezone ?? undefined },
      );
      this.scheduler.addCronJob(key, task as any);
      task.start();
      this.hydrationJobs.set(row.id, sig);
      scheduled++;
    }

    // Remove jobs for rows that were deleted or disabled.
    for (const rowId of [...this.hydrationJobs.keys()]) {
      if (!wanted.has(rowId)) {
        const key = `hydration_${rowId}`;
        try {
          this.scheduler.deleteCronJob(key);
        } catch {
          /* already gone */
        }
        this.hydrationJobs.delete(rowId);
        removed++;
      }
    }
    if (scheduled || removed)
      this.logger.log(`Hydration schedules synced: ${scheduled} scheduled, ${removed} removed`);
    return { scheduled, removed };
  }

  /** One dynamic scheduled-hydration run (reported on the /jobs page via HydrationJob). */
  private async executeHydrationRow(rowId: string): Promise<void> {
    const row = await this.prisma.scheduledHydration.findUnique({ where: { id: rowId } });
    if (!row || !row.enabled) return;
    const result = await this.adminService.triggerHydration('system', row.type, {
      pages: row.pages,
      railSnapshot: true,
    });
    await this.prisma.scheduledHydration.update({
      where: { id: row.id },
      data: { lastRunAt: new Date(), lastJobId: result.jobId },
    });
    this.logger.log(`Scheduled hydration "${row.label}" triggered: ${result.totalItems} items`);
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
    } catch {
      /* doesn't exist yet */
    }

    try {
      const cron = require('node-cron');
      const task = cron.schedule(job.schedule, () => this.executeJob(job.name), {
        scheduled: false,
        // Per-job IANA timezone; undefined = server default.
        timezone: job.timezone ?? undefined,
      });
      this.scheduler.addCronJob(job.name, task as any);
      task.start();
      this.logger.debug(
        `Scheduled "${job.name}" with: ${job.schedule}${job.timezone ? ` (${job.timezone})` : ''}`,
      );
    } catch (e) {
      // A bad stored schedule must not stop the API from booting.
      this.logger.error(
        `Could not schedule "${job.name}" (${job.schedule}): ${(e as Error).message}`,
      );
    }
  }

  // ---------------- Run lock ----------------

  private async acquire(name: string): Promise<boolean> {
    if (this.running.has(name)) return false;
    this.running.add(name);
    const client = this.redis?.client;
    if (!client) return true;
    try {
      const ok = await client.set(LOCK_PREFIX + name, this.instanceId, 'PX', LOCK_TTL_MS, 'NX');
      if (ok !== 'OK') {
        this.running.delete(name);
        return false;
      }
      const renew = setInterval(() => {
        client
          .eval(RENEW_LOCK, 1, LOCK_PREFIX + name, this.instanceId, String(LOCK_TTL_MS))
          .catch(() => undefined);
      }, LOCK_RENEW_MS);
      renew.unref?.();
      this.lockRenewals.set(name, renew);
      return true;
    } catch (e) {
      // Redis down: fall back to the in-process guard rather than skipping the job.
      this.logger.warn(`Cron lock unavailable for ${name}: ${(e as Error).message}`);
      return true;
    }
  }

  private async release(name: string) {
    this.running.delete(name);
    const renew = this.lockRenewals.get(name);
    if (renew) clearInterval(renew);
    this.lockRenewals.delete(name);
    await this.redis?.client
      .eval(RELEASE_LOCK, 1, LOCK_PREFIX + name, this.instanceId)
      .catch(() => undefined);
  }

  private async isRunning(name: string): Promise<boolean> {
    if (this.running.has(name)) return true;
    const client = this.redis?.client;
    if (!client) return false;
    return (await client.exists(LOCK_PREFIX + name).catch(() => 0)) === 1;
  }

  /** The latest stored result of a job (any status), e.g. to resume from its cursors. */
  private async previousResult(jobId: string): Promise<Record<string, unknown> | null> {
    const previous = await this.prisma.cronJobRun.findFirst({
      where: { jobId, result: { not: Prisma.DbNull } },
      orderBy: { startedAt: 'desc' },
      select: { result: true },
    });
    const result = previous?.result;
    return result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  }

  /** Runs one job under its lock. Scheduled runs skip disabled jobs; manual runs don't. */
  private async executeJob(
    name: string,
    options: { manual?: boolean } = {},
  ): Promise<'ran' | 'busy' | 'disabled' | 'missing'> {
    const handler = this.handlers.get(name);
    if (!handler) return 'missing';

    const job = await this.prisma.cronJob.findUnique({ where: { name } });
    if (!job) return 'missing';
    if (!job.enabled && !options.manual) return 'disabled';
    if (!(await this.acquire(name))) {
      this.logger.warn(`Cron job "${job.label}" is still running — skipping this run`);
      return 'busy';
    }

    const startedAt = new Date();
    this.logger.log(`Running cron job: ${job.label}${options.manual ? ' (manual)' : ''}`);
    try {
      const ctx: JobContext = {
        config: resolveJobConfig(handler.options, job.config),
        previous: await this.previousResult(job.id),
      };
      let status = 'success';
      let error: string | null = null;
      let resultJson: Record<string, unknown> | undefined;
      try {
        const result = await handler.fn(ctx);
        // Persist the handler's outcome summary (counts) with the run — powers the "Report"
        // column in the admin history view. Must stay valid JSON within the 2000-char
        // budget: slicing mid-JSON breaks parsing and falsely fails the run.
        resultJson =
          result && typeof result === 'object' ? safeCronResultSummary(result) : undefined;
        // A multi-step job reports failed steps without losing the other steps' progress.
        const failedSteps = (result as Record<string, unknown> | undefined)?.failedSteps;
        if (typeof failedSteps === 'string' && failedSteps) {
          status = 'failed';
          error = failedSteps.slice(0, 500);
        }
      } catch (e) {
        status = 'failed';
        error = (e as Error).message?.slice(0, 500) ?? 'failed';
      }
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      await this.prisma.cronJob.update({
        where: { name },
        data: {
          lastRunAt: startedAt,
          lastStatus: status,
          lastError: error,
          lastDurationMs: durationMs,
          runs: { increment: 1 },
        },
      });
      await this.prisma.cronJobRun.create({
        data: {
          jobId: job.id,
          status,
          ...(resultJson ? { result: resultJson as Prisma.InputJsonValue } : {}),
          ...(error ? { error } : {}),
          durationMs,
          startedAt,
          finishedAt,
        },
      });
      if (error) this.logger.error(`Cron job "${job.label}" failed: ${error}`);
      await this.pruneHistory(job.id, handler.retentionDays ?? DEFAULT_RETENTION_DAYS);
      return 'ran';
    } finally {
      await this.release(name);
    }
  }

  /** Run history is bounded per job (frequent jobs used to grow it without limit). */
  private async pruneHistory(jobId: string, days: number) {
    await this.prisma.cronJobRun
      .deleteMany({
        where: { jobId, startedAt: { lt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } },
      })
      .catch((e) => this.logger.warn(`Cron history prune failed: ${(e as Error).message}`));
  }

  // ---------------- Admin API ----------------
  async getAll() {
    const jobs = await this.prisma.cronJob.findMany({ orderBy: { name: 'asc' } });
    const known = jobs.filter((job) => this.handlers.has(job.name));
    // Keep the handler registration order (grouped by purpose) instead of alphabetical.
    const order = [...this.handlers.keys()];
    known.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    return Promise.all(
      known.map(async (job) => {
        const handler = this.handlers.get(job.name)!;
        return {
          ...job,
          description: handler.description,
          defaultSchedule: handler.defaultSchedule,
          options: handler.options ?? [],
          config: resolveJobConfig(handler.options, job.config),
          running: await this.isRunning(job.name),
        };
      }),
    );
  }

  async getHistory(name: string, page = 1, pageSize = 20) {
    const job = await this.prisma.cronJob.findUnique({ where: { name } });
    if (!job) return { items: [], total: 0 };
    const [items, total] = await Promise.all([
      this.prisma.cronJobRun.findMany({
        where: { jobId: job.id },
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.cronJobRun.count({ where: { jobId: job.id } }),
    ]);
    return { items, total, page, pageSize };
  }

  async update(
    adminId: string,
    name: string,
    data: { schedule?: string; enabled?: boolean; timezone?: string | null; config?: unknown },
  ) {
    const handler = this.handlers.get(name);
    if (!handler) throw new NotFoundException('Unknown job');
    const patch: Prisma.CronJobUpdateInput = {};
    if (data.schedule !== undefined) {
      const schedule = String(data.schedule).trim();
      if (!require('node-cron').validate(schedule))
        throw new BadRequestException(`Invalid cron schedule "${schedule}"`);
      patch.schedule = schedule;
    }
    if (data.enabled !== undefined) patch.enabled = data.enabled === true;
    if (data.timezone !== undefined) {
      const timezone = data.timezone ? String(data.timezone).trim() : null;
      if (timezone && !validTimezone(timezone))
        throw new BadRequestException(`Unknown timezone "${timezone}"`);
      patch.timezone = timezone;
    }
    if (data.config !== undefined)
      patch.config =
        data.config === null
          ? Prisma.DbNull
          : (validateJobConfig(handler.options, data.config) as Prisma.InputJsonValue);

    const job = await this.prisma.cronJob.update({ where: { name }, data: patch });
    try {
      this.scheduler.deleteCronJob(name);
    } catch {
      /* not scheduled */
    }
    if (job.enabled) this.scheduleJob(job);
    await this.adminService
      .audit(adminId, 'cron_job_update', 'cron_job', name, {
        schedule: data.schedule,
        enabled: data.enabled,
        timezone: data.timezone,
        config: data.config,
      })
      .catch(() => undefined);
    this.logger.log(
      `Cron job "${name}" updated: schedule=${job.schedule} enabled=${job.enabled} tz=${job.timezone ?? 'server'}`,
    );
    return job;
  }

  /** Starts a run in the background (runs can take hours); the list shows it as running. */
  async triggerNow(adminId: string, name: string) {
    if (!this.handlers.has(name)) throw new NotFoundException('Unknown job');
    if (await this.isRunning(name)) throw new ConflictException('This job is already running');
    void this.executeJob(name, { manual: true }).catch((e) =>
      this.logger.error(`Manual run of "${name}" failed: ${(e as Error).message}`),
    );
    await this.adminService
      .audit(adminId, 'cron_job_trigger', 'cron_job', name)
      .catch(() => undefined);
    return { started: true };
  }
}
