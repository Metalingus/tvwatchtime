import { ImportService } from './import.service';
import { STRUCTURE_PENDING_ERROR } from './lib/structure-pending';

/** Resume flow: latest unfinished import surfaces; dismiss cancels all of them. */
describe('ImportService — resumable + dismissPending', () => {
  it('getResumable returns the latest non-terminal import (or null)', async () => {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async (args: any) => {
          expect(args.where.userId).toBe('u1');
          expect(args.where.status.in).toContain('READY_FOR_REVIEW');
          expect(args.where.status.in).not.toContain('COMPLETED');
          expect(args.orderBy).toEqual({ createdAt: 'desc' });
          return { id: 'imp1', status: 'READY_FOR_REVIEW', needsReviewCount: 12 };
        }),
      },
      importItem: { count: jest.fn().mockResolvedValue(34) },
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

    const res = await service.getResumable('u1');

    expect(res.import).toEqual(
      expect.objectContaining({
        id: 'imp1',
        status: 'READY_FOR_REVIEW',
        needsReviewCount: 12,
        pendingStructureCount: 34,
      }),
    );
    expect(prisma.importItem.count).toHaveBeenCalledWith({
      where: {
        importId: 'imp1',
        status: 'PENDING_MATCH',
        errorMessage: STRUCTURE_PENDING_ERROR,
      },
    });
  });

  it('dismissPending cancels every unfinished import for the user', async () => {
    const prisma: any = {
      import: { updateMany: jest.fn(async () => ({ count: 2 })) },
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

    const res = await service.dismissPending('u1');

    expect(prisma.import.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        status: { in: expect.arrayContaining(['READY_FOR_REVIEW', 'IMPORTING']) },
      },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    });
    expect(res).toEqual({ dismissed: 2 });
  });
});
