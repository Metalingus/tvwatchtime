import { ImportService } from './import.service';
import { STRUCTURE_PENDING_ERROR } from './lib/structure-pending';

describe('ImportService.confirm retry', () => {
  it('allows a failed section-idempotent import to be confirmed again', async () => {
    const prisma: any = {
      import: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'imp1',
          userId: 'u1',
          status: 'FAILED',
          processedAt: new Date('2026-08-01T12:00:00.000Z'),
          format: 'tvtime',
          ownerExternalId: null,
          storageKey: 'already-cleaned',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const events = { emit: jest.fn() };
    const service = new ImportService(
      prisma,
      storage as any,
      {} as any,
      events as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (service as any).claimShadowAccount = jest.fn().mockResolvedValue(undefined);
    (service as any).applyBatch = jest.fn().mockResolvedValue({ created: 2, skipped: 1 });
    (service as any).rebuildShowStatuses = jest.fn().mockResolvedValue(undefined);

    await expect(service.confirm('u1', 'imp1')).resolves.toEqual({
      importId: 'imp1',
      created: 2,
      skipped: 1,
    });
    expect(prisma.import.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'imp1' },
      data: { status: 'IMPORTING', progress: 0 },
    });
    expect(prisma.import.update).toHaveBeenLastCalledWith({
      where: { id: 'imp1' },
      data: {
        status: 'COMPLETED',
        completedAt: expect.any(Date),
        progress: 100,
      },
    });
  });

  it('rejects a FAILED import whose archive processing never completed', async () => {
    const prisma: any = {
      import: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'imp1',
          userId: 'u1',
          status: 'FAILED',
          processedAt: null,
        }),
        update: jest.fn(),
      },
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.confirm('u1', 'imp1')).rejects.toThrow(
      'Import cannot be confirmed (status=FAILED)',
    );
    expect(prisma.import.update).not.toHaveBeenCalled();
  });

  it('completes the import without waiting for structure-pending episode rows', async () => {
    const matched = {
      id: 'matched-1',
      status: 'MATCHED',
      sourceEntityType: 'WATCHED_EPISODE',
      matchedMediaId: 'show-ok',
      matchedEpisodeId: 'episode-ok',
      errorMessage: null,
    };
    const pending = {
      id: 'pending-1',
      status: 'PENDING_MATCH',
      sourceEntityType: 'WATCHED_EPISODE',
      matchedMediaId: 'lost',
      matchedEpisodeId: null,
      errorMessage: STRUCTURE_PENDING_ERROR,
    };
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([matched, pending])
      .mockResolvedValueOnce([{ matchedMediaId: 'lost' }])
      .mockResolvedValue([]);
    const prisma: any = {
      import: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'imp1',
          userId: 'u1',
          status: 'READY_FOR_REVIEW',
          processedAt: new Date(),
          format: 'tvtime',
          ownerExternalId: null,
          storageKey: 'archive.zip',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: { findMany },
    };
    const hydration = { enqueueStructureEvaluation: jest.fn().mockResolvedValue(undefined) };
    const service = new ImportService(
      prisma,
      { delete: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any,
      { emit: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      hydration as any,
    );
    (service as any).claimShadowAccount = jest.fn().mockResolvedValue(undefined);
    (service as any).applyBatch = jest.fn().mockResolvedValue({ created: 1, skipped: 0 });
    (service as any).rebuildShowStatuses = jest.fn().mockResolvedValue(undefined);
    (service as any).reconcilePendingCharacterVotes = jest.fn().mockResolvedValue({
      imports: 0,
      created: 0,
      skipped: 0,
    });

    await expect(service.confirm('u1', 'imp1')).resolves.toEqual({
      importId: 'imp1',
      created: 1,
      skipped: 0,
    });

    expect((service as any).applyBatch).toHaveBeenCalledWith('u1', 'imp1', [matched], 'TVTIME');
    expect(hydration.enqueueStructureEvaluation).toHaveBeenCalledWith('lost');
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: { status: 'COMPLETED', completedAt: expect.any(Date), progress: 100 },
    });
  });
});
