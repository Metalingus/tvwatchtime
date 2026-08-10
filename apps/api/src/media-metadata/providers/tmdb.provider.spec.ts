import { ExternalProvider } from '@tvwatch/shared';
import { TmdbProvider } from './tmdb.provider';

/** getShow/getMovie: appended seasons/keywords/translations in one call + fallbacks. */

function makeClient(responses: Record<string, any>) {
  return {
    enabled: true,
    img: (p?: string | null, size = 'w500') => (p ? `img:${size}:${p}` : null),
    get: jest.fn(async (path: string, _params?: any, _lang?: string) => {
      if (responses[path]) return responses[path];
      throw new Error(`unexpected TMDB call: ${path}`);
    }),
  } as any;
}

const showPayload = (over: Record<string, any> = {}) => ({
  id: 65942,
  name: 'Re:ZERO',
  overview: 'en overview',
  seasons: [
    { id: 76465, season_number: 0, name: 'Specials', episode_count: 77 },
    { id: 75470, season_number: 1, name: 'Season 1', episode_count: 85 },
  ],
  keywords: { results: [{ name: 'anime' }, { name: 'isekai' }] },
  translations: {
    translations: [
      { iso_639_1: 'it', data: { name: 'Re:ZERO IT', overview: 'panoramica' } },
      { iso_639_1: 'ja', data: { name: '', overview: 'ja overview only' } },
    ],
  },
  external_ids: { imdb_id: 'tt5607616', tvdb_id: 305089 },
  ...over,
});

const seasonPayload = (count: number) => ({
  episodes: Array.from({ length: count }, (_, i) => ({
    id: 9000 + i,
    episode_number: i + 1,
    name: `E${i + 1}`,
    air_date: '2016-04-04',
  })),
});

describe('TmdbProvider.getShow', () => {
  it('reads appended seasons, keywords and translations from ONE call', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(77), 'season/1': seasonPayload(85) }),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(show.seasons).toHaveLength(2);
    expect(show.seasons[0].episodes).toHaveLength(77);
    expect(show.seasons[0].isSpecial).toBe(true);
    expect(show.seasons[1].episodes).toHaveLength(85);
    expect(show.keywords).toEqual(['anime', 'isekai']);
    expect(show.translations?.it).toEqual({ title: 'Re:ZERO IT', overview: 'panoramica' });
    expect(show.translations?.ja).toEqual({ title: undefined, overview: 'ja overview only' });
    expect(show.externals).toContainEqual({ provider: ExternalProvider.THE_TVDB, value: '305089' });
  });

  it('falls back to the per-season endpoint when an appended season is missing', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(2) }), // season/1 NOT appended
      '/tv/65942/season/1': seasonPayload(85),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.seasons[1].episodes).toHaveLength(85);
    expect(client.get).toHaveBeenCalledWith('/tv/65942/season/1', {}, 'en-US');
  });

  it('ignores an appended season with an empty episode list and falls back', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(2), 'season/1': { episodes: [] } }),
      '/tv/65942/season/1': seasonPayload(85),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.seasons[1].episodes).toHaveLength(85);
  });

  it('joins up to two TMDB networks into the single network string', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({
        networks: [
          { id: 98, name: 'TV Tokyo' },
          { id: 173, name: 'AT-X' },
          { id: 999, name: 'Third' },
        ],
        'season/0': seasonPayload(77),
        'season/1': seasonPayload(85),
      }),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.network).toBe('TV Tokyo · AT-X');
  });

  it('keeps network null when the show has none', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(77), 'season/1': seasonPayload(85) }),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    expect(show.network).toBeNull();
  });

  it('skips the per-season fetch when skipSeasonDetail covers the season', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(2) }), // season/1 NOT appended
      // no '/tv/65942/season/1' response — an unexpected fetch would throw here
    });
    const provider = new TmdbProvider(client);
    const skipSeasonDetail = jest.fn((n: number) => n === 1);
    const show = await provider.getShow(65942, 'en-US', { skipSeasonDetail });

    expect(skipSeasonDetail).toHaveBeenCalledTimes(1);
    expect(skipSeasonDetail).toHaveBeenCalledWith(1, 85);
    expect(client.get).toHaveBeenCalledTimes(1); // the one appended show call only
    // The skipped season is left episode-less; the caller filters it out before persisting.
    expect(show.seasons[1].number).toBe(1);
    expect(show.seasons[1].episodes).toHaveLength(0);
    expect(show.seasons[1].episodeCount).toBe(85);
  });

  it('still fetches the season when skipSeasonDetail returns false', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({ 'season/0': seasonPayload(2) }), // season/1 NOT appended
      '/tv/65942/season/1': seasonPayload(85),
    });
    const provider = new TmdbProvider(client);
    const skipSeasonDetail = jest.fn(() => false);
    const show = await provider.getShow(65942, 'en-US', { skipSeasonDetail });

    expect(skipSeasonDetail).toHaveBeenCalledWith(1, 85);
    expect(client.get).toHaveBeenCalledWith('/tv/65942/season/1', {}, 'en-US');
    expect(show.seasons[1].episodes).toHaveLength(85);
  });

  it('appends recommendations within the 20-append cap (12 seasons + recommendations)', async () => {
    const client = makeClient({
      '/tv/65942': showPayload({
        'season/0': seasonPayload(2),
        'season/1': seasonPayload(85),
        recommendations: {
          results: [
            {
              id: 1,
              media_type: 'tv',
              name: 'Steins;Gate',
              first_air_date: '2011-04-06',
              vote_average: 8.8,
            },
            { id: 2, media_type: 'tv', name: 'No Game No Life', vote_average: 8.1 },
          ],
        },
      }),
    });
    const provider = new TmdbProvider(client);
    const show = await provider.getShow(65942, 'en-US');

    const appends = String(client.get.mock.calls[0][1].append_to_response).split(',');
    expect(appends.length).toBeLessThanOrEqual(20);
    expect(appends).toContain('recommendations');
    expect(appends.filter((a: string) => a.startsWith('season/'))).toHaveLength(12);
    expect(show.recommendations).toEqual([
      { tmdbId: 1, type: 'SHOW', title: 'Steins;Gate', posterUrl: null, year: 2011, rating: 8.8 },
      {
        tmdbId: 2,
        type: 'SHOW',
        title: 'No Game No Life',
        posterUrl: null,
        year: null,
        rating: 8.1,
      },
    ]);
  });
});

describe('TmdbProvider.getShowSupplements', () => {
  it('fetches supplemental fields and filter facets without season appends', async () => {
    const client = makeClient({
      '/tv/65942': {
        id: 65942,
        name: 'Re:ZERO',
        vote_average: 8.2,
        original_language: 'ja',
        origin_country: ['JP'],
        keywords: { results: [{ name: 'anime' }, { name: 'isekai' }] },
        recommendations: {
          results: [
            {
              id: 1,
              media_type: 'tv',
              name: 'Steins;Gate',
              first_air_date: '2011-04-06',
            },
          ],
        },
        'watch/providers': {
          results: {
            US: {
              link: 'https://www.themoviedb.org/tv/65942/watch',
              flatrate: [
                {
                  provider_id: 8,
                  provider_name: 'Netflix',
                  logo_path: '/netflix.png',
                  display_priority: 1,
                },
              ],
            },
          },
        },
      },
    });
    const provider = new TmdbProvider(client);

    const supplements = await provider.getShowSupplements(65942);

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('/tv/65942', {
      append_to_response: 'watch/providers,recommendations,keywords',
    });
    expect(supplements).toEqual({
      rating: 8.2,
      recommendations: [
        {
          tmdbId: 1,
          type: 'SHOW',
          title: 'Steins;Gate',
          posterUrl: null,
          year: 2011,
          rating: null,
        },
      ],
      providers: [{ name: 'Netflix', logoUrl: 'img:w92:/netflix.png' }],
      providersByCountry: {
        US: {
          link: 'https://www.themoviedb.org/tv/65942/watch',
          stream: [{ id: 8, name: 'Netflix', logoUrl: 'img:w92:/netflix.png' }],
          rent: [],
          buy: [],
        },
      },
      keywords: ['anime', 'isekai'],
      originCountries: ['JP'],
      originalLanguage: 'ja',
    });
  });
});

describe('TmdbProvider.getMovie', () => {
  it('parses movie-shaped keywords and translations in one call', async () => {
    const client = makeClient({
      '/movie/62211': {
        id: 62211,
        title: 'Monsters University',
        keywords: { keywords: [{ name: 'anime' }] },
        translations: { translations: [{ iso_639_1: 'fr', data: { name: 'Monstres Academy' } }] },
        external_ids: { imdb_id: 'tt3232262' },
      },
    });
    const provider = new TmdbProvider(client);
    const movie = await provider.getMovie(62211, 'en-US');

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(movie.keywords).toEqual(['anime']);
    expect(movie.translations?.fr).toEqual({ title: 'Monstres Academy', overview: undefined });
  });

  it('appends recommendations and normalizes them (cap 20)', async () => {
    const client = makeClient({
      '/movie/62211': {
        id: 62211,
        title: 'Monsters University',
        recommendations: {
          results: [
            {
              id: 550,
              media_type: 'movie',
              title: 'Fight Club',
              poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
              release_date: '1999-10-15',
              vote_average: 8.4,
            },
            { id: 551, media_type: 'movie', title: 'The Truman Show' },
            // Beyond the cap — dropped.
            ...Array.from({ length: 25 }, (_, i) => ({ id: 1000 + i, title: `Filler ${i}` })),
          ],
        },
      },
    });
    const provider = new TmdbProvider(client);
    const movie = await provider.getMovie(62211, 'en-US');

    const appends = String(client.get.mock.calls[0][1].append_to_response).split(',');
    expect(appends).toContain('recommendations');
    expect(appends.length).toBeLessThanOrEqual(20);
    expect(movie.recommendations).toHaveLength(20);
    expect(movie.recommendations?.[0]).toEqual({
      tmdbId: 550,
      type: 'MOVIE',
      title: 'Fight Club',
      posterUrl: 'img:w342:/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
      year: 1999,
      rating: 8.4,
    });
    expect(movie.recommendations?.[1]).toEqual({
      tmdbId: 551,
      type: 'MOVIE',
      title: 'The Truman Show',
      posterUrl: null,
      year: null,
      rating: null,
    });
  });

  it('light recommendations fetch hits the single endpoint (no appends)', async () => {
    const client = makeClient({
      '/movie/62211/recommendations': {
        results: [{ id: 550, title: 'Fight Club', release_date: '1999-10-15' }],
      },
      '/tv/65942/recommendations': {
        results: [{ id: 1, name: 'Steins;Gate', first_air_date: '2011-04-06' }],
      },
    });
    const provider = new TmdbProvider(client);

    const movieRecs = await provider.getMovieRecommendations(62211);
    const showRecs = await provider.getShowRecommendations(65942);

    expect(movieRecs).toEqual([
      {
        tmdbId: 550,
        type: 'MOVIE',
        title: 'Fight Club',
        posterUrl: null,
        year: 1999,
        rating: null,
      },
    ]);
    expect(showRecs).toEqual([
      { tmdbId: 1, type: 'SHOW', title: 'Steins;Gate', posterUrl: null, year: 2011, rating: null },
    ]);
    expect(client.get).toHaveBeenCalledWith('/movie/62211/recommendations');
    expect(client.get).toHaveBeenCalledWith('/tv/65942/recommendations');
  });
});
