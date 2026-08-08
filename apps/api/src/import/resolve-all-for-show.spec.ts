import { ImportService } from './import.service';

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

    expect(res).toEqual({ resolved: 0, matched: 0, needsReview: 0 });
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
    expect(res).toEqual({ resolved: 1, matched: 1, needsReview: 0 });
  });
});
