import { MediaType } from '@tvwatch/shared';
import { CollectionsService } from './collections.service';

describe('CollectionsService bounded movie library', () => {
  it('filters watched movies before paging the watchlist', async () => {
    const prisma = {
      watchlistItem: {
        findMany: jest.fn().mockResolvedValue([{ mediaId: 'movie1' }]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const discovery = {
      fetchCardDtos: jest.fn().mockResolvedValue([{ id: 'movie1', title: 'Movie' }]),
    };
    const service = new CollectionsService(
      prisma as any,
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
    const prisma = {
      mediaItem: { findUnique: jest.fn().mockResolvedValue({ id: 'show', type: MediaType.SHOW }) },
      watchlistItem: { findUnique: jest.fn().mockResolvedValue({ id: 'watchlist-row' }) },
      userShowStatus: { upsert: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    const service = new CollectionsService(prisma as any, events as any, redis as any, {} as any);

    await expect(service.dropMedia('user', 'show')).resolves.toEqual({
      dropped: true,
      inWatchlist: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith({
      where: { userId_mediaId: { userId: 'user', mediaId: 'show' } },
      create: { userId: 'user', mediaId: 'show', dropped: true },
      update: { dropped: true, pausedAt: null },
    });
  });

  it('drops a movie from the watchlist without creating show progress state', async () => {
    const tx = {
      watchlistItem: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      mediaItem: { update: jest.fn() },
      userShowStatus: { upsert: jest.fn() },
    };
    const prisma = {
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({ id: 'movie', type: MediaType.MOVIE }),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new CollectionsService(prisma as any, events as any, redis as any, {} as any);

    await service.dropMedia('user', 'movie');

    expect(tx.mediaItem.update).not.toHaveBeenCalled();
    expect(tx.userShowStatus.upsert).not.toHaveBeenCalled();
  });

  it('restores a dropped show without changing watchlist membership', async () => {
    const prisma = {
      userShowStatus: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const service = new CollectionsService(prisma as any, events as any, redis as any, {} as any);

    await expect(service.restoreDroppedShow('user', 'show')).resolves.toEqual({ dropped: false });
    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user', mediaId: 'show', dropped: true },
      data: { dropped: false },
    });
  });

  it('removes a watchlist row without turning the show into Dropped', async () => {
    const prisma = {
      watchlistItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mediaItem: { update: jest.fn().mockResolvedValue({}) },
      userShowStatus: { updateMany: jest.fn() },
    };
    const service = new CollectionsService(prisma as any, events as any, redis as any, {} as any);

    await service.removeWatchlist('user', 'show');

    expect(prisma.userShowStatus.updateMany).not.toHaveBeenCalled();
    expect(prisma.watchlistItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user', mediaId: 'show' },
    });
  });
});
