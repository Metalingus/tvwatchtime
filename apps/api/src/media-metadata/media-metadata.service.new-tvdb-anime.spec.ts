import { MediaMetadataService } from './media-metadata.service';

function makeService(genres: { tmdbId: number; name: string }[]) {
  const mediaItemUpdate = jest.fn(async () => ({}));
  const showUpdate = jest.fn(async () => ({}));
  const prisma = {
    mediaItem: {
      findUnique: jest.fn(async () => ({
        id: 'new-show',
        type: 'SHOW',
        metadataRefreshedAt: null,
        manualClassification: false,
        show: {
          episodesCount: 0,
          structureProvider: null,
          structureReason: null,
        },
        externalIds: [{ id: 'tvdb-alias' }],
      })),
      update: mediaItemUpdate,
    },
    show: { update: showUpdate },
  };
  const tvdb = {
    getShow: jest.fn(async () => ({ genres })),
  };
  const service = new MediaMetadataService(
    prisma as any,
    {} as any,
    tvdb as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  const ensureShowFullTvdb = jest
    .spyOn(service, 'ensureShowFullTvdb')
    .mockResolvedValue('new-show');
  return { service, tvdb, mediaItemUpdate, showUpdate, ensureShowFullTvdb };
}

describe('MediaMetadataService — new TVDB show anime routing', () => {
  it('routes and fully hydrates a newly created show when TVDB says Anime', async () => {
    const { service, mediaItemUpdate, showUpdate, ensureShowFullTvdb } = makeService([
      { tmdbId: 27, name: 'Anime' },
    ]);

    await expect(service.hydrateNewTvdbShowAsAnime('new-show', 123)).resolves.toBe(true);

    expect(showUpdate).toHaveBeenCalledWith({
      where: { mediaId: 'new-show' },
      data: expect.objectContaining({
        structureProvider: 'TVDB',
        structureReason: 'ANIME_TVDB',
      }),
    });
    expect(ensureShowFullTvdb).toHaveBeenCalledWith(
      123,
      undefined,
      expect.objectContaining({ forceRefresh: true, skipClassification: true }),
    );
    expect(mediaItemUpdate).toHaveBeenCalledWith({
      where: { id: 'new-show' },
      data: expect.objectContaining({
        contentClassification: 'ANIME',
        classificationTier: 'confirmed',
      }),
    });
  });

  it('does not route a newly created TVDB show whose genres are not Anime', async () => {
    const { service, mediaItemUpdate, showUpdate, ensureShowFullTvdb } = makeService([
      { tmdbId: 3, name: 'Drama' },
    ]);

    await expect(service.hydrateNewTvdbShowAsAnime('new-show', 123)).resolves.toBe(false);

    expect(showUpdate).not.toHaveBeenCalled();
    expect(mediaItemUpdate).not.toHaveBeenCalled();
    expect(ensureShowFullTvdb).not.toHaveBeenCalled();
  });
});
