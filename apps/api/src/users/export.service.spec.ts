import AdmZip from 'adm-zip';
import * as fs from 'fs/promises';
import { isTraktArchive } from '../import/lib/trakt/detect';
import { normalizeTraktWatched } from '../import/lib/trakt/watched';
import { buildUserExportArchive, ExportService, toTraktIds } from './export.service';

jest.mock('fs/promises', () => ({
  unlink: jest.fn(),
  readFile: jest.fn(),
}));

const D = new Date('2024-01-02T03:04:05.000Z');

const redisForExport = (lockResult: 'OK' | null = 'OK') => ({
  client: {
    set: jest.fn(async () => lockResult),
    eval: jest.fn(async () => 1),
  },
});

const snapshot = () => {
  const show = {
    id: 'show-media',
    type: 'SHOW',
    title: 'Example Show',
    externalIds: [
      { provider: 'TMDB', providerEntityKind: 'SERIES', value: '101', url: null },
      { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '202', url: null },
      { provider: 'IMDB', providerEntityKind: 'SERIES', value: 'tt303', url: null },
    ],
    show: { yearStart: 2020, yearEnd: null },
    movie: null,
  };
  const movie = {
    id: 'movie-media',
    type: 'MOVIE',
    title: 'Example Movie',
    externalIds: [{ provider: 'TMDB', providerEntityKind: 'MOVIE', value: '404', url: null }],
    show: null,
    movie: { releaseYear: 2021, runtimeMinutes: 120 },
  };
  const episode = {
    id: 'episode-1',
    title: 'Pilot',
    number: 1,
    absoluteNumber: 1,
    runtimeMinutes: 45,
    airDate: D,
    externalIds: [
      { provider: 'TMDB', providerEntityKind: 'EPISODE', value: '505', url: null },
      { provider: 'THE_TVDB', providerEntityKind: 'EPISODE', value: '606', url: null },
    ],
    season: {
      number: 1,
      title: 'Season 1',
      isSpecial: false,
      show: { media: show },
    },
  };
  return {
    exportedAt: D.toISOString(),
    account: {
      id: 'user-1',
      username: 'tester',
      createdAt: D,
      profile: { displayName: 'Test User', languagePreference: 'EN' },
    },
    catalog: { media: [show, movie], episodes: [episode] },
    tracking: {
      showStatuses: [],
      episodeStatuses: [{ episodeId: episode.id, watched: true, watchCount: 3, watchedAt: D }],
      movieStatuses: [{ mediaId: movie.id, watched: true, watchCount: 2, watchedAt: D }],
      watchHistory: [
        { mediaId: show.id, mediaType: 'SHOW', episodeId: episode.id, watchedAt: D },
        { mediaId: movie.id, mediaType: 'MOVIE', episodeId: null, watchedAt: D },
      ],
    },
    library: { watchlist: [], favorites: [], customLists: [], providerAlerts: [] },
    votes: {
      ratings: [{ episodeId: episode.id, mediaId: null, rating: 4, createdAt: D, updatedAt: D }],
      reactions: [{ episodeId: episode.id, reaction: 'WOW', createdAt: D }],
      characterVotes: [{ episodeId: episode.id, castId: 'cast-1', createdAt: D }],
    },
    comments: { authored: [], likes: [], spoilerReports: [], externalReviewLikes: [] },
    social: {
      following: [],
      followers: [],
      blocks: [],
      reportsFiled: [],
      listLikes: [],
      listSubscriptions: [],
    },
    notifications: { preferences: null, notifications: [], pushJobs: [] },
    achievements: [],
    imports: [],
    activity: [],
    support: [],
    stats: { summary: null, snapshots: [] },
  };
};

const prismaForGather = (importFindMany: jest.Mock) => {
  const emptyModel = {
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => null),
  };
  return new Proxy(
    {
      user: {
        findUnique: jest.fn(async () => ({
          id: 'user-1',
          username: 'tester',
          profile: null,
          notificationPrefs: null,
        })),
      },
      import: { findMany: importFindMany },
    } as any,
    {
      get(target, property) {
        return target[property] ?? emptyModel;
      },
    },
  );
};

describe('Trakt-compatible user export', () => {
  it('maps all portable provider ids into the Trakt ids shape', () => {
    expect(
      toTraktIds([
        { provider: 'TMDB', value: '10' },
        { provider: 'THE_TVDB', value: '20' },
        { provider: 'TRAKT', value: '30' },
        { provider: 'IMDB', value: 'tt40' },
      ]),
    ).toEqual({ tmdb: 10, tvdb: 20, trakt: 30, imdb: 'tt40' });
  });

  it('emits Trakt files, restores collapsed play counts, and preserves app-specific votes', () => {
    const zip = new AdmZip(buildUserExportArchive(snapshot()));
    const names = zip.getEntries().map((entry) => entry.entryName);
    expect(isTraktArchive(names)).toBe(true);
    expect(names).toEqual(
      expect.arrayContaining([
        'watched-history-1.json',
        'ratings-episodes.json',
        'lists-watchlist.json',
        'comments-episodes.json',
        'user-settings.json',
        'tvwatchtime-export.json',
      ]),
    );

    const history = JSON.parse(zip.readAsText('watched-history-1.json'));
    expect(history.filter((row: any) => row.type === 'episode')).toHaveLength(3);
    expect(history.filter((row: any) => row.type === 'movie')).toHaveLength(2);
    expect(history[0].show.ids).toMatchObject({ tmdb: 101, tvdb: 202, imdb: 'tt303' });
    const roundTrip = normalizeTraktWatched({
      history: [history],
      watchedMovies: [],
      watchedShows: [],
    });
    expect(roundTrip.episodes[0].watchCount).toBe(3);
    expect(roundTrip.movies[0].watchCount).toBe(2);

    const ratings = JSON.parse(zip.readAsText('ratings-episodes.json'));
    expect(ratings[0]).toMatchObject({ rating: 8, episode: { ids: { tmdb: 505, tvdb: 606 } } });

    const complete = JSON.parse(zip.readAsText('tvwatchtime-export.json'));
    expect(complete.votes.reactions).toHaveLength(1);
    expect(complete.votes.characterVotes).toHaveLength(1);
  });

  it('stores the ZIP in shared database storage instead of a replica-local file', async () => {
    const prisma: any = {
      dataExport: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (args: any) => ({
          token: args.data.token,
          expiresAt: args.data.expiresAt,
        })),
      },
    };
    const config: any = { get: jest.fn(() => 'https://api.example.test') };
    const redis = redisForExport();
    const service = new ExportService(prisma, config, redis as any);
    jest.spyOn(service as any, 'gatherUserData').mockResolvedValue(snapshot());

    const result = await service.requestExport('user-1');

    expect(result.downloadUrl).toMatch(
      /^https:\/\/api\.example\.test\/api\/me\/export-download\?token=/,
    );
    expect(result.reused).toBe(false);
    expect(prisma.dataExport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          fileName: expect.stringMatching(/\.zip$/),
          contentType: 'application/zip',
          payload: expect.any(Buffer),
          status: 'ready',
        }),
      }),
    );
    expect(redis.client.set).toHaveBeenCalledWith(
      'user-export:user-1',
      expect.any(String),
      'EX',
      600,
      'NX',
    );
  });

  it('reuses a recent export instead of regenerating it', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const prisma: any = {
      dataExport: {
        findFirst: jest.fn(async () => ({ token: 'existing-token', expiresAt })),
        create: jest.fn(),
      },
    };
    const redis = redisForExport();
    const service = new ExportService(
      prisma,
      { get: jest.fn(() => 'https://api.example.test') } as any,
      redis as any,
    );
    const gather = jest.spyOn(service as any, 'gatherUserData');

    await expect(service.requestExport('user-1')).resolves.toMatchObject({
      downloadUrl: 'https://api.example.test/api/me/export-download?token=existing-token',
      reused: true,
    });
    expect(gather).not.toHaveBeenCalled();
    expect(prisma.dataExport.create).not.toHaveBeenCalled();
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('rejects a concurrent export while another replica holds the user lock', async () => {
    const prisma: any = { dataExport: { findFirst: jest.fn(async () => null) } };
    const redis = redisForExport(null);
    const service = new ExportService(
      prisma,
      { get: jest.fn(() => 'https://api.example.test') } as any,
      redis as any,
    );
    const gather = jest.spyOn(service as any, 'gatherUserData');

    await expect(service.requestExport('user-1')).rejects.toMatchObject({ status: 429 });
    expect(gather).not.toHaveBeenCalled();
  });

  it('exports import audit data without loading provider JSON staging blobs', async () => {
    const importFindMany = jest.fn(async (args: unknown) => {
      const query = JSON.stringify(args);
      if (/rawData|normalizedData|previousData|newData|storageKey/.test(query)) {
        throw new Error('Prisma N-API string conversion failure');
      }
      return [];
    });
    const prisma = prismaForGather(importFindMany);
    const service = new ExportService(
      prisma as any,
      { get: jest.fn() } as any,
      redisForExport() as any,
    );

    await expect((service as any).gatherUserData('user-1')).resolves.toMatchObject({ imports: [] });
    expect(importFindMany).toHaveBeenCalledTimes(1);
    const select = (importFindMany.mock.calls[0][0] as any).select;
    expect(select.items.select).toMatchObject({ matchedMediaId: true, matchedEpisodeId: true });
    expect(select.applied.select).toMatchObject({ targetTable: true, targetRecordId: true });
  });

  it('does not fail the complete export when a legacy import audit row is undecodable', async () => {
    const importFindMany = jest.fn(async () => {
      throw Object.assign(new Error('Failed to convert rust String into napi string'), {
        code: 'P2010',
      });
    });
    const service = new ExportService(
      prismaForGather(importFindMany) as any,
      {
        get: jest.fn(),
      } as any,
      redisForExport() as any,
    );

    await expect((service as any).gatherUserData('user-1')).resolves.toMatchObject({ imports: [] });
  });
});

describe('ExportService.deleteForUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes database-backed exports without touching replica-local storage', async () => {
    const prisma: any = {
      dataExport: {
        findMany: jest.fn(async () => [
          { id: 'export-1', fileName: 'one.zip', contentType: 'application/zip' },
        ]),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const service = new ExportService(prisma, { get: jest.fn() } as any, redisForExport() as any);

    await expect(service.deleteForUser('user-1')).resolves.toBe(1);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(prisma.dataExport.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['export-1'] } },
    });
  });

  it('retains a legacy record when filesystem deletion fails so cleanup can retry', async () => {
    const prisma: any = {
      dataExport: {
        findMany: jest.fn(async () => [
          { id: 'export-1', fileName: 'one.json', contentType: 'application/json' },
        ]),
        deleteMany: jest.fn(),
      },
    };
    (fs.unlink as jest.Mock).mockRejectedValueOnce(new Error('disk unavailable'));
    const service = new ExportService(prisma, { get: jest.fn() } as any, redisForExport() as any);

    await expect(service.deleteForUser('user-1')).resolves.toBe(0);
    expect(prisma.dataExport.deleteMany).not.toHaveBeenCalled();
  });
});
