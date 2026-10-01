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
import { MediaType } from '@tvwatch/shared';
import { CollectionsService } from './collections.service';

describe('CollectionsService bounded movie library', () => {
  it('filters watched movies before paging the watchlist', async () => {
    const prisma: any = {
      watchlistItem: {
        findMany: jest.fn().mockResolvedValue([{ mediaId: 'movie1' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const discovery = {
      fetchCardDtos: jest.fn().mockResolvedValue([{ id: 'movie1', title: 'Movie' }]),
    };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      { emit: jest.fn() } as any,
      {} as any,
      discovery as any,
    );

    const result = await service.watchlist('u1', MediaType.MOVIE, 1, 60, undefined, true);

    expect(prisma.watchlistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 60,
        where: expect.objectContaining({
          userId: 'u1',
          media: expect.objectContaining({
            type: MediaType.MOVIE,
            movieStatuses: { none: { userId: 'u1', watched: true } },
          }),
        }),
      }),
    );
    expect(result.total).toBe(1);
  });

  it('requires every selected genre before paging a collection', async () => {
    const prisma: any = {
      watchlistItem: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      { emit: jest.fn() } as any,
      {} as any,
      { fetchCardDtos: jest.fn().mockResolvedValue([]) } as any,
    );

    await service.watchlist('u1', MediaType.SHOW, 1, 20, 'anime, adventure');

    expect(prisma.watchlistItem.findMany.mock.calls[0][0].where.media.AND).toEqual([
      {
        genres: {
          some: { genre: { slug: { equals: 'anime', mode: 'insensitive' } } },
        },
      },
      {
        genres: {
          some: { genre: { slug: { equals: 'adventure', mode: 'insensitive' } } },
        },
      },
    ]);
  });

  it('applies exclusion, country, tag, and rating order before paging', async () => {
    const prisma: any = {
      watchlistItem: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      { emit: jest.fn() } as any,
      {} as any,
      { fetchCardDtos: jest.fn().mockResolvedValue([]) } as any,
    );

    await service.watchlist('u1', MediaType.SHOW, 1, 20, 'drama', false, {
      excludeGenres: 'horror',
      country: 'kr',
      tags: 'k-drama,true-crime',
      sort: 'rating',
    });

    const args = prisma.watchlistItem.findMany.mock.calls[0][0];
    expect(args.where.media).toEqual(
      expect.objectContaining({
        genres: {
          none: { genre: { slug: { in: ['horror'], mode: 'insensitive' } } },
        },
        tags: {
          some: { tag: { slug: { in: ['k-drama', 'true-crime'] } } },
        },
        show: { originCountries: { has: 'KR' } },
      }),
    );
    expect(args.orderBy).toEqual([
      { media: { rating: { sort: 'desc', nulls: 'last' } } },
      { id: 'desc' },
    ]);
  });
});

describe('CollectionsService "Date watched" order', () => {
  it('pages favorites by latest watch, then never-watched by date added', async () => {
    const prisma: any = {
      favorite: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'f1', mediaId: 'unwatched', createdAt: new Date('2026-09-30') },
          { id: 'f2', mediaId: 'watched-old', createdAt: new Date('2026-01-01') },
          { id: 'f3', mediaId: 'watched-new', createdAt: new Date('2025-01-01') },
        ]),
        count: jest.fn(),
      },
      userShowStatus: {
        findMany: jest.fn().mockResolvedValue([
          { mediaId: 'watched-old', lastWatchedAt: new Date('2026-02-01') },
          { mediaId: 'watched-new', lastWatchedAt: new Date('2026-09-01') },
        ]),
      },
      userMovieStatus: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const discovery = { fetchCardDtos: jest.fn(async (ids: string[]) => ids) };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      { emit: jest.fn() } as any,
      {} as any,
      discovery as any,
    );

    const result = await service.favorites('u1', MediaType.SHOW, 1, 2, undefined, {
      sort: 'watchedDate',
    });

    expect(discovery.fetchCardDtos).toHaveBeenCalledWith(['watched-new', 'watched-old'], 'u1', 2);
    expect(result).toMatchObject({ total: 3, hasMore: true });
    expect(prisma.favorite.count).not.toHaveBeenCalled();
  });
});

describe('CollectionsService dropMedia', () => {
  const redis = {
    client: { incr: jest.fn().mockResolvedValue(1) },
    delByPattern: jest.fn(),
    del: jest.fn(),
  };
  const events = { emit: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('drops a show into a persistent status without removing its watchlist row', async () => {
    const prisma: any = {
      mediaItem: { findUnique: jest.fn().mockResolvedValue({ id: 'show', type: MediaType.SHOW }) },
      watchlistItem: { findUnique: jest.fn().mockResolvedValue({ id: 'watchlist-row' }) },
      userShowStatus: { upsert: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      events as any,
      redis as any,
      {} as any,
    );

    await expect(service.dropMedia('user', 'show')).resolves.toEqual({
      dropped: true,
      inWatchlist: true,
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith({
      where: { userId_mediaId: { userId: 'user', mediaId: 'show' } },
      create: { userId: 'user', mediaId: 'show', dropped: true },
      update: { dropped: true, pausedAt: null, rewatchStartedAt: null },
    });
  });

  it('drops a movie from the watchlist without creating show progress state', async () => {
    const tx = {
      watchlistItem: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      mediaItem: { update: jest.fn() },
      userShowStatus: { upsert: jest.fn() },
    };
    const prisma: any = {
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({ id: 'movie', type: MediaType.MOVIE }),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      events as any,
      redis as any,
      {} as any,
    );

    await service.dropMedia('user', 'movie');

    expect(tx.mediaItem.update).not.toHaveBeenCalled();
    expect(tx.userShowStatus.upsert).not.toHaveBeenCalled();
  });

  it('restores a dropped show without changing watchlist membership', async () => {
    const prisma: any = {
      userShowStatus: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      events as any,
      redis as any,
      {} as any,
    );

    await expect(service.restoreDroppedShow('user', 'show')).resolves.toEqual({ dropped: false });
    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user', mediaId: 'show', dropped: true },
      data: { dropped: false },
    });
  });

  it('removes a watchlist row without turning the show into Dropped', async () => {
    const prisma: any = {
      watchlistItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mediaItem: { update: jest.fn().mockResolvedValue({}) },
      userShowStatus: { updateMany: jest.fn() },
    };
    const service = new CollectionsService(
      withMockTransaction(prisma as any),
      events as any,
      redis as any,
      {} as any,
    );

    await service.removeWatchlist('user', 'show');

    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user', mediaId: 'show', rewatchStartedAt: { not: null } },
      data: { rewatchStartedAt: null },
    });
    expect(prisma.watchlistItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user', mediaId: 'show' },
    });
  });
});
