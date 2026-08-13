import { MediaType } from '@tvwatch/shared';
import { AdminService, classifyHydrationIssue } from './admin.service';

function makeService(options?: { prisma?: any; meta?: any; canonical?: any }) {
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
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    undefined,
    undefined,
    options?.canonical,
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
