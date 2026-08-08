import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { MediaMetadataService } from './media-metadata.service';
import { runInLanguage } from '../common/language.context';

/**
 * Focused spec: show hydration persists episode-level external ids into
 * `episode_external_ids` (TMDB ids for the TMDB path, TVDB ids for the TVDB path) so
 * import matching can resolve episodes by external id.
 */

function makeShow(epIds: number[], external: { provider: ExternalProvider; value: string }) {
  return {
    type: MediaType.SHOW,
    tmdbId: 0,
    title: 'Show',
    overview: null,
    posterUrl: null,
    backdropUrl: null,
    status: 'ENDED',
    yearStart: 2002,
    yearEnd: 2007,
    network: null,
    runtimeMinutes: 23,
    rating: 8,
    popularity: 10,
    trailerUrl: null,
    seasonsCount: 1,
    episodesCount: epIds.length,
    inProduction: false,
    genres: [{ tmdbId: 0, name: 'Animation' }],
    externals: [external],
    cast: [],
    providers: [],
    nextAirDate: null,
    seasons: [
      {
        number: 1,
        title: 'Season 1',
        overview: null,
        posterUrl: null,
        episodeCount: epIds.length,
        isSpecial: false,
        episodes: epIds.map((id, i) => ({
          number: i + 1,
          title: `E${i + 1}`,
          overview: null,
          stillUrl: null,
          runtimeMinutes: 23,
          airDate: '2002-10-03',
          rating: 7,
          isFinale: false,
          tmdbId: id, // TMDB ep id for TMDB hydration; TVDB ep id for TVDB hydration
        })),
      },
    ],
  } as any;
}

function fakePrisma() {
  const episodeExternalUpserts: any[] = [];
  const tx: any = {
    mediaItem: {
      findUnique: async () => null,
      create: async () => ({ id: 'media-1' }),
      update: async () => ({}),
    },
    externalId: { upsert: async () => ({}) },
    show: { upsert: async () => ({}), findUnique: async () => ({ id: 'show-1' }) },
    genre: { findUnique: async () => null, upsert: async () => ({ id: 'g-1' }) },
    watchProvider: { upsert: async () => ({ id: 'p-1' }) },
    castMember: { upsert: async () => ({ id: 'c-1' }) },
    mediaGenre: { deleteMany: async () => ({}), createMany: async () => ({}) },
    mediaWatchProvider: { deleteMany: async () => ({}), createMany: async () => ({}) },
    mediaCast: {
      findMany: async () => [],
      deleteMany: async () => ({}),
      createMany: async () => ({}),
      create: async () => ({}),
    },
    season: {
      findMany: async () => [],
      findUnique: async () => null,
      upsert: async (a: any) => ({ id: `se-${a.where.showId_number.number}` }),
    },
    episode: {
      create: async (a: any) => ({ id: `ep-${a.data.number}` }),
      update: async (a: any) => ({ id: a.where.id }),
    },
    episodeExternalId: {
      upsert: async (a: any) => {
        episodeExternalUpserts.push(a);
        return {};
      },
    },
  };
  const prisma = {
    $transaction: async (fn: any) => fn(tx),
    mediaItem: { findUnique: async () => ({ metadataRefreshedAt: new Date() }) },
    externalId: { findFirst: async () => null }, // findMediaByExternal → no existing media
    show: { findUnique: async () => ({ id: 'show-1' }) }, // syncSeasons root lookup
  };
  return { prisma, tx, episodeExternalUpserts };
}

const fakeHydration = { enqueueClassifyCandidate: async () => undefined };
const fakeRedis = { get: async () => null, set: async () => undefined, del: async () => undefined };

describe('MediaMetadataService — episode external id persistence', () => {
  it('reactivates the exact parked TVDB episode during a structure remap', async () => {
    const { prisma, tx, episodeExternalUpserts } = fakePrisma();
    const season = makeShow([80001], {
      provider: ExternalProvider.THE_TVDB,
      value: '78857',
    }).seasons[0];
    tx.season.findUnique = jest.fn().mockResolvedValue({
      number: 1,
      titles: null,
      overviews: null,
      posterUrls: null,
      episodes: [],
    });
    tx.episodeExternalId.findUnique = jest.fn().mockResolvedValue({
      episode: {
        id: 'parked-tvdb-episode',
        number: 27,
        titles: null,
        overviews: null,
        stillUrls: null,
        structureState: 'LEGACY_UNMAPPED',
        externalIds: [{ id: 'tvdb-external-id' }],
        season: { showId: 'show-1' },
      },
    });
    tx.episode.create = jest.fn();
    tx.episode.update = jest.fn(async (args: any) => ({ id: args.where.id }));
    const svc = new MediaMetadataService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      fakeHydration as any,
      fakeRedis as any,
    );

    await (svc as any).syncOneSeason(
      tx,
      'show-1',
      season,
      undefined,
      'en',
      ExternalProvider.THE_TVDB,
      true,
    );

    expect(tx.episode.create).not.toHaveBeenCalled();
    expect(tx.episode.update).toHaveBeenCalledWith({
      where: { id: 'parked-tvdb-episode' },
      data: expect.objectContaining({
        seasonId: 'se-1',
        number: 1,
        structureState: 'ACTIVE',
      }),
    });
    expect(episodeExternalUpserts[0].create.episodeId).toBe('parked-tvdb-episode');
  });

  it('fails structure staging when its canonical episode id cannot be persisted', async () => {
    const { prisma, tx } = fakePrisma();
    const season = makeShow([80001], {
      provider: ExternalProvider.THE_TVDB,
      value: '78857',
    }).seasons[0];
    tx.episodeExternalId.findUnique = jest.fn().mockResolvedValue(null);
    tx.episodeExternalId.upsert = jest.fn().mockRejectedValue(new Error('identity collision'));
    const svc = new MediaMetadataService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      fakeHydration as any,
      fakeRedis as any,
    );

    await expect(
      (svc as any).syncOneSeason(
        tx,
        'show-1',
        season,
        undefined,
        'en',
        ExternalProvider.THE_TVDB,
        true,
      ),
    ).rejects.toThrow('identity collision');
  });

  it('TVDB hydration stores THE_TVDB episode ids', async () => {
    const { prisma, episodeExternalUpserts } = fakePrisma();
    const tvdb = {
      enabled: true,
      getShow: async () =>
        makeShow([80001, 80002], { provider: ExternalProvider.THE_TVDB, value: '78857' }),
    };
    const svc = new MediaMetadataService(
      prisma as any,
      {} as any,
      tvdb as any,
      {} as any,
      {} as any,
      fakeHydration as any,
      fakeRedis as any,
    );
    await runInLanguage('en', () => svc.ensureShowFullTvdb(78857));

    expect(episodeExternalUpserts).toHaveLength(2);
    expect(episodeExternalUpserts[0]).toEqual({
      where: {
        provider_providerEntityKind_value: {
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: 'EPISODE',
          value: '80001',
        },
      },
      create: {
        episodeId: 'ep-1',
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: 'EPISODE',
        value: '80001',
      },
      update: {},
    });
    expect(episodeExternalUpserts[1].create.value).toBe('80002');
  });

  it('TMDB hydration stores TMDB episode ids', async () => {
    const { prisma, episodeExternalUpserts } = fakePrisma();
    const tmdb = {
      enabled: true,
      getShow: async () => makeShow([90001], { provider: ExternalProvider.TMDB, value: '1399' }),
    };
    const svc = new MediaMetadataService(
      prisma as any,
      tmdb as any,
      {} as any,
      {} as any,
      {} as any,
      fakeHydration as any,
      fakeRedis as any,
    );
    await runInLanguage('en', () => svc.ensureShowFull(1399));

    expect(episodeExternalUpserts).toHaveLength(1);
    expect(episodeExternalUpserts[0].create).toEqual({
      episodeId: 'ep-1',
      provider: ExternalProvider.TMDB,
      providerEntityKind: 'EPISODE',
      value: '90001',
    });
  });
});
