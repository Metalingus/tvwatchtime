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
