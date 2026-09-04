import { StructureProvider } from '@prisma/client';
import { ExternalProvider, MediaType, ProviderEntityKind } from '@tvwatch/shared';
import { ArtworkGalleryService } from './artwork-gallery.service';

const image = (
  provider: ExternalProvider,
  providerEntityId: string,
  id = `${provider}-${providerEntityId}`,
) => ({
  id,
  kind: 'BACKDROP',
  provider,
  providerEntityKind: ProviderEntityKind.SERIES,
  providerEntityId,
  providerImageId: `/${id}.jpg`,
  sourceKey: id,
  url: `https://example.test/${id}.jpg`,
  previewUrl: null,
  width: 1920,
  height: 1080,
  sortOrder: 0,
});

describe('ArtworkGalleryService', () => {
  function setup(media: any) {
    const tx = {
      image: { deleteMany: jest.fn(), upsert: jest.fn() },
      episodeImage: { deleteMany: jest.fn(), upsert: jest.fn() },
      $executeRaw: jest.fn(),
    };
    const prisma = {
      mediaItem: { findUnique: jest.fn().mockResolvedValue(media) },
      episode: { findUnique: jest.fn() },
      image: { findFirst: jest.fn(), findUnique: jest.fn() },
      episodeImage: { findFirst: jest.fn(), findUnique: jest.fn() },
      $executeRaw: jest.fn(),
      $transaction: jest.fn(async (run: any) => run(tx)),
    };
    const queue = { enqueueArtworkGallery: jest.fn().mockResolvedValue(undefined) };
    const tmdb = {
      enabled: true,
      getShowArtwork: jest.fn().mockResolvedValue([]),
      getMovieArtwork: jest.fn().mockResolvedValue([]),
      getEpisodeArtwork: jest.fn().mockResolvedValue([]),
    };
    const tvdb = {
      enabled: true,
      getShowArtwork: jest.fn().mockResolvedValue([]),
      getMovieArtwork: jest.fn().mockResolvedValue([]),
      getEpisodeArtwork: jest.fn().mockResolvedValue([]),
    };
    return {
      service: new ArtworkGalleryService(prisma as any, queue as any, tmdb as any, tvdb as any),
      prisma,
      queue,
      tmdb,
      tvdb,
      tx,
    };
  }

  const tvdbShow = () => ({
    id: 'show-1',
    type: MediaType.SHOW,
    posterUrl: null,
    backdropUrl: null,
    metadataRefreshedAt: new Date(1_000),
    metadataProvenance: null,
    galleryState: null,
    show: { structureProvider: StructureProvider.TVDB },
    canonicalSource: null,
    externalIds: [
      {
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: '10',
      },
      {
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: '20',
      },
    ],
    images: [
      image(ExternalProvider.TMDB, '10', 'tmdb'),
      image(ExternalProvider.THE_TVDB, '20', 'tvdb'),
    ],
  });

  it('returns and queues only the persisted show authority provider', async () => {
    const { service, queue } = setup(tvdbShow());

    const result = await service.getMediaGallery('show-1');

    expect(result.pending).toBe(true);
    expect(result.gallery.map((item) => item.id)).toEqual(['tvdb']);
    expect(queue.enqueueArtworkGallery).toHaveBeenCalledWith(
      'MEDIA',
      'show-1',
      expect.stringContaining('THE_TVDB|SERIES|20'),
    );
  });

  it('never calls the non-authority provider during gallery hydration', async () => {
    const { service, queue, tmdb, tvdb, tx } = setup(tvdbShow());
    await service.getMediaGallery('show-1');
    const fingerprint = queue.enqueueArtworkGallery.mock.calls[0][2];
    tvdb.getShowArtwork.mockResolvedValue([
      {
        kind: 'BACKDROP',
        providerImageId: 'background.jpg',
        url: 'https://artworks.thetvdb.com/banners/background.jpg',
      },
    ]);

    await service.hydrateMedia('show-1', fingerprint);

    expect(tvdb.getShowArtwork).toHaveBeenCalledWith(20);
    expect(tmdb.getShowArtwork).not.toHaveBeenCalled();
    expect(tx.image.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ mediaId_sourceKey: expect.any(Object) }),
      }),
    );
  });

  it('resolves a stale mobile image id through the stable owner/source key', async () => {
    const media = tvdbShow();
    const { service, prisma } = setup(media);
    const current = { ...image(ExternalProvider.THE_TVDB, '20', 'current'), media };
    prisma.image.findFirst.mockResolvedValue(null);
    prisma.image.findUnique.mockResolvedValue(current);

    await expect(
      service.resolveCoverSource('MEDIA', media.id, 'stale-id', current.sourceKey),
    ).resolves.toEqual({ url: current.url, provider: ExternalProvider.THE_TVDB });
    expect(prisma.image.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mediaId_sourceKey: { mediaId: media.id, sourceKey: current.sourceKey } },
      }),
    );
  });

  it('uses TMDB for a TMDB-owned show even when a TVDB alias exists', async () => {
    const media = { ...tvdbShow(), show: { structureProvider: StructureProvider.TMDB } };
    const { service, queue, tmdb, tvdb } = setup(media);
    await service.getMediaGallery('show-1');
    const fingerprint = queue.enqueueArtworkGallery.mock.calls[0][2];

    await service.hydrateMedia('show-1', fingerprint);

    expect(tmdb.getShowArtwork).toHaveBeenCalledWith(10);
    expect(tvdb.getShowArtwork).not.toHaveBeenCalled();
  });

  it('inherits TVDB episode authority and never asks TMDB for extra stills', async () => {
    const media = tvdbShow();
    const episode = {
      id: 'episode-1',
      number: 2,
      stillUrl: 'https://artworks.thetvdb.com/banners/episode.jpg',
      structureState: 'ACTIVE',
      updatedAt: new Date(2_000),
      galleryState: null,
      images: [],
      externalIds: [
        {
          provider: ExternalProvider.TMDB,
          providerEntityKind: ProviderEntityKind.EPISODE,
          value: '100',
        },
        {
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: ProviderEntityKind.EPISODE,
          value: '200',
        },
      ],
      season: { number: 1, show: { ...media.show, media } },
    };
    const { service, prisma, queue, tmdb, tvdb } = setup(media);
    prisma.episode.findUnique.mockResolvedValue(episode);
    await service.getEpisodeGallery('episode-1');
    const fingerprint = queue.enqueueArtworkGallery.mock.calls[0][2];

    await service.hydrateEpisode('episode-1', fingerprint);

    expect(tvdb.getEpisodeArtwork).toHaveBeenCalledWith(200);
    expect(tmdb.getEpisodeArtwork).not.toHaveBeenCalled();
  });

  it('caps media galleries at 30 backdrops plus 20 posters', () => {
    const { service } = setup(tvdbShow());
    const artworks = [
      ...Array.from({ length: 60 }, (_, index) => ({
        kind: 'BACKDROP' as const,
        providerImageId: `b${index}`,
        url: `https://image.tmdb.org/t/p/original/b${index}.jpg`,
        providerRank: 30 - index,
      })),
      ...Array.from({ length: 60 }, (_, index) => ({
        kind: 'POSTER' as const,
        providerImageId: `p${index}`,
        url: `https://image.tmdb.org/t/p/original/p${index}.jpg`,
        providerRank: 30 - index,
      })),
    ];

    const selected = (service as any).selectMediaArtwork(artworks, null, null);

    expect(selected).toHaveLength(50);
    expect(selected.filter((item: any) => item.kind === 'BACKDROP')).toHaveLength(30);
    expect(selected.filter((item: any) => item.kind === 'POSTER')).toHaveLength(20);
  });
});
