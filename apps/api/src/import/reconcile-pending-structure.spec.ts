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

  function makeService(episodes: any[], items?: any[]) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      importItem: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            items ?? [pendingItem('item-17', '1685201'), pendingItem('item-18', '1685211')],
          ),
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

  it('keeps unresolved E0 placeholders out of review and preserves their comments at show level', async () => {
    const watched = pendingItem('watched-e0', '90001');
    (watched as any).normalizedData = { title: 'Alone', season: 7, episode: 0 };
    const vote = pendingItem('vote-e0', '90002');
    vote.sourceEntityType = 'EPISODE_CHARACTER_VOTE';
    vote.targetEntityType = 'EPISODE_CHARACTER_VOTE';
    (vote as any).normalizedData = {
      showTitle: 'Will Trent',
      seasonNumber: 0,
      episodeNumber: 0,
    };
    const comment = pendingItem('comment-e0', '90003');
    comment.sourceEntityType = 'EPISODE_COMMENT';
    comment.targetEntityType = 'EPISODE_COMMENT';
    (comment as any).normalizedData = {
      showTitle: 'Alone',
      seasonNumber: 7,
      episodeNumber: 0,
      text: 'Preserve this comment',
    };

    const { service, updateMany } = makeService([], [watched, vote, comment]);

    await expect(
      service.reconcilePendingStructureItems({
        mediaId: 'lost',
        evaluated: true,
        blocked: true,
      }),
    ).resolves.toEqual({ examined: 3, matched: 1, needsReview: 0, applied: 0 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['comment-e0'] } },
      data: {
        sourceEntityType: 'SHOW_COMMENT',
        targetEntityType: 'SHOW_COMMENT',
        status: 'MATCHED',
        matchedEpisodeId: null,
        confidenceScore: 0.75,
        errorMessage: null,
      },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['watched-e0', 'vote-e0'] } },
      data: {
        status: 'UNMATCHED',
        matchedEpisodeId: null,
        errorMessage: null,
      },
    });
  });

  it('does not coordinate-match an unresolved S0 special after structure evaluation', async () => {
    const special = pendingItem('special-s0e1', '91001');
    (special as any).normalizedData = { title: 'Special', season: 0, episode: 1 };
    const { service, updateMany } = makeService(
      [
        {
          id: 'coordinate-only-special',
          number: 1,
          season: { number: 0 },
          externalIds: [],
        },
      ],
      [special],
    );

    await expect(
      service.reconcilePendingStructureItems({
        mediaId: 'lost',
        evaluated: true,
        blocked: false,
      }),
    ).resolves.toEqual({ examined: 1, matched: 0, needsReview: 0, applied: 0 });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['special-s0e1'] } },
      data: {
        status: 'UNMATCHED',
        matchedEpisodeId: null,
        errorMessage: null,
      },
    });
  });
});
