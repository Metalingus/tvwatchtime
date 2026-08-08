import { MediaType } from '@tvwatch/shared';
import {
  reconcileCollapsedWatchRows,
  StatsService,
  topGenresByDistinctTitles,
} from './stats.service';

describe('topGenresByDistinctTitles', () => {
  it('counts genres once per title instead of once per episode or rewatch', () => {
    const show = {
      mediaId: 'show-1',
      media: {
        genres: [{ genre: { name: 'Drama' } }, { genre: { name: 'Comedy' } }],
      },
    };

    expect(
      topGenresByDistinctTitles([
        show,
        show,
        show,
        {
          mediaId: 'show-2',
          media: { genres: [{ genre: { name: 'Drama' } }] },
        },
      ]),
    ).toEqual([
      { name: 'Drama', count: 2 },
      { name: 'Comedy', count: 1 },
    ]);
  });
});

describe('reconcileCollapsedWatchRows', () => {
  const mediaShape = (id: string, runtimeMinutes: number) => ({
    id,
    title: id,
    genres: [],
    show: id.startsWith('show') ? { network: null } : null,
    movie: id.startsWith('movie') ? { runtimeMinutes } : null,
  });

  it('adds only imported plays missing from history and does not double native rewatches', () => {
    const showMedia = mediaShape('show-1', 45);
    const movieMedia = mediaShape('movie-1', 120);
    const watchedAt = new Date('2024-01-01T00:00:00.000Z');
    const showRow = {
      mediaId: showMedia.id,
      mediaType: MediaType.SHOW,
      episodeId: 'episode-1',
      seasonNumber: 1,
      episodeNumber: 1,
      runtimeMinutes: 45,
      watchedAt,
      media: showMedia,
    };
    const movieRow = {
      mediaId: movieMedia.id,
      mediaType: MediaType.MOVIE,
      episodeId: null,
      runtimeMinutes: 120,
      watchedAt,
      media: movieMedia,
    };

    const rows = reconcileCollapsedWatchRows(
      [showRow, showRow, movieRow],
      [
        {
          episodeId: 'episode-1',
          watched: true,
          watchCount: 3,
          watchedAt,
          episode: {
            number: 1,
            runtimeMinutes: 45,
            season: { number: 1, show: { media: showMedia } },
          },
        },
      ],
      [{ mediaId: movieMedia.id, watched: true, watchCount: 2, watchedAt, media: movieMedia }],
    );

    expect(rows.filter((row) => row.mediaType === MediaType.SHOW)).toHaveLength(3);
    expect(rows.filter((row) => row.mediaType === MediaType.MOVIE)).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.runtimeMinutes, 0)).toBe(3 * 45 + 2 * 120);
  });
});

describe('leaderboard cache lifecycle', () => {
  const entry = {
    userId: 'user-1',
    username: 'viewer',
    displayName: null,
    avatarUrl: null,
    totalMinutes: 120,
    position: 1,
  };
  const rankings = {
    combined: [entry],
    shows: [{ ...entry, totalMinutes: 90 }],
    movies: [{ ...entry, totalMinutes: 30 }],
  };

  function makeService(get: jest.Mock) {
    const redis = {
      get,
      set: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
      client: {
        get: jest.fn(async (_key: string): Promise<string | null> => null),
        set: jest.fn(async () => 'OK'),
      },
    };
    const leaderboardBust = { request: jest.fn(async () => undefined) };
    return {
      redis,
      leaderboardBust,
      service: new StatsService({} as any, redis as any, leaderboardBust as any),
    };
  }

  it('returns a stale ranking without waiting for the background recompute', async () => {
    let finish!: (value: typeof rankings) => void;
    const pending = new Promise<typeof rankings>((resolve) => {
      finish = resolve;
    });
    const { service } = makeService(
      jest.fn(async (key: string) => (key === 'lb:stale:combined' ? rankings.combined : null)),
    );
    const compute = jest
      .spyOn(service as any, 'computeRankedLeaderboards')
      .mockReturnValue(pending);

    await expect((service as any).getRankedLeaderboard('combined')).resolves.toEqual({
      entries: rankings.combined,
      stale: true,
    });
    expect(compute).toHaveBeenCalledTimes(1);

    finish(rankings);
    await pending;
  });

  it('shares one cold recompute across leaderboard types', async () => {
    const { service } = makeService(jest.fn(async () => null));
    const compute = jest
      .spyOn(service as any, 'computeRankedLeaderboards')
      .mockResolvedValue(rankings);

    await expect(
      Promise.all([
        (service as any).getRankedLeaderboard('combined'),
        (service as any).getRankedLeaderboard('shows'),
        (service as any).getRankedLeaderboard('movies'),
      ]),
    ).resolves.toEqual([
      { entries: rankings.combined, stale: false },
      { entries: rankings.shows, stale: false },
      { entries: rankings.movies, stale: false },
    ]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('computes and stores every ranking from one totals query', async () => {
    const { service, redis } = makeService(jest.fn(async () => null));
    const prisma = (service as any).prisma;
    prisma.user = {
      findMany: jest.fn(async () => [
        {
          id: 'user-1',
          username: 'viewer',
          isSuspended: false,
          profile: { displayName: null, avatarUrl: null, isPrivate: false },
        },
      ]),
    };
    jest
      .spyOn(service as any, 'loadLeaderboardMinutes')
      .mockResolvedValue([{ userId: 'user-1', showMinutes: 90, movieMinutes: 30 }]);

    await expect((service as any).computeRankedLeaderboards()).resolves.toEqual(rankings);
    expect((service as any).loadLeaderboardMinutes).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(6);
    expect(redis.set).toHaveBeenCalledWith(
      'lb:combined',
      rankings.combined,
      (service as any).lbTtlSec,
    );
    expect(redis.set).toHaveBeenCalledWith(
      'lb:stale:combined',
      rankings.combined,
      (service as any).lbStaleTtlSec,
    );
    expect(redis.client.set).toHaveBeenCalledWith('lb:computed-version', '0');
  });

  it('discards a partial snapshot when another season lands during the query', async () => {
    const { service, redis } = makeService(jest.fn(async () => null));
    const prisma = (service as any).prisma;
    prisma.user = {
      findMany: jest.fn(async () => [
        {
          id: 'user-1',
          username: 'viewer',
          isSuspended: false,
          profile: { displayName: null, avatarUrl: null, isPrivate: false },
        },
      ]),
    };
    redis.client.get
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('2')
      .mockResolvedValueOnce('2')
      .mockResolvedValueOnce('2');
    jest
      .spyOn(service as any, 'loadLeaderboardMinutes')
      .mockResolvedValueOnce([{ userId: 'user-1', showMinutes: 500, movieMinutes: 0 }])
      .mockResolvedValueOnce([{ userId: 'user-1', showMinutes: 1006, movieMinutes: 0 }]);

    const result = await (service as any).computeRankedLeaderboards();

    expect((service as any).loadLeaderboardMinutes).toHaveBeenCalledTimes(2);
    expect(result.combined[0].totalMinutes).toBe(1006);
    expect(redis.set).toHaveBeenCalledTimes(6);
    expect(redis.client.set).toHaveBeenCalledWith('lb:computed-version', '2');
  });

  it('pins the viewer current total while the global ranking is stale', async () => {
    const partial = [{ ...entry, totalMinutes: 500, position: 765 }];
    const { service } = makeService(
      jest.fn(async (key: string) => (key === 'lb:stale:combined' ? partial : null)),
    );
    jest.spyOn(service as any, 'computeRankedLeaderboards').mockResolvedValue(rankings);
    jest
      .spyOn(service as any, 'loadLeaderboardMinutes')
      .mockResolvedValue([{ userId: 'user-1', showMinutes: 1006, movieMinutes: 0 }]);

    const result = await service.getLeaderboard('user-1', 'combined');

    expect(result.stale).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.me).toMatchObject({ userId: 'user-1', totalMinutes: 1006 });
  });
});
