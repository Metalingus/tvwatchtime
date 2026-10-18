import AdmZip from 'adm-zip';
import { buildUserExportArchive } from '../../../users/export.service';
import {
  isTvWatchTimeArchive,
  isTvWatchTimeExportData,
  isTvWatchTimeStandaloneFile,
  parseTvWatchTimeExport,
} from './format';

const D1 = new Date('2024-01-02T03:04:05.000Z');
const D2 = new Date('2024-03-04T05:06:07.000Z');

/** A snapshot in the exporter's own shape, so the test covers the real export → import path. */
const snapshot = () => {
  const show = {
    id: 'show-media',
    type: 'SHOW',
    title: 'Example Show',
    externalIds: [
      { provider: 'TMDB', value: '101' },
      { provider: 'THE_TVDB', value: '202' },
    ],
    show: { yearStart: 2020 },
    movie: null,
  };
  const movie = {
    id: 'movie-media',
    type: 'MOVIE',
    title: 'Example Movie',
    externalIds: [{ provider: 'IMDB', value: 'tt404' }],
    show: null,
    movie: { releaseYear: 2021, runtimeMinutes: 120 },
  };
  const episode = {
    id: 'episode-1',
    title: 'Pilot',
    number: 1,
    absoluteNumber: 1,
    runtimeMinutes: 45,
    airDate: D1,
    externalIds: [{ provider: 'THE_TVDB', value: '606' }],
    season: { number: 1, show: { media: show } },
  };
  return {
    exportedAt: D2.toISOString(),
    restoreToken: 'v1.user-1.signature',
    account: { username: 'tester', createdAt: D1 },
    catalog: { media: [show, movie], episodes: [episode] },
    showStatuses: [
      {
        mediaId: show.id,
        watchedCount: 1,
        totalCount: 10,
        lastWatchedAt: D2,
        dropped: true,
        pausedAt: null,
        rewatchStartedAt: null,
      },
    ],
    episodeStatuses: [
      { episodeId: episode.id, watched: true, watchCount: 2, watchedAt: D2, device: 'TV' },
    ],
    movieStatuses: [{ mediaId: movie.id, watched: true, watchCount: 1, watchedAt: D1 }],
    watchHistory: [
      { mediaId: show.id, mediaType: 'SHOW', episodeId: episode.id, watchedAt: D2 },
      { mediaId: show.id, mediaType: 'SHOW', episodeId: episode.id, watchedAt: D1 },
      // A legacy history row without an episode row survives as a coordinate.
      {
        mediaId: show.id,
        mediaType: 'SHOW',
        episodeId: null,
        seasonNumber: 1,
        episodeNumber: 2,
        watchedAt: D1,
      },
      { mediaId: movie.id, mediaType: 'MOVIE', episodeId: null, watchedAt: D1 },
    ],
    watchlist: [{ mediaId: show.id, priority: 3, createdAt: D1 }],
    favorites: [{ mediaId: movie.id, createdAt: D2 }],
    ratings: [
      { episodeId: episode.id, mediaId: null, rating: 4, createdAt: D1, updatedAt: D2 },
      { episodeId: null, mediaId: movie.id, rating: 9, createdAt: D1, updatedAt: D1 },
    ],
    reactions: [
      { episodeId: episode.id, mediaId: null, reaction: 'SHOCKED', createdAt: D1 },
      { episodeId: episode.id, mediaId: null, reaction: 'NOT_A_REACTION', createdAt: D1 },
    ],
    characterVotes: [
      {
        episodeId: episode.id,
        mediaId: null,
        createdAt: D1,
        cast: { character: 'Lead', characterExternalId: 707, castMember: null },
      },
    ],
    customLists: [
      {
        id: 'list-1',
        title: 'Revisit',
        description: 'Later',
        coverUrl: null,
        visibility: 'PUBLIC',
        createdAt: D1,
        updatedAt: D1,
        items: [{ mediaId: movie.id, order: 0, createdAt: D2 }],
      },
    ],
    comments: [
      {
        id: 'comment-1',
        parentId: 'someone-elses-comment',
        threadType: 'EPISODE',
        threadId: episode.id,
        mediaId: show.id,
        body: 'Agreed!',
        isSpoiler: true,
        createdAt: D1,
        updatedAt: D1,
      },
    ],
    profile: {
      displayName: 'Tess',
      bio: null,
      location: null,
      isPrivate: false,
      hideAnimeInExplore: true,
      exploreDefaultFilters: null,
      exploreSections: null,
      themePreference: 'LIGHT',
      languagePreference: 'PT_BR',
    },
    notificationPreference: null,
    providerAlerts: [
      { mediaId: movie.id, offerType: 'RENT', country: 'US', providerIds: [2], active: true },
    ],
    follows: [{ username: 'friend', createdAt: D1 }],
    blocks: [],
    listSubscriptions: [{ listId: 'their-list', notifyOnAdd: true, createdAt: D1 }],
    listLikes: [{ listId: 'their-list', createdAt: D1 }],
  };
};

const exportedJson = () =>
  JSON.parse(new AdmZip(buildUserExportArchive(snapshot())).readAsText('tvwatchtime-export.json'));

describe('TV Watch Time native export parsing', () => {
  it('detects the archive entry, standalone uploads, and the format marker', () => {
    expect(isTvWatchTimeArchive(['export/tvwatchtime-export.json'])).toBe(true);
    expect(isTvWatchTimeArchive(['watched-history-1.json'])).toBe(false);
    expect(isTvWatchTimeStandaloneFile('tvwatchtime-export (1).json')).toBe(true);
    expect(isTvWatchTimeStandaloneFile('shows.json')).toBe(false);
    expect(isTvWatchTimeExportData(exportedJson())).toBe(true);
    expect(isTvWatchTimeExportData({ format: 'trakt' })).toBe(false);
  });

  it('round-trips everything the exporter writes', () => {
    const parsed = parseTvWatchTimeExport(exportedJson())!;
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(5);
    expect(parsed.restoreToken).toBe('v1.user-1.signature');

    expect(parsed.shows).toEqual([
      expect.objectContaining({
        exportId: 'show-media',
        title: 'Example Show',
        year: 2020,
        ids: { tmdb: 101, tvdb: 202 },
        watchlisted: { addedAt: D1, priority: 3 },
        tracking: { dropped: true, pausedAt: null, rewatchStartedAt: null },
      }),
    ]);
    expect(parsed.movies[0]).toMatchObject({
      exportId: 'movie-media',
      ids: { imdb: 'tt404' },
      favorite: { addedAt: D2 },
      views: { count: 1, dates: [D1], device: null },
      // 9 is outside the app's 1–5 scale and is dropped rather than clamped.
      rating: null,
    });

    const [watched, legacy] = parsed.episodes;
    expect(watched).toMatchObject({
      exportId: 'episode-1',
      showExportId: 'show-media',
      season: 1,
      number: 1,
      ids: { tvdb: 606 },
      views: { count: 2, dates: [D1, D2], device: 'TV' },
      rating: { value: 4, ratedAt: D2 },
      emotions: [{ value: 'SHOCKED', at: D1 }],
      characterVote: { tvdbCharacterId: 707 },
      comments: [
        {
          exportId: 'comment-1',
          parentId: 'someone-elses-comment',
          text: 'Agreed!',
          spoiler: true,
        },
      ],
    });
    expect(legacy).toMatchObject({
      exportId: null,
      showExportId: 'show-media',
      season: 1,
      number: 2,
      views: { count: 1, dates: [D1] },
    });

    expect(parsed.lists).toEqual([
      {
        sourceKey: 'tvwatchtime:list:list-1',
        title: 'Revisit',
        description: 'Later',
        coverUrl: null,
        visibility: 'PUBLIC',
        createdAt: D1,
        items: [{ mediaExportId: 'movie-media', addedAt: D2, order: 0 }],
      },
    ]);
    expect(parsed.profile).toMatchObject({
      displayName: 'Tess',
      hideAnimeInExplore: true,
      theme: 'LIGHT',
      language: 'PT_BR',
    });
    expect(parsed.providerAlerts).toEqual([
      {
        mediaExportId: 'movie-media',
        offerType: 'RENT',
        country: 'US',
        providerIds: [2],
        active: true,
      },
    ]);
    expect(parsed.social).toEqual({
      following: ['friend'],
      blocked: [],
      listSubscriptions: [{ listId: 'their-list', notifyOnAdd: true }],
      likedLists: ['their-list'],
    });
  });

  it('accepts version 4 exports, which predate account state', () => {
    const v4 = exportedJson();
    v4.version = 4;
    delete v4.user.restoreToken;
    delete v4.user.profile;
    delete v4.social;
    delete v4.providerAlerts;
    delete v4.lists[0].id;
    const parsed = parseTvWatchTimeExport(v4)!;
    expect(parsed.restoreToken).toBeNull();
    expect(parsed.profile).toBeNull();
    expect(parsed.social).toEqual({
      following: [],
      blocked: [],
      listSubscriptions: [],
      likedLists: [],
    });
    expect(parsed.lists[0].sourceKey).toBe('tvwatchtime:list:0:revisit');
  });

  it('rejects other formats and counts unusable rows', () => {
    expect(parseTvWatchTimeExport({ format: 'other', version: 5 })).toBeNull();
    expect(parseTvWatchTimeExport({ format: 'tvwatchtime-library', version: 3 })).toBeNull();
    expect(parseTvWatchTimeExport('garbage')).toBeNull();

    const parsed = parseTvWatchTimeExport({
      format: 'tvwatchtime-library',
      version: 5,
      shows: [{ id: 's1', title: 'Kept' }, { id: 's1', title: 'Duplicate' }, { title: 'No id' }],
      movies: [{ id: 'm1' }],
      episodes: [
        { id: 'e1', showId: 'unknown-show', season: 1, number: 1 },
        { id: 'e2', showId: 's1', season: 'x', number: 1 },
      ],
      lists: [{ items: [] }],
      providerAlerts: [{ mediaId: 's1', offerType: 'FREE', country: 'US' }],
    })!;
    expect(parsed.shows.map((show) => show.exportId)).toEqual(['s1']);
    expect(parsed.movies).toEqual([]);
    expect(parsed.episodes).toEqual([]);
    expect(parsed.invalid).toBe(7);
  });
});
