import { ImportService } from './import.service';
import { STRUCTURE_SKIPPED_ERROR } from './lib/structure-pending';

/**
 * resolveAllForShow safety: bulk title resolution must NEVER span unrelated titles.
 * Regression tests for the incident where resolving "승리호" matched every non-Latin
 * item in the import (all normalized to the same empty string).
 */
describe('ImportService.resolveAllForShow — title identity safety', () => {
  function makeService(items: any[]) {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1' })),
        update: jest.fn(async () => ({})),
      },
      importItem: {
        findMany: jest.fn(async () => items),
        update: jest.fn(async () => ({})),
        groupBy: jest.fn(async () => []),
      },
      mediaItem: {
        findUnique: jest.fn(async () => ({ id: 'm1', type: 'SHOW' })),
      },
    };
    const matcher = {
      ensureShowHydrated: jest.fn(async () => undefined),
      reconcileStructureForMissingEpisodes: jest.fn(async () => ({
        attempted: false,
        repaired: false,
        blocked: false,
      })),
      resolveEpisode: jest.fn(async () => 'ep-1'),
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, matcher };
  }

  it('refuses to bulk-resolve a title with no letters/digits (empty identity)', async () => {
    const { service, prisma } = makeService([
      {
        id: 'it1',
        sourceEntityType: 'LIST_ITEM',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: '승리호' },
      },
    ]);

    const res = await service.resolveAllForShow('u1', 'imp1', 'm-yatterman', '???', null);

    expect(res).toEqual({ resolved: 0, matched: 0, needsReview: 0, skipped: 0 });
    expect(prisma.importItem.update).not.toHaveBeenCalled();
  });

  it('matches only the SAME non-Latin title (승리호 ≠ 소울메이트)', async () => {
    const items = [
      {
        id: 'it-target',
        sourceEntityType: 'LIST_ITEM',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: '승리호' },
      },
      {
        id: 'it-other',
        sourceEntityType: 'LIST_ITEM',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: '소울메이트' },
      },
    ];
    const { service, prisma } = makeService(items);

    const res = await service.resolveAllForShow('u1', 'imp1', 'm-space-sweepers', '승리호', null);

    expect(res.resolved).toBe(1);
    const updatedIds = prisma.importItem.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(updatedIds).toEqual(['it-target']);
  });

  it('retitles episode-scoped items to MOVIE equivalents when the target is a movie', async () => {
    const items = [
      {
        id: 'ep1',
        sourceEntityType: 'WATCHED_EPISODE',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: 'Pirates of the Caribbean', season: 1, episode: 2 },
      },
      {
        id: 'r1',
        sourceEntityType: 'EPISODE_RATING',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: 'Pirates of the Caribbean', season: 1, episode: 2 },
      },
      {
        id: 'cv1',
        sourceEntityType: 'EPISODE_CHARACTER_VOTE',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: 'Pirates of the Caribbean', season: 1, episode: 2 },
      },
    ];
    const { service, prisma } = makeService(items);
    prisma.mediaItem = { findUnique: jest.fn(async () => ({ id: 'm-pirates', type: 'MOVIE' })) };

    const res = await service.resolveAllForShow(
      'u1',
      'imp1',
      'm-pirates',
      'Pirates of the Caribbean',
      1,
    );

    const byId = Object.fromEntries(
      prisma.importItem.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data]),
    );
    expect(byId['ep1']).toEqual(
      expect.objectContaining({
        sourceEntityType: 'WATCHED_MOVIE',
        matchedEpisodeId: null,
        status: 'MATCHED',
      }),
    );
    expect(byId['r1']).toEqual(
      expect.objectContaining({ sourceEntityType: 'MOVIE_RATING', status: 'MATCHED' }),
    );
    expect(byId['cv1']).toEqual(
      expect.objectContaining({
        sourceEntityType: 'MOVIE_CHARACTER_VOTE',
        matchedEpisodeId: null,
        status: 'MATCHED',
      }),
    );
    expect(res.matched).toBe(3);
    expect(res.needsReview).toBe(0);
  });

  it('patchItem retypes an episode item to WATCHED_MOVIE on a manual movie match', async () => {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1' })),
        update: jest.fn(async () => ({})),
      },
      importItem: {
        findFirst: jest.fn(async () => ({
          id: 'ep1',
          importId: 'imp1',
          sourceEntityType: 'WATCHED_EPISODE',
        })),
        update: jest.fn(async (args: any) => args),
        groupBy: jest.fn(async () => []),
      },
      mediaItem: { findUnique: jest.fn(async () => ({ id: 'm-pirates', type: 'MOVIE' })) },
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

    await service.patchItem('u1', 'imp1', 'ep1', { matchedMediaId: 'm-pirates' });

    expect(prisma.importItem.update).toHaveBeenCalledWith({
      where: { id: 'ep1' },
      data: expect.objectContaining({
        matchedMediaId: 'm-pirates',
        matchedEpisodeId: null,
        sourceEntityType: 'WATCHED_MOVIE',
        status: 'MATCHED',
      }),
    });
  });

  it('patchItem resolves every unresolved movie row sharing the selected archive movie UUID', async () => {
    const prisma: any = {
      import: { update: jest.fn(async () => ({})) },
      importItem: {
        findFirst: jest.fn(async () => ({
          id: 'rating-1',
          importId: 'imp1',
          sourceEntityType: 'MOVIE_RATING',
          normalizedData: {
            movieTitle: 'Finding ‘Ohana',
            movieUuid: 'c428a33a-2799-438b-82b5-33ed49b78f37',
          },
        })),
        findMany: jest.fn(async () => [
          {
            id: 'emotion-1',
            sourceEntityType: 'MOVIE_EMOTION',
            normalizedData: {
              movieTitle: 'Finding ‘Ohana',
              movieUuid: 'c428a33a-2799-438b-82b5-33ed49b78f37',
            },
          },
          {
            id: 'watchlist-1',
            sourceEntityType: 'WATCHLIST_MOVIE',
            normalizedData: {
              title: 'Finding ‘Ohana',
              movieUuid: 'c428a33a-2799-438b-82b5-33ed49b78f37',
            },
          },
        ]),
        update: jest.fn(async (args: any) => args),
        updateMany: jest.fn(async () => ({ count: 2 })),
        groupBy: jest.fn(async () => []),
      },
      mediaItem: { findUnique: jest.fn(async () => ({ id: 'finding-ohana', type: 'MOVIE' })) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
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

    await service.patchItem('u1', 'imp1', 'rating-1', { matchedMediaId: 'finding-ohana' });

    expect(prisma.importItem.findMany).toHaveBeenCalledWith({
      where: {
        importId: 'imp1',
        id: { not: 'rating-1' },
        status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] },
        normalizedData: {
          path: ['movieUuid'],
          equals: 'c428a33a-2799-438b-82b5-33ed49b78f37',
        },
      },
      select: { id: true, sourceEntityType: true, normalizedData: true },
    });
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['emotion-1', 'watchlist-1'] } },
      data: {
        matchedMediaId: 'finding-ohana',
        matchedEpisodeId: null,
        status: 'MATCHED',
        confidenceScore: 1,
        errorMessage: null,
      },
    });
  });

  it('never merges year variants in bulk resolves ("One Piece" ≠ "ONE PIECE (2023)")', async () => {
    const items = [
      {
        id: 'it-anime',
        sourceEntityType: 'WATCHED_EPISODE',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: 'One Piece', season: 1, episode: 5 },
      },
      {
        id: 'it-live',
        sourceEntityType: 'WATCHED_EPISODE',
        status: 'NEEDS_REVIEW',
        normalizedData: { title: 'ONE PIECE (2023)', season: 1, episode: 5 },
      },
    ];
    const { service, prisma } = makeService(items);

    const res = await service.resolveAllForShow('u1', 'imp1', 'm-onepiece', 'One Piece', null);

    expect(res.resolved).toBe(1);
    const updatedIds = prisma.importItem.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(updatedIds).toEqual(['it-anime']);
  });

  it('reconciles a manually selected show before retrying a missing split episode', async () => {
    const items = [
      {
        id: 'lost-finale-part-2',
        sourceEntityType: 'WATCHED_EPISODE',
        status: 'NEEDS_REVIEW',
        normalizedData: { showTitle: 'Lost', season: 6, episode: 18 },
      },
    ];
    const { service, prisma, matcher } = makeService(items);
    matcher.reconcileStructureForMissingEpisodes.mockResolvedValue({
      attempted: true,
      repaired: true,
      blocked: false,
    });
    matcher.resolveEpisode.mockResolvedValue('tvdb-lost-s6e18');

    const res = await service.resolveAllForShow('u1', 'imp1', 'lost', 'Lost', null);

    expect(matcher.reconcileStructureForMissingEpisodes).toHaveBeenCalledWith('lost', [
      { season: 6, episode: 18 },
    ]);
    expect(prisma.importItem.update).toHaveBeenCalledWith({
      where: { id: 'lost-finale-part-2' },
      data: expect.objectContaining({
        matchedMediaId: 'lost',
        matchedEpisodeId: 'tvdb-lost-s6e18',
        status: 'MATCHED',
      }),
    });
    expect(res).toEqual({ resolved: 1, matched: 1, needsReview: 0, skipped: 0 });
  });
});

describe('ImportService.resolveAllForShow — terminal episode artifacts', () => {
  function makeService(items: any[], episodeId: string | null = null) {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async () => ({ id: 'import-1', userId: 'user-1' })),
        update: jest.fn(async () => ({})),
      },
      mediaItem: { findUnique: jest.fn(async () => ({ type: 'SHOW' })) },
      importItem: {
        findMany: jest.fn(async () => items),
        update: jest.fn(async () => ({})),
        groupBy: jest.fn(async () => []),
      },
    };
    const matcher: any = {
      ensureShowHydrated: jest.fn(async () => undefined),
      reconcileStructureForMissingEpisodes: jest.fn(async () => ({
        attempted: true,
        repaired: true,
        blocked: false,
      })),
      resolveEpisodeByExternalIds: jest.fn(async () => episodeId),
      resolveEpisode: jest.fn(async () => null),
      recoverEpisodeByTvdbId: jest.fn(async () => null),
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      matcher,
      {} as any,
      {} as any,
    );
    return { service, prisma, matcher };
  }

  const item = (overrides: Record<string, unknown> = {}) => ({
    id: 'item-1',
    sourceEntityType: 'EPISODE_CHARACTER_VOTE',
    normalizedData: {
      showTitle: 'Will Trent',
      seasonNumber: 0,
      episodeNumber: 0,
      externalEpisodeId: 9785898,
    },
    ...overrides,
  });

  it('silently skips a manually selected S0E0 artifact when its TVDB id has no target', async () => {
    const { service, prisma, matcher } = makeService([item()]);

    await expect(
      service.resolveAllForShow('user-1', 'import-1', 'will-trent', 'Will Trent'),
    ).resolves.toEqual({ resolved: 1, matched: 0, needsReview: 0, skipped: 1 });

    expect(matcher.resolveEpisodeByExternalIds).toHaveBeenCalledWith('will-trent', {
      tvdb: 9785898,
    });
    expect(matcher.resolveEpisode).not.toHaveBeenCalled();
    expect(matcher.recoverEpisodeByTvdbId).toHaveBeenCalledWith('will-trent', '9785898');
    expect(prisma.importItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: {
        matchedMediaId: 'will-trent',
        matchedEpisodeId: null,
        status: 'SKIPPED',
        confidenceScore: 0,
        errorMessage: STRUCTURE_SKIPPED_ERROR,
      },
    });
  });

  it('matches S0E0 only when its exact TVDB episode alias is active', async () => {
    const { service, prisma, matcher } = makeService([item()], 'special-episode');

    await expect(
      service.resolveAllForShow('user-1', 'import-1', 'will-trent', 'Will Trent'),
    ).resolves.toEqual({ resolved: 1, matched: 1, needsReview: 0, skipped: 0 });

    expect(matcher.resolveEpisode).not.toHaveBeenCalled();
    expect(matcher.recoverEpisodeByTvdbId).not.toHaveBeenCalled();
    expect(prisma.importItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: {
        matchedMediaId: 'will-trent',
        matchedEpisodeId: 'special-episode',
        status: 'MATCHED',
        confidenceScore: 1,
        errorMessage: null,
      },
    });
  });

  it('preserves an unresolvable episode comment as a show comment', async () => {
    const { service, prisma } = makeService([item({ sourceEntityType: 'EPISODE_COMMENT' })]);

    await expect(
      service.resolveAllForShow('user-1', 'import-1', 'will-trent', 'Will Trent'),
    ).resolves.toEqual({ resolved: 1, matched: 1, needsReview: 0, skipped: 0 });

    expect(prisma.importItem.update).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: {
        matchedMediaId: 'will-trent',
        matchedEpisodeId: null,
        sourceEntityType: 'SHOW_COMMENT',
        targetEntityType: 'SHOW_COMMENT',
        status: 'MATCHED',
        confidenceScore: 1,
        errorMessage: null,
      },
    });
  });
});
