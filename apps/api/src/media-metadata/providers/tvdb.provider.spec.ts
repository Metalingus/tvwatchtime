import { TvdbProvider } from './tvdb.provider';
import { ProviderThrottled } from './shared/provider-http';

/** Fake TvdbClient: returns canned responses per path and resolves artwork like the real one. */
function fakeClient(routes: Record<string, unknown>) {
  return {
    enabled: true,
    apiKey: 'k',
    artwork: (p?: string | null) => (p ? `https://art/${p}` : null),
    get: async <T>(path: string): Promise<T> => {
      const key = Object.keys(routes).find((k) => path.startsWith(k));
      if (!key) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: routes[key] } as unknown as T;
    },
  };
}

function fakeClientWithHandler(
  handler: (
    path: string,
    params?: Record<string, string | number | undefined>,
    language?: string,
    opts?: { bypassCache?: boolean },
  ) => any,
) {
  return {
    enabled: true,
    apiKey: 'k',
    artwork: (p?: string | null) => (p ? `https://art/${p}` : null),
    get: jest.fn(
      async <T>(
        path: string,
        params?: Record<string, string | number | undefined>,
        language?: string,
        opts?: { bypassCache?: boolean },
      ): Promise<T> => handler(path, params, language, opts) as T,
    ),
  };
}

describe('TvdbProvider — episode + translations', () => {
  it('preserves explicit TVDB search genres for new-show routing', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/search': [
          {
            tvdb_id: 123,
            type: 'series',
            name: 'Anime result',
            genres: [{ id: 27, name: 'Anime', slug: 'anime' }],
          },
        ],
      }) as any,
    );

    const result = await provider.searchShows('Anime result');

    expect(result.items[0].providerGenres).toEqual([{ id: 27, name: 'Anime', slug: 'anime' }]);
  });

  it('paginates routing snapshots beyond the old 12-page truncation', async () => {
    const client = fakeClientWithHandler((path, params) => {
      if (!path.includes('/episodes/official/')) throw new Error(`unexpected path: ${path}`);
      const page = Number(params?.page ?? 0);
      return {
        data: {
          episodes: [
            {
              id: 10_000 + page,
              name: `Episode ${page + 1}`,
              seasonNumber: 1,
              number: page + 1,
              aired: `2024-01-${String((page % 28) + 1).padStart(2, '0')}`,
            },
          ],
        },
        links: { next: page < 12 ? `page=${page + 1}` : null },
      };
    });
    const provider = new TvdbProvider(client as any);

    const index = await provider.getEpisodeRoutingIndex(77);

    expect(index.size).toBe(13);
    expect(client.get).toHaveBeenCalledTimes(13);
    expect(client.get).toHaveBeenCalledWith('/series/77/episodes/official/eng', { page: 0 }, 'eng');
    expect(index.get(10_012)).toMatchObject({ seasonNumber: 1, episodeNumber: 13 });
  });

  it('retries the same routing page after internal provider throttling', async () => {
    let attempts = 0;
    const client = fakeClientWithHandler(() => {
      attempts++;
      if (attempts === 1) throw new ProviderThrottled('tvdb', 1);
      return { data: { episodes: [] }, links: { next: null } };
    });
    const provider = new TvdbProvider(client as any);

    await expect(provider.getEpisodeRoutingIndex(77)).resolves.toEqual(new Map());
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('bypasses the provider cache for both series metadata and episode pages', async () => {
    const client = fakeClientWithHandler((path) => {
      if (path.endsWith('/extended')) {
        return { data: { id: 77, name: 'Current Show', status: { name: 'Continuing' } } };
      }
      return { data: { episodes: [] }, links: { next: null } };
    });
    const provider = new TvdbProvider(client as any);

    await provider.getShow(77, 'en', { bypassCache: true });

    expect(client.get).toHaveBeenNthCalledWith(
      1,
      '/series/77/extended',
      { meta: 'translations' },
      'eng',
      { bypassCache: true },
    );
    expect(client.get).toHaveBeenNthCalledWith(
      2,
      '/series/77/episodes/default/eng',
      { page: 0 },
      'eng',
      { bypassCache: true },
    );
  });

  it('rejects a routing snapshot when a later page fails instead of returning partial data', async () => {
    const client = fakeClientWithHandler((_path, params) => {
      const page = Number(params?.page ?? 0);
      if (page === 1) throw new Error('TVDB page failed');
      return {
        data: {
          episodes: [{ id: 101, name: 'Pilot', seasonNumber: 1, number: 1, aired: '2024-01-01' }],
        },
        links: { next: 'page=1' },
      };
    });
    const provider = new TvdbProvider(client as any);

    await expect(provider.getEpisodeRoutingIndex(77)).rejects.toThrow('TVDB page failed');
  });

  it('resolves an episode by TVDB id with parent-series + absolute number', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/episodes/555/extended': {
          id: 555,
          name: 'Pilot',
          overview: 'The beginning',
          aired: '2021-01-01',
          runtime: 45,
          seasonNumber: 1,
          number: 1,
          absoluteNumber: 1,
          seriesId: 77,
          image: 'ep.jpg',
        },
      }) as any,
    );
    const out = await provider.getEpisode(555);
    expect(out.tvdbEpisodeId).toBe(555);
    expect(out.seriesId).toBe(77);
    expect(out.seasonNumber).toBe(1);
    expect(out.absoluteNumber).toBe(1);
    expect(out.episode.title).toBe('Pilot');
    expect(out.episode.runtimeMinutes).toBe(45);
    expect(out.episode.stillUrl).toBe('https://art/ep.jpg');
  });

  it('returns localized series translations', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/77/translations/ja': { name: 'タイトル', overview: 'あらすじ' },
      }) as any,
    );
    const t = await provider.getSeriesTranslations(77, 'ja');
    expect(t).toEqual({ title: 'タイトル', overview: 'あらすじ', locale: 'ja' });
  });

  it('returns null fields when a translation is missing', async () => {
    const provider = new TvdbProvider(fakeClient({ '/movies/9/translations/fr': {} }) as any);
    const t = await provider.getMovieTranslations(9, 'fr');
    expect(t).toEqual({ title: null, overview: null, locale: 'fr' });
  });

  it('maps extended genres onto the normalized show (needed for anime detection)', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/78857/extended': {
          id: 78857,
          name: 'Naruto',
          overview: 'Ninja',
          status: { name: 'Ended' },
          firstAired: '2002-10-03',
          genres: [
            { id: 1, name: 'Animation' },
            { id: 2, name: 'Action' },
          ],
        },
        '/series/78857/episodes': { episodes: [] },
      }) as any,
    );
    const show = await provider.getShow(78857, 'en');
    expect(show.genres).toEqual([
      { tmdbId: 1, name: 'Animation' },
      { tmdbId: 2, name: 'Action' },
    ]);
  });

  it('counts only non-empty regular seasons and excludes specials', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/389492/extended': {
          id: 389492,
          name: 'Monster',
          status: { name: 'Continuing' },
          seasons: [0, 1, 2, 3, 4, 5].map((number) => ({ id: number + 10, number })),
        },
        '/series/389492/episodes/default/eng': {
          episodes: [
            { id: 1, name: 'Special', seasonNumber: 0, number: 1, aired: '2022-01-01' },
            { id: 2, name: 'One', seasonNumber: 1, number: 1, aired: '2022-09-21' },
            { id: 3, name: 'Two', seasonNumber: 2, number: 1, aired: '2024-09-19' },
            { id: 4, name: 'Three', seasonNumber: 3, number: 1, aired: '2025-10-03' },
          ],
        },
      }) as any,
    );

    const show = await provider.getShow(389492, 'en');

    expect(show.seasons).toHaveLength(6);
    expect(show.seasonsCount).toBe(3);
    expect(show.episodesCount).toBe(3);
  });

  it('keeps genres empty when the series has none', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/1/extended': { id: 1, name: 'Show', status: { name: 'Ended' } },
        '/series/1/episodes': { episodes: [] },
      }) as any,
    );
    const show = await provider.getShow(1, 'en');
    expect(show.genres).toEqual([]);
  });

  it('joins up to two Network-type companies, skipping studios and duplicates', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/42/extended': {
          id: 42,
          name: 'Anime',
          status: { name: 'Continuing' },
          companies: [
            {
              id: 433,
              name: 'AT-X',
              companyType: { companyTypeId: 1, companyTypeName: 'Network' },
            },
            {
              id: 46193,
              name: 'WHITE FOX',
              companyType: { companyTypeId: 2, companyTypeName: 'Studio' },
            },
            {
              id: 280,
              name: 'TV Tokyo',
              companyType: { companyTypeId: 1, companyTypeName: 'Network' },
            },
            {
              id: 999,
              name: 'Third Net',
              companyType: { companyTypeId: 1, companyTypeName: 'Network' },
            },
          ],
        },
        '/series/42/episodes': { episodes: [] },
      }) as any,
    );
    const show = await provider.getShow(42, 'en');
    expect(show.network).toBe('AT-X · TV Tokyo');
  });

  it('falls back to originalNetwork when the series has no companies', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/7/extended': {
          id: 7,
          name: 'Show',
          status: { name: 'Ended' },
          originalNetwork: { name: 'HBO' },
        },
        '/series/7/episodes': { episodes: [] },
      }) as any,
    );
    const show = await provider.getShow(7, 'en');
    expect(show.network).toBe('HBO');
  });

  it('maps TVDB character ids onto cast (characterExternalId for TVTime vote resolution)', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/5/extended': {
          id: 5,
          name: 'Show',
          status: { name: 'Ended' },
          characters: [
            {
              id: 64771402,
              name: 'Michael Scott',
              personName: 'Steve Carell',
              peopleId: 296807,
              peopleType: 'Actor',
              image: 'roles/michael-scott.jpg',
              personImgURL: 'https://people/steve-carell.jpg',
              sort: 0,
            },
            {
              id: 64771393,
              name: 'Dwight Schrute',
              personName: 'Rainn Wilson',
              peopleId: 296808,
              peopleType: 'Actor',
              sort: 1,
            },
            { id: 999, name: 'Crew Person', personName: 'Someone', peopleType: 'Crew', sort: 2 },
          ],
        },
        '/series/5/episodes': { episodes: [] },
      }) as any,
    );
    const show = await provider.getShow(5, 'en');
    expect(show.cast).toHaveLength(2);
    expect(show.cast[0]).toMatchObject({
      name: 'Steve Carell',
      character: 'Michael Scott',
      characterExternalId: 64771402,
      characterImageUrl: 'https://art/roles/michael-scott.jpg',
      profileUrl: 'https://people/steve-carell.jpg',
    });
    expect(show.cast[1]).toMatchObject({ characterExternalId: 64771393 });
  });

  it('CAST_ONLY keeps the top 40 plus every requested imported character without fetching episodes', async () => {
    const characters = Array.from({ length: 42 }, (_, index) => ({
      id: 1000 + index,
      name: `Character ${index + 1}`,
      personName: `Actor ${index + 1}`,
      peopleId: index >= 40 ? 9999 : 2000 + index,
      peopleType: index >= 40 ? 'Guest Star' : 'Actor',
      sort: index,
    }));
    const client = fakeClientWithHandler((path) => {
      if (path === '/series/5/extended') {
        return { data: { id: 5, name: 'Show', status: { name: 'Ended' }, characters } };
      }
      throw new Error(`unexpected structure request: ${path}`);
    });
    const provider = new TvdbProvider(client as any);

    const show = await provider.getShow(5, 'en', {
      includeStructure: false,
      requiredCharacterIds: [1040, 1041],
    });

    expect(show.cast).toHaveLength(42);
    expect(show.cast.some((cast) => cast.characterExternalId === 1040)).toBe(true);
    expect(show.cast.some((cast) => cast.characterExternalId === 1041)).toBe(true);
    expect(
      show.cast
        .filter((cast) => cast.characterExternalId === 1040 || cast.characterExternalId === 1041)
        .map((cast) => cast.personExternalId),
    ).toEqual(['TVDB_5_CHAR_1040', 'TVDB_5_CHAR_1041']);
    expect(show.seasons).toEqual([]);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('does not fold unsupported TVDB translations into English', async () => {
    const provider = new TvdbProvider(
      fakeClientWithHandler((path) => {
        if (path.includes('/episodes/')) return { data: { episodes: [] }, links: {} };
        return {
          data: {
            id: 77398,
            name: 'The X-Files',
            status: { name: 'Ended' },
            seasons: [],
            artworks: [],
            characters: [],
            genres: [],
            translations: {
              nameTranslations: [
                { language: 'ces', name: 'Akta X' },
                { language: 'eng', name: 'The X-Files' },
              ],
              overviewTranslations: [
                { language: 'ces', overview: 'Czech overview' },
                { language: 'eng', overview: 'English overview' },
              ],
            },
          },
        };
      }) as any,
    );

    const show = await provider.getShow(77398, 'en');

    expect(show.title).toBe('The X-Files');
    expect(show.overview).toBe('English overview');
  });

  it('maps TVDB ita translations to the app it locale', async () => {
    const provider = new TvdbProvider(
      fakeClientWithHandler(() => ({
        data: {
          id: 1,
          name: 'English Movie',
          artworks: [],
          characters: [],
          genres: [],
          remoteIds: [],
          translations: {
            nameTranslations: [
              { language: 'eng', name: 'English Movie' },
              { language: 'ita', name: 'Film italiano' },
            ],
            overviewTranslations: [{ language: 'ita', overview: 'Descrizione italiana' }],
          },
        },
      })) as any,
    );

    const movie = await provider.getMovie(1, 'it');

    expect(movie.title).toBe('Film italiano');
    expect(movie.translations?.it?.title).toBe('Film italiano');
    expect((movie.translations as any)?.ita).toBeUndefined();
  });
});

describe('TvdbProvider — artwork mapping (v4 types)', () => {
  it('series: type 2 is the poster, type 3 the backdrop — never the type-1 banner', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/368495/extended': {
          id: 368495,
          name: 'Show',
          status: { name: 'Ended' },
          artworks: [
            { type: 1, image: 'banner.jpg' },
            { type: 2, image: 'poster.jpg' },
            { type: 3, image: 'fanart.jpg' },
          ],
        },
        '/series/368495/episodes': { episodes: [] },
      }) as any,
    );
    const show = await provider.getShow(368495, 'en');
    expect(show.posterUrl).toBe('https://art/poster.jpg');
    expect(show.backdropUrl).toBe('https://art/fanart.jpg');
  });

  it('series: a banner fills the backdrop only when no fanart exists — poster stays null', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/368495/extended': {
          id: 368495,
          name: 'Show',
          status: { name: 'Ended' },
          artworks: [{ type: 1, image: 'banner.jpg' }],
        },
        '/series/368495/episodes': { episodes: [] },
      }) as any,
    );
    const show = await provider.getShow(368495, 'en');
    expect(show.posterUrl).toBeNull();
    expect(show.backdropUrl).toBe('https://art/banner.jpg');
  });

  it('movie: type 14 is the poster, 15 the backdrop — a type-1 banner never becomes a poster', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/movies/99/extended': {
          id: 99,
          name: 'Movie',
          artworks: [
            { type: 1, image: 'banner.jpg' },
            { type: 14, image: 'poster.jpg' },
            { type: 15, image: 'bg.jpg' },
          ],
        },
      }) as any,
    );
    const movie = await provider.getMovie(99, 'en');
    expect(movie.posterUrl).toBe('https://art/poster.jpg');
    expect(movie.backdropUrl).toBe('https://art/bg.jpg');
  });
});

describe('TvdbProvider artwork galleries', () => {
  it('uses series backgrounds and posters but excludes banners', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/77/extended': {
          id: 77,
          artworks: [
            { id: 1, type: 1, image: 'banner.jpg' },
            { id: 2, type: 2, image: 'poster.jpg' },
            { id: 3, type: 3, image: 'background.jpg' },
          ],
        },
      }) as any,
    );

    await expect(provider.getShowArtwork(77)).resolves.toEqual([
      expect.objectContaining({ kind: 'POSTER', providerImageId: '2' }),
      expect.objectContaining({ kind: 'BACKDROP', providerImageId: '3' }),
    ]);
  });

  it('returns only the single TVDB episode image', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/episodes/88/extended': {
          id: 88,
          seriesId: 77,
          number: 1,
          name: 'Episode',
          image: 'episode.jpg',
        },
      }) as any,
    );

    await expect(provider.getEpisodeArtwork(88)).resolves.toEqual([
      expect.objectContaining({ kind: 'STILL', providerImageId: '88' }),
    ]);
  });
});

describe('TvdbProvider.findMovieByImdb', () => {
  const imdbId = 'tt33764258';
  function setup(
    results: unknown = [{ movie: { id: 362547 } }],
    remoteIds: unknown = [
      { sourceName: 'IMDB', id: imdbId },
      { sourceName: 'TheMovieDB.com', id: '1368337' },
    ],
  ) {
    const client = fakeClientWithHandler((path) =>
      path.startsWith('/search/remoteid/')
        ? { data: results }
        : { data: { id: 362547, remoteIds } },
    );
    return { client, provider: new TvdbProvider(client as any) };
  }

  it('uses the typed remote-id route and verifies the extended movie', async () => {
    const { provider, client } = setup([{ series: { id: 777 } }, { movie: { id: 362547 } }]);
    await expect(provider.findMovieByImdb(imdbId, 1368337)).resolves.toEqual({
      tvdbId: 362547,
      tmdbId: 1368337,
      imdbId,
    });
    expect(client.get.mock.calls.map((call) => call[0])).toEqual([
      '/search/remoteid/tt33764258',
      '/movies/362547/extended',
    ]);
  });

  it.each([
    [[]],
    [[{ series: { id: 362547 } }, { episode: { id: 362547 } }, { people: { id: 362547 } }]],
    [[{ movie: { id: 362547 } }, { movie: { id: 999 } }]],
    [[{ movie: { id: -1 } }]],
    [[{ movie: { id: 'movie-362547' } }]],
  ])('refuses absent, ambiguous or malformed movie results %j', async (results) => {
    const { provider, client } = setup(results);
    await expect(provider.findMovieByImdb(imdbId, 1368337)).resolves.toBeNull();
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated base records for the same movie', async () => {
    const { provider } = setup([{ movie: { id: 362547 } }, { movie: { id: 362547 } }]);
    await expect(provider.findMovieByImdb(imdbId)).resolves.toMatchObject({ tvdbId: 362547 });
  });

  it.each([
    [[{ sourceName: 'IMDB', id: 'tt999' }]],
    [
      [
        { sourceName: 'IMDB', id: imdbId },
        { sourceName: 'TMDB', id: '99' },
      ],
    ],
    [[{ sourceName: 'TMDB', id: '1368337' }]],
  ])('refuses missing proof or a contradictory remote ID %j', async (remoteIds) => {
    const { provider } = setup(undefined, remoteIds);
    await expect(provider.findMovieByImdb(imdbId, 1368337)).resolves.toBeNull();
  });

  it('allows an exact IMDb match with no TMDB link', async () => {
    const { provider } = setup(undefined, [{ sourceName: 'IMDB', id: imdbId }]);
    await expect(provider.findMovieByImdb(imdbId, 1368337)).resolves.toMatchObject({
      tvdbId: 362547,
      tmdbId: null,
    });
  });

  it('refuses contradictory extended aliases', async () => {
    const { provider } = setup(undefined, [
      { sourceName: 'IMDB', id: imdbId },
      { sourceName: 'IMDB', id: 'tt999' },
    ]);
    await expect(provider.findMovieByImdb(imdbId)).rejects.toThrow('Conflicting');
  });

  it('rejects an extended record for a different movie', async () => {
    const { provider, client } = setup();
    client.get
      .mockResolvedValueOnce({ data: [{ movie: { id: 362547 } }] })
      .mockResolvedValueOnce({ data: { id: 999 } });
    await expect(provider.findMovieByImdb(imdbId)).rejects.toThrow('different movie');
  });

  it('propagates provider errors and malformed responses for retry', async () => {
    const { provider, client } = setup(null);
    await expect(provider.findMovieByImdb(imdbId)).rejects.toThrow('Invalid TVDB');
    client.get.mockRejectedValueOnce(new Error('timeout'));
    await expect(provider.findMovieByImdb(imdbId)).rejects.toThrow('timeout');
  });

  it('does not send a bare numeric TMDB ID as an IMDb remote ID', async () => {
    const { provider, client } = setup();
    await expect(provider.findMovieByImdb('1368337')).resolves.toBeNull();
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('TVDB season presentation metadata', () => {
  it('keeps the title and poster from the selected season order', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/99/extended': {
          id: 99,
          name: 'Anthology',
          defaultSeasonType: 1,
          seasons: [
            {
              id: 200,
              number: 4,
              type: { id: 2, type: 'dvd' },
              name: 'DVD title',
              image: 'dvd.jpg',
            },
            {
              id: 201,
              number: 4,
              type: { id: 1, type: 'official' },
              name: 'The Lizzie Borden Story',
              image: 'season-4.jpg',
            },
          ],
        },
        '/series/99/episodes': {
          episodes: [{ id: 1, seasonNumber: 4, number: 1, name: 'Bloodbath' }],
        },
      }) as any,
    );
    const result = await provider.getShow(99, 'en', { seasonType: 'official' });
    expect(result.seasons[0]).toMatchObject({
      tmdbId: 201,
      number: 4,
      title: 'The Lizzie Borden Story',
      posterUrl: 'https://art/season-4.jpg',
    });
  });
  it.each([true, false])(
    'does not guess another order when the matching season is absent (multiple=%s)',
    async (multiple) => {
      const provider = new TvdbProvider(
        fakeClient({
          '/series/99/extended': {
            id: 99,
            name: 'Anthology',
            seasons: [
              { id: 200, number: 4, type: { id: 2, type: 'dvd' }, name: 'DVD title' },
              ...(multiple
                ? [
                    {
                      id: 201,
                      number: 4,
                      type: { id: 3, type: 'absolute' },
                      name: 'Absolute title',
                    },
                  ]
                : []),
            ],
          },
          '/series/99/episodes': {
            episodes: [{ id: 1, seasonNumber: 4, number: 1, name: 'Bloodbath' }],
          },
        }) as any,
      );
      expect((await provider.getShow(99, 'en', { seasonType: 'official' })).seasons[0].title).toBe(
        'Season 4',
      );
    },
  );
});

describe('TVDB broadcast schedule identity', () => {
  it('reads the Slow Horses schedule without a stale provider cache', async () => {
    const client = fakeClientWithHandler(() => ({
      data: {
        id: 372264,
        airsTime: '00:00',
        originalCountry: 'gbr',
        originalNetwork: { name: 'Apple TV' },
      },
    }));
    const provider = new TvdbProvider(client as any);
    await expect(provider.getBroadcastSchedule(372264)).resolves.toEqual({
      airTime: '00:00',
      timeZone: 'America/New_York',
      legacyTimeZone: 'Europe/London',
    });
    expect(client.get).toHaveBeenCalledWith('/series/372264/extended', {}, 'eng', {
      bypassCache: true,
    });
  });

  it('rejects a schedule response for a different series', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/372264/extended': { id: 999, airsTime: '00:00', originalCountry: 'gbr' },
      }) as any,
    );
    await expect(provider.getBroadcastSchedule(372264)).rejects.toThrow('identity mismatch');
  });

  it('rejects an episode response for a different episode', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/episodes/11839840/extended': { id: 11839913, seriesId: 372264, aired: '2026-09-23' },
      }) as any,
    );
    await expect(provider.getEpisode(11839840)).rejects.toThrow('identity mismatch');
  });
});

describe('TVDB trailer metadata', () => {
  const trailers = [
    { language: 'eng', name: 'Trailer', url: 'https://www.youtube.com/watch?v=O9ZJChzPn0U' },
  ];
  it('preserves the series trailer instead of hardcoding null', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/series/372264/extended': { id: 372264, name: 'Slow Horses', trailers },
        '/series/372264/episodes': { episodes: [] },
      }) as any,
    );
    expect((await provider.getShow(372264, 'en')).trailerUrl).toBe(trailers[0].url);
  });
  it('preserves the movie trailer from the extended record', async () => {
    const provider = new TvdbProvider(
      fakeClient({
        '/movies/9/extended': { id: 9, name: 'Movie', trailers },
      }) as any,
    );
    expect((await provider.getMovie(9, 'en')).trailerUrl).toBe(trailers[0].url);
  });
});

describe('TvdbProvider.findSeriesByImdb', () => {
  const imdbId = 'tt13207736';
  function setup(
    results: unknown = [{ series: { id: 424242 } }],
    remoteIds: unknown = [
      { sourceName: 'IMDB', id: imdbId },
      { sourceName: 'TheMovieDB.com', id: '299939' },
    ],
  ) {
    const client = fakeClientWithHandler((path) =>
      path.startsWith('/search/remoteid/')
        ? { data: results }
        : { data: { id: 424242, name: 'Monster', year: '2026', remoteIds } },
    );
    return { client, provider: new TvdbProvider(client as any) };
  }

  it('uses the typed remote-id route and verifies the extended series', async () => {
    const { provider, client } = setup([{ movie: { id: 777 } }, { series: { id: 424242 } }]);
    await expect(provider.findSeriesByImdb(imdbId, 299939)).resolves.toEqual({
      tvdbId: 424242,
      tmdbId: 299939,
      imdbId,
    });
    expect(client.get.mock.calls.map((call) => call[0])).toEqual([
      '/search/remoteid/tt13207736',
      '/series/424242/extended',
    ]);
  });

  it.each([
    [[]],
    [[{ movie: { id: 424242 } }, { episode: { id: 424242 } }]],
    [[{ series: { id: 424242 } }, { series: { id: 999 } }]],
    [[{ series: { id: 0 } }]],
  ])('refuses absent, ambiguous or malformed series results %j', async (results) => {
    const { provider, client } = setup(results);
    await expect(provider.findSeriesByImdb(imdbId, 299939)).resolves.toBeNull();
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('refuses a series whose own record links to another IMDb or TMDB title', async () => {
    await expect(
      setup(undefined, [{ sourceName: 'IMDB', id: 'tt1' }]).provider.findSeriesByImdb(imdbId),
    ).resolves.toBeNull();
    await expect(setup().provider.findSeriesByImdb(imdbId, 5)).resolves.toBeNull();
  });

  it('returns title and year evidence from the same extended record', async () => {
    const { provider } = setup();
    await expect(provider.getShowEvidence(424242)).resolves.toMatchObject({
      tvdbId: 424242,
      imdbId,
      titles: ['Monster'],
      year: 2026,
    });
  });
});
