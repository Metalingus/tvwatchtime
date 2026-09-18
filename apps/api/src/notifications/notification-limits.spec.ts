import { NotificationService } from './notification.service';
import { NotificationScheduler } from './notification.scheduler';

function fixture(inApp = false) {
  const notices: any[] = [],
    jobs: any[] = [];
  const prisma: any = {
    notificationPreference: {
      upsert: jest.fn(async () => ({
        preferences: {
          EPISODE_TODAY: { push: true, inApp },
          WATCHLIST_REMINDER: { push: true, inApp },
        },
      })),
    },
    notification: {
      findUnique: jest.fn(
        async ({ where }) =>
          notices.find((n) => n.dedupeKey === where.userId_dedupeKey.dedupeKey) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }) =>
          notices.find(
            (n) =>
              n.userId === where.userId &&
              n.category === where.category &&
              n.createdAt > where.createdAt.gt,
          ) ?? null,
      ),
      create: jest.fn(async ({ data }) => {
        notices.push({ ...data, createdAt: new Date() });
        return data;
      }),
    },
    pushNotificationJob: {
      count: jest.fn(async () => 0),
      findFirst: jest.fn(
        async ({ where }) =>
          jobs.find(
            (n) =>
              n.userId === where.userId &&
              n.category === where.category &&
              (where.OR
                ? where.OR.some((o: any) => n.payload[o.payload.path[0]] === o.payload.equals)
                : n.createdAt > where.createdAt.gt),
          ) ?? null,
      ),
    },
    $queryRaw: jest.fn(async () => []),
  };
  prisma.$transaction = jest.fn(async (fn) => fn(prisma));
  const push = {
    schedule: jest.fn(async (input, db) => {
      expect(db).toBe(prisma);
      jobs.push({
        ...input,
        payload: { dedupeKey: input.dedupeKey, pushDedupeKey: input.pushDedupeKey },
        createdAt: new Date(),
      });
    }),
  };
  const service = new NotificationService(
    prisma,
    push as any,
    { get: () => 100 } as any,
    { isEnabled: async () => true } as any,
  );
  return { service, prisma, push, notices, jobs };
}

describe('scheduled notification limits', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-17T12:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it.each([false, true])(
    'deduplicates reruns with inApp=%s while allowing different shows and days',
    async (inApp) => {
      const f = fixture(inApp);
      const send = (key: string) =>
        f.service.createForUser('user', {
          category: 'EPISODE_TODAY',
          title: 'Episode',
          dedupeKey: key,
          push: true,
        });
      await send('show:a:episode:2026-09-17');
      await send('show:a:episode:2026-09-17');
      await send('show:b:episode:2026-09-17');
      await send('show:a:episode:2026-09-18');
      expect(f.push.schedule).toHaveBeenCalledTimes(3);
      expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(4);
      expect(f.prisma.$queryRaw.mock.calls[0][0].join('?')).toContain('pg_advisory_xact_lock');
    },
  );

  it('does not duplicate a deferred alert or send a second show alert on its delivery day', async () => {
    const f = fixture(false);
    const send = (event: string, delivery: string) =>
      f.service.createForUser('user', {
        category: 'EPISODE_TODAY',
        title: 'Episode',
        dedupeKey: event,
        pushDedupeKey: delivery,
        push: true,
      });
    await send('show:a:17', 'show:a:18');
    await send('show:a:17', 'show:a:18');
    await send('show:a:18', 'show:a:18');
    expect(f.push.schedule).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'limits reminders across all shows to 72 hours with inApp=%s',
    async (inApp) => {
      const f = fixture(inApp);
      const send = (day: string) =>
        f.service.createForUser('user', {
          category: 'WATCHLIST_REMINDER',
          title: 'Catch up',
          dedupeKey: 'remind:' + day,
          push: true,
        });
      await send('17');
      jest.setSystemTime(new Date('2026-09-18T12:00:00Z'));
      await send('18');
      jest.setSystemTime(new Date('2026-09-20T11:59:59Z'));
      await send('20-before');
      expect(f.push.schedule).toHaveBeenCalledTimes(1);
      jest.setSystemTime(new Date('2026-09-20T12:00:00Z'));
      await send('20');
      expect(f.push.schedule).toHaveBeenCalledTimes(2);
    },
  );

  it('selects one episode per show for a season drop on the viewer local day', async () => {
    jest.setSystemTime(new Date('2026-09-18T01:00:00Z')); // September 17 in Los Angeles
    const episode = (show: string, number: number) => ({
      id: show + '-' + number,
      number,
      title: 'Episode',
      airDate: new Date('2026-09-17'),
      airTime: null,
      season: {
        number: 2,
        isSpecial: false,
        show: { mediaId: show, media: { id: show, title: show } },
      },
    });
    const prisma: any = {
      episode: {
        findMany: jest.fn(async () => [
          episode('a', 3),
          episode('a', 1),
          episode('a', 2),
          episode('b', 2),
        ]),
      },
      userShowStatus: {
        findMany: jest.fn(async () => [
          { userId: 'user', watchedCount: 2, lastWatchedAt: new Date() },
        ]),
      },
      $queryRaw: jest.fn(async () => []),
      watchlistItem: { findMany: jest.fn(async () => []) },
      device: {
        findMany: jest.fn(async () => [{ userId: 'user', timezone: 'America/Los_Angeles' }]),
      },
      notificationPreference: { findMany: jest.fn(async () => []) },
    };
    const notifications = { createForUser: jest.fn(async () => undefined) };
    const scheduler = new NotificationScheduler(
      prisma,
      notifications as any,
      {} as any,
      { get: () => undefined } as any,
      {} as any,
    );
    await scheduler.scheduleEpisodeNotifications();
    expect(notifications.createForUser).toHaveBeenCalledTimes(2);
    expect(notifications.createForUser).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({
        link: 'tvwatchtime://episode/a-1',
        dedupeKey: 'show:a:episode:2026-09-17',
      }),
    );
  });
});
