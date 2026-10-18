import { ImportService } from './import.service';

/**
 * resolveByName: bulk-resolves visible review items through the verified-name matcher,
 * resolves episodes by S/E for episode-scoped entities, and never touches LIST containers.
 */
describe('ImportService.resolveByName', () => {
  function makeService(opts: {
    items: any[];
    match?: { mediaId: string | null; confidence: number; matchedTitle?: string | null };
    episodeId?: string | null;
  }) {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1' })),
        update: jest.fn(async () => ({})),
      },
      importItem: {
        findMany: jest.fn(async () => opts.items),
        updateMany: jest.fn(async () => ({ count: 1 })),
        groupBy: jest.fn(async () => []),
      },
    };
    const matcher = {
      matchByTitleVerified: jest.fn(async () => opts.match ?? { mediaId: null, confidence: 0 }),
      ensureShowHydrated: jest.fn(async () => undefined),
      resolveEpisodeByExternalIds: jest.fn(async () => null),
      resolveEpisode: jest.fn(async () => opts.episodeId ?? null),
      recoverEpisodeByTvdbId: jest.fn(async () => null),
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

  it('marks a name-verified movie item as MATCHED', async () => {
    const { service, prisma, matcher } = makeService({
      items: [
        {
          id: 'it1',
          sourceEntityType: 'WATCHED_MOVIE',
          status: 'NEEDS_REVIEW',
          normalizedData: { title: '7. Koğuştaki Mucize' },
        },
      ],
      match: { mediaId: 'm-movie', confidence: 0.85 },
    });

    const res = await service.resolveByName('u1', 'imp1', { status: 'needs_review' });

    expect(matcher.matchByTitleVerified).toHaveBeenCalledWith(
      '7 kogustaki mucize',
      '7. Koğuştaki Mucize',
      'MOVIE',
      null,
    );
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'it1', status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] } },
      data: {
        matchedMediaId: 'm-movie',
        matchedEpisodeId: null,
        status: 'MATCHED',
        confidenceScore: 0.85,
      },
    });
    expect(res).toEqual({ examined: 1, resolved: 1, stillUnresolved: 0, applied: 0 });
  });

  it('hydrates the show and resolves the episode for episode-scoped items', async () => {
    const { service, prisma, matcher } = makeService({
      items: [
        {
          id: 'it2',
          sourceEntityType: 'WATCHED_EPISODE',
          status: 'UNMATCHED',
          normalizedData: { title: 'Silo', season: 2, episode: 3 },
        },
      ],
      match: { mediaId: 'm-show', confidence: 0.85 },
      episodeId: 'ep-23',
    });

    const res = await service.resolveByName('u1', 'imp1', {});

    expect(matcher.ensureShowHydrated).toHaveBeenCalledWith('m-show');
    expect(matcher.resolveEpisode).toHaveBeenCalledWith('m-show', 2, 3);
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ matchedEpisodeId: 'ep-23', status: 'MATCHED' }),
      }),
    );
    expect(res.resolved).toBe(1);
  });

  it('leaves an episode item unresolved when the episode cannot be found', async () => {
    const { service, prisma } = makeService({
      items: [
        {
          id: 'it3',
          sourceEntityType: 'WATCHED_EPISODE',
          status: 'NEEDS_REVIEW',
          normalizedData: { title: 'Silo', season: 9, episode: 40 },
        },
      ],
      match: { mediaId: 'm-show', confidence: 0.85 },
      episodeId: null,
    });

    const res = await service.resolveByName('u1', 'imp1', {});

    expect(prisma.importItem.updateMany).not.toHaveBeenCalled();
    expect(res).toEqual({ examined: 1, resolved: 0, stillUnresolved: 1, applied: 0 });
  });

  it('passes the season/episode footprint hint for shows', async () => {
    const { service, matcher } = makeService({
      items: [
        {
          id: 'a',
          sourceEntityType: 'WATCHED_EPISODE',
          status: 'NEEDS_REVIEW',
          normalizedData: { title: 'The Haunting', season: 2, episode: 9 },
        },
        {
          id: 'b',
          sourceEntityType: 'WATCHED_EPISODE',
          status: 'NEEDS_REVIEW',
          normalizedData: { title: 'The Haunting', season: 1, episode: 10 },
        },
      ],
      match: { mediaId: null, confidence: 0 },
    });

    await service.resolveByName('u1', 'imp1', {});

    expect(matcher.matchByTitleVerified).toHaveBeenCalledWith(
      'the haunting',
      'The Haunting',
      'SHOW',
      expect.objectContaining({
        maxSeason: 2,
        seasonEpisodes: expect.arrayContaining([
          { season: 2, maxEpisode: 9 },
          { season: 1, maxEpisode: 10 },
        ]),
      }),
    );
  });

  it('never includes LIST container rows in the query', async () => {
    const { service, prisma } = makeService({ items: [] });

    await service.resolveByName('u1', 'imp1', { entity: 'LIST,LIST_ITEM' });

    expect(prisma.importItem.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ sourceEntityType: 'LIST_ITEM' }),
      take: 500,
    });
  });
});
