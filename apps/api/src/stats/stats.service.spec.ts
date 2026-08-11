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

describe('incremental leaderboard', () => {
  function makeService() {
    const write = {
      del: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zrem: jest.fn().mockReturnThis(),
      exec: jest.fn(async () => []),
    };
    const client = {
      get: jest.fn(async (key: string) => {
        if (key === 'lb:v2:ready') return '1';
        if (key.endsWith(':version')) return '3';
        if (key.endsWith(':computed-version')) return '3';
        return null;
      }),
      set: jest.fn(async () => 'OK'),
      del: jest.fn(async () => 0),
      eval: jest.fn(async () => 1),
      multi: jest.fn(() => write),
      sismember: jest.fn(async () => 0),
      scard: jest.fn(async () => 0),
      zcard: jest.fn(async () => 0),
      zrevrange: jest.fn(async () => [] as string[]),
      zscore: jest.fn(async () => null as string | null),
      zrevrank: jest.fn(async () => null as number | null),
      zcount: jest.fn(async () => 0),
    };
    const redis = { client };
    const prisma = {
      user: {
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(async () => null),
      },
    };
    const leaderboardBust = {
      request: jest.fn(async () => undefined),
      scheduleExisting: jest.fn(async () => undefined),
    };
    return {
      service: new StatsService(prisma as any, redis as any, leaderboardBust as any),
      prisma,
      redis,
      client,
      write,
      leaderboardBust,
    };
  }

  it('refreshes only the changed user across all three sorted sets', async () => {
    const { service, prisma, write } = makeService();
    jest
      .spyOn(service as any, 'loadLeaderboardMinutes')
      .mockResolvedValue([{ userId: 'user-1', showMinutes: 90, movieMinutes: 30 }]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      isSuspended: false,
      profile: { isPrivate: false },
    } as any);

    await (service as any).refreshLeaderboardUserOnce('user-1');

    expect((service as any).loadLeaderboardMinutes).toHaveBeenCalledWith('user-1');
    expect(write.zadd.mock.calls).toEqual([
      ['lb:v2:rank:combined', 120, 'user-1'],
      ['lb:v2:rank:shows', 90, 'user-1'],
      ['lb:v2:rank:movies', 30, 'user-1'],
    ]);
    expect(write.zrem).not.toHaveBeenCalled();
  });

  it('removes a private user from every ranking without rebuilding anyone else', async () => {
    const { service, prisma, write } = makeService();
    jest
      .spyOn(service as any, 'loadLeaderboardMinutes')
      .mockResolvedValue([{ userId: 'user-1', showMinutes: 90, movieMinutes: 30 }]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      isSuspended: false,
      profile: { isPrivate: true },
    } as any);

    await (service as any).refreshLeaderboardUserOnce('user-1');

    expect(write.zrem.mock.calls).toEqual([
      ['lb:v2:rank:combined', 'user-1'],
      ['lb:v2:rank:shows', 'user-1'],
      ['lb:v2:rank:movies', 'user-1'],
    ]);
    expect(write.zadd).not.toHaveBeenCalled();
  });

  it('retains a trailing refresh when the user changes during the scoped query', async () => {
    const { service, prisma, client, leaderboardBust } = makeService();
    jest
      .spyOn(service as any, 'loadLeaderboardMinutes')
      .mockResolvedValue([{ userId: 'user-1', showMinutes: 90, movieMinutes: 30 }]);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      isSuspended: false,
      profile: { isPrivate: false },
    } as any);
    client.eval.mockResolvedValueOnce(0);

    await (service as any).refreshLeaderboardUserOnce('user-1');

    expect(leaderboardBust.scheduleExisting).toHaveBeenCalledWith('user-1');
  });

  it('reads a page from the sorted set without running the global totals query', async () => {
    const { service, prisma, client } = makeService();
    jest.spyOn(service as any, 'ensureLeaderboardReady').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensureLeaderboardUserCurrent').mockResolvedValue(undefined);
    const totals = jest.spyOn(service as any, 'loadLeaderboardMinutes');
    client.zcard.mockResolvedValue(2);
    client.zrevrange.mockResolvedValue(['user-1', '120', 'user-2', '90']);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'user-1',
        username: 'alpha',
        isSuspended: false,
        profile: { displayName: 'Alpha', avatarUrl: null, isPrivate: false },
      },
      {
        id: 'user-2',
        username: 'beta',
        isSuspended: false,
        profile: { displayName: 'Beta', avatarUrl: null, isPrivate: false },
      },
    ] as any);

    const result = await service.getLeaderboard('user-1', 'combined', 1, 10);

    expect(result.entries).toEqual([
      {
        userId: 'user-1',
        username: 'alpha',
        displayName: 'Alpha',
        avatarUrl: null,
        totalMinutes: 120,
        position: 1,
      },
      {
        userId: 'user-2',
        username: 'beta',
        displayName: 'Beta',
        avatarUrl: null,
        totalMinutes: 90,
        position: 2,
      },
    ]);
    expect(result.me).toBeNull();
    expect(result.stale).toBe(false);
    expect(totals).not.toHaveBeenCalled();
  });
});
