import { NotificationScheduler } from './notification.scheduler';

function createScheduler(prisma: any, tvmazeEnabled = true) {
  const notifications = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const meta = { ensureAirtimes: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: jest.fn((key: string) => (key === 'metadata.tvmazeEnabled' ? tvmazeEnabled : undefined)),
  };
  const settings = { getNumber: jest.fn().mockResolvedValue(30) };
  return new NotificationScheduler(
    prisma,
    notifications as any,
    meta as any,
    config as any,
    settings as any,
  );
}

describe('NotificationScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not truncate same-day episode candidates after the first 400 rows', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00.000Z'));

    const episode = (id: string, mediaId: string) => ({
      id,
      number: 2,
      title: `Episode ${id}`,
      airDate: new Date('2026-09-03T00:00:00.000Z'),
      airTime: null,
      season: {
        number: 2,
        show: {
          mediaId,
          media: {
            id: mediaId,
            title: `Show ${mediaId}`,
            backdropUrl: null,
          },
        },
      },
    });
    const episodes = [
      ...Array.from({ length: 400 }, (_, i) => episode(`noise-${i}`, 'noise-media')),
      episode('target-episode', 'target-media'),
    ];

    const prisma = {
      episode: {
        // Honour `take` like Prisma would so this test regresses if a global cap is
        // reintroduced: the target episode deliberately sits at position 401.
        findMany: jest
          .fn()
          .mockImplementation((args: { take?: number }) =>
            Promise.resolve(args.take ? episodes.slice(0, args.take) : episodes),
          ),
      },
      userShowStatus: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            where.mediaId === 'target-media'
              ? [
                  {
                    userId: 'active-user',
                    lastWatchedAt: new Date('2026-09-01T12:00:00.000Z'),
                    watchedCount: 1,
                    pausedAt: null,
                    dropped: false,
                  },
                ]
              : [],
          ),
        ),
      },
      watchlistItem: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      device: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'active-user', timezone: 'UTC' }]),
      },
      notificationPreference: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const scheduler = createScheduler(prisma, false);
    await scheduler.scheduleEpisodeNotifications();

    expect((scheduler as any).notifications.createForUser).toHaveBeenCalledTimes(1);
    expect((scheduler as any).notifications.createForUser).toHaveBeenCalledWith(
      'active-user',
      expect.objectContaining({ dedupeKey: 'ep:target-episode:today' }),
    );
    expect(prisma.episode.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.any(Number) }),
    );
  });

  it('excludes dropped shows from episode notification tracking users', async () => {
    const prisma = {
      userShowStatus: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'active-user',
            lastWatchedAt: new Date('2026-07-01'),
            watchedCount: 2,
            pausedAt: null,
            dropped: false,
          },
          {
            userId: 'dropped-user',
            lastWatchedAt: new Date('2026-06-01'),
            watchedCount: 5,
            pausedAt: null,
            dropped: true,
          },
        ]),
      },
      watchlistItem: { findMany: jest.fn().mockResolvedValue([{ userId: 'dropped-user' }]) },
      $queryRaw: jest.fn().mockResolvedValue([
        { userId: 'active-user', cnt: 2, lastAt: new Date('2026-07-01') },
        { userId: 'dropped-user', cnt: 5, lastAt: new Date('2026-06-01') },
      ]),
    };

    const scheduler = createScheduler(prisma);
    const users = await (scheduler as any).trackingUsersWithStatus('media-1');

    expect(users.map((u: any) => u.userId)).toEqual(['active-user']);

    expect(prisma.userShowStatus.findMany).toHaveBeenCalledWith({
      where: { mediaId: 'media-1' },
      select: {
        userId: true,
        lastWatchedAt: true,
        watchedCount: true,
        pausedAt: true,
        dropped: true,
      },
    });
  });

  it('excludes paused trackers from episode notification recipients (status and watchlist branches)', async () => {
    const prisma = {
      userShowStatus: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'active-user',
            lastWatchedAt: new Date('2026-07-01'),
            watchedCount: 2,
            pausedAt: null,
            dropped: false,
          },
          {
            userId: 'paused-user',
            lastWatchedAt: new Date('2026-07-01'),
            watchedCount: 4,
            pausedAt: new Date('2026-07-10'),
            dropped: false,
          },
        ]),
      },
      // A watchlist-only user who paused must not leak in via the union either.
      watchlistItem: { findMany: jest.fn().mockResolvedValue([{ userId: 'paused-user' }]) },
      $queryRaw: jest.fn().mockResolvedValue([
        { userId: 'active-user', cnt: 2, lastAt: new Date('2026-07-01') },
        { userId: 'paused-user', cnt: 4, lastAt: new Date('2026-07-01') },
      ]),
    };

    const scheduler = createScheduler(prisma);
    const users = await (scheduler as any).trackingUsersWithStatus('media-1');

    expect(users.map((u: any) => u.userId)).toEqual(['active-user']);
  });

  it('excludes paused shows from stale watchlist reminders', async () => {
    const prisma = {
      userShowStatus: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const scheduler = createScheduler(prisma);
    await scheduler.watchlistReminders();

    expect(prisma.userShowStatus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dropped: false, pausedAt: null, watchedCount: { gt: 0 } }),
      }),
    );
  });

  it('excludes dropped shows from stale watchlist reminders', async () => {
    const prisma = {
      userShowStatus: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const scheduler = createScheduler(prisma);
    await scheduler.watchlistReminders();

    expect(prisma.userShowStatus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dropped: false, watchedCount: { gt: 0 } }),
      }),
    );
  });

  it('does not refresh airtimes for dropped-or-paused-only shows', async () => {
    const prisma = {
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const scheduler = createScheduler(prisma);
    await scheduler.refreshAirtimes();

    expect(prisma.mediaItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { showStatuses: { some: { dropped: false, pausedAt: null } } },
            { watchlist: { some: {} } },
          ],
        }),
      }),
    );
  });

  it('does not scan the catalog when TVmaze is disabled', async () => {
    const prisma = {
      mediaItem: { findMany: jest.fn() },
    };

    const scheduler = createScheduler(prisma, false);
    const result = await scheduler.refreshAirtimes();

    expect(result).toEqual({ processed: 0, disabled: true });
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });
});
