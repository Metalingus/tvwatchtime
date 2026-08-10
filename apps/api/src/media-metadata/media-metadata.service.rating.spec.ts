import { MediaMetadataService } from './media-metadata.service';

function make(provenance: Record<string, unknown> = {}, rating: number | null = 7.1) {
  const update = jest.fn(async () => ({}));
  const findUnique = jest.fn(async () => ({
    rating,
    metadataProvenance: provenance,
    externalIds: [{ value: '123' }],
  }));
  const tmdb = {
    enabled: true,
    localizedShowBase: jest.fn(async () => ({ rating: 8.4 })),
    localizedMovieBase: jest.fn(async () => ({ rating: 7.9 })),
  };
  const service = new MediaMetadataService(
    { mediaItem: { findUnique, update } } as any,
    tmdb as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, tmdb, update };
}

describe('MediaMetadataService supplemental TMDB ratings', () => {
  it('refreshes legacy non-null values and stamps their provenance', async () => {
    const { service, tmdb, update } = make();

    await (service as any).refreshRatingFromTmdb('media-1', 'SHOW');

    expect(tmdb.localizedShowBase).toHaveBeenCalledWith(123, 'en-US');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'media-1' },
      data: {
        rating: 8.4,
        metadataProvenance: expect.objectContaining({
          ratingProvider: 'TMDB',
          ratingRefreshedAt: expect.any(String),
          ratingCheckedAt: expect.any(String),
        }),
      },
    });
  });

  it('does not re-fetch a supplement checked within the last day', async () => {
    const { service, tmdb, update } = make({
      ratingProvider: 'TMDB',
      ratingRefreshedAt: new Date().toISOString(),
    });

    await (service as any).refreshRatingFromTmdb('media-1', 'SHOW');

    expect(tmdb.localizedShowBase).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('MediaMetadataService TVDB-owner TMDB supplements', () => {
  const owner = {
    type: 'SHOW',
    metadataProvenance: {},
    show: { structureProvider: 'TVDB' },
    canonicalSource: null,
    externalIds: [{ value: '123' }],
  };

  function makeSupplementService(current = owner, initial = owner) {
    const mediaItemUpdate = jest.fn(async (_args: any) => ({}));
    const tx = {
      mediaItem: {
        findUnique: jest.fn(async () => current),
        update: mediaItemUpdate,
      },
      watchProvider: {
        upsert: jest.fn(async () => ({ id: 'provider-netflix' })),
      },
      mediaWatchProvider: {
        deleteMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 1 })),
      },
      $executeRaw: jest.fn(async () => 1),
    };
    const prisma = {
      mediaItem: { findUnique: jest.fn(async () => initial) },
      $transaction: jest.fn(async (fn: (transaction: any) => Promise<unknown>) => fn(tx)),
    };
    const tmdb = {
      enabled: true,
      getShowSupplements: jest.fn(async () => ({
        rating: 8.4,
        recommendations: [
          {
            tmdbId: 20,
            type: 'SHOW',
            title: 'Related',
            posterUrl: null,
            year: 2024,
            rating: 7.5,
          },
        ],
        providers: [{ name: 'Netflix', logoUrl: 'netflix.png' }],
        providersByCountry: {
          US: {
            stream: [{ id: 8, name: 'Netflix', logoUrl: 'netflix.png' }],
            rent: [],
            buy: [],
          },
        },
      })),
    };
    const service = new MediaMetadataService(
      prisma as any,
      tmdb as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, prisma, tmdb, tx, mediaItemUpdate };
  }

  it('updates only TMDB-owned supplemental fields for a TVDB-owned show', async () => {
    const { service, tmdb, tx, mediaItemUpdate } = makeSupplementService();

    await expect(service.refreshTmdbShowSupplements('media-1')).resolves.toEqual({
      refreshed: true,
      tmdbId: 123,
    });

    expect(tmdb.getShowSupplements).toHaveBeenCalledWith(123);
    expect(mediaItemUpdate).toHaveBeenCalledWith({
      where: { id: 'media-1' },
      data: {
        rating: 8.4,
        recommendations: expect.any(Array),
        recommendationsSyncedAt: expect.any(Date),
        watchProviders: expect.any(Object),
      },
    });
    const written = mediaItemUpdate.mock.calls[0][0].data;
    expect(written).not.toHaveProperty('title');
    expect(written).not.toHaveProperty('posterUrl');
    expect(written).not.toHaveProperty('cast');
    expect(written).not.toHaveProperty('seasons');
    expect(tx.mediaWatchProvider.createMany).toHaveBeenCalledWith({
      data: [{ mediaId: 'media-1', providerId: 'provider-netflix' }],
      skipDuplicates: true,
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('aborts the write when authority changes while TMDB is being fetched', async () => {
    const { service, tmdb, mediaItemUpdate } = makeSupplementService({
      ...owner,
      show: { structureProvider: 'TMDB' },
    });

    await expect(service.refreshTmdbShowSupplements('media-1')).resolves.toEqual({
      refreshed: false,
      reason: 'authority-changed',
      tmdbId: 123,
    });

    expect(tmdb.getShowSupplements).toHaveBeenCalledWith(123);
    expect(mediaItemUpdate).not.toHaveBeenCalled();
  });

  it('skips a fresh snapshot unless the caller explicitly forces a refresh', async () => {
    const fresh = {
      ...owner,
      metadataProvenance: { tmdbSupplementRefreshedAt: new Date().toISOString() },
    };
    const { service, tmdb } = makeSupplementService(fresh, fresh);

    await expect(service.refreshTmdbShowSupplements('media-1')).resolves.toEqual({
      refreshed: false,
      reason: 'fresh',
      tmdbId: 123,
    });
    expect(tmdb.getShowSupplements).not.toHaveBeenCalled();

    await expect(service.refreshTmdbShowSupplements('media-1', { force: true })).resolves.toEqual({
      refreshed: true,
      tmdbId: 123,
    });
    expect(tmdb.getShowSupplements).toHaveBeenCalledWith(123);
  });

  it('queues one supplement job keyed by the completed TVDB metadata version', async () => {
    const refreshedAt = new Date('2026-08-10T10:00:00.000Z');
    const enqueueTmdbShowSupplement = jest.fn(async () => ({}));
    const prisma = {
      mediaItem: {
        findUnique: jest.fn(async () => ({
          type: 'SHOW',
          metadataRefreshedAt: refreshedAt,
          show: { structureProvider: 'TVDB' },
          externalIds: [{ value: '123' }],
        })),
      },
    };
    const service = new MediaMetadataService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { enqueueTmdbShowSupplement } as any,
      {} as any,
    );

    await (service as any).scheduleTmdbShowSupplements('media-1');

    expect(enqueueTmdbShowSupplement).toHaveBeenCalledWith(
      'media-1',
      String(refreshedAt.getTime()),
    );
  });
});
