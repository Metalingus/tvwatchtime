import { MediaType } from '@tvwatch/shared';
import { AdminService, classifyHydrationIssue } from './admin.service';

function makeService(options?: {
  prisma?: any;
  meta?: any;
  canonical?: any;
  tmdb?: any;
  metadataBackfill?: any;
  structureAuthority?: any;
}) {
  const prisma =
    options?.prisma ??
    ({
      hydrationJobItem: {
        findMany: jest.fn(),
        groupBy: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      hydrationJob: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      externalId: { findUnique: jest.fn(), findMany: jest.fn() },
      mediaItem: { findUnique: jest.fn(), findMany: jest.fn() },
      adminAuditLog: { create: jest.fn(async () => ({})) },
    } as any);
  const meta = options?.meta ?? ({ ensureShowFull: jest.fn(), ensureMovieFull: jest.fn() } as any);
  const unused = {} as any;
  const service = new AdminService(
    prisma,
    meta,
    options?.tmdb ?? unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    options?.metadataBackfill,
    undefined,
    options?.canonical,
    undefined,
    options?.structureAuthority,
  );
  return { service, prisma, meta };
}

const pendingShow = {
  id: 'item-171',
  jobId: 'job-1',
  tmdbId: 123,
  mediaType: 'SHOW',
  status: 'pending',
};

function finalJobUpdate(prisma: any) {
  const calls = prisma.hydrationJob.update.mock.calls;
  return calls[calls.length - 1][0];
}

describe('AdminService hydration jobs', () => {
  it('classifies transient and authority errors without treating authority conflicts as retryable', () => {
    expect(classifyHydrationIssue('TMDB request timed out with 503')).toEqual({
      kind: 'provider_transient',
      retryable: true,
    });
    expect(
      classifyHydrationIssue('atomic structure remap failed: TVDB episode belongs to another show'),
    ).toEqual({ kind: 'authority_conflict', retryable: false });
  });

  it('keeps prior successful counts when a retry finishes', async () => {
    const { service, prisma, meta } = makeService();
    prisma.hydrationJobItem.findMany.mockResolvedValue([pendingShow]);
    prisma.hydrationJobItem.groupBy.mockResolvedValue([
      { status: 'done', _count: { _all: 170 } },
      { status: 'pending', _count: { _all: 1 } },
    ]);
    prisma.hydrationJob.findUnique.mockResolvedValue({ totalItems: 171, tmdbApiCalls: 510 });
    prisma.externalId.findMany.mockResolvedValue([]);
    meta.ensureShowFull.mockResolvedValue('media-123');

    await (service as any).processHydrationJob('job-1', 'trending_shows', 'admin', true);

    expect(finalJobUpdate(prisma)).toEqual({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'completed',
        processedItems: 171,
        failedItems: 0,
        tmdbApiCalls: 513,
      }),
    });
  });

  it('uses an exact existing canonical row as a read-only rail fallback when refresh fails', async () => {
    const canonical = { resolveMediaId: jest.fn(async () => 'canonical-media') };
    const { service, prisma, meta } = makeService({ canonical });
    prisma.hydrationJobItem.findMany.mockResolvedValue([pendingShow]);
    prisma.hydrationJobItem.groupBy.mockResolvedValue([{ status: 'pending', _count: { _all: 1 } }]);
    prisma.hydrationJob.findUnique.mockResolvedValue({ totalItems: 1, tmdbApiCalls: 0 });
    prisma.externalId.findMany.mockResolvedValue([
      { mediaId: 'old-media', value: '123', providerEntityKind: 'SERIES' },
    ]);
    prisma.mediaItem.findUnique.mockResolvedValue({
      id: 'canonical-media',
      title: 'Existing Show',
      type: MediaType.SHOW,
      canonicalSource: null,
    });
    meta.ensureShowFull.mockRejectedValue(
      new Error('atomic structure remap failed: TVDB episode belongs to another show'),
    );

    await (service as any).processHydrationJob('job-1', 'trending_shows', 'admin', true);

    expect(canonical.resolveMediaId).toHaveBeenCalledWith('old-media');
    expect(prisma.hydrationJobItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: pendingShow.id },
        data: expect.objectContaining({ status: 'fallback', mediaId: 'canonical-media' }),
      }),
    );
    expect(finalJobUpdate(prisma).data).toEqual(
      expect.objectContaining({ status: 'completed', processedItems: 1, failedItems: 0 }),
    );
  });

  it('keeps a new or unresolved title fail-closed when hydration fails', async () => {
    const { service, prisma, meta } = makeService();
    prisma.hydrationJobItem.findMany.mockResolvedValue([pendingShow]);
    prisma.hydrationJobItem.groupBy.mockResolvedValue([{ status: 'pending', _count: { _all: 1 } }]);
    prisma.hydrationJob.findUnique.mockResolvedValue({ totalItems: 1, tmdbApiCalls: 0 });
    prisma.externalId.findMany.mockResolvedValue([]);
    meta.ensureShowFull.mockRejectedValue(new Error('TMDB 404 not found'));

    await (service as any).processHydrationJob('job-1', 'trending_shows', 'admin', true);

    expect(prisma.hydrationJobItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    expect(finalJobUpdate(prisma).data).toEqual(
      expect.objectContaining({ status: 'failed', processedItems: 1, failedItems: 1 }),
    );
  });

  describe('streaming chart snapshots', () => {
    const presetShow = { ...pendingShow, mediaId: 'stub-show' };
    const presetMovie = {
      id: 'item-2',
      jobId: 'job-1',
      tmdbId: 456,
      mediaType: 'MOVIE',
      status: 'pending',
      mediaId: 'stub-movie',
    };

    it('decides a never-owned show against its stored TVDB alias, not TMDB raw links', async () => {
      const decision = { provider: 'TMDB', reason: 'GENERAL_TMDB' };
      const structureAuthority = { forTmdb: jest.fn(async () => decision) };
      const { service, prisma, meta } = makeService({ structureAuthority });
      prisma.hydrationJobItem.findMany.mockResolvedValue([presetShow]);
      prisma.hydrationJobItem.groupBy.mockResolvedValue([
        { status: 'pending', _count: { _all: 1 } },
      ]);
      prisma.hydrationJob.findUnique.mockResolvedValue({ totalItems: 1, tmdbApiCalls: 0 });
      prisma.externalId.findMany.mockResolvedValue([]);
      prisma.mediaItem.findUnique.mockResolvedValueOnce({
        id: 'stub-show',
        type: MediaType.SHOW,
        show: { structureProvider: null },
        externalIds: [{ provider: 'TMDB', providerEntityKind: 'SERIES', value: '123' }],
      });
      meta.ensureShowFull.mockResolvedValue('stub-show');

      await (service as any).processHydrationJob('job-1', 'streaming_top', 'system', true);

      expect(structureAuthority.forTmdb).toHaveBeenCalledWith(123, 'stub-show', {
        storedTvdbAlias: true,
      });
      expect(meta.ensureShowFull).toHaveBeenCalledWith(123, undefined, { decision });
      expect(finalJobUpdate(prisma).data).toEqual(expect.objectContaining({ status: 'completed' }));
    });

    it('never re-hydrates a chart title that already has metadata', async () => {
      const metadataBackfill = { hydrateExistingMedia: jest.fn(async () => undefined) };
      const { service, prisma, meta } = makeService({ metadataBackfill });
      prisma.hydrationJobItem.findMany.mockResolvedValue([presetShow]);
      prisma.hydrationJobItem.groupBy.mockResolvedValue([
        { status: 'pending', _count: { _all: 1 } },
      ]);
      prisma.hydrationJob.findUnique.mockResolvedValue({ totalItems: 1, tmdbApiCalls: 0 });
      prisma.externalId.findMany.mockResolvedValue([]);
      prisma.mediaItem.findUnique.mockResolvedValueOnce({
        id: 'stub-show',
        type: MediaType.SHOW,
        metadataRefreshedAt: new Date('2026-07-01'),
        show: { structureProvider: 'TMDB' },
        externalIds: [{ provider: 'TMDB', providerEntityKind: 'SERIES', value: '123' }],
      });

      await (service as any).processHydrationJob('job-1', 'streaming_top', 'system', true);

      // Long-running shows (thousands of episodes) are refreshed by the metadata jobs instead.
      expect(meta.ensureShowFull).not.toHaveBeenCalled();
      expect(metadataBackfill.hydrateExistingMedia).not.toHaveBeenCalled();
      expect(finalJobUpdate(prisma).data).toEqual(
        expect.objectContaining({ status: 'completed', tmdbApiCalls: 0 }),
      );
    });

    it('hydrates an owned show through the owner-routed backfill', async () => {
      const metadataBackfill = { hydrateExistingMedia: jest.fn(async () => undefined) };
      const { service, prisma, meta } = makeService({ metadataBackfill });
      prisma.hydrationJobItem.findMany.mockResolvedValue([presetShow]);
      prisma.hydrationJobItem.groupBy.mockResolvedValue([
        { status: 'pending', _count: { _all: 1 } },
      ]);
      prisma.hydrationJob.findUnique.mockResolvedValue({ totalItems: 1, tmdbApiCalls: 0 });
      prisma.externalId.findMany.mockResolvedValue([]);
      prisma.mediaItem.findUnique.mockResolvedValueOnce({
        id: 'stub-show',
        type: MediaType.SHOW,
        show: { structureProvider: 'TVDB' },
        externalIds: [{ provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '900' }],
      });

      await (service as any).processHydrationJob('job-1', 'streaming_top', 'system', true);

      expect(metadataBackfill.hydrateExistingMedia).toHaveBeenCalledWith('stub-show');
      expect(meta.ensureShowFull).not.toHaveBeenCalled();
    });

    it('activates with a failed new title, which never falls back to its empty stub', async () => {
      const { service, prisma, meta } = makeService();
      prisma.hydrationJobItem.findMany.mockResolvedValue([
        presetMovie,
        { ...presetMovie, id: 'item-3', tmdbId: 789, mediaId: 'ok-movie' },
      ]);
      prisma.hydrationJobItem.groupBy.mockResolvedValue([
        { status: 'pending', _count: { _all: 2 } },
        { status: 'skipped', _count: { _all: 1 } },
      ]);
      prisma.hydrationJob.findUnique.mockResolvedValue({ totalItems: 3, tmdbApiCalls: 0 });
      prisma.externalId.findMany.mockResolvedValue([]);
      prisma.mediaItem.findUnique.mockImplementation(async ({ where, select }: any) =>
        select?.canonicalSource
          ? { id: where.id, title: 'Stub', type: MediaType.MOVIE, metadataRefreshedAt: null }
          : {
              id: where.id,
              type: MediaType.MOVIE,
              show: null,
              externalIds: [
                {
                  provider: 'TMDB',
                  providerEntityKind: 'MOVIE',
                  value: where.id === 'ok-movie' ? '789' : '456',
                },
              ],
            },
      );
      meta.ensureMovieFull.mockImplementation(async (tmdbId: number) => {
        if (tmdbId === 456) throw new Error('TMDB 404 not found');
        return 'ok-movie';
      });

      await (service as any).processHydrationJob('job-1', 'streaming_top', 'system', true);

      expect(prisma.hydrationJobItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-2' },
          data: expect.objectContaining({ status: 'failed' }),
        }),
      );
      expect(finalJobUpdate(prisma).data).toEqual(
        expect.objectContaining({ status: 'completed', failedItems: 1, skippedItems: 1 }),
      );
    });
  });

  it('starts retry progress from all terminal rows instead of only the retry batch', async () => {
    const { service, prisma } = makeService();
    prisma.hydrationJob.findUnique.mockResolvedValue({
      id: 'job-1',
      type: 'trending_shows',
      railSnapshot: true,
    });
    prisma.hydrationJobItem.updateMany.mockResolvedValue({ count: 4 });
    prisma.hydrationJobItem.groupBy.mockResolvedValue([
      { status: 'done', _count: { _all: 166 } },
      { status: 'fallback', _count: { _all: 1 } },
      { status: 'pending', _count: { _all: 4 } },
    ]);
    jest.spyOn(service as any, 'processHydrationJob').mockResolvedValue(undefined);

    await service.retryJob('admin', 'job-1');

    expect(prisma.hydrationJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'running',
        processedItems: 167,
        failedItems: 0,
      }),
    });
  });

  it('returns failed titles and structured issue details to the admin UI', async () => {
    const { service, prisma } = makeService();
    prisma.hydrationJob.findUnique.mockResolvedValue({
      id: 'job-1',
      items: [
        {
          id: 'failed-1',
          tmdbId: 123,
          mediaType: 'SHOW',
          mediaId: null,
          status: 'failed',
          errorMessage: 'atomic structure remap failed',
        },
      ],
    });
    prisma.externalId.findMany.mockResolvedValue([
      {
        value: '123',
        providerEntityKind: 'SERIES',
        media: { id: 'media-123', title: 'Problem Show' },
      },
    ]);

    const result = await service.getJobDetail('job-1');

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        title: 'Problem Show',
        issue: { kind: 'authority_conflict', retryable: false },
      }),
    );
    expect(result.failureSummary).toEqual({ authority_conflict: 1 });
  });
});

it('uses one fixed upcoming window for every page in a scheduled hydration snapshot', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-09-18T23:59:59Z'));
  try {
    const tmdb = {
      enabled: true,
      upcomingMovies: jest.fn(async () => {
        jest.setSystemTime(new Date('2026-09-19T00:00:01Z'));
        return [{ tmdbId: 7 }];
      }),
    };
    const { service, prisma } = makeService({ tmdb });
    prisma.hydrationJob.create = jest.fn(async () => ({ id: 'new-job', _count: { items: 1 } }));
    jest.spyOn(service as any, 'processHydrationJob').mockResolvedValue(undefined);
    await service.triggerHydration('system', 'upcoming_movies', { pages: 2, railSnapshot: true });
    expect(tmdb.upcomingMovies.mock.calls).toEqual([
      [1, { start: '2026-09-15', end: '2026-11-18' }],
      [2, { start: '2026-09-15', end: '2026-11-18' }],
    ]);
    expect(prisma.hydrationJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'upcoming_movies',
          railSnapshot: true,
          totalItems: 1,
        }),
      }),
    );
  } finally {
    jest.useRealTimers();
  }
});
