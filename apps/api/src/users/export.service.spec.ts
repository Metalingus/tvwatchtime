import AdmZip from 'adm-zip';
import * as fs from 'fs/promises';
import { buildUserExportArchive, ExportService, toPortableIds } from './export.service';

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
      username: 'tester',
      createdAt: D,
    },
    catalog: { media: [show, movie], episodes: [episode] },
    showStatuses: [
      {
        mediaId: show.id,
        watchedCount: 3,
        totalCount: 10,
        lastWatchedAt: D,
        dropped: false,
        pausedAt: null,
      },
    ],
    episodeStatuses: [{ episodeId: episode.id, watched: true, watchCount: 3, watchedAt: D }],
    movieStatuses: [{ mediaId: movie.id, watched: true, watchCount: 2, watchedAt: D }],
    watchHistory: [
      { mediaId: show.id, mediaType: 'SHOW', episodeId: episode.id, watchedAt: D },
      { mediaId: movie.id, mediaType: 'MOVIE', episodeId: null, watchedAt: D },
    ],
    watchlist: [{ mediaId: show.id, priority: 1, createdAt: D }],
    favorites: [{ mediaId: movie.id, createdAt: D }],
    ratings: [{ episodeId: episode.id, mediaId: null, rating: 4, createdAt: D, updatedAt: D }],
    reactions: [{ episodeId: episode.id, mediaId: null, reaction: 'WOW', createdAt: D }],
    characterVotes: [
      {
        episodeId: episode.id,
        mediaId: null,
        createdAt: D,
        cast: {
          character: 'The Lead',
          characterExternalId: 707,
          castMember: {
            name: 'Example Actor',
            tmdbId: 808,
            tvdbId: 909,
            imdbId: 'nm1010',
            biography: 'Not user data'.repeat(1000),
            credits: { huge: 'metadata'.repeat(1000) },
          },
        },
      },
      {
        episodeId: null,
        mediaId: movie.id,
        createdAt: D,
        cast: {
          character: 'Movie Lead',
          characterExternalId: null,
          externalIds: [{ provider: 'THE_TVDB', value: '1717' }],
          castMember: {
            name: 'Movie Actor',
            tmdbId: 1818,
            tvdbId: 1919,
            imdbId: 'nm2020',
          },
        },
      },
    ],
    customLists: [
      {
        title: 'Favorites to revisit',
        description: null,
        visibility: 'PRIVATE',
        createdAt: D,
        updatedAt: D,
        items: [{ mediaId: movie.id, order: 0, createdAt: D }],
      },
    ],
    comments: [
      {
        id: 'comment-1',
        parentId: null,
        threadType: 'EPISODE',
        threadId: episode.id,
        mediaId: show.id,
        body: 'Great episode',
        isSpoiler: false,
        createdAt: D,
        updatedAt: D,
      },
    ],
  };
};

const prismaForGather = ({
  importFindMany = jest.fn(async () => []),
  characterVoteFindMany = jest.fn(async (_args: any) => []),
}: {
  importFindMany?: jest.Mock;
  characterVoteFindMany?: jest.Mock;
} = {}) => {
  const emptyModel = {
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => null),
  };
  return new Proxy(
    {
      user: {
        findUnique: jest.fn(async () => ({
          username: 'tester',
          createdAt: D,
        })),
      },
      import: { findMany: importFindMany },
      characterVote: { findMany: characterVoteFindMany },
    } as any,
    {
      get(target, property) {
        return target[property] ?? emptyModel;
      },
    },
  );
};

describe('Compact user library export', () => {
  it('maps all stable provider ids into one portable ids object', () => {
    expect(
      toPortableIds([
        { provider: 'TMDB', value: '10' },
        { provider: 'THE_TVDB', value: '20' },
        { provider: 'TRAKT', value: '30' },
        { provider: 'IMDB', value: 'tt40' },
      ]),
    ).toEqual({ tmdb: 10, tvdb: 20, trakt: 30, imdb: 'tt40' });
  });

  it('emits one normalized file with view counts, dates, library state, and votes', () => {
    const zip = new AdmZip(buildUserExportArchive(snapshot()));
    const names = zip.getEntries().map((entry) => entry.entryName);
    expect(names).toEqual(['tvwatchtime-export.json']);

    const text = zip.readAsText('tvwatchtime-export.json');
    const exported = JSON.parse(text);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(5_000);
    expect(text).not.toContain('\n');
    expect(text).not.toContain('Not user data');
    expect(text).not.toContain('metadata');
    expect(exported).toMatchObject({
      format: 'tvwatchtime-library',
      version: 4,
      user: { username: 'tester' },
    });
    expect(exported.shows[0]).toMatchObject({
      id: 'show-media',
      ids: { tmdb: 101, tvdb: 202, imdb: 'tt303' },
      watchlisted: { priority: 1, addedAt: D.toISOString() },
      tracking: { watchedEpisodes: 3, totalEpisodes: 10, dropped: false },
    });
    expect(exported.movies[0]).toMatchObject({
      id: 'movie-media',
      favorite: { addedAt: D.toISOString() },
      views: { count: 2, dates: [D.toISOString()] },
      characterVote: {
        character: 'Movie Lead',
        characterIds: { tvdb: 1717 },
        person: { name: 'Movie Actor', ids: { tmdb: 1818, tvdb: 1919, imdb: 'nm2020' } },
      },
    });
    expect(exported.episodes[0]).toMatchObject({
      id: 'episode-1',
      showId: 'show-media',
      ids: { tmdb: 505, tvdb: 606 },
      views: { count: 3, dates: [D.toISOString()] },
      rating: { value: 4, ratedAt: D.toISOString() },
      emotions: [{ value: 'WOW', at: D.toISOString() }],
      characterVote: {
        character: 'The Lead',
        characterIds: { tvdb: 707 },
        person: { name: 'Example Actor', ids: { tmdb: 808, tvdb: 909, imdb: 'nm1010' } },
      },
      comments: [{ text: 'Great episode', spoiler: false }],
    });
    expect(exported.episodes[0]).not.toHaveProperty('show');
    expect(exported.lists[0].items).toEqual([{ mediaId: 'movie-media', addedAt: D.toISOString() }]);
    expect(exported).not.toHaveProperty('imports');
    expect(exported).not.toHaveProperty('notifications');
    expect(exported).not.toHaveProperty('social');
    expect(exported).not.toHaveProperty('stats');
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
    expect(prisma.dataExport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fileName: { startsWith: 'tvwatchtime-export-v4-' },
        }),
      }),
    );
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

  it('does not query or export import audit data', async () => {
    const importFindMany = jest.fn(async () => {
      throw new Error('Import audit must not be queried');
    });
    const prisma = prismaForGather({ importFindMany });
    const service = new ExportService(
      prisma as any,
      { get: jest.fn() } as any,
      redisForExport() as any,
    );

    const gathered = await (service as any).gatherUserData('user-1');
    expect(importFindMany).not.toHaveBeenCalled();
    expect(gathered).not.toHaveProperty('imports');
  });

  it('does not duplicate cast biographies and credits inside character votes', async () => {
    const characterVoteFindMany = jest.fn(async (_args: any) => []);
    const service = new ExportService(
      prismaForGather({ characterVoteFindMany }) as any,
      { get: jest.fn() } as any,
      redisForExport() as any,
    );

    await (service as any).gatherUserData('user-1');

    const castMemberSelect = characterVoteFindMany.mock.calls[0][0].select.cast.select.castMember
      .select as Record<string, boolean>;
    expect(castMemberSelect).toMatchObject({
      name: true,
      tmdbId: true,
      tvdbId: true,
      imdbId: true,
    });
    expect(castMemberSelect).not.toHaveProperty('biography');
    expect(castMemberSelect).not.toHaveProperty('credits');
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
