import { CronManagerService, safeCronResultSummary } from './cron-manager.service';

const scheduleMock: jest.Mock = jest.fn(() => ({ start: jest.fn() }));
jest.mock('node-cron', () => ({ schedule: scheduleMock }));

type FnMap = Record<string, jest.Mock>;
function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function makeService() {
  const prisma: any = {
    cronJob: model(['findMany', 'upsert', 'update', 'findUnique']),
    cronJobRun: model(['create', 'findFirst']),
    scheduledHydration: model(['findMany', 'findUnique', 'update']),
  };
  const scheduler = {
    doesExist: jest.fn().mockReturnValue(false),
    deleteCronJob: jest.fn(),
    addCronJob: jest.fn(),
  };
  const notificationScheduler = {
    scheduleEpisodeNotifications: jest.fn(),
    watchlistReminders: jest.fn(),
    refreshAirtimes: jest.fn(),
  };
  const adminService = {
    triggerHydration: jest.fn().mockResolvedValue({ jobId: 'job-1', totalItems: 20 }),
  };
  const metadataBackfill = {
    backfillBatch: jest.fn(),
    syncTmdbChanges: jest.fn(),
    refreshTrackedTvdbSchedules: jest.fn(),
    rehydrateAnimeFromTvdb: jest.fn(),
    reconcileStructures: jest.fn(),
  };
  const providerAlerts = {
    checkAlerts: jest.fn(),
    syncCatalog: jest.fn(),
  };
  const config: { get: jest.Mock } = {
    get: jest.fn((key: string) => (key === 'jobs.structureRepairBatchSize' ? 200 : undefined)),
  };
  const svc = new CronManagerService(
    prisma,
    scheduler as any,
    notificationScheduler as any,
    adminService as any,
    metadataBackfill as any,
    providerAlerts as any,
    config as any,
  );
  return { svc, prisma, scheduler, adminService, metadataBackfill, config };
}

describe('CronManagerService', () => {
  beforeEach(() => scheduleMock.mockClear());

  it('keeps scheduled structure reconciliation report-only until explicitly enabled', async () => {
    const { svc, prisma, metadataBackfill, config } = makeService();
    metadataBackfill.reconcileStructures.mockResolvedValue({ mode: 'report' });
    prisma.cronJob.findMany.mockResolvedValue([]);
    prisma.scheduledHydration.findMany.mockResolvedValue([]);

    await svc.onModuleInit();
    await (svc as any).handlers.get('structure_reconcile').fn();

    expect(metadataBackfill.reconcileStructures).toHaveBeenCalledWith({
      mode: 'report',
      limit: 200,
    });

    config.get.mockImplementation((key: string) =>
      key === 'jobs.structureRepairEnabled' ? true : 200,
    );
    await (svc as any).handlers.get('structure_reconcile').fn();
    expect(metadataBackfill.reconcileStructures).toHaveBeenLastCalledWith({
      mode: 'repair',
      limit: 200,
    });
  });

  it('runs the bounded TVDB schedule refresh with the configured batch size', async () => {
    const { svc, prisma, metadataBackfill, config } = makeService();
    prisma.cronJob.findMany.mockResolvedValue([]);
    prisma.scheduledHydration.findMany.mockResolvedValue([]);
    config.get.mockImplementation((key: string) =>
      key === 'jobs.tvdbScheduleRefreshBatchSize' ? 75 : undefined,
    );

    await svc.onModuleInit();
    await (svc as any).handlers.get('tvdb_schedule_refresh').fn();

    expect(metadataBackfill.refreshTrackedTvdbSchedules).toHaveBeenCalledWith(75);
  });

  it('continues the scheduled structure repair from the previous bounded cursor', async () => {
    const { svc, prisma, metadataBackfill } = makeService();
    prisma.cronJob.findMany.mockResolvedValue([]);
    prisma.scheduledHydration.findMany.mockResolvedValue([]);
    prisma.cronJobRun.findFirst.mockResolvedValue({ result: { nextCursor: 'media-200' } });

    await svc.onModuleInit();
    await (svc as any).handlers.get('structure_reconcile').fn();

    expect(metadataBackfill.reconcileStructures).toHaveBeenCalledWith({
      mode: 'report',
      limit: 200,
      cursor: 'media-200',
    });
  });

  it('schedules jobs with their per-job timezone', async () => {
    const { svc, prisma } = makeService();
    prisma.cronJob.findMany.mockResolvedValue([
      {
        name: 'tmdb_changes',
        label: 'TMDB Changes Sync',
        schedule: '0 5 * * *',
        enabled: true,
        timezone: 'Europe/Rome',
      },
      {
        name: 'metadata_backfill',
        label: 'Metadata Backfill',
        schedule: '0 4 * * *',
        enabled: true,
        timezone: null,
      },
    ]);
    prisma.scheduledHydration.findMany.mockResolvedValue([]);
    await svc.onModuleInit();

    const tzCalls = scheduleMock.mock.calls.filter((c) => c[2]?.timezone === 'Europe/Rome');
    expect(tzCalls).toHaveLength(1);
    expect(tzCalls[0][0]).toBe('0 5 * * *');
    const serverCalls = scheduleMock.mock.calls.filter((c) => c[2]?.timezone === undefined);
    expect(serverCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('persists the handler result on CronJobRun (Report column data)', async () => {
    const { svc, prisma } = makeService();
    prisma.cronJob.findMany.mockResolvedValue([]);
    prisma.scheduledHydration.findMany.mockResolvedValue([]);
    (svc as any).handlers.set('test_job', {
      label: 'Test',
      defaultSchedule: '0 1 * * *',
      fn: async () => ({ processed: 12, succeeded: 10, failed: 2 }),
    });
    prisma.cronJob.findUnique.mockResolvedValue({ id: 'cj1', name: 'test_job', enabled: true });
    prisma.cronJob.upsert.mockResolvedValue(undefined);

    await svc.onModuleInit();
    await (svc as any).executeJob('test_job');

    expect(prisma.cronJobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'cj1',
        status: 'success',
        result: { processed: 12, succeeded: 10, failed: 2 },
      }),
    });
  });

  it('keeps oversized handler results as valid JSON instead of slicing mid-string', async () => {
    const { svc, prisma } = makeService();
    prisma.cronJob.findMany.mockResolvedValue([]);
    prisma.scheduledHydration.findMany.mockResolvedValue([]);
    (svc as any).handlers.set('big_job', {
      label: 'Big',
      defaultSchedule: '0 1 * * *',
      // Regression: the old slice(0, 2000) truncated mid-JSON and the run was falsely
      // recorded as FAILED ("Unterminated string in JSON at position 2000").
      fn: async () => ({
        mode: 'report',
        processed: 1000,
        titles: Array.from({ length: 500 }, (_, i) => ({
          mediaId: `m${i}`,
          title: `Some Show ${i}`,
          action: 'needs-review',
        })),
      }),
    });
    prisma.cronJob.findUnique.mockResolvedValue({ id: 'cj2', name: 'big_job', enabled: true });
    prisma.cronJob.upsert.mockResolvedValue(undefined);

    await svc.onModuleInit();
    await (svc as any).executeJob('big_job');

    const created = prisma.cronJobRun.create.mock.calls[0][0].data;
    expect(created.status).toBe('success'); // NOT failed
    expect(() => JSON.parse(JSON.stringify(created.result))).not.toThrow();
    expect(JSON.stringify(created.result).length).toBeLessThanOrEqual(2000);
    expect(created.result).toMatchObject({ truncated: true, processed: 1000 });
  });

  it('safeCronResultSummary passes through payloads within the budget', () => {
    const small = { processed: 3, ok: true };
    expect(safeCronResultSummary(small)).toEqual(small);
  });

  it('registers per-row hydration jobs with their own schedule + timezone (no hourly batch)', async () => {
    const { svc, prisma, scheduler } = makeService();
    prisma.cronJob.findMany.mockResolvedValue([]);
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
    prisma.cronJob.findMany.mockResolvedValue([]);
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
});
