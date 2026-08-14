import { decodeStremioWatched } from './stremio.client';
import { normalizeSimklItems, SimklClient } from './simkl.client';
import {
  isPrivateAddress,
  jellyfinItemIdFromSourceKey,
  jellyfinWebUrl,
  JellyfinClient,
  normalizeJellyfinUrl,
} from './jellyfin.client';
import { providerJson } from './provider-http';

jest.mock('./provider-http', () => ({
  ...jest.requireActual('./provider-http'),
  providerJson: jest.fn(),
}));

function createSimklClient() {
  const values: Record<string, string> = {
    'integrations.simklClientId': 'client-123',
    'integrations.simklAppName': 'tvwatch',
    'integrations.simklAppVersion': '2.4.1',
  };
  return new SimklClient({ get: jest.fn((key: string) => values[key]) } as any);
}

beforeEach(() => {
  (providerJson as jest.Mock).mockReset();
});

describe('inbound integration provider normalization', () => {
  it('normalizes SIMKL watched episodes, watchlists, movie history, and ratings', () => {
    const items = normalizeSimklItems({
      shows: [
        {
          status: 'watching',
          user_rating: 8,
          user_rated_at: '2026-08-01T00:00:00Z',
          show: {
            title: 'Example Show',
            year: 2025,
            ids: { simkl: 10, imdb: 'tt1234567', tmdb: 20, tvdb: 30 },
          },
          seasons: [
            {
              number: 1,
              episodes: [
                {
                  number: 2,
                  watched_at: '2026-08-02T00:00:00Z',
                  ids: { tvdb_id: 31 },
                },
              ],
            },
          ],
        },
      ],
      movies: [
        {
          status: 'completed',
          last_watched_at: '2026-08-03T00:00:00Z',
          movie: { title: 'Example Movie', year: 2024, ids: { simkl: 11, tmdb: 40 } },
        },
      ],
    });

    expect(items.map((item) => item.entityType)).toEqual([
      'SHOW_STATE',
      'WATCHLIST_SHOW',
      'SHOW_RATING',
      'WATCHED_EPISODE',
      'WATCHED_MOVIE',
    ]);
    expect(items[0]).toMatchObject({ showState: 'ACTIVE' });
    expect(items[3]).toMatchObject({ season: 1, episode: 2, episodeIds: { tvdb: 31 } });
  });

  it('maps SIMKL hold and dropped states and emits active restoration state', () => {
    const items = normalizeSimklItems({
      shows: [
        {
          status: 'hold',
          show: { title: 'Paused Show', ids: { simkl: 20 } },
        },
        {
          status: 'dropped',
          show: { title: 'Dropped Show', ids: { simkl: 21 } },
        },
        {
          status: 'completed',
          show: { title: 'Restored Show', ids: { simkl: 22 } },
        },
      ],
    });

    expect(
      items
        .filter((item) => item.entityType === 'SHOW_STATE')
        .map((item) => [item.title, item.showState]),
    ).toEqual([
      ['Paused Show', 'PAUSED'],
      ['Dropped Show', 'DROPPED'],
      ['Restored Show', 'ACTIVE'],
    ]);
    expect(
      items.filter((item) => item.entityType === 'WATCHLIST_SHOW').map((item) => item.title),
    ).toEqual(['Paused Show', 'Dropped Show']);
  });

  it('does not mark a rating-only completed SIMKL movie watched without a watched date', () => {
    const items = normalizeSimklItems({
      movies: [
        {
          status: 'completed',
          user_rating: 9,
          movie: { title: 'Rated Only', ids: { simkl: 12 } },
        },
      ],
    });
    expect(items.map((item) => item.entityType)).toEqual(['MOVIE_RATING']);
  });

  it('decodes Stremio watched bitfields using the official anchor format', () => {
    const videos = Array.from({ length: 9 }, (_, index) => `tt2934286:1:${index + 1}`);
    const watched = decodeStremioWatched('tt2934286:1:5:5:eJyTZwAAAEAAIA==', videos);
    expect(watched).toContain('tt2934286:1:5');
    expect(watched).not.toContain('tt2934286:1:6');
  });

  it('normalizes Jellyfin base paths and rejects embedded credentials', () => {
    expect(normalizeJellyfinUrl('https://media.example.com/jellyfin/')).toBe(
      'https://media.example.com/jellyfin',
    );
    expect(() => normalizeJellyfinUrl('https://user:pass@media.example.com')).toThrow(
      'Jellyfin server URL is invalid',
    );
  });

  it('recognizes private and reserved Jellyfin targets', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.20')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::10')).toBe(true);
    expect(isPrivateAddress('ff02::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('imports explicit Jellyfin movie and series favorites as watchlist items', async () => {
    (providerJson as jest.Mock)
      .mockResolvedValueOnce({
        Items: [
          {
            Id: 'movie-1',
            Name: 'Favorite Movie',
            Type: 'Movie',
            ProviderIds: { Tmdb: '10' },
            UserData: { IsFavorite: true },
          },
          {
            Id: 'series-1',
            Name: 'Favorite Show',
            Type: 'Series',
            ProviderIds: { Tvdb: '20' },
            UserData: { IsFavorite: true },
          },
        ],
        TotalRecordCount: 2,
      })
      .mockResolvedValueOnce({ Items: [], TotalRecordCount: 0 });
    const client = new JellyfinClient({ get: jest.fn().mockReturnValue(true) } as any);

    const result = await client.sync({
      serverUrl: 'http://jellyfin.local',
      accessToken: 'token',
      userId: 'user-1',
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        entityType: 'WATCHLIST_MOVIE',
        sourceKey: 'movie:movie-1:favorite',
      }),
      expect.objectContaining({
        entityType: 'WATCHLIST_SHOW',
        sourceKey: 'series:series-1:favorite',
      }),
    ]);
  });

  it('imports Jellyfin BoxSets as lists with their movie and series items', async () => {
    (providerJson as jest.Mock)
      .mockResolvedValueOnce({ Items: [], TotalRecordCount: 0 })
      .mockResolvedValueOnce({
        Items: [{ Id: 'box-1', Name: 'My Collection', Type: 'BoxSet' }],
        TotalRecordCount: 1,
      })
      .mockResolvedValueOnce({
        Items: [
          {
            Id: 'movie-1',
            Name: 'Collection Movie',
            Type: 'Movie',
            ProviderIds: { Tmdb: '10' },
          },
          {
            Id: 'series-1',
            Name: 'Collection Show',
            Type: 'Series',
            ProviderIds: { Tvdb: '20' },
          },
        ],
        TotalRecordCount: 2,
      });
    const client = new JellyfinClient({ get: jest.fn().mockReturnValue(true) } as any);

    const result = await client.sync({
      serverUrl: 'http://jellyfin.local',
      accessToken: 'token',
      userId: 'user-1',
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        entityType: 'LIST',
        listKey: 'boxset:box-1',
        listTitle: 'My Collection',
      }),
      expect.objectContaining({
        entityType: 'LIST_ITEM',
        mediaType: 'MOVIE',
        listKey: 'boxset:box-1',
        sourceKey: 'boxset:box-1:item:movie-1',
      }),
      expect.objectContaining({
        entityType: 'LIST_ITEM',
        mediaType: 'SHOW',
        listKey: 'boxset:box-1',
        sourceKey: 'boxset:box-1:item:series-1',
      }),
    ]);
  });

  it('builds Jellyfin details links from synced source keys', () => {
    expect(jellyfinItemIdFromSourceKey('movie:movie-1:favorite')).toBe('movie-1');
    expect(jellyfinItemIdFromSourceKey('series:series-1:episode:episode-1:watched')).toBe(
      'series-1',
    );
    expect(jellyfinItemIdFromSourceKey('boxset:box-1:item:movie-2')).toBe('movie-2');
    expect(jellyfinWebUrl('https://media.example.com/jellyfin/', 'movie-1')).toBe(
      'https://media.example.com/jellyfin/web/#/details?id=movie-1',
    );
  });

  it('resolves an untouched Jellyfin library item by external ID for direct opening', async () => {
    (providerJson as jest.Mock).mockResolvedValueOnce({
      Items: [
        {
          Id: 'movie-2',
          Name: 'Localized Library Title',
          Type: 'Movie',
          ProviderIds: { Imdb: 'tt1234567' },
        },
      ],
      TotalRecordCount: 1,
    });
    const client = new JellyfinClient({ get: jest.fn().mockReturnValue(true) } as any);

    await expect(
      client.findLibraryItemId(
        {
          serverUrl: 'http://jellyfin.local',
          accessToken: 'token',
          userId: 'user-1',
        },
        {
          mediaType: 'MOVIE',
          title: 'Different TVWatch Title',
          year: 2025,
          ids: { imdb: 'tt1234567' },
        },
      ),
    ).resolves.toBe('movie-2');
    expect(providerJson).toHaveBeenCalledWith(
      'Jellyfin',
      expect.stringContaining('SearchTerm=Different+TVWatch+Title'),
      expect.any(Object),
    );
  });
});

describe('SIMKL sync request policy', () => {
  it('pulls initial libraries separately and sequentially before saving activities', async () => {
    const request = providerJson as jest.Mock;
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const shows = deferred<{ shows: [] }>();
    const movies = deferred<{ movies: [] }>();
    const anime = deferred<{ anime: [] }>();
    const activities = deferred<{ all: string }>();
    request
      .mockReturnValueOnce(shows.promise)
      .mockReturnValueOnce(movies.promise)
      .mockReturnValueOnce(anime.promise)
      .mockReturnValueOnce(activities.promise);

    const sync = createSimklClient().sync('access-token');
    expect(request).toHaveBeenCalledTimes(1);
    shows.resolve({ shows: [] });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    movies.resolve({ movies: [] });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(3);
    anime.resolve({ anime: [] });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(4);
    activities.resolve({ all: '2026-08-13T12:00:00Z' });
    const result = await sync;
    const urls = request.mock.calls.map((call) => new URL(call[1]));

    expect(urls.map((url) => url.pathname)).toEqual([
      '/sync/all-items/shows',
      '/sync/all-items/movies',
      '/sync/all-items/anime',
      '/sync/activities',
    ]);
    for (const [index, url] of urls.entries()) {
      expect(url.searchParams.get('client_id')).toBe('client-123');
      expect(url.searchParams.get('app-name')).toBe('tvwatch');
      expect(url.searchParams.get('app-version')).toBe('2.4.1');
      expect(url.searchParams.has('date_from')).toBe(false);
      expect(request.mock.calls[index][2]).toEqual({
        headers: {
          Authorization: 'Bearer access-token',
          'User-Agent': 'tvwatch/2.4.1',
        },
      });
    }
    expect(urls[0].searchParams.get('extended')).toBe('full');
    expect(urls[0].searchParams.get('include_all_episodes')).toBe('yes');
    expect(urls[1].searchParams.has('extended')).toBe(false);
    expect(urls[2].searchParams.get('episode_watched_at')).toBe('yes');
    expect(result.cursor).toEqual({
      all: '2026-08-13T12:00:00Z',
      _tvwatchCheckedAt: expect.any(String),
    });
  });

  it('checks activities before a combined delta and preserves date_from exactly', async () => {
    const request = providerJson as jest.Mock;
    request
      .mockResolvedValueOnce({ all: '2026-08-13T12:00:00Z' })
      .mockResolvedValueOnce({ shows: [], movies: [], anime: [] });
    const previous = '2026-08-12T09:03:45Z';

    await createSimklClient().sync(
      'access-token',
      { all: previous, _tvwatchCheckedAt: '2026-08-12T10:00:00Z' },
      { forceActivityCheck: true },
    );

    const activityUrl = new URL(request.mock.calls[0][1]);
    const deltaUrl = new URL(request.mock.calls[1][1]);
    expect(activityUrl.pathname).toBe('/sync/activities');
    expect(deltaUrl.pathname).toBe('/sync/all-items');
    expect(deltaUrl.searchParams.get('date_from')).toBe(previous);
    expect(deltaUrl.searchParams.get('extended')).toBe('full');
    expect(deltaUrl.searchParams.get('episode_watched_at')).toBe('yes');
    expect(deltaUrl.searchParams.get('include_all_episodes')).toBe('yes');
    expect(deltaUrl.searchParams.get('episode_tvdb_id')).toBe('yes');
  });

  it('skips the delta when activities are unchanged', async () => {
    const request = providerJson as jest.Mock;
    request.mockResolvedValueOnce({ all: '2026-08-13T12:00:00Z' });

    const result = await createSimklClient().sync(
      'access-token',
      { all: '2026-08-13T12:00:00Z', _tvwatchCheckedAt: '2026-08-12T10:00:00Z' },
      { forceActivityCheck: true },
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
  });

  it('throttles non-manual activity checks for 15 minutes', async () => {
    const request = providerJson as jest.Mock;
    const cursor = {
      all: '2026-08-13T12:00:00Z',
      _tvwatchCheckedAt: new Date().toISOString(),
    };

    await expect(createSimklClient().sync('access-token', cursor)).resolves.toEqual({
      items: [],
      cursor,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('adds the required identity to PIN authorization requests', async () => {
    const request = providerJson as jest.Mock;
    request.mockResolvedValueOnce({
      result: 'OK',
      user_code: 'ABCD',
      verification_url: 'https://simkl.com/pin/',
      expires_in: 600,
      interval: 5,
    });

    await createSimklClient().startLink();

    const url = new URL(request.mock.calls[0][1]);
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('app-name')).toBe('tvwatch');
    expect(url.searchParams.get('app-version')).toBe('2.4.1');
    expect(request.mock.calls[0][2]).toEqual({ headers: { 'User-Agent': 'tvwatch/2.4.1' } });
  });

  it('adds the required identity to PIN completion requests', async () => {
    const request = providerJson as jest.Mock;
    request.mockResolvedValueOnce({ result: 'OK', access_token: 'access-token' });

    await expect(createSimklClient().completeLink('AB C')).resolves.toBe('access-token');

    const url = new URL(request.mock.calls[0][1]);
    expect(url.pathname).toBe('/oauth/pin/AB%20C');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('app-name')).toBe('tvwatch');
    expect(url.searchParams.get('app-version')).toBe('2.4.1');
    expect(request.mock.calls[0][2]).toEqual({ headers: { 'User-Agent': 'tvwatch/2.4.1' } });
  });
});
