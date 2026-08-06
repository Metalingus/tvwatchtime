import { NotificationScheduler } from './notification.scheduler';

function createScheduler(prisma: any) {
  const notifications = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const meta = { ensureAirtimes: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn() };
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
});
