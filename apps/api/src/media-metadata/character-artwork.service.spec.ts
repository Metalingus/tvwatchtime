import { ExternalProvider, MediaType, ProviderEntityKind } from '@prisma/client';
import { CharacterArtworkService } from './character-artwork.service';

describe('CharacterArtworkService scheduling', () => {
  const cast = [
    {
      id: 'credit-1',
      character: 'Eleven',
      characterImageUrl: null,
      characterExternalId: null,
      castMember: {
        externalId: 'TMDB_1356210',
        tmdbId: 1356210,
        tvdbId: null,
        name: 'Millie Bobby Brown',
      },
    },
  ];

  const media = {
    id: 'media-1',
    type: MediaType.SHOW,
    metadataProvenance: null,
    cast,
    externalIds: [
      {
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: '66732',
      },
    ],
  };

  function setup() {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const queue = { enqueueCharacterArtwork: jest.fn().mockResolvedValue(undefined) };
    const service = new CharacterArtworkService(
      prisma as any,
      queue as any,
      { enabled: true } as any,
      { enabled: true } as any,
    );
    return { service, prisma, queue };
  }

  it('serves immediately, schedules one worker, and honors a matching parked fingerprint', async () => {
    const { service, queue } = setup();

    await expect(service.scheduleIfNeeded(media)).resolves.toMatchObject({ pending: true });
    const fingerprint = queue.enqueueCharacterArtwork.mock.calls[0][1];
    const parked = {
      ...media,
      metadataProvenance: {
        characterArtwork: {
          version: 1,
          fingerprint,
          status: 'parked',
          checkedAt: new Date().toISOString(),
          retryAfter: new Date(Date.now() + 86_400_000).toISOString(),
        },
      },
    };

    await expect(service.scheduleIfNeeded(parked)).resolves.toEqual({ pending: false });
    expect(queue.enqueueCharacterArtwork).toHaveBeenCalledTimes(1);
  });

  it('re-arms a parked title when its cast evidence changes', async () => {
    const { service, queue } = setup();
    await service.scheduleIfNeeded(media);
    const oldFingerprint = queue.enqueueCharacterArtwork.mock.calls[0][1];

    await expect(
      service.scheduleIfNeeded({
        ...media,
        cast: [{ ...cast[0], character: 'Jane / Eleven' }],
        metadataProvenance: {
          characterArtwork: {
            version: 1,
            fingerprint: oldFingerprint,
            status: 'parked',
            retryAfter: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
      }),
    ).resolves.toMatchObject({ pending: true });
    expect(queue.enqueueCharacterArtwork).toHaveBeenCalledTimes(2);
  });

  it('fails open when background work cannot be queued', async () => {
    const prisma = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const queue = {
      enqueueCharacterArtwork: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const service = new CharacterArtworkService(
      prisma as any,
      queue as any,
      { enabled: true } as any,
      { enabled: true } as any,
    );

    await expect(service.scheduleIfNeeded(media)).resolves.toEqual({ pending: false });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('parks a title when TVDB genuinely has no character-role artwork', async () => {
    const identifiedMedia = {
      ...media,
      externalIds: [
        ...media.externalIds,
        {
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: ProviderEntityKind.SERIES,
          value: '305288',
        },
      ],
    };
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({
          ...identifiedMedia,
          title: 'Stranger Things',
          canonicalSource: null,
          movie: null,
        }),
      },
    };
    const queue = { enqueueCharacterArtwork: jest.fn().mockResolvedValue(undefined) };
    const tvdb = {
      enabled: true,
      getShow: jest.fn().mockResolvedValue({ cast: [] }),
    };
    const service = new CharacterArtworkService(
      prisma as any,
      queue as any,
      { enabled: true } as any,
      tvdb as any,
    );
    await service.scheduleIfNeeded(identifiedMedia);
    const fingerprint = queue.enqueueCharacterArtwork.mock.calls[0][1];

    await expect(service.enrich(media.id, fingerprint)).resolves.toEqual({
      updated: 0,
      status: 'parked',
      reason: 'provider-has-no-character-images',
    });
    expect(tvdb.getShow).toHaveBeenCalledWith(305288, 'en', { includeStructure: false });
  });
});
