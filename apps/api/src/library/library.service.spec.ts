import { LibraryService } from './library.service';

/** Minimal card factory — bucket rails only need a few fields for these tests. */
const card = (showId: string, bucket: string) => ({
  showId,
  bucket,
  episode: { id: `ep_${showId}` },
});

const makeSvc = () => {
  const prisma = {
    userShowStatus: { findMany: jest.fn() },
    userMovieStatus: { findMany: jest.fn(), count: jest.fn() },
    watchlistItem: { findMany: jest.fn() },
    episode: { findMany: jest.fn().mockResolvedValue([]) },
    mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn(),
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(null),
    del: jest.fn(),
    delByPattern: jest.fn(),
  };
  const meta = {
    ensureListLocaleOverrides: jest.fn().mockResolvedValue(undefined),
    ensureEpisodeLocaleOverrides: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new LibraryService(prisma as any, redis as any, meta as any);
  return { svc, prisma, redis, meta };
};

describe('LibraryService watchNext capped rails + bucket pagination', () => {
  it('caps every primary rail and exposes uncapped bucketTotals', async () => {
    const { svc } = makeSvc();
    const watchNext = Array.from({ length: 27 }, (_, i) => card(`wn${i}`, 'WATCH_NEXT'));
    const notRecently = Array.from({ length: 23 }, (_, i) => card(`nr${i}`, 'NOT_RECENTLY'));
    const startWatching = Array.from({ length: 14 }, (_, i) => card(`sw${i}`, 'START_WATCHING'));
    jest.spyOn(svc as any, 'computeWatchNext').mockResolvedValue({
      history: [card('h1', 'HISTORY')],
      historyHasMore: false,
      watchNext,
      startWatching,
      notRecently,
    });

    const res = await svc.watchNext('u1');
    expect(res.items).toHaveLength(1 + 20 + 10 + 10);
    expect(res.bucketTotals).toEqual({ watchNext: 27, notRecently: 23, startWatching: 14 });
    // "Haven't watched for a while" ships before "Start watching" in the payload.
    const firstSw = res.items.findIndex((i) => i.bucket === 'START_WATCHING');
    const lastNr = res.items.map((i) => i.bucket).lastIndexOf('NOT_RECENTLY');
    expect(firstSw).toBeGreaterThan(lastNr);
  });

  it('watchNextBucket slices the uncapped rail with offset/hasMore/nextOffset', async () => {
    const { svc } = makeSvc();
    const notRecently = Array.from({ length: 23 }, (_, i) => card(`nr${i}`, 'NOT_RECENTLY'));
    jest.spyOn(svc as any, 'computeWatchNext').mockResolvedValue({
      history: [],
      historyHasMore: false,
      watchNext: [],
      startWatching: [],
      notRecently,
    });

    const page2 = await svc.watchNextBucket('u1', 'NOT_RECENTLY', 10, 10);
    expect(page2.items.map((i: any) => i.showId)).toEqual(
      notRecently.slice(10, 20).map((c) => c.showId),
    );
    expect(page2.hasMore).toBe(true);
    expect(page2.nextOffset).toBe(20);

    const page3 = await svc.watchNextBucket('u1', 'NOT_RECENTLY', 20, 10);
    expect(page3.items).toHaveLength(3);
    expect(page3.hasMore).toBe(false);
    expect(page3.total).toBe(23);
  });

  it('pages the WATCH_NEXT rail after the initial 20 cards', async () => {
    const { svc } = makeSvc();
    const watchNext = Array.from({ length: 35 }, (_, i) => card(`wn${i}`, 'WATCH_NEXT'));
    jest.spyOn(svc as any, 'computeWatchNext').mockResolvedValue({
      history: [],
      historyHasMore: false,
      watchNext,
      startWatching: [],
      notRecently: [],
    });

    const page = await svc.watchNextBucket('u1', 'WATCH_NEXT', 20, 10);
    expect(page.items.map((item: any) => item.showId)).toEqual(
      watchNext.slice(20, 30).map((item) => item.showId),
    );
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(35);
  });

  it('watch-next cache key stays inside the shared `watchnext:{userId}:*` invalidation glob', async () => {
    // Regression: a `watchnext:v2:{userId}:{lang}` key never matched the
    // `delByPattern('watchnext:{userId}:*')` calls in tracking/collections/import/
    // onboarding, so removed/paused shows lingered in the Shows tab until the TTL.
    const { svc, prisma, redis } = makeSvc();
    (prisma as any).watchHistory = { findMany: jest.fn().mockResolvedValue([]) };
    (prisma as any).userEpisodeStatus = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.userShowStatus.findMany.mockResolvedValue([]);
    prisma.watchlistItem.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);

    await svc.watchNext('u1');

    const key = (redis.set.mock.calls[0]?.[0] ?? '') as string;
    expect(key.startsWith('watchnext:u1:')).toBe(true);
    // The glob `watchnext:u1:*` must match: prefix + any suffix.
    expect(`watchnext:u1:*`.slice(0, -1) + key.slice('watchnext:u1:'.length)).toContain(key);
  });

  it('keeps history-only status rows out of Watch Next when the show is not watchlisted', async () => {
    const { svc, prisma } = makeSvc();
    (prisma as any).watchHistory = { findMany: jest.fn().mockResolvedValue([]) };
    (prisma as any).userEpisodeStatus = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.userShowStatus.findMany.mockResolvedValue([
      {
        id: 'status1',
        userId: 'u1',
        mediaId: 'historyOnly',
        dropped: false,
        pausedAt: null,
        watchedCount: 3,
        totalCount: 10,
        lastWatchedAt: new Date(),
        media: { id: 'historyOnly', title: 'History Only', show: {} },
      },
    ]);
    // Both the membership lookup and the never-watched lookup return no rows.
    prisma.watchlistItem.findMany.mockResolvedValue([]);

    const result = await svc.watchNext('u1');

    expect(result.items).toEqual([]);
    expect(result.bucketTotals).toEqual({ watchNext: 0, notRecently: 0, startWatching: 0 });
    // No episode-status aggregation should run for a user with no eligible shows.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.watchlistItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          media: expect.objectContaining({
            showStatuses: {
              none: {
                userId: 'u1',
                OR: [{ pausedAt: { not: null } }, { dropped: true }],
              },
            },
          }),
        }),
      }),
    );
  });
});

describe('LibraryService bounded large-library paths', () => {
  it('coalesces simultaneous cache misses in one API process', async () => {
    const { svc } = makeSvc();
    const loader = jest.fn(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return 'done';
    });

    const first = (svc as any).cached('large:u1', 60, loader);
    const second = (svc as any).cached('large:u1', 60, loader);

    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('returns one localized My Shows page with the summary total', async () => {
    const { svc, prisma } = makeSvc();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ mediaId: 'show1', watchedCount: 3, airedTotal: 12 }])
      .mockResolvedValueOnce([
        { watching: 800, notStarted: 0, finished: 0, paused: 0, dropped: 0 },
      ]);
    prisma.mediaItem.findMany.mockResolvedValue([
      {
        id: 'show1',
        title: 'Large Show',
        posterUrl: null,
        rating: 8,
        show: { yearStart: 2020 },
        titles: null,
        posterUrls: null,
        backdropUrls: null,
      },
    ]);

    const result = await svc.showsProgressPage('u1', 'watching', 1, 24);
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'show1', progress: 0.25, title: 'Large Show' }),
    ]);
    expect(result.total).toBe(800);
    expect(result.hasMore).toBe(true);
  });

  it('returns dropped shows from their dedicated paged section', async () => {
    const { svc, prisma } = makeSvc();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ mediaId: 'dropped1', watchedCount: 3, airedTotal: 12 }])
      .mockResolvedValueOnce([{ watching: 0, notStarted: 0, finished: 0, paused: 0, dropped: 1 }]);
    prisma.mediaItem.findMany.mockResolvedValue([
      {
        id: 'dropped1',
        title: 'Dropped Show',
        posterUrl: null,
        rating: 8,
        show: { yearStart: 2020 },
        titles: null,
        posterUrls: null,
        backdropUrls: null,
      },
    ]);

    const result = await svc.showsProgressPage('u1', 'dropped', 1, 24);

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'dropped1', progress: 0.25, title: 'Dropped Show' }),
    ]);
    expect(result.total).toBe(1);
  });

  it('pages distinct watched movies from status rows instead of watch events', async () => {
    const { svc, prisma, meta } = makeSvc();
    prisma.userMovieStatus.findMany.mockResolvedValue([
      {
        id: 'status1',
        media: {
          id: 'movie1',
          title: 'Movie',
          titles: { fr: 'Film' },
          posterUrl: null,
          posterUrls: null,
          rating: 7,
          movie: { releaseYear: 2024 },
        },
      },
    ]);
    prisma.userMovieStatus.count.mockResolvedValue(700);
    prisma.mediaItem.findMany.mockResolvedValue([]);

    const result = await svc.watchedMovies('u1', 1, 24);
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'movie1', watched: true, progress: 1 }),
    ]);
    expect(result.total).toBe(700);
    expect(result.hasMore).toBe(true);
    expect(meta.ensureListLocaleOverrides).not.toHaveBeenCalled();
    expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
  });

  it('uses one extra past row for Upcoming hasMore instead of a full historical count', async () => {
    const { svc, prisma, redis } = makeSvc();
    prisma.watchlistItem.findMany.mockResolvedValue([{ mediaId: 'show1' }]);
    const media = { id: 'show1', title: 'Show', posterUrl: null, show: { network: null } };
    const past = Array.from({ length: 11 }, (_, index) => ({
      id: `ep${index}`,
      number: index + 1,
      title: `Episode ${index + 1}`,
      airDate: new Date(2026, 0, index + 1),
      airTime: null,
      isFinale: false,
      season: { number: 1, show: { media } },
    }));
    prisma.episode.findMany
      .mockResolvedValueOnce(past)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.mediaItem.findMany.mockResolvedValue([]);

    const result = await svc.upcoming('u1');
    expect(result.past.hasMore).toBe(true);
    expect(result.groups.flatMap((group: any) => group.items)).toHaveLength(10);
    expect((prisma.episode as any).count).toBeUndefined();
    expect(redis.set.mock.calls[0]?.[0]).toEqual(expect.stringMatching(/^upcoming:u1:/));
  });
});

describe('LibraryService showsByStatus inactive buckets', () => {
  const statusRow = (
    mediaId: string,
    opts: { watchedCount?: number; pausedAt?: Date | null; dropped?: boolean },
  ) => ({
    userId: 'u1',
    mediaId,
    watchedCount: opts.watchedCount ?? 0,
    pausedAt: opts.pausedAt ?? null,
    dropped: opts.dropped ?? false,
    lastWatchedAt: null,
    media: {
      id: mediaId,
      title: `Show ${mediaId}`,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      show: { yearStart: 2020 },
    },
  });

  it('routes paused shows to their own rail and out of watching/finished/notStarted', async () => {
    const { svc, prisma, redis } = makeSvc();
    prisma.userShowStatus.findMany.mockResolvedValue([
      statusRow('watching1', { watchedCount: 3 }),
      statusRow('paused1', { watchedCount: 5, pausedAt: new Date('2026-07-01') }),
      statusRow('paused2', { watchedCount: 0, pausedAt: new Date('2026-07-02') }),
      statusRow('finished1', { watchedCount: 10 }),
    ]);
    prisma.watchlistItem.findMany.mockResolvedValue([
      // paused2 is also watchlisted — it must NOT surface in notStarted.
      {
        userId: 'u1',
        mediaId: 'paused2',
        createdAt: new Date(),
        media: statusRow('paused2', {}).media,
      },
      {
        userId: 'u1',
        mediaId: 'fresh1',
        createdAt: new Date(),
        media: statusRow('fresh1', {}).media,
      },
    ]);
    // Canonical graph counts: watching1 3/10, paused1 5/10, finished1 10/10.
    prisma.$queryRaw.mockResolvedValue([
      { mediaId: 'watching1', totalCount: 10, watchedCount: 3 },
      { mediaId: 'paused1', totalCount: 10, watchedCount: 5 },
      { mediaId: 'finished1', totalCount: 10, watchedCount: 10 },
    ]);

    const res = await svc.showsByStatus('u1');
    expect(res.watching.map((i: any) => i.id)).toEqual(['watching1']);
    expect(res.finished.map((i: any) => i.id)).toEqual(['finished1']);
    expect(res.paused.map((i: any) => i.id)).toEqual(['paused2', 'paused1']); // pausedAt desc
    expect(res.notStarted.map((i: any) => i.id)).toEqual(['fresh1']);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('showsprogress:u1:v4:'),
      expect.anything(),
      30,
    );
  });

  it('routes dropped shows to their own bucket while keeping them out of active buckets', async () => {
    const { svc, prisma } = makeSvc();
    prisma.userShowStatus.findMany.mockResolvedValue([
      statusRow('watching1', { watchedCount: 3 }),
      statusRow('droppedWatching', { watchedCount: 3, dropped: true }),
      statusRow('droppedFinished', { watchedCount: 10, dropped: true }),
      statusRow('droppedPaused', {
        watchedCount: 2,
        dropped: true,
        pausedAt: new Date('2026-07-01'),
      }),
    ]);
    prisma.watchlistItem.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([
      { mediaId: 'watching1', totalCount: 10, watchedCount: 3 },
      { mediaId: 'droppedWatching', totalCount: 10, watchedCount: 3 },
      { mediaId: 'droppedFinished', totalCount: 10, watchedCount: 10 },
      { mediaId: 'droppedPaused', totalCount: 10, watchedCount: 2 },
    ]);

    const res = await svc.showsByStatus('u1');
    expect(res.watching.map((i: any) => i.id)).toEqual(['watching1']);
    expect(res.finished).toEqual([]);
    expect(res.paused).toEqual([]);
    expect(res.notStarted).toEqual([]);
    expect(res.dropped.map((i: any) => i.id)).toEqual([
      'droppedWatching',
      'droppedFinished',
      'droppedPaused',
    ]);
  });

  it('returns a re-added show (dropped cleared) to its bucket', async () => {
    const { svc, prisma } = makeSvc();
    prisma.userShowStatus.findMany.mockResolvedValue([
      statusRow('readded', { watchedCount: 3, dropped: false }),
    ]);
    prisma.watchlistItem.findMany.mockResolvedValue([
      {
        userId: 'u1',
        mediaId: 'readded',
        createdAt: new Date(),
        media: statusRow('readded', {}).media,
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([{ mediaId: 'readded', totalCount: 10, watchedCount: 3 }]);

    const res = await svc.showsByStatus('u1');
    expect(res.watching.map((i: any) => i.id)).toEqual(['readded']);
    expect(res.notStarted).toEqual([]);
  });
});
