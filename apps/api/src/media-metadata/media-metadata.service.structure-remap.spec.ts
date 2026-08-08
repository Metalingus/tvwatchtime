import { StructureProvider, StructureReason } from '@prisma/client';
import { ExternalProvider } from '@tvwatch/shared';
import { MediaMetadataService } from './media-metadata.service';

describe('MediaMetadataService canonical provider switches', () => {
  it('routes a discovered TMDB-to-TVDB owner change through the locked remap workflow', async () => {
    const prisma: any = {
      externalId: {
        findFirst: jest.fn().mockResolvedValue({
          media: { id: 'media-1', metadataRefreshedAt: new Date() },
        }),
        findUnique: jest.fn().mockResolvedValue({ mediaId: 'media-1' }),
        create: jest.fn(),
      },
      mediaItem: { findUnique: jest.fn().mockResolvedValue({ metadataRefreshedAt: new Date() }) },
      show: { update: jest.fn() },
    };
    const decision = {
      provider: StructureProvider.TVDB,
      reason: StructureReason.ANIME_TVDB,
      ruleVersion: 1,
      decidedAt: new Date(),
      tmdbId: 10,
      tvdbId: 20,
      imdbId: 'tt10',
    };
    const authority = {
      forTmdb: jest.fn().mockResolvedValue(decision),
      persisted: jest.fn().mockResolvedValue({
        provider: StructureProvider.TMDB,
        reason: StructureReason.GENERAL_TMDB,
        ruleVersion: 1,
        decidedAt: new Date(0),
      }),
    };
    const remap = {
      remapShow: jest.fn().mockResolvedValue({ stale: 1 }),
    };
    const hydration = { enqueueClassifyCandidate: jest.fn().mockResolvedValue(undefined) };
    const service = new MediaMetadataService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      hydration as any,
      {} as any,
      undefined,
      undefined,
      authority as any,
      remap as any,
    );
    const tvdbHydration = jest.spyOn(service, 'ensureShowFullTvdb').mockResolvedValue('media-1');

    await expect(service.ensureShowFull(10)).resolves.toBe('media-1');

    expect(tvdbHydration).toHaveBeenCalledWith(
      20,
      undefined,
      expect.objectContaining({
        decision,
        writeScope: 'STRUCTURE_REMAP',
        forceRefresh: true,
        lockHeld: true,
      }),
    );
    expect(remap.remapShow).toHaveBeenCalledWith('media-1', {
      canonical: 'tvdb',
      reason: StructureReason.ANIME_TVDB,
      foreignSeasons: undefined,
      preserveUnmappedSpecials: false,
    });
    expect(hydration.enqueueClassifyCandidate).toHaveBeenCalled();
  });

  it('blocks before staging a new provider graph when preview finds unmapped user data', async () => {
    const prisma: any = {
      show: { update: jest.fn() },
      mediaItem: { findUnique: jest.fn(), update: jest.fn() },
    };
    const current = {
      provider: StructureProvider.TMDB,
      reason: StructureReason.GENERAL_TMDB,
      ruleVersion: 1,
      decidedAt: new Date(0),
    };
    const snapshot = {
      tmdbId: 20,
      title: 'Show',
      overview: null,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      popularity: 0,
      status: null,
      trailerUrl: null,
      yearStart: 2020,
      yearEnd: null,
      network: null,
      runtimeMinutes: null,
      nextAirDate: null,
      seasonsCount: 0,
      episodesCount: 0,
      inProduction: false,
      genres: [],
      providers: [],
      cast: [],
      seasons: [
        {
          number: 1,
          isSpecial: false,
          episodes: [{ tmdbId: 201, number: 1 }],
        },
      ],
      externals: [],
    } as any;
    const decision = {
      provider: StructureProvider.TVDB,
      reason: StructureReason.GENERAL_TVDB,
      ruleVersion: 2,
      decidedAt: new Date(),
      tmdbId: 10,
      tvdbId: 20,
      tvdbSnapshot: snapshot,
      comparison: {
        equivalent: false,
        comparedAt: new Date(),
        tmdbEpisodeCount: 1,
        tvdbEpisodeCount: 1,
        tmdbOnlyCount: 1,
        tvdbOnlyCount: 1,
        tmdbOnlyCoordinates: ['S1E2'],
        tvdbOnlyCoordinates: ['S1E1'],
      },
    };
    const authority = {
      tmdbIdFor: jest.fn().mockResolvedValue(10),
      persisted: jest.fn().mockResolvedValue(current),
      forTmdb: jest.fn().mockResolvedValue(decision),
    };
    const preview = {
      stale: 1,
      mapped: 0,
      unmapped: 1,
      transferFailed: 0,
      statusesMoved: 0,
      historiesMoved: 0,
      ratingsMoved: 0,
      reactionsMoved: 0,
      votesMoved: 0,
      commentsMoved: 0,
      externalReviewsMoved: 0,
      legacyQuarantined: 1,
      specialsPreserved: 0,
      episodesRemoved: 0,
      seasonsRemoved: 0,
      matchRules: {},
      dryRun: true,
      blocked: false,
    };
    const remap = {
      previewShowAgainstSnapshot: jest.fn().mockResolvedValue(preview),
      remapShow: jest.fn(),
    };
    const service = new MediaMetadataService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      authority as any,
      remap as any,
    );
    const persist = jest.spyOn(service as any, 'persistShow');

    await expect(service.evaluateShowStructureAuthority('media-1')).resolves.toMatchObject({
      evaluated: true,
      changed: true,
      blocked: true,
      preview,
    });
    expect(remap.previewShowAgainstSnapshot).toHaveBeenCalledWith(
      'media-1',
      'tvdb',
      snapshot.seasons,
      { foreignSeasons: undefined, preserveUnmappedSpecials: true },
    );
    expect(persist).not.toHaveBeenCalled();
    expect(remap.remapShow).not.toHaveBeenCalled();
    expect(prisma.show.update).not.toHaveBeenCalled();
  });

  it('defers reevaluation without stamping equivalence when a provider comparison fails', async () => {
    const prisma: any = {
      show: { update: jest.fn() },
      mediaItem: { findUnique: jest.fn(), update: jest.fn() },
    };
    const current = {
      provider: StructureProvider.TMDB,
      reason: StructureReason.GENERAL_TMDB,
      ruleVersion: 2,
      decidedAt: new Date(0),
    };
    const decision = {
      ...current,
      tmdbId: 10,
      tvdbId: 20,
      profile: { tmdbId: 10, tvdbId: 20 },
    };
    const authority = {
      tmdbIdFor: jest.fn().mockResolvedValue(10),
      persisted: jest.fn().mockResolvedValue(current),
      forTmdb: jest.fn().mockResolvedValue(decision),
    };
    const remap = {
      previewShowAgainstSnapshot: jest.fn(),
      remapShow: jest.fn(),
    };
    const service = new MediaMetadataService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      authority as any,
      remap as any,
    );

    await expect(service.evaluateShowStructureAuthority('media-1')).resolves.toMatchObject({
      evaluated: true,
      changed: false,
      blocked: false,
      deferred: true,
    });
    expect(remap.previewShowAgainstSnapshot).not.toHaveBeenCalled();
    expect(remap.remapShow).not.toHaveBeenCalled();
    expect(prisma.show.update).not.toHaveBeenCalled();
  });

  it('does not enter remap when complete official structures are equivalent', async () => {
    const prisma: any = {
      episode: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'tmdb-episode-1', number: 1, season: { number: 1 } }]),
      },
      episodeExternalId: {
        upsert: jest.fn().mockResolvedValue({ episodeId: 'tmdb-episode-1' }),
      },
      externalId: { findUnique: jest.fn().mockResolvedValue({ mediaId: 'media-1' }) },
      show: { update: jest.fn() },
      mediaItem: { findUnique: jest.fn(), update: jest.fn() },
    };
    const current = {
      provider: StructureProvider.TMDB,
      reason: StructureReason.GENERAL_TMDB,
      ruleVersion: 2,
      decidedAt: new Date(0),
    };
    const tmdbSnapshot = {
      seasons: [
        {
          number: 1,
          isSpecial: false,
          episodes: [{ tmdbId: 101, number: 1 }],
        },
      ],
    } as any;
    const decision = {
      ...current,
      tmdbId: 10,
      tvdbId: 20,
      tmdbSnapshot,
      tvdbSnapshot: {
        seasons: [
          {
            number: 1,
            isSpecial: false,
            episodes: [{ tmdbId: 201, number: 1 }],
          },
        ],
      },
      comparison: {
        equivalent: true,
        comparedAt: new Date(),
        tmdbEpisodeCount: 1,
        tvdbEpisodeCount: 1,
        tmdbOnlyCount: 0,
        tvdbOnlyCount: 0,
        tmdbOnlyCoordinates: [],
        tvdbOnlyCoordinates: [],
      },
    };
    const authority = {
      tmdbIdFor: jest.fn().mockResolvedValue(10),
      persisted: jest.fn().mockResolvedValue(current),
      forTmdb: jest.fn().mockResolvedValue(decision),
    };
    const remap = {
      previewShowAgainstSnapshot: jest.fn(),
      remapShow: jest.fn(),
    };
    const service = new MediaMetadataService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      authority as any,
      remap as any,
    );
    const persist = jest.spyOn(service as any, 'persistShow').mockResolvedValue('media-1');
    jest
      .spyOn(service as any, 'withMediaWriteLock')
      .mockImplementation((...args: unknown[]) => (args[1] as () => unknown)());

    await expect(service.evaluateShowStructureAuthority('media-1')).resolves.toMatchObject({
      evaluated: true,
      blocked: false,
      decision,
    });
    expect(persist).toHaveBeenCalledWith(
      tmdbSnapshot,
      'media-1',
      'en',
      undefined,
      ExternalProvider.TMDB,
      'STRUCTURE_REMAP',
      decision,
      true,
    );
    expect(prisma.episodeExternalId.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ episodeId: 'tmdb-episode-1', value: '201' }),
      }),
    );
    expect(remap.previewShowAgainstSnapshot).not.toHaveBeenCalled();
    expect(remap.remapShow).not.toHaveBeenCalled();
  });

  it('atomically releases collapsed canonical aliases before staging separate TVDB rows', async () => {
    const tx: any = {
      episodeExternalId: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'alias-11', episodeId: 'collapsed-row' },
          { id: 'alias-12', episodeId: 'collapsed-row' },
          { id: 'alias-13', episodeId: 'single-row' },
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      season: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'canonical-season' }),
      },
      episode: {
        create: jest.fn(({ data }: any) => ({ id: `created-${data.number}` })),
        update: jest.fn(),
      },
    };
    const prisma: any = {
      show: { findUnique: jest.fn().mockResolvedValue({ id: 'show-1' }) },
      mediaItem: { update: jest.fn() },
      $transaction: jest.fn((callback: (transaction: any) => unknown) => callback(tx)),
    };
    const service = new MediaMetadataService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const seasons = [
      {
        tmdbId: 1,
        number: 1,
        title: 'Season 1',
        episodeCount: 3,
        isSpecial: false,
        episodes: [
          { tmdbId: 1408781, number: 11, title: 'Red, Bath and Beyond', isFinale: false },
          {
            tmdbId: 1408771,
            number: 12,
            title: 'Magic Snow and Creepy Gene',
            isFinale: false,
          },
          { tmdbId: 1411321, number: 13, title: 'Pampered and Tampered', isFinale: true },
        ],
      },
    ] as any;

    await (service as any).syncSeasons(
      'media-1',
      seasons,
      'en',
      undefined,
      ExternalProvider.THE_TVDB,
      true,
    );

    expect(tx.episodeExternalId.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['alias-11', 'alias-12'] } },
    });
    expect(tx.episodeExternalId.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ episodeId: 'created-11', value: '1408781' }),
      }),
    );
    expect(tx.episodeExternalId.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ episodeId: 'created-12', value: '1408771' }),
      }),
    );
  });
});
