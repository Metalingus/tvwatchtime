import { BadRequestException } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 86400_000);

/** OnboardingService: bulk quick-setup apply + versioned per-user state. */
describe('OnboardingService', () => {
  const make = (opts: {
    user?: any;
    media?: any;
    episodeCount?: number;
    seasons?: any[];
    existingStatuses?: { episodeId: string; watched: boolean }[];
    movieStatus?: any;
    watchlistItems?: { mediaId: string }[];
    hydratedCount?: number;
  }) => {
    const prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            opts.user === undefined
              ? { onboardingStatus: 'NOT_STARTED', onboardingVersion: null }
              : opts.user,
          ),
        update: jest.fn().mockResolvedValue({}),
      },
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue(opts.media ?? null),
        update: jest.fn().mockResolvedValue({}),
      },
      episode: {
        count: jest
          .fn()
          .mockResolvedValueOnce(opts.episodeCount ?? 2)
          .mockResolvedValue(opts.hydratedCount ?? opts.episodeCount ?? 2),
      },
      season: { findMany: jest.fn().mockResolvedValue(opts.seasons ?? []) },
      userEpisodeStatus: {
        findMany: jest.fn().mockResolvedValue(opts.existingStatuses ?? []),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(2),
        aggregate: jest.fn().mockResolvedValue({ _max: { watchedAt: PAST } }),
      },
      watchHistory: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
      },
      userMovieStatus: {
        findUnique: jest.fn().mockResolvedValue(opts.movieStatus ?? null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      watchlistItem: {
        findMany: jest.fn().mockResolvedValue(opts.watchlistItems ?? []),
        upsert: jest.fn().mockResolvedValue({}),
      },
      userShowStatus: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      externalId: { findFirst: jest.fn().mockResolvedValue({ value: '123' }) },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const events = { emit: jest.fn() };
    const redis = {
      delByPattern: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(0),
    };
    const meta = {
      ensureShowFull: jest.fn().mockResolvedValue('media-1'),
      ensureShowFullTvdb: jest.fn(),
    };
    const tmdb = { enabled: true };
    const tvdb = { enabled: true };
    const svc = new OnboardingService(
      prisma as any,
      events as any,
      redis as any,
      meta as any,
      tmdb as any,
      tvdb as any,
    );
    return { svc, prisma, events, meta };
  };

  const showMedia = { id: 'media-1', type: 'SHOW', show: { id: 'show-1' } };
  const movieMedia = { id: 'movie-1', type: 'MOVIE', movie: { id: 'm-1', runtimeMinutes: 100 } };
  const seasons = [
    {
      number: 1,
      episodes: [
        { id: 'e1', number: 1, airDate: PAST, runtimeMinutes: 45 },
        { id: 'e2', number: 2, airDate: PAST, runtimeMinutes: 45 },
      ],
    },
    { number: 2, episodes: [{ id: 'e3', number: 1, airDate: null, runtimeMinutes: 45 }] },
  ];

  // ---------------- State ----------------
  it('getState returns the stored status/version plus the required version', async () => {
    const { svc } = make({ user: { onboardingStatus: 'COMPLETED', onboardingVersion: 1 } });
    await expect(svc.getState('u1')).resolves.toEqual({
      status: 'COMPLETED',
      version: 1,
      requiredVersion: 1,
    });
  });

  it('updateState stamps onboardingCompletedAt only for terminal states', async () => {
    const { svc, prisma } = make({});
    await svc.updateState('u1', { status: 'IN_PROGRESS', version: 1 });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { onboardingStatus: 'IN_PROGRESS', onboardingVersion: 1 },
    });
    await svc.updateState('u1', { status: 'SKIPPED', version: 1 });
    expect(prisma.user.update).toHaveBeenLastCalledWith({
      where: { id: 'u1' },
      data: {
        onboardingStatus: 'SKIPPED',
        onboardingVersion: 1,
        onboardingCompletedAt: expect.any(Date),
      },
    });
  });

  // ---------------- CAUGHT_UP ----------------
  it('CAUGHT_UP marks eligible episodes in one transaction and rebuilds the show status', async () => {
    const { svc, prisma, events } = make({ media: showMedia, seasons });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'CAUGHT_UP' }],
      movies: [],
    });

    expect(out.applied).toEqual({
      showsProcessed: 1,
      episodesMarked: 3,
      moviesWatched: 0,
      watchlistAdded: 1,
    });
    expect(out.unresolved).toEqual([]);
    // Undated official episodes are eligible; explicit future episodes and specials are not.
    expect(prisma.season.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          show: { mediaId: 'media-1' },
          isSpecial: false,
          episodes: { some: { structureState: 'ACTIVE' } },
        },
        include: {
          episodes: {
            where: {
              structureState: 'ACTIVE',
              OR: [{ airDate: null }, { airDate: { lte: expect.any(Date) } }],
            },
          },
        },
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.userEpisodeStatus.createMany).toHaveBeenCalledWith({
      data: ['e1', 'e2', 'e3'].map((id) =>
        expect.objectContaining({ userId: 'u1', episodeId: id, watched: true, watchCount: 1 }),
      ),
    });
    expect(prisma.watchHistory.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ episodeId: 'e1', seasonNumber: 1, episodeNumber: 1 }),
        expect.objectContaining({ episodeId: 'e3', seasonNumber: 2, episodeNumber: 1 }),
      ]),
    });
    expect(events.emit).toHaveBeenCalledTimes(2); // watch.episode + watchlist.added
    expect(events.emit).toHaveBeenCalledWith('watch.episode', { userId: 'u1', mediaId: 'media-1' });
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ watchedCount: 2, totalCount: 2, dropped: false }),
      }),
    );
    // A successful apply completes onboarding atomically.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: expect.objectContaining({ onboardingStatus: 'COMPLETED', onboardingVersion: 1 }),
    });
  });

  it('never re-marks already-watched episodes (idempotent replay is a no-op)', async () => {
    const { svc, prisma, events } = make({
      media: showMedia,
      seasons,
      existingStatuses: [
        { episodeId: 'e1', watched: true },
        { episodeId: 'e2', watched: true },
        { episodeId: 'e3', watched: true },
      ],
    });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'CAUGHT_UP' }],
      movies: [],
    });

    expect(out.applied.episodesMarked).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.watchHistory.createMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith('watch.episode', expect.anything());
    // The show status is still rebuilt (keeps counters correct) and onboarding completes.
    expect(prisma.userShowStatus.upsert).toHaveBeenCalled();
  });

  it('flips unwatched rows without touching watched ones', async () => {
    const { svc, prisma } = make({
      media: showMedia,
      seasons,
      existingStatuses: [
        { episodeId: 'e1', watched: true }, // keeps FIRST watchedAt
        { episodeId: 'e2', watched: false }, // flipped
      ],
    });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'CAUGHT_UP' }],
      movies: [],
    });

    expect(out.applied.episodesMarked).toBe(2); // e2 flipped + e3 created
    expect(prisma.userEpisodeStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', episodeId: { in: ['e2'] }, watched: false },
      data: expect.objectContaining({ watched: true, watchCount: 1 }),
    });
    expect(prisma.userEpisodeStatus.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ episodeId: 'e3' })],
    });
  });

  // ---------------- WATCHED_THROUGH ----------------
  it('WATCHED_THROUGH marks only episodes up to the boundary (S/E ordering)', async () => {
    const { svc, prisma } = make({ media: showMedia, seasons });
    const out = await svc.apply('u1', {
      shows: [
        {
          mediaId: 'media-1',
          action: 'WATCHED_THROUGH',
          throughSeasonNumber: 1,
          throughEpisodeNumber: 2,
        },
      ],
      movies: [],
    });

    expect(out.applied.episodesMarked).toBe(2);
    expect(prisma.userEpisodeStatus.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ episodeId: 'e1' }),
        expect.objectContaining({ episodeId: 'e2' }),
      ],
    });
  });

  it('rejects WATCHED_THROUGH without a boundary', async () => {
    const { svc } = make({});
    await expect(
      svc.apply('u1', { shows: [{ mediaId: 'media-1', action: 'WATCHED_THROUGH' }], movies: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ---------------- Watchlist ----------------
  it('WATCHLIST upserts the item, bumps addedCount and un-drops shows — no episode writes', async () => {
    const { svc, prisma, events } = make({ media: showMedia });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'WATCHLIST' }],
      movies: [],
    });

    expect(out.applied).toEqual({
      showsProcessed: 1,
      episodesMarked: 0,
      moviesWatched: 0,
      watchlistAdded: 1,
    });
    expect(prisma.watchlistItem.upsert).toHaveBeenCalledWith({
      where: { userId_mediaId: { userId: 'u1', mediaId: 'media-1' } },
      create: { userId: 'u1', mediaId: 'media-1' },
      update: {},
    });
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'media-1' },
      data: { addedCount: { increment: 1 } },
    });
    expect(prisma.userShowStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', mediaId: 'media-1', dropped: true },
      data: { dropped: false },
    });
    expect(events.emit).toHaveBeenCalledWith('watchlist.added', {
      userId: 'u1',
      mediaId: 'media-1',
      mediaType: 'SHOW',
    });
    expect(prisma.season.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('watchlist adds merge idempotently (existing item → no writes, no event)', async () => {
    const { svc, prisma, events } = make({
      media: showMedia,
      watchlistItems: [{ mediaId: 'media-1' }],
    });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'WATCHLIST' }],
      movies: [],
    });

    expect(out.applied.watchlistAdded).toBe(0);
    expect(prisma.watchlistItem.upsert).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  // ---------------- Movies ----------------
  it('movie WATCHED writes status + history + event only on the unwatched→watched transition', async () => {
    const { svc, prisma, events } = make({ media: movieMedia });
    const out = await svc.apply('u1', {
      shows: [],
      movies: [{ mediaId: 'movie-1', action: 'WATCHED' }],
    });

    expect(out.applied.moviesWatched).toBe(1);
    expect(prisma.userMovieStatus.upsert).toHaveBeenCalled();
    expect(prisma.watchHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', mediaId: 'movie-1', runtimeMinutes: 100 }),
    });
    expect(events.emit).toHaveBeenCalledWith('watch.movie', { userId: 'u1', mediaId: 'movie-1' });
  });

  it('movie WATCHED on an already-watched movie is a no-op', async () => {
    const { svc, prisma, events } = make({
      media: movieMedia,
      movieStatus: { watched: true },
      watchlistItems: [{ mediaId: 'movie-1' }],
    });
    const out = await svc.apply('u1', {
      shows: [],
      movies: [{ mediaId: 'movie-1', action: 'WATCHED' }],
    });

    expect(out.applied.moviesWatched).toBe(0);
    expect(prisma.watchHistory.create).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  // ---------------- Watched ⇒ also watchlisted ----------------
  it('CAUGHT_UP also watchlists the show (tracked-library convention)', async () => {
    const { svc, prisma, events } = make({ media: showMedia, seasons });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'CAUGHT_UP' }],
      movies: [],
    });

    expect(out.applied.watchlistAdded).toBe(1);
    expect(prisma.watchlistItem.upsert).toHaveBeenCalledWith({
      where: { userId_mediaId: { userId: 'u1', mediaId: 'media-1' } },
      create: { userId: 'u1', mediaId: 'media-1' },
      update: {},
    });
    expect(events.emit).toHaveBeenCalledWith('watchlist.added', {
      userId: 'u1',
      mediaId: 'media-1',
      mediaType: 'SHOW',
    });
  });

  it('movie WATCHED also watchlists the movie', async () => {
    const { svc, prisma } = make({ media: movieMedia });
    const out = await svc.apply('u1', {
      shows: [],
      movies: [{ mediaId: 'movie-1', action: 'WATCHED' }],
    });

    expect(out.applied.watchlistAdded).toBe(1);
    expect(prisma.watchlistItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: { userId: 'u1', mediaId: 'movie-1' } }),
    );
  });

  it('replayed apply does not re-add or re-count watchlist rows for watched titles', async () => {
    const { svc, prisma, events } = make({
      media: showMedia,
      seasons,
      watchlistItems: [{ mediaId: 'media-1' }], // already tracked (e.g. first apply ran)
    });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'CAUGHT_UP' }],
      movies: [],
    });

    expect(out.applied.watchlistAdded).toBe(0);
    expect(prisma.watchlistItem.upsert).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith('watchlist.added', expect.anything());
  });

  it('reports NOT_FOUND for unknown media and continues with the rest', async () => {
    const { svc, prisma } = make({ media: null });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'gone', action: 'CAUGHT_UP' }],
      movies: [{ mediaId: 'gone-too', action: 'WATCHED' }],
    });

    expect(out.unresolved).toEqual([
      { mediaId: 'gone', reason: 'NOT_FOUND' },
      { mediaId: 'gone-too', reason: 'NOT_FOUND' },
    ]);
    expect(prisma.user.update).toHaveBeenCalled(); // onboarding still completes
  });

  // ---------------- Hydration / failure isolation ----------------
  it('hydrates shows with no episodes and reports HYDRATION_FAILED when still empty', async () => {
    const { svc, prisma, meta } = make({ media: showMedia, episodeCount: 0, hydratedCount: 0 });
    const out = await svc.apply('u1', {
      shows: [{ mediaId: 'media-1', action: 'CAUGHT_UP' }],
      movies: [],
    });

    expect(out.unresolved).toEqual([{ mediaId: 'media-1', reason: 'HYDRATION_FAILED' }]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    void meta;
  });

  it('isolates per-show failures: one throwing show does not abort the batch', async () => {
    const { svc, prisma } = make({ media: showMedia, seasons });
    prisma.mediaItem.findUnique
      .mockRejectedValueOnce(new Error('db boom'))
      .mockResolvedValue(showMedia);
    const out = await svc.apply('u1', {
      shows: [
        { mediaId: 'bad', action: 'CAUGHT_UP' },
        { mediaId: 'media-1', action: 'CAUGHT_UP' },
      ],
      movies: [],
    });

    expect(out.unresolved).toEqual([{ mediaId: 'bad', reason: 'ERROR' }]);
    expect(out.applied.showsProcessed).toBe(1);
    expect(out.applied.episodesMarked).toBe(3);
  });
});
