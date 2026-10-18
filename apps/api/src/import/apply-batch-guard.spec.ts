// Catalog locking is exercised by the real-database fence suite; these tests isolate service behavior.
jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
function withMockTransaction<T>(prisma: T): T {
  const client = prisma as any;
  if (!client.$transaction)
    client.$transaction = jest.fn(async (work: any) =>
      typeof work === 'function' ? work(client) : Promise.all(work),
    );
  return prisma;
}
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
      userEpisodeStatus: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      userMovieStatus: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      userShowStatus: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      watchlistItem: { findMany: jest.fn().mockResolvedValue([]) },
      watchHistory: {},
      customList: { findMany: jest.fn().mockResolvedValue([]) },
      import: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ status: 'IMPORTING', format: 'trakt' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      importItem: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const chunked: any[] = [];
    const service = new ImportService(
      withMockTransaction(prisma),
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

  it('coalesces imported finale halves into one watch and records the canonical episode number', async () => {
    const { service } = makeService(
      { show: 'SHOW' },
      {
        episodes: [
          {
            id: 'finale',
            number: 12,
            structureState: 'ACTIVE',
            runtimeMinutes: 90,
            season: { number: 2, show: { mediaId: 'show' } },
          },
        ],
      },
    );
    const items = [12, 13].map((episode) => ({
      id: 'half-' + episode,
      sourceEntityType: 'WATCHED_EPISODE',
      status: 'MATCHED',
      matchedMediaId: 'show',
      matchedEpisodeId: 'finale',
      normalizedData: { season: 2, episode, watchCount: 1, watchedAt: '2021-10-11T08:48:54Z' },
    }));
    await service.applyBatch('user', 'import', items, 'TVTIME');
    const writes = service.chunkedCreateMany.mock.calls;
    const history = writes
      .filter((call: any[]) => call[1] === 'watchHistory')
      .flatMap((call: any[]) => call[2]);
    const statuses = writes
      .filter((call: any[]) => call[1] === 'userEpisodeStatus')
      .flatMap((call: any[]) => call[2]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      episodeId: 'finale',
      episodeNumber: 12,
      seasonNumber: 2,
      runtimeMinutes: 90,
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0].watchCount).toBe(1);
  });

  const movieItem = (
    mediaId: string,
    normalizedData: Record<string, unknown> = {},
    id = 'it1',
  ) => ({
    id,
    sourceEntityType: 'WATCHED_MOVIE',
    status: 'MATCHED',
    matchedMediaId: mediaId,
    matchedEpisodeId: null,
    normalizedData: {
      watchedAt: '2017-03-12T12:51:53.000Z',
      watchCount: 1,
      ...normalizedData,
    },
  });

  it('applies movie and show LIST_ITEMs through the real canonical identity guard', async () => {
    const { service, prisma, chunked } = makeService({ 'movie-1': 'MOVIE', 'show-1': 'SHOW' });
    prisma.mediaCanonicalLink = {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    };
    require('../media-metadata/util/identity-write-fence').fenceIdentityWrite.mockImplementationOnce(
      jest.requireActual('../media-metadata/util/identity-write-fence').fenceIdentityWrite,
    );
    prisma.mediaItem.findUnique = jest.fn(async ({ where }: any) => ({
      id: where.id,
      type: where.id === 'movie-1' ? 'MOVIE' : 'SHOW',
      externalIds: [],
      show: where.id === 'show-1' ? { id: 's' } : null,
      movie: where.id === 'movie-1' ? { id: 'm' } : null,
    }));
    prisma.import.findUnique = jest
      .fn()
      .mockResolvedValue({ status: 'IMPORTING', format: 'trakt' });
    prisma.customList.findFirst = jest.fn().mockResolvedValue(null);
    prisma.customList.create = jest.fn(async ({ data }: any) => data);
    prisma.customListItem = { findMany: jest.fn().mockResolvedValue([]) };
    const items = [
      {
        id: 'list',
        sourceEntityType: 'LIST',
        status: 'MATCHED',
        normalizedData: { sourceKey: 'mixed', title: 'Mixed' },
      },
      ...['movie', 'show'].map((kind, index) => ({
        id: kind,
        sourceEntityType: 'LIST_ITEM',
        status: 'MATCHED',
        matchedMediaId: kind + '-1',
        normalizedData: { sourceKey: 'mixed', mediaType: kind, order: index },
      })),
    ];
    await expect(service.applyBatch('u1', 'imp1', items, 'TRAKT')).resolves.toEqual({
      created: 2,
      skipped: 0,
    });
    expect(chunked.filter((row) => row.listId).map((row) => row.mediaId)).toEqual([
      'movie-1',
      'show-1',
    ]);
    expect(items.every((item) => item.status === 'MATCHED')).toBe(true);
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

  it('applies a TV Time archived show as dropped even when its watchlist row already exists', async () => {
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });
    const pausedAt = new Date('2026-08-01T00:00:00.000Z');
    prisma.watchlistItem.findMany.mockResolvedValue([{ mediaId: 'show-1' }]);
    prisma.userShowStatus.findMany.mockResolvedValue([
      { id: 'show-status-1', mediaId: 'show-1', dropped: false, pausedAt },
    ]);
    const item = {
      id: 'archived-item-1',
      sourceEntityType: 'WATCHLIST_SHOW',
      status: 'MATCHED',
      matchedMediaId: 'show-1',
      matchedEpisodeId: null,
      normalizedData: { dropped: true },
    };

    await expect(service.applyBatch('u1', 'imp1', [item], 'TVTIME')).resolves.toEqual({
      created: 0,
      skipped: 0,
    });
    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['show-status-1'] } },
      data: { dropped: true, pausedAt: null },
    });
    expect(chunked).toContainEqual(
      expect.objectContaining({
        importId: 'imp1',
        importItemId: 'archived-item-1',
        targetTable: 'user_show_status',
        targetRecordId: 'show-status-1',
        action: 'updated',
        previousData: { dropped: false, pausedAt: pausedAt.toISOString() },
        newData: { dropped: true, pausedAt: null },
      }),
    );
  });

  it('atomically transitions an existing unwatched movie and stays idempotent on re-sync', async () => {
    const { service, prisma, chunked } = makeService({ 'movie-1': 'MOVIE' });
    prisma.userMovieStatus.findMany
      .mockResolvedValueOnce([
        {
          id: 'movie-status-1',
          mediaId: 'movie-1',
          watched: false,
          watchedAt: null,
          watchCount: 0,
          source: 'MANUAL',
          sourceKey: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'movie-status-1',
          mediaId: 'movie-1',
          watched: true,
          watchedAt: new Date('2026-08-18T07:22:27.517Z'),
          watchCount: 2,
          source: 'MANUAL',
          sourceKey: null,
        },
      ]);
    const item = movieItem('movie-1', {
      watchedAt: '2026-08-18T07:22:27.517Z',
      watchCount: 2,
      voteKey: 'emby:movie:movie-1:watched',
    });

    await expect(service.applyBatch('u1', 'imp1', [item], 'EMBY')).resolves.toEqual({
      created: 1,
      skipped: 0,
    });
    await expect(service.applyBatch('u1', 'imp2', [item], 'EMBY')).resolves.toEqual({
      created: 0,
      skipped: 1,
    });

    expect(prisma.userMovieStatus.update).toHaveBeenCalledTimes(1);
    expect(prisma.userMovieStatus.update).toHaveBeenCalledWith({
      where: { id: 'movie-status-1' },
      data: {
        watched: true,
        watchedAt: new Date('2026-08-18T07:22:27.517Z'),
        watchCount: 2,
      },
    });
    expect(
      chunked.filter(
        (row) => row.mediaType === 'MOVIE' && row.sourceKey === 'emby:movie:movie-1:watched',
      ),
    ).toHaveLength(1);
    expect(chunked).toContainEqual(
      expect.objectContaining({
        importId: 'imp1',
        targetTable: 'user_movie_status',
        targetRecordId: 'movie-status-1',
        action: 'updated',
      }),
    );
  });

  it('collapses duplicate movie items to one status/history row and keeps the highest count', async () => {
    const { service, chunked } = makeService({ 'movie-1': 'MOVIE' });
    const items = [
      movieItem('movie-1', { watchCount: 1, voteKey: 'plex:movie:1:watched' }, 'movie-item-1'),
      movieItem('movie-1', { watchCount: 3, voteKey: 'plex:movie:1:watched' }, 'movie-item-2'),
    ];

    await expect(service.applyBatch('u1', 'imp1', items, 'PLEX')).resolves.toEqual({
      created: 1,
      skipped: 1,
    });
    expect(chunked.filter((row) => row.mediaId === 'movie-1' && row.watched === true)).toEqual([
      expect.objectContaining({ watchCount: 3 }),
    ]);
    expect(chunked.filter((row) => row.mediaType === 'MOVIE')).toHaveLength(1);
  });

  it('upgrades a movie rewatch count only when the same provider owns the row', async () => {
    const { service, prisma, chunked } = makeService({ 'movie-1': 'MOVIE' });
    prisma.userMovieStatus.findMany.mockResolvedValueOnce([
      {
        id: 'movie-status-1',
        mediaId: 'movie-1',
        watched: true,
        watchedAt: new Date('2026-08-18T07:22:27.517Z'),
        watchCount: 1,
        source: 'JELLYFIN',
        sourceKey: 'movie:jellyfin-1:watched',
      },
    ]);
    const item = movieItem('movie-1', {
      watchCount: 3,
      voteKey: 'movie:jellyfin-1:watched',
    });

    await expect(service.applyBatch('u1', 'imp1', [item], 'JELLYFIN')).resolves.toEqual({
      created: 1,
      skipped: 0,
    });
    expect(prisma.userMovieStatus.update).toHaveBeenCalledWith({
      where: { id: 'movie-status-1' },
      data: { watchCount: 3 },
    });
    expect(chunked.filter((row) => row.mediaType === 'MOVIE')).toHaveLength(0);
    expect(chunked).toContainEqual(
      expect.objectContaining({
        targetTable: 'user_movie_status',
        targetRecordId: 'movie-status-1',
        action: 'updated',
        previousData: { watchCount: 1 },
        newData: { watchCount: 3 },
      }),
    );
  });

  const episodeItem = (episodeId: string, normalizedData: Record<string, unknown> = {}) => ({
    id: 'ep-item-1',
    sourceEntityType: 'WATCHED_EPISODE',
    status: 'MATCHED',
    matchedMediaId: 'show-1',
    matchedEpisodeId: episodeId,
    normalizedData: { season: 1, episode: 2, watchCount: 1, ...normalizedData },
  });

  it('atomically transitions an existing unwatched row and stays idempotent on re-sync', async () => {
    const episode = {
      id: 'ep-1',
      number: 2,
      runtimeMinutes: 45,
      structureState: 'ACTIVE',
      season: { number: 1, show: { mediaId: 'show-1' } },
    };
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' }, { episodes: [episode] });
    prisma.userEpisodeStatus.findMany
      .mockResolvedValueOnce([
        {
          id: 'status-1',
          episodeId: 'ep-1',
          watched: false,
          watchedAt: null,
          watchCount: 0,
          source: 'MANUAL',
          sourceKey: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'status-1',
          episodeId: 'ep-1',
          watched: true,
          watchedAt: new Date('2026-08-18T07:22:27.517Z'),
          watchCount: 1,
          source: 'MANUAL',
          sourceKey: null,
        },
      ]);
    const item = episodeItem('ep-1', {
      watchedAt: '2026-08-18T07:22:27.517Z',
      voteKey: 'series:tt14688458:tt14688458:3:2',
    });

    await expect(service.applyBatch('u1', 'imp1', [item], 'STREMIO')).resolves.toEqual({
      created: 1,
      skipped: 0,
    });
    await expect(service.applyBatch('u1', 'imp2', [item], 'STREMIO')).resolves.toEqual({
      created: 0,
      skipped: 1,
    });

    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledTimes(1);
    const transition = prisma.userEpisodeStatus.update.mock.calls[0][0];
    expect(transition).toEqual({
      where: { id: 'status-1' },
      data: {
        watched: true,
        watchedAt: new Date('2026-08-18T07:22:27.517Z'),
        watchCount: 1,
      },
    });
    expect(transition.data).not.toHaveProperty('source');
    expect(
      chunked.filter(
        (row) => row.mediaType === 'SHOW' && row.sourceKey === 'series:tt14688458:tt14688458:3:2',
      ),
    ).toHaveLength(1);
    expect(chunked).toContainEqual(
      expect.objectContaining({
        importId: 'imp1',
        targetTable: 'user_episode_status',
        targetRecordId: 'status-1',
        action: 'updated',
      }),
    );
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

  it('never applies an episode rating as a show rating when its episode is unresolved', async () => {
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });
    const item = {
      id: 'rating-item-unscoped',
      sourceEntityType: 'EPISODE_RATING',
      status: 'MATCHED',
      matchedMediaId: 'show-1',
      matchedEpisodeId: null,
      normalizedData: {
        normalizedRating: 5,
        voteKey: 'trakt:episode:123',
        seasonNumber: 1,
        episodeNumber: 2,
      },
    };

    await expect(service.applyBatch('u1', 'imp1', [item], 'TRAKT')).resolves.toEqual({
      created: 0,
      skipped: 1,
    });
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['rating-item-unscoped'] } },
      data: {
        status: 'SKIPPED',
        errorMessage: 'Rating target scope could not be resolved safely',
      },
    });
    expect(chunked.some((row) => row.rating)).toBe(false);
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
      prisma.episode.findMany.mock.calls.some(
        ([args]: any[]) => Array.isArray(args.where?.OR) || args.where?.number?.in,
      ),
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

  it('repairs a stale id-less episode target with one indexed lookup per show', async () => {
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' });
    prisma.episode.findMany
      .mockResolvedValueOnce([]) // the staged episode is no longer ACTIVE
      .mockResolvedValueOnce([
        { id: 'active-s1e2', number: 2, season: { number: 1, show: { mediaId: 'show-1' } } },
        // Superset row from the seasons × numbers lookup; never chosen for S1E2.
        { id: 'active-s2e2', number: 2, season: { number: 2, show: { mediaId: 'show-1' } } },
      ]);
    const item = {
      id: 'rating-item-1',
      sourceEntityType: 'EPISODE_RATING',
      status: 'MATCHED',
      matchedMediaId: 'show-1',
      matchedEpisodeId: 'legacy-unmapped',
      normalizedData: { normalizedRating: 4, seasonNumber: 1, episodeNumber: 2 },
    };

    await service.applyBatch('u1', 'imp1', [item], 'TVTIME');

    const coordinateQuery = prisma.episode.findMany.mock.calls[1][0];
    expect(coordinateQuery.where).toEqual({
      structureState: 'ACTIVE',
      season: { show: { mediaId: 'show-1' }, number: { in: [1] } },
      number: { in: [2] },
    });
    expect(chunked).toEqual(
      expect.arrayContaining([expect.objectContaining({ episodeId: 'active-s1e2', rating: 4 })]),
    );
  });

  it('applies a future combined-episode rating to both recorded parts with one source key', async () => {
    const active = ['part1', 'part2'].map((id) => ({
      id,
      season: { show: { mediaId: 'show-1' } },
    }));
    const { service, prisma, chunked } = makeService({ 'show-1': 'SHOW' }, { episodes: active });
    prisma.mediaCanonicalLink = { findUnique: jest.fn().mockResolvedValue(null) };
    prisma.mediaItem.findUnique = jest
      .fn()
      .mockResolvedValue({ type: 'SHOW', externalIds: [], show: { id: 'show' }, movie: null });
    prisma.mediaCanonicalCopy = {
      findMany: jest.fn(async ({ where }: any) =>
        [
          { sourceId: 'THE_TVDB:EPISODE:123', targetId: 'combined' },
          { sourceId: 'combined', targetId: 'part1' },
          { sourceId: 'combined', targetId: 'part2' },
        ].filter((row) => where.sourceId.in.includes(row.sourceId)),
      ),
    };
    const item = {
      id: 'rating-1',
      sourceEntityType: 'EPISODE_RATING',
      status: 'MATCHED',
      matchedMediaId: 'show-1',
      matchedEpisodeId: 'part1',
      normalizedData: { normalizedRating: 8, externalEpisodeId: 123, voteKey: 'original-key' },
    };
    await service.applyBatch('u1', 'imp1', [item], 'TRAKT');
    const ratings = chunked.filter((row) => row.rating === 8);
    expect(ratings.map((row) => row.episodeId).sort()).toEqual(['part1', 'part2']);
    expect(ratings.every((row) => row.sourceKey === 'original-key')).toBe(true);
  });

  it('sizes createMany chunks by row width as well as row count', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const service = new ImportService(
      withMockTransaction({} as any),
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
