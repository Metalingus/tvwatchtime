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
      getEpisode: jest.fn().mockResolvedValue({
        seriesId: 153241,
        episode: {
          title: 'Die neue Folge',
          overview: 'Neue Beschreibung',
          stillUrl: 'https://artworks.thetvdb.com/episode-30.jpg',
          runtimeMinutes: 30,
        },
      }),
    };
    const svc = serviceWith(prisma, tmdb, tvdb, {});

    const result = await runInLanguage('de', () =>
      svc.refreshRecentIncompleteEpisodes('show-media'),
    );

    expect(result).toEqual({ attempted: 1, refreshed: 1 });
    expect(tmdb.localizedEpisodeBase).not.toHaveBeenCalled();
    expect(tvdb.getEpisode).toHaveBeenCalledWith(11881358, 'de');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'episode-30' },
      data: expect.objectContaining({
        stillUrl: 'https://artworks.thetvdb.com/episode-30.jpg',
        runtimeMinutes: 30,
        titles: { de: 'Die neue Folge' },
        overviews: { de: 'Neue Beschreibung' },
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
    expect(tmdb.localizedEpisodeBase).toHaveBeenCalledWith(13819, 2026, 30, 'en');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'episode-30' },
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
