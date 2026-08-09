import { ExternalReviewsService } from './external-reviews.service';

const review = (id: string) => ({
  externalId: id,
  author: 'A',
  username: 'a',
  avatarUrl: null,
  rating: 8,
  content: 'great',
  url: `https://www.themoviedb.org/review/${id}`,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: null,
});

function makePrisma(opts: { media?: any; episode?: any } = {}) {
  const tx: any = {
    externalReview: {
      deleteMany: jest.fn(async () => ({})),
      upsert: jest.fn(async () => ({})),
    },
  };
  const prisma: any = {
    externalReview: {
      findMany: jest.fn(async () => []),
    },
    mediaItem: {
      findUnique: jest.fn(async () => opts.media ?? null),
      update: jest.fn(async () => ({})),
    },
    episode: {
      findUnique: jest.fn(async () => opts.episode ?? null),
      update: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return { prisma, tx };
}

describe('ExternalReviewsService', () => {
  it('syncMediaReviews upserts stable review ids, prunes vanished rows and marks synced', async () => {
    const { prisma, tx } = makePrisma();
    const svc = new ExternalReviewsService(prisma, { enabled: true } as any);

    await svc.syncMediaReviews('m1', [review('r1'), review('r2')]);

    expect(tx.externalReview.upsert).toHaveBeenCalledTimes(2);
    expect(tx.externalReview.upsert).toHaveBeenCalledWith({
      where: { provider_externalId: { provider: 'TMDB', externalId: 'r1' } },
      create: expect.objectContaining({ externalId: 'r1', mediaId: 'm1', episodeId: null }),
      update: expect.objectContaining({ externalId: 'r1', mediaId: 'm1', episodeId: null }),
    });
    expect(tx.externalReview.deleteMany).toHaveBeenCalledWith({
      where: {
        mediaId: 'm1',
        externalId: { notIn: ['r1', 'r2'] },
        comments: { none: {} },
        likes: { none: {} },
      },
    });
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { reviewsSyncedAt: expect.any(Date) },
    });
  });

  it('ensureFreshForThread: never-synced media fetches inline and syncs', async () => {
    const { prisma } = makePrisma({
      media: { type: 'MOVIE', reviewsSyncedAt: null, externalIds: [{ value: '1368337' }] },
    });
    const tmdb = {
      enabled: true,
      getMovieReviews: jest.fn(async () => [review('r9')]),
      getShowReviews: jest.fn(),
    };
    const svc = new ExternalReviewsService(prisma, tmdb as any);

    await svc.ensureFreshForThread('MOVIE' as any, 'm1');

    expect(tmdb.getMovieReviews).toHaveBeenCalledWith(1368337);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalled();
  });

  it('keeps cached translations when provider content is unchanged', async () => {
    const { prisma, tx } = makePrisma();
    prisma.externalReview.findMany.mockResolvedValue([{ externalId: 'r1', content: 'great' }]);
    const svc = new ExternalReviewsService(prisma, { enabled: true } as any);

    await svc.syncMediaReviews('m1', [review('r1')]);

    expect(tx.externalReview.upsert.mock.calls[0][0].update).not.toHaveProperty('translations');
    expect(tx.externalReview.upsert.mock.calls[0][0].update).not.toHaveProperty('language');
  });

  it('ensureFreshForThread: fresh media does NOT refetch', async () => {
    const { prisma } = makePrisma({
      media: { type: 'SHOW', reviewsSyncedAt: new Date(), externalIds: [{ value: '1' }] },
    });
    const tmdb = { enabled: true, getShowReviews: jest.fn() };
    const svc = new ExternalReviewsService(prisma, tmdb as any);

    await svc.ensureFreshForThread('SHOW' as any, 'm1');

    expect(tmdb.getShowReviews).not.toHaveBeenCalled();
  });

  it('ensureFreshForThread: episode keeps legacy cache and skips unsupported provider fetches', async () => {
    const { prisma } = makePrisma({
      episode: {
        reviewsSyncedAt: null,
        number: 13,
        season: { number: 1, show: { media: { externalIds: [{ value: '65942' }] } } },
      },
    });
    const tmdb = {
      enabled: true,
      getEpisodeReviews: jest.fn(),
    };
    const svc = new ExternalReviewsService(prisma, tmdb as any);

    await svc.ensureFreshForThread('EPISODE' as any, 'e1');

    expect(tmdb.getEpisodeReviews).not.toHaveBeenCalled();
    expect(prisma.episode.findUnique).not.toHaveBeenCalled();
    expect(prisma.episode.update).not.toHaveBeenCalled();
  });

  it('a 404 from TMDB syncs EMPTY (no retry storm on review-less entities)', async () => {
    const { prisma, tx } = makePrisma({
      media: { type: 'MOVIE', reviewsSyncedAt: null, externalIds: [{ value: '1' }] },
    });
    const { ProviderError } = await import('./providers/shared/provider-errors');
    const tmdb = {
      enabled: true,
      getMovieReviews: jest.fn(async () => {
        throw new ProviderError('not_found', 'tmdb 404', 404);
      }),
    };
    const svc = new ExternalReviewsService(prisma, tmdb as any);

    await svc.ensureFreshForThread('MOVIE' as any, 'm1');

    expect(tx.externalReview.deleteMany).toHaveBeenCalledWith({
      where: {
        mediaId: 'm1',
        externalId: { notIn: [] },
        comments: { none: {} },
        likes: { none: {} },
      },
    });
    expect(tx.externalReview.upsert).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalled(); // marked synced
  });

  it('a transient error leaves the target unsynced (retried on a later open)', async () => {
    const { prisma } = makePrisma({
      media: { type: 'MOVIE', reviewsSyncedAt: null, externalIds: [{ value: '1' }] },
    });
    const tmdb = {
      enabled: true,
      getMovieReviews: jest.fn(async () => {
        throw new Error('throttled internally: tmdb');
      }),
    };
    const svc = new ExternalReviewsService(prisma, tmdb as any);

    await svc.ensureFreshForThread('MOVIE' as any, 'm1');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
  });
});
