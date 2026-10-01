import { StreamingChartsRunner } from './streaming-charts.runner';

const config = {
  countries: ['US'],
  services: ['netflix', 'hbo'],
  monthlyBudget: 1000,
  reserve: 20,
  watchforge: true,
  retentionDays: 14,
};

function fixture(opts: { quota?: any; doneToday?: string[]; configured?: boolean } = {}) {
  const prisma: any = {
    hydrationJob: {
      findMany: jest
        .fn()
        // rails already completed today
        .mockResolvedValueOnce((opts.doneToday ?? []).map((railKey) => ({ railKey })))
        // latest completed per rail (prune keep-list)
        .mockResolvedValueOnce([{ id: 'keep-1' }]),
      deleteMany: jest.fn(async () => ({ count: 3 })),
    },
  };
  const admin: any = {
    runRankedSnapshot: jest.fn(async () => ({ jobId: 'job', status: 'completed', hydrated: 0 })),
  };
  const charts: any = {
    collect: jest.fn(async () => ({
      items: [{ rank: 1, tmdbId: 1, mediaType: 'MOVIE', mediaId: 'm', status: 'pending' }],
      dropped: 0,
      filtered: 1,
      existing: 1,
      created: 0,
      skipped: 0,
      conflicts: 0,
      duplicates: 0,
    })),
    invalidateAvailability: jest.fn(async () => undefined),
  };
  const motn: any = {
    configured: jest.fn(async () => opts.configured ?? true),
    quota: jest.fn(async () => opts.quota ?? null),
  };
  return { runner: new StreamingChartsRunner(prisma, admin, charts, motn), prisma, admin, charts };
}

describe('StreamingChartsRunner', () => {
  it('reports not configured without spending anything', async () => {
    const f = fixture({ configured: false });
    await expect(f.runner.run(config, null)).resolves.toEqual({ skipped: 1, notConfigured: 1 });
    expect(f.charts.collect).not.toHaveBeenCalled();
  });

  it('refuses a run whose monthly projection is over budget', async () => {
    const f = fixture();
    await expect(
      f.runner.run(
        {
          ...config,
          reserve: 100,
          countries: ['US', 'FR', 'DE', 'ES', 'IT', 'BR'],
          services: ['netflix', 'prime', 'disney', 'apple', 'hbo'],
        },
        null,
      ),
    ).rejects.toThrow(/exceed/);
    expect(f.charts.collect).not.toHaveBeenCalled();
  });

  it('fetches each rail once per day and stores a partial-friendly snapshot', async () => {
    const f = fixture({ doneToday: ['motn:netflix:US'] });
    const result = await f.runner.run(config, null);
    expect(f.charts.collect).toHaveBeenCalledTimes(1);
    expect(f.charts.collect).toHaveBeenCalledWith('US', 'hbo', { watchforge: true });
    expect(f.admin.runRankedSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'streaming_top', railKey: 'motn:hbo:US', provider: 'MOTN' }),
    );
    expect(result).toMatchObject({
      railsFetched: 1,
      railsAlreadyToday: 1,
      itemsExisting: 1,
      pruned: 3,
    });
    expect(f.prisma.hydrationJob.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: { notIn: ['keep-1'] } }),
    });
    expect(result).toMatchObject({ lastJobId: 'job', itemsHydrated: 0 });
  });

  it('stops before spending when the observed quota is used up, falling back to the last report', async () => {
    const f = fixture();
    const previous = {
      quotaUsed: 990,
      quotaGranted: 1000,
      quotaResetAt: new Date(Date.now() + 86400_000).toISOString(),
    };
    const result = await f.runner.run(config, previous);
    expect(f.charts.collect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ railsQuotaStopped: 2, quotaRemaining: 10 });
  });

  it('never runs twice at once', async () => {
    const f = fixture();
    let release!: () => void;
    f.charts.collect.mockImplementationOnce(
      () =>
        new Promise(
          (resolve) =>
            (release = () =>
              resolve({
                items: [],
                dropped: 0,
                filtered: 0,
                existing: 0,
                created: 0,
                skipped: 0,
                conflicts: 0,
                duplicates: 0,
              })),
        ),
    );
    const first = f.runner.run(config);
    await new Promise((r) => setImmediate(r));
    expect(f.runner.running).toBe(true);
    await expect(f.runner.run(config)).resolves.toEqual({ skipped: 1, alreadyRunning: 1 });
    release();
    await first;
    expect(f.runner.running).toBe(false);
  });

  it('marks the run failed but keeps going when one rail errors', async () => {
    const f = fixture();
    f.charts.collect.mockRejectedValueOnce(new Error('motn 429'));
    const result = await f.runner.run(config, null);
    expect(result).toMatchObject({ railsFetched: 1, railsFailed: 1 });
    expect((result as { failedSteps?: string }).failedSteps).toMatch(/motn:netflix:US: motn 429/);
  });
});
