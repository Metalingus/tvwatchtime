import { tvdbBroadcastSchedule } from './util/tvdb-airtime';
import { EpisodeStructureState, StructureProvider, StructureReason } from '@prisma/client';
import { ExternalProvider, MediaType, ProviderEntityKind } from '@tvwatch/shared';
import { runInLanguage } from '../common/language.context';
import { MediaMetadataService } from './media-metadata.service';

const fakeRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
};

function serviceWith(prisma: any, tmdb: any, tvdb: any, hydration: any) {
  prisma.$transaction ??= jest.fn(async (work) => work(prisma));
  prisma.$queryRaw ??= jest.fn(async () => []);
  if (prisma.episode?.findMany) {
    prisma.episode.findUnique ??= jest.fn(async () => (await prisma.episode.findMany())[0]);
  }
  return new MediaMetadataService(
    prisma,
    tmdb,
    tvdb,
    {} as any,
    {} as any,
    hydration,
    fakeRedis as any,
  );
}

describe('MediaMetadataService recent incomplete episode refresh', () => {
  it('uses an exact TVDB episode alias even when a legacy row is stamped TMDB-owned', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      episode: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'episode-30',
            number: 30,
            title: 'Episode 30',
            overview: null,
            stillUrl: null,
            runtimeMinutes: null,
            titles: {},
            overviews: {},
            stillUrls: {},
            externalIds: [{ provider: ExternalProvider.THE_TVDB, value: '11881358' }],
            season: {
              number: 2026,
              show: {
                structureProvider: StructureProvider.TMDB,
                media: {
                  externalIds: [
                    { provider: ExternalProvider.TMDB, value: '13819' },
                    { provider: ExternalProvider.THE_TVDB, value: '153241' },
                  ],
                },
              },
            },
          },
        ]),
        update,
      },
    };
    const tmdb = {
      enabled: true,
      localizedEpisodeBase: jest.fn(),
    };
    const tvdb = {
      enabled: true,
      getEpisode: jest.fn(async (_id, lang) => ({
        seriesId: 153241,
        episode: {
          title: lang === 'en' ? 'The new episode' : 'Die neue Folge',
          overview: lang === 'en' ? 'New description' : 'Neue Beschreibung',
          stillUrl: 'https://artworks.thetvdb.com/episode-30.jpg',
          runtimeMinutes: 30,
        },
      })),
    };
    const svc = serviceWith(prisma, tmdb, tvdb, {});

    const result = await runInLanguage('de', () =>
      svc.refreshRecentIncompleteEpisodes('show-media'),
    );

    expect(result).toEqual({ attempted: 1, refreshed: 1 });
    expect(tmdb.localizedEpisodeBase).not.toHaveBeenCalled();
    expect(tvdb.getEpisode).toHaveBeenCalledWith(11881358, 'de', { bypassCache: true });
    expect(update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'episode-30',
        structureState: 'ACTIVE',
        season: { show: { mediaId: 'show-media' } },
      }),
      data: expect.objectContaining({
        stillUrl: 'https://artworks.thetvdb.com/episode-30.jpg',
        runtimeMinutes: 30,
        title: 'The new episode',
        titles: { de: 'Die neue Folge', en: 'The new episode' },
        overviews: { de: 'Neue Beschreibung', en: 'New description' },
        stillUrls: {
          de: 'https://artworks.thetvdb.com/episode-30.jpg',
          en: 'https://artworks.thetvdb.com/episode-30.jpg',
        },
      }),
    });
  });

  it('rejects a poisoned TVDB episode alias whose parent series does not match', async () => {
    const update = jest.fn();
    const prisma = {
      episode: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'episode-30',
            number: 30,
            title: 'Episode 30',
            overview: null,
            stillUrl: null,
            runtimeMinutes: null,
            titles: {},
            overviews: {},
            stillUrls: {},
            externalIds: [{ provider: ExternalProvider.THE_TVDB, value: '11881358' }],
            season: {
              number: 2026,
              show: {
                structureProvider: StructureProvider.TMDB,
                media: {
                  externalIds: [
                    { provider: ExternalProvider.TMDB, value: '13819' },
                    { provider: ExternalProvider.THE_TVDB, value: '153241' },
                  ],
                },
              },
            },
          },
        ]),
        update,
      },
    };
    const tvdb = {
      enabled: true,
      getEpisode: jest.fn().mockResolvedValue({
        seriesId: 999999,
        episode: { title: 'Wrong show', stillUrl: 'https://example.com/wrong.jpg' },
      }),
    };
    const svc = serviceWith(prisma, { enabled: true }, tvdb, {});

    await expect(svc.refreshRecentIncompleteEpisodes('show-media')).resolves.toEqual({
      attempted: 1,
      refreshed: 0,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('uses TMDB coordinates only when the response proves the stored episode id', async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      episode: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'episode-30',
            number: 30,
            title: 'Episode 30',
            overview: null,
            stillUrl: null,
            runtimeMinutes: null,
            titles: {},
            overviews: {},
            stillUrls: {},
            externalIds: [{ provider: ExternalProvider.TMDB, value: '55530' }],
            season: {
              number: 2026,
              show: {
                structureProvider: StructureProvider.TMDB,
                media: {
                  externalIds: [{ provider: ExternalProvider.TMDB, value: '13819' }],
                },
              },
            },
          },
        ]),
        update,
      },
    };
    const tmdb = {
      enabled: true,
      localizedEpisodeBase: jest.fn().mockResolvedValue({
        tmdbId: 55530,
        title: 'A current episode',
        overview: 'Current information',
        stillUrl: 'https://image.tmdb.org/episode-30.jpg',
      }),
    };
    const svc = serviceWith(prisma, tmdb, { enabled: true }, {});

    await expect(svc.refreshRecentIncompleteEpisodes('show-media')).resolves.toEqual({
      attempted: 1,
      refreshed: 1,
    });
    expect(tmdb.localizedEpisodeBase).toHaveBeenCalledWith(13819, 2026, 30, 'en', {
      bypassCache: true,
    });
    expect(update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'episode-30',
        structureState: 'ACTIVE',
        season: { show: { mediaId: 'show-media' } },
      }),
      data: expect.objectContaining({
        title: 'A current episode',
        overview: 'Current information',
        stillUrl: 'https://image.tmdb.org/episode-30.jpg',
      }),
    });
  });

  it('queues the audited structure repair when an ordinary TMDB refresh hits mixed rows', async () => {
    const enqueueStructureEvaluation = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      externalId: {
        findFirst: jest.fn().mockResolvedValue({
          media: {
            id: 'show-media',
            type: MediaType.SHOW,
            metadataRefreshedAt: new Date(0),
          },
        }),
      },
      episode: { count: jest.fn().mockResolvedValue(1) },
    };
    const tmdb = { enabled: true, getShow: jest.fn() };
    const svc = serviceWith(prisma, tmdb, { enabled: true }, { enqueueStructureEvaluation });
    jest.spyOn(svc as any, 'authorityForTmdb').mockResolvedValue({
      provider: StructureProvider.TMDB,
      reason: StructureReason.GENERAL_TMDB,
      ruleVersion: 2,
      decidedAt: new Date(),
      tmdbId: 13819,
    });

    await expect(svc.ensureShowFull(13819)).resolves.toBe('show-media');

    expect(prisma.episode.count).toHaveBeenCalledWith({
      where: {
        structureState: 'ACTIVE',
        season: { isSpecial: false, show: { mediaId: 'show-media' } },
        externalIds: { none: { provider: ExternalProvider.TMDB } },
      },
    });
    expect(enqueueStructureEvaluation).toHaveBeenCalledWith('show-media');
    expect(tmdb.getShow).not.toHaveBeenCalled();
  });
});

it.each([
  {
    owner: 'TVDB',
    id: 'bloodbath',
    title: 'Bloodbath',
    season: 4,
    providerId: 11934436,
    tvdbSeries: 389492,
    tmdbSeries: 123,
    date: '2026-09-17',
    airTime: '03:00',
    timeZone: 'America/New_York',
    expected: '2026-09-17T07:00:00Z',
  },
  {
    owner: 'TMDB',
    id: 'bloodbath-tmdb',
    title: 'Bloodbath',
    season: 4,
    providerId: 11934436,
    tvdbSeries: 389492,
    tmdbSeries: 123,
    date: '2026-09-17',
    airTime: '03:00',
    timeZone: 'America/New_York',
    expected: '2026-09-17T07:00:00Z',
  },
  {
    owner: 'TMDB',
    id: 'cmrccq7gy0ydmlf0joetlm5vu',
    title: 'Circle of Life',
    season: 6,
    providerId: 7377927,
    tvdbSeries: 372264,
    tmdbSeries: 95480,
    date: '2026-09-16',
    airTime: '00:00',
    timeZone: 'America/New_York',
    expected: '2026-09-16T04:00:00Z',
  },
])('fills an airtime-only gap for $title ($owner)', async (fixture) => {
  const {
    owner,
    id,
    title,
    season,
    providerId,
    tvdbSeries,
    tmdbSeries,
    date,
    airTime,
    timeZone,
    expected,
  } = fixture;
  const episode = {
    id,
    number: 1,
    title,
    overview: 'Complete text',
    stillUrl: 'https://example.test/image.jpg',
    runtimeMinutes: 54,
    airDate: new Date(date + 'T12:00:00Z'),
    airTime: '',
    titles: { en: title },
    overviews: {},
    stillUrls: {},
    externalIds: [{ provider: owner === 'TVDB' ? 'THE_TVDB' : 'TMDB', value: String(providerId) }],
    season: {
      number: season,
      show: {
        structureProvider: owner,
        media: {
          externalIds: [
            { provider: 'THE_TVDB', value: String(tvdbSeries) },
            { provider: 'TMDB', value: String(tmdbSeries) },
          ],
        },
      },
    },
  };
  const update = jest.fn().mockResolvedValue({});
  const prisma: any = { episode: { findMany: jest.fn(async () => [episode]), update } };
  const metadata = { tmdbId: providerId, title, airDate: date, isFinale: false };
  const tvdb: any = {
    enabled: true,
    getEpisode: jest.fn(async () => ({ seriesId: tvdbSeries, episode: metadata })),
    getBroadcastSchedule: jest.fn(async () => ({ airTime, timeZone })),
  };
  const tmdb: any = { enabled: true, localizedEpisodeBase: jest.fn(async () => metadata) };
  const service = serviceWith(prisma, tmdb, tvdb, {});
  await service.refreshRecentIncompleteEpisodes('show-media', [id]);
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ id }),
      data: expect.objectContaining({ airDate: new Date(expected), airTime }),
    }),
  );
  expect(prisma.episode.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ id: { in: [id] } }),
    }),
  );
});

it.each([
  { stored: '2026-09-15T23:00:00Z', providerDate: '2026-09-16', corrected: true },
  { stored: '2026-09-16T04:00:00Z', providerDate: '2026-09-16', corrected: false },
  { stored: '2026-09-16T01:00:00Z', providerDate: '2026-09-16', corrected: false },
  { stored: '2026-09-15T23:00:00Z', providerDate: '2026-09-17', corrected: false },
])(
  'repairs only a proven old streaming conversion ($stored / $providerDate)',
  async ({ stored, providerDate, corrected }) => {
    const episode = {
      id: 'slow-horses-1',
      number: 1,
      title: 'Circle of Life',
      overview: 'Complete',
      stillUrl: 'image',
      runtimeMinutes: 49,
      titles: {},
      overviews: {},
      stillUrls: {},
      airDate: new Date(stored),
      airTime: '00:00',
      externalIds: [{ provider: 'TMDB', value: '7377927' }],
      season: {
        number: 6,
        show: {
          structureProvider: 'TMDB',
          media: {
            externalIds: [
              { provider: 'TMDB', value: '95480' },
              { provider: 'THE_TVDB', value: '372264' },
            ],
          },
        },
      },
    };
    const update = jest.fn(async () => ({}));
    const prisma: any = { episode: { findMany: jest.fn(async () => [episode]), update } };
    const tmdb: any = {
      enabled: true,
      localizedEpisodeBase: jest.fn(async () => ({
        tmdbId: 7377927,
        title: 'Circle of Life',
        airDate: providerDate,
      })),
    };
    const tvdb: any = {
      enabled: true,
      getBroadcastSchedule: jest.fn(async () =>
        tvdbBroadcastSchedule({
          airsTime: '00:00',
          originalCountry: 'gbr',
          originalNetwork: { name: 'Apple TV', country: 'usa' },
        }),
      ),
    };
    await serviceWith(prisma, tmdb, tvdb, {}).refreshRecentIncompleteEpisodes('show', [
      'slow-horses-1',
    ]);
    if (corrected) {
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            airDate: new Date('2026-09-16T04:00:00Z'),
            airTime: '00:00',
          }),
        }),
      );
    } else {
      for (const call of update.mock.calls as any[])
        expect(call[0].data).not.toHaveProperty('airDate');
    }
  },
);
