import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CronManagerService,
  resolveJobConfig,
  safeCronResultSummary,
  validateJobConfig,
  type JobOptionSpec,
} from './cron-manager.service';

const scheduleMock: jest.Mock = jest.fn(() => ({ start: jest.fn() }));
const validateMock: jest.Mock = jest.fn(() => true);
jest.mock('node-cron', () => ({ schedule: scheduleMock, validate: validateMock }));

type FnMap = Record<string, jest.Mock>;
function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function makeService(options: { redis?: any } = {}) {
  const prisma: any = {
    cronJob: model(['findMany', 'upsert', 'update', 'findUnique']),
    cronJobRun: model(['create', 'findFirst', 'deleteMany']),
    scheduledHydration: model(['findMany', 'findUnique', 'update']),
  };
  prisma.cronJob.findMany.mockResolvedValue([]);
  prisma.scheduledHydration.findMany.mockResolvedValue([]);
  const scheduler = {
    doesExist: jest.fn().mockReturnValue(false),
    deleteCronJob: jest.fn(),
    addCronJob: jest.fn(),
  };
  const notificationScheduler = {
    scheduleEpisodeNotifications: jest.fn(),
    watchlistReminders: jest.fn(),
  };
  const adminService = {
    triggerHydration: jest.fn().mockResolvedValue({ jobId: 'job-1', totalItems: 20 }),
    audit: jest.fn().mockResolvedValue(undefined),
  };
  const metadataBackfill = {
    syncTmdbChanges: jest.fn(),
    refreshTrackedTvdbSchedules: jest.fn(),
    backfillRatings: jest.fn().mockResolvedValue({ succeeded: 3, failed: 0 }),
    repairRecommendations: jest.fn().mockResolvedValue({ succeeded: 1, failed: 0 }),
    backfillCharacterIds: jest.fn().mockResolvedValue({ succeeded: 0, failed: 0 }),
    repairMovieCountries: jest.fn().mockResolvedValue({ succeeded: 2, failed: 1 }),
    repairCastDuplicates: jest.fn().mockResolvedValue({ processed: 5, merged: 1 }),
    repairNonEnglishBase: jest.fn().mockResolvedValue({ processed: 1, succeeded: 1, failed: 0 }),
    repairNonEnglishContent: jest
      .fn()
      .mockResolvedValue({ processed: 2, verified: 1, fixed: 1, failed: 0 }),
  };
  const providerAlerts = { checkAlerts: jest.fn(), syncCatalog: jest.fn() };
  const integrations = {
    syncDue: jest.fn().mockResolvedValue({ selected: 0, succeeded: 0, failed: 0, busy: 0 }),
  };
  const config: { get: jest.Mock } = { get: jest.fn(() => undefined) };
  const identityAudit = {
    run: jest.fn().mockResolvedValue({ rulesVersion: 2, dupPairsGeneral: 3 }),
  };
  const identityMaintenance = {
    run: jest.fn().mockResolvedValue({ mode: 'apply', sweepCursor: '0:m9', repaired: 2 }),
  };
  const streamingCharts = {
    running: false,
    run: jest.fn().mockResolvedValue({ railsFetched: 5, lastJobId: 'chart-job' }),
  };
  const svc = new CronManagerService(
    prisma,
    scheduler as any,
    notificationScheduler as any,
    adminService as any,
    metadataBackfill as any,
    providerAlerts as any,
    integrations as any,
    config as any,
    identityAudit as any,
    identityMaintenance as any,
    options.redis,
    streamingCharts as any,
  );
  return {
    svc,
    prisma,
    scheduler,
    adminService,
    metadataBackfill,
    integrations,
    config,
    identityAudit,
    identityMaintenance,
    streamingCharts,
  };
}

/** Handlers are registered on module init; run one with a resolved context. */
async function handler(svc: CronManagerService, name: string) {
  await svc.onModuleInit();
  return (svc as any).handlers.get(name);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('CronManagerService', () => {
  beforeEach(() => {
    scheduleMock.mockClear();
    validateMock.mockReset().mockReturnValue(true);
  });

  it('seeds one row per handler and keeps identity maintenance off until enabled', async () => {
    const { svc, prisma } = makeService();
    await svc.onModuleInit();
    const seeded = prisma.cronJob.upsert.mock.calls.map((c: any[]) => c[0].create);
    expect(seeded.map((row: any) => row.name).sort()).toEqual(
      [
        'english_content_verify',
        'episode_notifications',
        'identity_audit',
        'identity_maintenance',
        'inbound_integrations',
        'metadata_completeness',
        'provider_alerts_check',
        'tmdb_changes',
        'tvdb_schedule_refresh',
        'watch_provider_catalog_sync',
        'watchlist_reminders',
      ].sort(),
    );
    expect(seeded.find((row: any) => row.name === 'identity_maintenance')).toMatchObject({
      enabled: false,
      schedule: '*/30 1-6 * * *',
    });
    // Admin-owned fields are never overwritten on boot.
    for (const call of prisma.cronJob.upsert.mock.calls) {
      expect(Object.keys(call[0].update)).toEqual(['label']);
    }
  });

  it('persists the read-only identity audit snapshot as the job result', async () => {
    const { svc, identityAudit } = makeService();
    const result = await (await handler(svc, 'identity_audit')).fn({ config: {}, previous: null });
    expect(identityAudit.run).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rulesVersion: 2, dupPairsGeneral: 3 });
  });

  it('runs identity maintenance with its resolved options and the previous run cursors', async () => {
    const { svc, identityMaintenance } = makeService();
    const job = await handler(svc, 'identity_maintenance');
    const config = resolveJobConfig(job.options, { mode: 'dry-run', maxMinutes: 10 });
    await job.fn({ config, previous: { sweepCursor: '0:m1' } });
    expect(identityMaintenance.run).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'dry-run',
        maxMinutes: 10,
        repairSweep: true,
        backlog: true,
        structure: true,
        watchforge: true,
        sweepBatch: 25,
      }),
      { sweepCursor: '0:m1' },
    );
  });

  it('runs the TVDB schedule refresh with the batch option (env value as the default)', async () => {
    const { svc, metadataBackfill, config } = makeService();
    config.get.mockImplementation((key: string) =>
      key === 'jobs.tvdbScheduleRefreshBatchSize' ? 75 : undefined,
    );
    const job = await handler(svc, 'tvdb_schedule_refresh');
    await job.fn({ config: resolveJobConfig(job.options, null), previous: null });
    expect(metadataBackfill.refreshTrackedTvdbSchedules).toHaveBeenLastCalledWith(75);
    await job.fn({ config: resolveJobConfig(job.options, { batchSize: 20 }), previous: null });
    expect(metadataBackfill.refreshTrackedTvdbSchedules).toHaveBeenLastCalledWith(20);
  });

  it('runs only the enabled completeness steps and reports a failed step without losing the rest', async () => {
    const { svc, metadataBackfill } = makeService();
    metadataBackfill.backfillCharacterIds.mockRejectedValue(new Error('tvdb down'));
    const job = await handler(svc, 'metadata_completeness');
    const result = await job.fn({
      config: resolveJobConfig(job.options, { recommendations: false, batchSize: 50 }),
      previous: null,
    });
    expect(metadataBackfill.repairRecommendations).not.toHaveBeenCalled();
    expect(metadataBackfill.backfillRatings).toHaveBeenCalledWith(50);
    expect(metadataBackfill.repairCastDuplicates).toHaveBeenCalledWith({
      mode: 'repair',
      limit: 50,
    });
    expect(result).toMatchObject({
      ratingsFilled: 3,
      countriesFilled: 2,
      castMerged: 1,
      failedSteps: 'characterIds: tvdb down',
    });
  });

  it('runs both English repair steps as one job', async () => {
    const { svc, metadataBackfill } = makeService();
    const job = await handler(svc, 'english_content_verify');
    const result = await job.fn({ config: resolveJobConfig(job.options, null), previous: null });
    expect(metadataBackfill.repairNonEnglishBase).toHaveBeenCalledWith(500);
    expect(metadataBackfill.repairNonEnglishContent).toHaveBeenCalledWith(500);
    expect(result).toMatchObject({ baseFixed: 1, contentFixed: 1 });
  });

  it('registers the bounded inbound integration refresh handler', async () => {
    const { svc, integrations } = makeService();
    await (await handler(svc, 'inbound_integrations')).fn({ config: {}, previous: null });
    expect(integrations.syncDue).toHaveBeenCalledTimes(1);
  });

  it('schedules jobs with their per-job timezone and survives an invalid stored schedule', async () => {
    const { svc, prisma } = makeService();
    prisma.cronJob.findMany.mockResolvedValue([
      { name: 'tmdb_changes', schedule: '0 5 * * *', enabled: true, timezone: 'Europe/Rome' },
      { name: 'identity_audit', schedule: '0 7 * * *', enabled: true, timezone: null },
      { name: 'watchlist_reminders', schedule: 'nonsense', enabled: true, timezone: null },
    ]);
    scheduleMock.mockImplementation((expr: string) => {
      if (expr === 'nonsense') throw new Error('Invalid cron expression');
      return { start: jest.fn() };
    });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();

    const tzCalls = scheduleMock.mock.calls.filter((c) => c[2]?.timezone === 'Europe/Rome');
    expect(tzCalls).toHaveLength(1);
    expect(tzCalls[0][0]).toBe('0 5 * * *');
    scheduleMock.mockImplementation(() => ({ start: jest.fn() }));
  });

  describe('runs', () => {
    function withJob(svc: CronManagerService, prisma: any, fn: jest.Mock, enabled = true) {
      (svc as any).handlers.set('test_job', {
        label: 'Test',
        description: '',
        defaultSchedule: '0 1 * * *',
        options: [{ key: 'n', label: 'N', type: 'number', default: 5, min: 1, max: 10 }],
        fn,
      });
      prisma.cronJob.findUnique.mockResolvedValue({
        id: 'cj1',
        name: 'test_job',
        label: 'Test',
        enabled,
        config: { n: 7 },
      });
    }

    it('persists the handler result and passes resolved options and the previous result', async () => {
      const { svc, prisma } = makeService();
      const fn = jest.fn(async () => ({ processed: 12, succeeded: 10, failed: 2 }));
      withJob(svc, prisma, fn);
      prisma.cronJobRun.findFirst.mockResolvedValue({ result: { nextCursor: 'c1' } });

      await expect((svc as any).executeJob('test_job')).resolves.toBe('ran');

      expect(fn).toHaveBeenCalledWith({ config: { n: 7 }, previous: { nextCursor: 'c1' } });
      expect(prisma.cronJobRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { jobId: 'cj1', result: { not: Prisma.DbNull } } }),
      );
      expect(prisma.cronJobRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          jobId: 'cj1',
          status: 'success',
          result: { processed: 12, succeeded: 10, failed: 2 },
        }),
      });
      // History is bounded per job.
      expect(prisma.cronJobRun.deleteMany).toHaveBeenCalledWith({
        where: { jobId: 'cj1', startedAt: { lt: expect.any(Date) } },
      });
    });

    it('records a run with failed steps as failed but keeps its result (cursors survive)', async () => {
      const { svc, prisma } = makeService();
      withJob(
        svc,
        prisma,
        jest.fn(async () => ({ cursor: 'c2', failedSteps: 'backlog: boom' })),
      );

      await (svc as any).executeJob('test_job');

      expect(prisma.cronJobRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'failed',
          error: 'backlog: boom',
          result: { cursor: 'c2', failedSteps: 'backlog: boom' },
        }),
      });
      expect(prisma.cronJob.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastStatus: 'failed' }) }),
      );
    });

    it('keeps oversized handler results as valid JSON instead of slicing mid-string', async () => {
      const { svc, prisma } = makeService();
      withJob(
        svc,
        prisma,
        // Regression: the old slice(0, 2000) truncated mid-JSON and the run was falsely
        // recorded as FAILED ("Unterminated string in JSON at position 2000").
        jest.fn(async () => ({
          mode: 'report',
          processed: 1000,
          titles: Array.from({ length: 500 }, (_, i) => ({ mediaId: `m${i}`, title: `S ${i}` })),
        })),
      );
      await (svc as any).executeJob('test_job');
      const created = prisma.cronJobRun.create.mock.calls[0][0].data;
      expect(created.status).toBe('success');
      expect(JSON.stringify(created.result).length).toBeLessThanOrEqual(2000);
      expect(created.result).toMatchObject({ truncated: true, processed: 1000 });
    });

    it('skips a scheduled run of a disabled job but runs it when triggered manually', async () => {
      const { svc, prisma } = makeService();
      const fn = jest.fn(async () => ({ ok: 1 }));
      withJob(svc, prisma, fn, false);

      await expect((svc as any).executeJob('test_job')).resolves.toBe('disabled');
      expect(fn).not.toHaveBeenCalled();
      await expect((svc as any).executeJob('test_job', { manual: true })).resolves.toBe('ran');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('never runs the same job twice at once (in-process and across instances)', async () => {
      const redis = {
        client: {
          set: jest.fn().mockResolvedValue(null), // another instance holds the lock
          eval: jest.fn().mockResolvedValue(1),
          exists: jest.fn().mockResolvedValue(1),
        },
      };
      const { svc, prisma } = makeService({ redis });
      const fn = jest.fn(async () => ({}));
      withJob(svc, prisma, fn);
      await expect((svc as any).executeJob('test_job')).resolves.toBe('busy');
      expect(fn).not.toHaveBeenCalled();

      redis.client.set.mockResolvedValue('OK');
      let release!: () => void;
      fn.mockImplementation(() => new Promise<any>((resolve) => (release = () => resolve({}))));
      const first = (svc as any).executeJob('test_job');
      await flush();
      await expect((svc as any).executeJob('test_job')).resolves.toBe('busy');
      release();
      await expect(first).resolves.toBe('ran');
      // Short lock (renewed while alive) so a crashed process frees it within minutes.
      expect(redis.client.set).toHaveBeenLastCalledWith(
        'cron:lock:test_job',
        expect.any(String),
        'PX',
        120000,
        'NX',
      );
      expect(redis.client.eval).toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('starts a manual run in the background and refuses a second one while it runs', async () => {
      const { svc, prisma, adminService } = makeService();
      let release!: () => void;
      withJob(
        svc,
        prisma,
        jest.fn(() => new Promise<any>((resolve) => (release = () => resolve({})))),
      );

      await expect(svc.triggerNow('admin-1', 'test_job')).resolves.toEqual({ started: true });
      await flush();
      await expect(svc.triggerNow('admin-1', 'test_job')).rejects.toBeInstanceOf(ConflictException);
      release();
      await flush();
      expect(adminService.audit).toHaveBeenCalledWith(
        'admin-1',
        'cron_job_trigger',
        'cron_job',
        'test_job',
      );
    });
  });

  describe('admin edits', () => {
    it('validates the schedule, timezone and options, and audits the change', async () => {
      const { svc, prisma, adminService } = makeService();
      await svc.onModuleInit();
      prisma.cronJob.update.mockResolvedValue({ name: 'tvdb_schedule_refresh', enabled: false });

      validateMock.mockReturnValueOnce(false);
      await expect(
        svc.update('a', 'tvdb_schedule_refresh', { schedule: 'every day' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('a', 'tvdb_schedule_refresh', { timezone: 'Mars/Olympus' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('a', 'tvdb_schedule_refresh', { config: { batchSize: 5000 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        svc.update('a', 'tvdb_schedule_refresh', { config: { runs: 1 } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cronJob.update).not.toHaveBeenCalled();

      await svc.update('a', 'tvdb_schedule_refresh', {
        schedule: '45 * * * *',
        timezone: 'Europe/Paris',
        config: { batchSize: 50 },
      });
      // Only whitelisted columns are written, whatever the request body carries.
      expect(prisma.cronJob.update).toHaveBeenCalledWith({
        where: { name: 'tvdb_schedule_refresh' },
        data: { schedule: '45 * * * *', timezone: 'Europe/Paris', config: { batchSize: 50 } },
      });
      expect(adminService.audit).toHaveBeenCalledWith(
        'a',
        'cron_job_update',
        'cron_job',
        'tvdb_schedule_refresh',
        expect.anything(),
      );

      await svc.update('a', 'tvdb_schedule_refresh', { config: null });
      expect(prisma.cronJob.update).toHaveBeenLastCalledWith({
        where: { name: 'tvdb_schedule_refresh' },
        data: { config: Prisma.DbNull },
      });
    });

    it('lists only jobs with a handler, with their options and resolved values', async () => {
      const { svc, prisma } = makeService();
      await svc.onModuleInit();
      prisma.cronJob.findMany.mockResolvedValue([
        { name: 'push_dispatch', schedule: '* * * * *', enabled: true, config: null },
        { name: 'tvdb_schedule_refresh', schedule: '45 * * * *', enabled: true, config: null },
      ]);
      const jobs = await svc.getAll();
      expect(jobs.map((j) => j.name)).toEqual(['tvdb_schedule_refresh']);
      expect(jobs[0]).toMatchObject({
        config: { batchSize: 100 },
        running: false,
        defaultSchedule: '45 * * * *',
      });
      expect(jobs[0].options[0]).toMatchObject({ key: 'batchSize', type: 'number' });
    });
  });

  describe('job option helpers', () => {
    const specs: JobOptionSpec[] = [
      { key: 'on', label: 'On', type: 'boolean', default: true },
      { key: 'n', label: 'N', type: 'number', default: 5, min: 1, max: 10 },
      { key: 'mode', label: 'Mode', type: 'select', default: 'a', choices: ['a', 'b'] },
    ];

    it('resolves stored values against defaults, clamping and dropping invalid ones', () => {
      expect(resolveJobConfig(specs, null)).toEqual({ on: true, n: 5, mode: 'a' });
      expect(resolveJobConfig(specs, { on: false, n: 99, mode: 'zzz', extra: 1 })).toEqual({
        on: false,
        n: 10,
        mode: 'a',
      });
    });

    it('rejects unknown keys and invalid values on edit', () => {
      expect(validateJobConfig(specs, { n: 3, mode: 'b' })).toEqual({ n: 3, mode: 'b' });
      expect(() => validateJobConfig(specs, { n: 3.5 })).toThrow(BadRequestException);
      expect(() => validateJobConfig(specs, { on: 'yes' })).toThrow(BadRequestException);
      expect(() => validateJobConfig(specs, { other: 1 })).toThrow(BadRequestException);
      expect(() => validateJobConfig(specs, [])).toThrow(BadRequestException);
    });

    it('safeCronResultSummary passes through payloads within the budget', () => {
      const small = { processed: 3, ok: true };
      expect(safeCronResultSummary(small)).toEqual(small);
    });
  });

  describe('dynamic hydration schedules', () => {
    it('registers per-row hydration jobs with their own schedule + timezone (no hourly batch)', async () => {
      const { svc, prisma, scheduler } = makeService();
      prisma.scheduledHydration.findMany.mockResolvedValue([
        {
          id: 'h1',
          type: 'trending_shows',
          label: 'Trending',
          schedule: '0 3 * * *',
          timezone: 'UTC',
          pages: 2,
          enabled: true,
        },
        {
          id: 'h2',
          type: 'popular_shows',
          label: 'Popular',
          schedule: '0 4 * * *',
          timezone: null,
          pages: 1,
          enabled: false,
        },
      ]);

      const res = await svc.syncHydrationSchedules();

      expect(res.scheduled).toBe(1);
      const call = scheduleMock.mock.calls.find((c) => c[0] === '0 3 * * *');
      expect(call).toBeDefined();
      expect(call[2]).toMatchObject({ timezone: 'UTC' });
      expect(scheduler.addCronJob).toHaveBeenCalledWith('hydration_h1', expect.anything());
    });

    it('removes dynamic jobs when a row is disabled or deleted', async () => {
      const { svc, prisma, scheduler } = makeService();
      prisma.scheduledHydration.findMany.mockResolvedValueOnce([
        {
          id: 'h1',
          type: 'trending_shows',
          label: 'Trending',
          schedule: '0 3 * * *',
          timezone: null,
          pages: 1,
          enabled: true,
        },
      ]);
      await svc.syncHydrationSchedules();
      prisma.scheduledHydration.findMany.mockResolvedValueOnce([]); // row deleted

      const res = await svc.syncHydrationSchedules();

      expect(res.removed).toBe(1);
      expect(scheduler.deleteCronJob).toHaveBeenCalledWith('hydration_h1');
    });

    it('a dynamic hydration run triggers the hydration and stamps the row', async () => {
      const { svc, prisma, adminService } = makeService();
      prisma.scheduledHydration.findUnique.mockResolvedValue({
        id: 'h1',
        type: 'trending_shows',
        label: 'Trending',
        pages: 2,
        enabled: true,
      });

      await (svc as any).executeHydrationRow('h1');

      expect(adminService.triggerHydration).toHaveBeenCalledWith('system', 'trending_shows', {
        pages: 2,
        railSnapshot: true,
      });
      expect(prisma.scheduledHydration.update).toHaveBeenCalledWith({
        where: { id: 'h1' },
        data: expect.objectContaining({ lastJobId: 'job-1' }),
      });
    });

    it('runs the streaming chart row with its options instead of a TMDB hydration', async () => {
      const { svc, prisma, adminService, streamingCharts } = makeService();
      prisma.scheduledHydration.findUnique.mockResolvedValue({
        id: 'charts',
        type: 'streaming_top',
        label: 'Streaming Top Charts',
        pages: 1,
        enabled: true,
        config: { countries: ['US', 'FR'], services: ['netflix'] },
      });

      await (svc as any).executeHydrationRow('charts');

      expect(adminService.triggerHydration).not.toHaveBeenCalled();
      expect(streamingCharts.run).toHaveBeenCalledWith(
        expect.objectContaining({ countries: ['US', 'FR'], services: ['netflix'] }),
      );
      expect(prisma.scheduledHydration.update).toHaveBeenCalledWith({
        where: { id: 'charts' },
        data: expect.objectContaining({ lastJobId: 'chart-job' }),
      });
    });

    it('Run Now starts the charts in the background and refuses a second concurrent run', async () => {
      const { svc, prisma, adminService, streamingCharts } = makeService();
      (adminService as any).triggerScheduledHydration = jest.fn();
      prisma.scheduledHydration.findUnique.mockResolvedValue({
        id: 'charts',
        type: 'streaming_top',
        enabled: false,
        config: null,
      });
      await expect(svc.triggerScheduledHydration('admin', 'charts')).resolves.toEqual({
        status: 'running',
      });
      await flush();
      expect(streamingCharts.run).toHaveBeenCalledTimes(1);
      streamingCharts.running = true;
      await expect(svc.triggerScheduledHydration('admin', 'charts')).rejects.toThrow(
        'already running',
      );
      prisma.scheduledHydration.findUnique.mockResolvedValue({ id: 'h1', type: 'trending_shows' });
      await svc.triggerScheduledHydration('admin', 'h1');
      expect((adminService as any).triggerScheduledHydration).toHaveBeenCalledWith('admin', 'h1');
    });
  });
});
