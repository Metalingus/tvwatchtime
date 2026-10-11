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

describe('CharacterArtworkService stale role artwork', () => {
  const DAY = 86_400_000;
  const tvdbIds = [
    {
      provider: ExternalProvider.THE_TVDB,
      providerEntityKind: ProviderEntityKind.SERIES,
      value: '376098',
    },
  ];
  let order = 0;
  const credit = (id: string, roleId: number | null, image: string | null) => ({
    id,
    sortOrder: order++,
    character: id,
    characterImageUrl: image,
    characterExternalId: roleId,
    castMember: { externalId: `TMDB_${id}`, tmdbId: null, tvdbId: null, name: id },
  });
  const illustrated = {
    id: 'lanterns',
    type: MediaType.SHOW,
    metadataProvenance: null as unknown,
    cast: [credit('hal', 1, 'https://art/hal-old.jpg')],
    externalIds: tvdbIds,
  };
  const stamped = (checkedAt: number, extra: Record<string, unknown> = {}) => ({
    ...illustrated,
    metadataProvenance: {
      characterArtwork: {
        version: 1,
        fingerprint: 'older-cast',
        status: 'parked',
        checkedAt: new Date(checkedAt).toISOString(),
        retryAfter: new Date(Date.now() + 60 * DAY).toISOString(),
        ...extra,
      },
    },
  });

  function scheduler() {
    const queue = { enqueueCharacterArtwork: jest.fn().mockResolvedValue(undefined) };
    const service = new CharacterArtworkService(
      { $executeRaw: jest.fn().mockResolvedValue(1) } as any,
      queue as any,
      { enabled: true } as any,
      { enabled: true } as any,
    );
    return { service, queue };
  }

  it('leaves fully illustrated casts alone inside the refresh window', async () => {
    const { service, queue } = scheduler();
    await expect(service.scheduleIfNeeded(stamped(Date.now() - 5 * DAY))).resolves.toEqual({
      pending: false,
    });
    await expect(
      service.scheduleIfNeeded(stamped(Date.now() - 5 * DAY, { status: 'complete' })),
    ).resolves.toEqual({ pending: false });
    expect(queue.enqueueCharacterArtwork).not.toHaveBeenCalled();
  });

  it('re-checks saved role artwork after the refresh window, even when parked', async () => {
    const { service, queue } = scheduler();
    await expect(service.scheduleIfNeeded(stamped(Date.now() - 31 * DAY))).resolves.toMatchObject(
      { pending: true },
    );
    await expect(service.scheduleIfNeeded(illustrated)).resolves.toMatchObject({ pending: true });
    expect(queue.enqueueCharacterArtwork).toHaveBeenCalledTimes(2);
  });

  it('replaces rotated role artwork and keeps images it cannot re-prove', async () => {
    const cast = [
      credit('hal', 1, 'https://art/hal-old.jpg'),
      credit('sinestro', 2, 'https://art/sinestro.jpg'),
      credit('zoe', null, 'https://art/zoe.jpg'),
      credit('kerry', 3, null),
    ];
    const tx = {
      mediaCast: { update: jest.fn().mockResolvedValue(undefined) },
      mediaCastExternalId: { upsert: jest.fn().mockResolvedValue(undefined) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue({
          ...illustrated,
          title: 'Lanterns',
          cast,
          canonicalSource: null,
          movie: null,
        }),
      },
    };
    const queue = { enqueueCharacterArtwork: jest.fn().mockResolvedValue(undefined) };
    const tvdb = {
      enabled: true,
      getShow: jest.fn().mockResolvedValue({
        tmdbId: 0,
        cast: [
          { characterExternalId: 1, characterImageUrl: 'https://art/hal-new.jpg' },
          { characterExternalId: 2, characterImageUrl: 'https://art/sinestro.jpg' },
          { characterExternalId: 3, characterImageUrl: 'https://art/kerry.jpg' },
        ],
      }),
    };
    const service = new CharacterArtworkService(
      prisma as any,
      queue as any,
      { enabled: true } as any,
      tvdb as any,
    );
    await service.scheduleIfNeeded({ ...illustrated, cast });
    const fingerprint = queue.enqueueCharacterArtwork.mock.calls[0][1];

    await expect(service.enrich('lanterns', fingerprint)).resolves.toEqual({
      updated: 2,
      status: 'complete',
      reason: undefined,
    });
    const writes = tx.mediaCast.update.mock.calls.map(([args]) => [
      args.where.id,
      args.data.characterImageUrl,
    ]);
    // Rotated file replaced, missing one filled; unchanged and unprovable images untouched.
    expect(writes).toEqual([
      ['hal', 'https://art/hal-new.jpg'],
      ['kerry', 'https://art/kerry.jpg'],
    ]);
  });
});

describe('CharacterArtworkService movie identity', () => {
  it('uses the IMDb remote-id bridge for a movie before requesting TVDB character artwork', async () => {
    const media: any = {
      id: 'movie',
      type: 'MOVIE',
      title: 'The Odyssey',
      canonicalSource: null,
      metadataProvenance: null,
      movie: { releaseDate: null },
      externalIds: [{ provider: 'TMDB', providerEntityKind: 'MOVIE', value: '1368337' }],
      cast: [
        {
          id: 'credit',
          character: 'Odysseus',
          characterImageUrl: null,
          characterExternalId: null,
          castMember: { externalId: 'TMDB_1', tmdbId: 1, tvdbId: null, name: 'Actor' },
        },
      ],
    };
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mediaItem: { findUnique: jest.fn().mockResolvedValue(media) },
    };
    const queue = { enqueueCharacterArtwork: jest.fn().mockResolvedValue(undefined) };
    const tmdb = {
      enabled: true,
      getImdbIdForMovieStrict: jest.fn().mockResolvedValue('tt33764258'),
    };
    const tvdb = {
      enabled: true,
      findMovieByImdb: jest
        .fn()
        .mockResolvedValue({ tvdbId: 362547, tmdbId: 1368337, imdbId: 'tt33764258' }),
      getMovie: jest.fn().mockResolvedValue({ cast: [] }),
      searchMovies: jest.fn(),
    };
    const service = new CharacterArtworkService(
      prisma as any,
      queue as any,
      tmdb as any,
      tvdb as any,
    );
    await service.scheduleIfNeeded(media);
    const fingerprint = queue.enqueueCharacterArtwork.mock.calls[0][1];
    await service.enrich('movie', fingerprint);
    expect(tvdb.findMovieByImdb).toHaveBeenCalledWith('tt33764258', 1368337);
    expect(tvdb.getMovie).toHaveBeenCalledWith(362547, 'en');
    expect(tvdb.searchMovies).not.toHaveBeenCalled();
  });
});
