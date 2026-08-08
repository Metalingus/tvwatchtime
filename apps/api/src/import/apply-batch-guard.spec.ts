import { ImportService } from './import.service';

/**
 * applyBatch cross-type guard: user data must never land on a media row of the wrong
 * entity type (a mis-tagged import item or a bad external-id cross-link).
 */
describe('ImportService.applyBatch — cross-type guard', () => {
  function makeService(
    mediaTypes: Record<string, string>,
    options: { episodes?: any[]; episodeAliases?: any[] } = {},
  ) {
    const prisma: any = {
      mediaItem: {
        findMany: jest.fn(async () =>
          Object.entries(mediaTypes).map(([id, type]) => ({ id, type })),
        ),
      },
      movie: { findMany: jest.fn().mockResolvedValue([]) },
      episode: {
        findMany: jest.fn().mockResolvedValue(options.episodes ?? []),
      },
      episodeExternalId: {
        findMany: jest.fn().mockResolvedValue(options.episodeAliases ?? []),
      },
      rating: { findMany: jest.fn().mockResolvedValue([]) },
      userEpisodeStatus: { findMany: jest.fn().mockResolvedValue([]) },
      userMovieStatus: { findMany: jest.fn().mockResolvedValue([]) },
      watchHistory: {},
      customList: { findMany: jest.fn().mockResolvedValue([]) },
      import: { update: jest.fn().mockResolvedValue({}) },
      importItem: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const chunked: any[] = [];
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
    (service as any).chunkedCreateMany = jest.fn(async (_tx: any, _model: string, rows: any[]) => {
      chunked.push(...rows);
    });
    return { service: service as any, prisma, chunked };
  }

  const movieItem = (mediaId: string) => ({
    id: 'it1',
    sourceEntityType: 'WATCHED_MOVIE',
    status: 'MATCHED',
    matchedMediaId: mediaId,
    matchedEpisodeId: null,
    normalizedData: { watchedAt: '2017-03-12T12:51:53.000Z', watchCount: 1 },
  });

  it('drops a WATCHED_MOVIE item whose matched media is a SHOW (no movie status written)', async () => {
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });
    const res = await service.applyBatch('u1', 'imp1', [movieItem('show-1')], 'TVTIME');
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(chunked.find((r) => r.mediaId === 'show-1')).toBeUndefined();
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['it1'] } },
      data: {
        status: 'SKIPPED',
        errorMessage: 'Matched media type is incompatible with this import item',
      },
    });
  });

  it('still applies a WATCHED_MOVIE item to a real MOVIE row', async () => {
    const { service, chunked } = makeService({ 'movie-1': 'MOVIE' });
    const res = await service.applyBatch('u1', 'imp1', [movieItem('movie-1')], 'TVTIME');
    expect(res.created).toBe(1);
    expect(chunked.some((r) => r.mediaId === 'movie-1' && r.watched === true)).toBe(true);
  });

  const episodeItem = (episodeId: string, normalizedData: Record<string, unknown> = {}) => ({
    id: 'ep-item-1',
    sourceEntityType: 'WATCHED_EPISODE',
    status: 'MATCHED',
    matchedMediaId: 'show-1',
    matchedEpisodeId: episodeId,
    normalizedData: { season: 1, episode: 2, watchCount: 1, ...normalizedData },
  });

  it('repairs a stale regular-episode match before creating watched rows', async () => {
    const replacement = {
      id: 'ep-new',
      number: 2,
      runtimeMinutes: 45,
      season: { number: 1, show: { mediaId: 'show-1' } },
    };
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });
    prisma.episode.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([replacement])
      .mockResolvedValueOnce([replacement]);

    const res = await service.applyBatch('u1', 'imp1', [episodeItem('ep-deleted')], 'TVTIME');

    expect(res.created).toBe(1);
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ep-item-1'] } },
      data: { matchedEpisodeId: 'ep-new', errorMessage: null },
    });
    expect(chunked.some((row) => row.episodeId === 'ep-new' && row.watched === true)).toBe(true);
    expect(chunked.some((row) => row.episodeId === 'ep-deleted')).toBe(false);
  });

  it('skips an irrecoverable stale episode without failing the rest of the import', async () => {
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });

    const res = await service.applyBatch(
      'u1',
      'imp1',
      [episodeItem('ep-deleted', { special: true })],
      'TVTIME',
    );

    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(prisma.episode.findMany.mock.calls.some(([args]: any[]) => args.where?.season)).toBe(
      false,
    );
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ep-item-1'] } },
      data: {
        status: 'SKIPPED',
        matchedEpisodeId: null,
        errorMessage: 'Episode is missing or its canonical replacement is ambiguous',
      },
    });
    expect(chunked.some((row) => row.episodeId)).toBe(false);
  });

  it('skips a stale regular episode when its canonical S/E replacement is ambiguous', async () => {
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });
    prisma.episode.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'ep-a', number: 2, season: { number: 1, show: { mediaId: 'show-1' } } },
      { id: 'ep-b', number: 2, season: { number: 1, show: { mediaId: 'show-1' } } },
    ]);

    const res = await service.applyBatch('u1', 'imp1', [episodeItem('ep-deleted')], 'TVTIME');

    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ep-item-1'] } },
      data: {
        status: 'SKIPPED',
        matchedEpisodeId: null,
        errorMessage: 'Episode is missing or its canonical replacement is ambiguous',
      },
    });
    expect(chunked).toHaveLength(0);
  });

  it('chunks large episode lookups and applied-item updates below the bind limit', async () => {
    const { service, prisma } = makeService({ 'show-1': 'SHOW' });
    (service.chunkedCreateMany as jest.Mock).mockImplementation(async () => undefined);
    prisma.episode.findMany.mockImplementation(async (args: any) => {
      const ids: string[] = args.where?.id?.in ?? [];
      return ids.map((id) => ({
        id,
        number: 2,
        runtimeMinutes: 24,
        season: { number: 1, show: { mediaId: 'show-1' } },
      }));
    });

    const items = Array.from({ length: 5001 }, (_, index) => ({
      ...episodeItem(`ep-${index}`),
      id: `item-${index}`,
    }));

    await expect(service.applyBatch('u1', 'imp1', items, 'TVTIME')).resolves.toEqual({
      created: 5001,
      skipped: 0,
    });

    const episodeLookupSizes = prisma.episode.findMany.mock.calls
      .map(([args]: any[]) => args.where?.id?.in?.length)
      .filter((size: number | undefined): size is number => size !== undefined);
    expect(episodeLookupSizes).toEqual([5000, 1, 5000, 1]);
    expect(
      prisma.userEpisodeStatus.findMany.mock.calls.every(
        ([args]: any[]) => args.where.episodeId.in.length <= 5000,
      ),
    ).toBe(true);

    const appliedUpdateSizes = prisma.importItem.updateMany.mock.calls
      .filter(([args]: any[]) => args.data?.status === 'APPLIED')
      .map(([args]: any[]) => args.where.id.in.length);
    expect(appliedUpdateSizes).toEqual([5000, 1]);
  });

  it('repairs an old episode rating through its active TVDB alias before createMany', async () => {
    const alias = {
      value: '12345',
      episodeId: 'ep-new',
      episode: { season: { show: { mediaId: 'show-1' } } },
    };
    const { service, prisma, chunked } = makeService(
      { 'show-1': 'SHOW' },
      { episodeAliases: [alias] },
    );
    prisma.episode.findMany.mockResolvedValueOnce([]);
    const item = {
      id: 'rating-item-1',
      sourceEntityType: 'EPISODE_RATING',
      status: 'MATCHED',
      matchedMediaId: 'show-1',
      matchedEpisodeId: 'ep-deleted',
      normalizedData: {
        normalizedRating: 4,
        externalEpisodeId: 12345,
        seasonNumber: 1,
        episodeNumber: 2,
      },
    };

    await expect(service.applyBatch('u1', 'imp1', [item], 'TVTIME')).resolves.toEqual({
      created: 1,
      skipped: 0,
    });

    expect(prisma.episodeExternalId.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['rating-item-1'] } },
      data: { matchedEpisodeId: 'ep-new', errorMessage: null },
    });
    expect(chunked.some((row) => row.episodeId === 'ep-new' && row.rating === 4)).toBe(true);
    expect(chunked.some((row) => row.episodeId === 'ep-deleted')).toBe(false);
  });

  it('keeps one newest rating when two provider episodes converge onto one episode', async () => {
    const activeEpisode = {
      id: 'combined-episode',
      number: 17,
      runtimeMinutes: 90,
      season: { number: 6, show: { mediaId: 'show-1' } },
    };
    const { service, prisma, chunked } = makeService(
      { 'show-1': 'SHOW' },
      { episodes: [activeEpisode] },
    );
    const ratings = [
      {
        id: 'rating-part-1',
        sourceEntityType: 'EPISODE_RATING',
        status: 'MATCHED',
        matchedMediaId: 'show-1',
        matchedEpisodeId: 'combined-episode',
        normalizedData: {
          normalizedRating: 3,
          voteKey: 'tvdb:part-1',
          sourceUpdatedAt: '2020-05-23T20:00:00.000Z',
        },
      },
      {
        id: 'rating-part-2',
        sourceEntityType: 'EPISODE_RATING',
        status: 'MATCHED',
        matchedMediaId: 'show-1',
        matchedEpisodeId: 'combined-episode',
        normalizedData: {
          normalizedRating: 5,
          voteKey: 'tvdb:part-2',
          sourceUpdatedAt: '2020-05-23T21:00:00.000Z',
        },
      },
    ];

    await expect(service.applyBatch('u1', 'imp1', ratings, 'TVTIME')).resolves.toEqual({
      created: 1,
      skipped: 1,
    });

    expect(chunked.filter((row) => row.episodeId === 'combined-episode' && row.rating)).toEqual([
      expect.objectContaining({ rating: 5, sourceKey: 'tvdb:part-2' }),
    ]);
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['rating-part-1', 'rating-part-2'] } },
      data: { status: 'APPLIED' },
    });
  });

  it('does not positionally guess when a stale rating has an explicit missing TVDB alias', async () => {
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });
    prisma.episode.findMany.mockResolvedValueOnce([]);
    const item = {
      id: 'rating-item-1',
      sourceEntityType: 'EPISODE_RATING',
      status: 'MATCHED',
      matchedMediaId: 'show-1',
      matchedEpisodeId: 'ep-deleted',
      normalizedData: {
        normalizedRating: 5,
        externalEpisodeId: 99999,
        seasonNumber: 1,
        episodeNumber: 2,
      },
    };

    await expect(service.applyBatch('u1', 'imp1', [item], 'TVTIME')).resolves.toEqual({
      created: 0,
      skipped: 1,
    });

    expect(
      prisma.episode.findMany.mock.calls.some(([args]: any[]) => Array.isArray(args.where?.OR)),
    ).toBe(false);
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['rating-item-1'] } },
      data: {
        status: 'SKIPPED',
        matchedEpisodeId: null,
        errorMessage: 'Episode is missing or its canonical replacement is ambiguous',
      },
    });
    expect(chunked.some((row) => row.rating)).toBe(false);
  });

  it('sizes createMany chunks by row width as well as row count', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const service = new ImportService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      a: index,
      b: index,
      c: index,
      d: index,
      e: index,
      f: index,
      g: index,
      h: index,
      i: index,
      j: index,
    }));

    await service.chunkedCreateMany({ wideModel: { createMany } }, 'wideModel', rows);

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls.map(([args]) => args.data.length)).toEqual([3000, 2000]);
  });
});
