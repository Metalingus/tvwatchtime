import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaType } from '@tvwatch/shared';
import { TrackingService } from './tracking.service';

describe('TrackingService.markSeasonWatched concurrency', () => {
  it('retries a raced insert and treats an already-completed watch as a no-op', async () => {
    const episode = {
      id: 'e1',
      number: 1,
      runtimeMinutes: 45,
      structureState: 'ACTIVE',
      airDate: null,
    };
    const prisma: any = {
      season: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'season-1',
          number: 1,
          isSpecial: false,
          show: { mediaId: 'media-1' },
          episodes: [episode],
        }),
      },
      userEpisodeStatus: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ episodeId: 'e1', watched: true }]),
        createMany: jest.fn().mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.22.0',
          }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      watchHistory: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) =>
      callback(prisma),
    );
    const events = { emit: jest.fn() };
    const redis = {
      client: { incr: jest.fn().mockResolvedValue(1) },
      delByPattern: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(0),
    };
    const service = new TrackingService(prisma, events as any, redis as any);

    await expect(service.markSeasonWatched('u1', 'season-1')).resolves.toEqual({
      watched: true,
      count: 1,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(prisma.watchHistory.createMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

/** unwatchEpisodeOnce / unwatchSeasonOnce: undo ONE viewing, stay watched. */
describe('TrackingService unwatch-once', () => {
  const NOW = new Date();
  const PAST = new Date(NOW.getTime() - 86400_000);

  const make = (opts: {
    episode?: any;
    status?: any;
    season?: any;
    watchedStatuses?: { episodeId: string }[];
    latestHistory?: { id: string } | null;
  }) => {
    const prisma = {
      mediaCanonicalCopy: { findFirst: jest.fn().mockResolvedValue(null) },
      episode: { findUnique: jest.fn().mockResolvedValue(opts.episode ?? null) },
      season: { findUnique: jest.fn().mockResolvedValue(opts.season ?? null) },
      userEpisodeStatus: {
        findUnique: jest.fn().mockResolvedValue(opts.status ?? null),
        findMany: jest.fn().mockResolvedValue(opts.watchedStatuses ?? []),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      watchHistory: {
        findFirst: jest.fn().mockResolvedValue(opts.latestHistory ?? null),
        delete: jest.fn().mockResolvedValue({}),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const events = { emit: jest.fn() };
    const redis = {
      client: { incr: jest.fn().mockResolvedValue(1) },
      delByPattern: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(0),
    };
    const svc = new TrackingService(prisma as any, events as any, redis as any);
    return { svc, prisma, events };
  };

  const episode = { id: 'e1', number: 1, season: { number: 1, show: { mediaId: 'media-1' } } };
  const season = {
    id: 'season-1',
    number: 1,
    show: { mediaId: 'media-1' },
    episodes: [
      { id: 'e1', number: 1, airDate: PAST, runtimeMinutes: 45, structureState: 'ACTIVE' },
      { id: 'e2', number: 2, airDate: PAST, runtimeMinutes: 45, structureState: 'ACTIVE' },
    ],
  };

  it('unwatchEpisodeOnce decrements watchCount and deletes only the latest history row', async () => {
    const { svc, prisma, events } = make({
      episode,
      status: { watched: true, watchCount: 3 },
      latestHistory: { id: 'wh-latest' },
    });
    const out = await svc.unwatchEpisodeOnce('u1', 'e1');
    expect(out).toEqual({ watched: true, watchCount: 2 });
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { userId_episodeId: { userId: 'u1', episodeId: 'e1' } },
      data: { watchCount: { decrement: 1 }, source: 'MANUAL', sourceKey: null },
    });
    expect(prisma.watchHistory.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1', episodeId: 'e1' },
      orderBy: { watchedAt: 'desc' },
      select: { id: true },
    });
    expect(prisma.watchHistory.delete).toHaveBeenCalledWith({ where: { id: 'wh-latest' } });
    expect(events.emit).toHaveBeenCalledWith('unwatch.episode', {
      userId: 'u1',
      mediaId: 'media-1',
      episodeId: 'e1',
    });
  });

  it('unwatchEpisodeOnce rejects episodes on their first watch (use full unwatch)', async () => {
    const { svc, prisma } = make({ episode, status: { watched: true, watchCount: 1 } });
    await expect(svc.unwatchEpisodeOnce('u1', 'e1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('unwatchEpisodeOnce rejects unwatched episodes', async () => {
    const { svc } = make({ episode, status: null });
    await expect(svc.unwatchEpisodeOnce('u1', 'e1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('unwatchSeasonOnce decrements only episodes watched 2+ times (first watches stay)', async () => {
    const { svc, prisma, events } = make({
      season,
      watchedStatuses: [{ episodeId: 'e1' }], // e2 has watchCount 1 → untouched
    });
    const out = await svc.unwatchSeasonOnce('u1', 'season-1');
    expect(out).toEqual({ watched: true, count: 1 });
    expect(prisma.userEpisodeStatus.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        episodeId: { in: ['e1', 'e2'] },
        watched: true,
        watchCount: { gte: 2 },
      },
      select: { episodeId: true },
    });
    expect(prisma.userEpisodeStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', episodeId: { in: ['e1'] } },
      data: { watchCount: { decrement: 1 }, source: 'MANUAL', sourceKey: null },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('unwatch.episode', {
      userId: 'u1',
      mediaId: 'media-1',
    });
  });

  it('unwatchSeasonOnce rejects when no episode was rewatched', async () => {
    const { svc, prisma } = make({ season, watchedStatuses: [] });
    await expect(svc.unwatchSeasonOnce('u1', 'season-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

/** rewatchSeason: bulk rewatch of already-watched, aired episodes only. */
describe('TrackingService.rewatchSeason', () => {
  const NOW = new Date();
  const PAST = new Date(NOW.getTime() - 86400_000);
  const FUTURE = new Date(NOW.getTime() + 86400_000);

  const make = (opts: { season?: any; watchedStatuses?: { episodeId: string }[] }) => {
    const prisma = {
      season: { findUnique: jest.fn().mockResolvedValue(opts.season ?? null) },
      userEpisodeStatus: {
        findMany: jest.fn().mockResolvedValue(opts.watchedStatuses ?? []),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      watchHistory: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const events = { emit: jest.fn() };
    const redis = {
      client: { incr: jest.fn().mockResolvedValue(1) },
      delByPattern: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(0),
    };
    const svc = new TrackingService(prisma as any, events as any, redis as any);
    return { svc, prisma, events };
  };

  const seasonWith = (episodes: any[]) => ({
    id: 'season-1',
    number: 1,
    show: { mediaId: 'media-1' },
    episodes,
  });

  const ep = (id: string, number: number, airDate: Date | null) => ({
    id,
    number,
    airDate,
    runtimeMinutes: 45,
    structureState: 'ACTIVE',
  });

  it('includes watched undated episodes and excludes explicit future episodes', async () => {
    const { svc, prisma, events } = make({
      season: seasonWith([
        ep('e1', 1, PAST), // watched + aired → rewatched
        ep('e2', 2, PAST), // unwatched + aired → untouched
        ep('e3', 3, FUTURE), // watched + unaired → untouched
        ep('e4', 4, null), // watched + official undated → rewatched
      ]),
      watchedStatuses: [{ episodeId: 'e1' }, { episodeId: 'e3' }, { episodeId: 'e4' }],
    });
    const out = await svc.rewatchSeason('u1', 'season-1');

    expect(out).toEqual({ watched: true, count: 2 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [statusUpdate, historyCreate] = prisma.$transaction.mock.calls[0][0];
    void statusUpdate;
    void historyCreate;
    expect(prisma.userEpisodeStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', episodeId: { in: ['e1', 'e4'] } },
      data: { watchCount: { increment: 1 }, source: 'MANUAL', sourceKey: null },
    });
    expect(prisma.watchHistory.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          userId: 'u1',
          mediaId: 'media-1',
          episodeId: 'e1',
          seasonNumber: 1,
          episodeNumber: 1,
        }),
        expect.objectContaining({ episodeId: 'e4', episodeNumber: 4 }),
      ]),
    });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('rewatch.episode', {
      userId: 'u1',
      mediaId: 'media-1',
    });
  });

  it('throws NotFoundException for an unknown season', async () => {
    const { svc } = make({ season: null });
    await expect(svc.rewatchSeason('u1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequestException when no aired episode is watched (a rewatch never creates first watches)', async () => {
    const { svc, prisma } = make({
      season: seasonWith([ep('e1', 1, PAST)]),
      watchedStatuses: [],
    });
    await expect(svc.rewatchSeason('u1', 'season-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('is a no-op when the season has no aired episodes', async () => {
    const { svc, prisma, events } = make({
      season: seasonWith([ep('e1', 1, FUTURE)]),
    });
    const out = await svc.rewatchSeason('u1', 'season-1');
    expect(out).toEqual({ watched: true, count: 0 });
    expect(prisma.userEpisodeStatus.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

/** Dropped (removed-from-watchlist) is sticky: rewatches must NOT resurface the show. */
describe('TrackingService dropped semantics', () => {
  const make = (existing: any) => {
    const prisma = {
      userShowStatus: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      episode: { count: jest.fn().mockResolvedValue(12) },
    };
    const svc = new TrackingService(
      prisma as any,
      { emit: jest.fn() } as any,
      { client: { incr: jest.fn() }, delByPattern: jest.fn(), del: jest.fn() } as any,
    );
    return { svc, prisma };
  };

  it('watching an episode of a dropped show does NOT clear the dropped flag', async () => {
    const { svc, prisma } = make({ id: 'uss1', watchedCount: 3, totalCount: 12, dropped: true });
    await (svc as any).bumpShowCount('u1', 'media-1', 1, new Date());
    expect(prisma.userShowStatus.update).toHaveBeenCalledWith({
      where: { id: 'uss1' },
      data: expect.not.objectContaining({ dropped: false }),
    });
    // Count still bumps — history is kept, the show just stays hidden.
    expect(prisma.userShowStatus.update).toHaveBeenCalledWith({
      where: { id: 'uss1' },
      data: expect.objectContaining({ watchedCount: 4 }),
    });
  });

  it('a positive delta on a non-dropped show writes no dropped field either', async () => {
    const { svc, prisma } = make({ id: 'uss1', watchedCount: 3, totalCount: 12, dropped: false });
    await (svc as any).bumpShowCount('u1', 'media-1', 1);
    expect(prisma.userShowStatus.update).toHaveBeenCalledWith({
      where: { id: 'uss1' },
      data: expect.not.objectContaining({ dropped: expect.anything() }),
    });
  });
});

describe('TrackingService markEpisodeAndPreviousWatched', () => {
  it('marks earlier aired episodes and the selected episode in one batch', async () => {
    const current = {
      id: 's2e2',
      number: 2,
      runtimeMinutes: 45,
      airDate: null,
      structureState: 'ACTIVE',
      season: {
        id: 'season-2',
        showId: 'show-record',
        number: 2,
        isSpecial: false,
        show: { mediaId: 'media-show' },
      },
    };
    const previous = {
      id: 's1e2',
      number: 2,
      runtimeMinutes: 42,
      airDate: null,
      structureState: 'ACTIVE',
      season: { id: 'season-1', showId: 'show-record', number: 1, isSpecial: false },
    };
    const tx = {
      userEpisodeStatus: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ episodeId: previous.id, watched: false, watchCount: 0 }]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      watchHistory: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const prisma = {
      mediaCanonicalCopy: { findFirst: jest.fn().mockResolvedValue(null) },
      episode: {
        findUnique: jest.fn().mockResolvedValue(current),
        findMany: jest.fn().mockResolvedValue([previous]),
      },
      userShowStatus: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'status',
          watchedCount: 1,
          totalCount: 10,
          dropped: false,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const events = { emit: jest.fn() };
    const redis = {
      client: { incr: jest.fn().mockResolvedValue(1) },
      delByPattern: jest.fn(),
      del: jest.fn(),
    };
    const service = new TrackingService(prisma as any, events as any, redis as any);

    const result = await service.markEpisodeAndPreviousWatched('user', current.id, {});

    expect(prisma.episode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          structureState: 'ACTIVE',
          season: { showId: 'show-record', isSpecial: false },
          AND: expect.arrayContaining([
            {
              OR: [{ airDate: null }, { airDate: { lte: expect.any(Date) } }],
            },
          ]),
        }),
      }),
    );
    expect(tx.userEpisodeStatus.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ episodeId: current.id, watched: true, watchCount: 1 })],
    });
    expect(tx.userEpisodeStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ episodeId: { in: [previous.id] } }),
      }),
    );
    expect(tx.watchHistory.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          episodeId: previous.id,
          mediaType: MediaType.SHOW,
          seasonNumber: 1,
        }),
        expect.objectContaining({ episodeId: current.id, seasonNumber: 2 }),
      ]),
    });
    expect(prisma.userShowStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ watchedCount: 3 }) }),
    );
    expect(events.emit).toHaveBeenCalledWith('watch.episode', {
      userId: 'user',
      mediaId: 'media-show',
      episodeId: current.id,
    });
    expect(result).toEqual({ watched: true, watchCount: 1, count: 2, previousCount: 1 });
  });
});
