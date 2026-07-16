import { TvdbProvider } from './tvdb.provider';

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

describe('TvdbProvider — episode + translations', () => {
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
      fakeClient({ '/series/77/translations/ja': { name: 'タイトル', overview: 'あらすじ' } }) as any,
    );
    const t = await provider.getSeriesTranslations(77, 'ja');
    expect(t).toEqual({ title: 'タイトル', overview: 'あらすじ', locale: 'ja' });
  });

  it('returns null fields when a translation is missing', async () => {
    const provider = new TvdbProvider(
      fakeClient({ '/movies/9/translations/fr': {} }) as any,
    );
    const t = await provider.getMovieTranslations(9, 'fr');
    expect(t).toEqual({ title: null, overview: null, locale: 'fr' });
  });
});
