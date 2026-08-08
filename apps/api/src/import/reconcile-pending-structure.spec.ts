import { ImportService } from './import.service';
import { STRUCTURE_PENDING_ERROR, STRUCTURE_REVIEW_ERROR } from './lib/structure-pending';

describe('ImportService.reconcilePendingStructureItems', () => {
  const pendingItem = (id: string, tvdbId: string) => ({
    id,
    importId: 'import-1',
    sourceEntityType: 'WATCHED_EPISODE',
    targetEntityType: 'WATCHED_EPISODE',
    status: 'PENDING_MATCH',
    errorMessage: STRUCTURE_PENDING_ERROR,
    matchedMediaId: 'lost',
    matchedEpisodeId: null,
    confidenceScore: 0.6,
    rawData: { episodeIds: { tvdb: Number(tvdbId) } },
    normalizedData: { season: 6, episode: tvdbId === '1685201' ? 17 : 18 },
    import: {
      id: 'import-1',
      userId: 'user-1',
      format: 'tvtime',
      status: 'READY_FOR_REVIEW',
    },
  });

  function makeService(episodes: any[]) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      importItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            pendingItem('item-17', '1685201'),
            pendingItem('item-18', '1685211'),
          ]),
        updateMany,
        groupBy: jest.fn().mockResolvedValue([]),
      },
      episode: { findMany: jest.fn().mockResolvedValue(episodes) },
      import: { update: jest.fn().mockResolvedValue({}) },
    };
    const matcher = { clearStructureEvaluationPending: jest.fn() };
    const service = new ImportService(
      prisma as any,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, matcher, updateMany };
  }

  it('rematches split provider episodes to separate active TVDB targets', async () => {
    const { service, prisma, matcher, updateMany } = makeService([
      {
        id: 'tvdb-17',
        number: 17,
        season: { number: 6 },
        externalIds: [{ value: '1685201' }],
      },
      {
        id: 'tvdb-18',
        number: 18,
        season: { number: 6 },
        externalIds: [{ value: '1685211' }],
      },
    ]);

    await expect(
      service.reconcilePendingStructureItems({
        mediaId: 'lost',
        evaluated: true,
        blocked: false,
      }),
    ).resolves.toEqual({ examined: 2, matched: 2, needsReview: 0, applied: 0 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-17'] } },
      data: expect.objectContaining({ status: 'MATCHED', matchedEpisodeId: 'tvdb-17' }),
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-18'] } },
      data: expect.objectContaining({ status: 'MATCHED', matchedEpisodeId: 'tvdb-18' }),
    });
    expect(matcher.clearStructureEvaluationPending).toHaveBeenCalledWith('lost');
    expect(prisma.importItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['PENDING_MATCH', 'NEEDS_REVIEW'] },
          errorMessage: { in: [STRUCTURE_PENDING_ERROR, STRUCTURE_REVIEW_ERROR] },
        }),
      }),
    );
  });

  it('refuses to collapse two provider episode identities onto one active episode', async () => {
    const { service, updateMany } = makeService([
      {
        id: 'tmdb-combined-finale',
        number: 17,
        season: { number: 6 },
        externalIds: [{ value: '1685201' }, { value: '1685211' }],
      },
    ]);

    await expect(
      service.reconcilePendingStructureItems({
        mediaId: 'lost',
        evaluated: true,
        blocked: false,
      }),
    ).resolves.toEqual({ examined: 2, matched: 0, needsReview: 2, applied: 0 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-17', 'item-18'] } },
      data: {
        status: 'NEEDS_REVIEW',
        matchedEpisodeId: null,
        errorMessage: STRUCTURE_REVIEW_ERROR,
      },
    });
  });

  it('replays exact active aliases individually when the authority migration is blocked', async () => {
    const { service, updateMany } = makeService([
      {
        id: 'active-17',
        number: 17,
        season: { number: 6 },
        externalIds: [{ value: '1685201' }],
      },
      {
        id: 'coordinate-only-18',
        number: 18,
        season: { number: 6 },
        externalIds: [],
      },
    ]);

    await expect(
      service.reconcilePendingStructureItems({
        mediaId: 'lost',
        evaluated: true,
        blocked: true,
      }),
    ).resolves.toEqual({ examined: 2, matched: 1, needsReview: 1, applied: 0 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-17'] } },
      data: expect.objectContaining({
        status: 'MATCHED',
        matchedEpisodeId: 'active-17',
        errorMessage: null,
      }),
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-18'] } },
      data: {
        status: 'NEEDS_REVIEW',
        matchedEpisodeId: null,
        errorMessage: STRUCTURE_REVIEW_ERROR,
      },
    });
  });
});
