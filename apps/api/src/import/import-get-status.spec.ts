import { ImportService } from './import.service';
import { STRUCTURE_PENDING_ERROR } from './lib/structure-pending';

/** getStatus importTotals: distinct matched shows/movies + per-family item counts. */
describe('ImportService.getStatus — importTotals', () => {
  it('computes distinct media counts and family totals', async () => {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1', createdAt: new Date() })),
      },
      importItem: {
        count: jest.fn(async (args: any) => {
          expect(args.where).toEqual({
            importId: 'imp1',
            status: 'PENDING_MATCH',
            errorMessage: STRUCTURE_PENDING_ERROR,
          });
          return 27;
        }),
        groupBy: jest.fn(async (args: any) => {
          expect(args.where.status).toEqual({ not: 'SKIPPED' });
          return [
            { sourceEntityType: 'EPISODE_COMMENT', _count: { _all: 3 } },
            { sourceEntityType: 'MOVIE_COMMENT', _count: { _all: 2 } },
            { sourceEntityType: 'EPISODE_EMOTION', _count: { _all: 4 } },
            { sourceEntityType: 'EPISODE_RATING', _count: { _all: 5 } },
            { sourceEntityType: 'SHOW_RATING', _count: { _all: 1 } },
            { sourceEntityType: 'EPISODE_CHARACTER_VOTE', _count: { _all: 6 } },
            { sourceEntityType: 'LIST', _count: { _all: 2 } },
          ];
        }),
      },
      $queryRaw: jest.fn(async () => [{ shows: 12, movies: 3 }]),
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

    const res: any = await service.getStatus('u1', 'imp1');

    expect(res.importTotals).toEqual({
      shows: 12,
      movies: 3,
      lists: 2,
      comments: 5, // 3 episode + 2 movie
      reactions: 4,
      ratings: 6, // 5 episode + 1 show
      characterVotes: 6,
    });
    expect(res.pendingStructureCount).toBe(27);
  });
});
