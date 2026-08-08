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
  handler: (path: string, params?: Record<string, string | number | undefined>) => any,
) {
  return {
    enabled: true,
    apiKey: 'k',
    artwork: (p?: string | null) => (p ? `https://art/${p}` : null),
    get: jest.fn(
      async <T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> =>
        handler(path, params) as T,
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
