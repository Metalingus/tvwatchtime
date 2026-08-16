import { decodeStremioWatched } from './stremio.client';
import { normalizeSimklItems, SimklClient } from './simkl.client';
import {
  isPrivateAddress,
  jellyfinItemIdFromSourceKey,
  jellyfinWebUrl,
  JellyfinClient,
  normalizeJellyfinUrl,
  swiftfinItemUrl,
} from './jellyfin.client';
import { providerJson } from './provider-http';
import {
  embyAndroidItemUrl,
  embyIosItemUrl,
  embyItemIdFromSourceKey,
  embyWebUrl,
  EmbyClient,
} from './emby.client';
import { PlexClient, plexWatchUrl } from './plex.client';

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

function createServerConfig() {
  const values: Record<string, unknown> = {
    'integrations.allowPrivateUrls': true,
    'integrations.appName': 'TVWatch',
    'integrations.appVersion': '2.4.1',
  };
  return { get: jest.fn((key: string) => values[key]) } as any;
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

  it('keeps the Jellyfin server ID returned during authentication', async () => {
    (providerJson as jest.Mock).mockResolvedValue({
      AccessToken: 'token',
      ServerId: 'server-1',
      User: { Id: 'user-1', Name: 'Viewer' },
    });
    const client = new JellyfinClient({ get: jest.fn().mockReturnValue(true) } as any);

    await expect(client.connect('http://jellyfin.local', 'viewer', 'password')).resolves.toEqual({
      serverUrl: 'http://jellyfin.local',
      accessToken: 'token',
      userId: 'user-1',
      serverId: 'server-1',
      displayName: 'Viewer',
    });
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

  it('skips Jellyfin collection requests when collection import is disabled', async () => {
    (providerJson as jest.Mock).mockResolvedValueOnce({ Items: [], TotalRecordCount: 0 });
    const client = new JellyfinClient({ get: jest.fn().mockReturnValue(true) } as any);

    const result = await client.sync(
      {
        serverUrl: 'http://jellyfin.local',
        accessToken: 'token',
        userId: 'user-1',
      },
      { includeCollections: false },
    );

    expect(providerJson).toHaveBeenCalledTimes(1);
    expect(result.snapshotEntityTypes).toEqual(expect.arrayContaining(['LIST', 'LIST_ITEM']));
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
    expect(swiftfinItemUrl('server-1', 'user-1', 'movie-1')).toBe(
      'swiftfin://server-1/user-1/item/movie-1',
    );
  });

  it('resolves and caches the Jellyfin server ID for connections saved before native links', async () => {
    (providerJson as jest.Mock).mockResolvedValue({ Id: 'server-1' });
    const client = new JellyfinClient({ get: jest.fn().mockReturnValue(true) } as any);
    const credentials = {
      serverUrl: 'http://jellyfin.local',
      accessToken: 'token',
      userId: 'user-1',
    };

    await expect(client.resolveServerId(credentials)).resolves.toBe('server-1');
    await expect(client.resolveServerId(credentials)).resolves.toBe('server-1');
    expect(providerJson).toHaveBeenCalledTimes(1);
    expect(providerJson).toHaveBeenCalledWith(
      'Jellyfin',
      'http://jellyfin.local/System/Info',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Emby-Token': 'token' }),
      }),
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

  it('imports Emby played items, favorites as watchlist, and BoxSets as private lists', async () => {
    (providerJson as jest.Mock)
      .mockResolvedValueOnce({
        Items: [
          {
            Id: 'movie-1',
            Name: 'Played Movie',
            Type: 'Movie',
            ProviderIds: { Tmdb: '10' },
            UserData: {
              Played: true,
              PlayCount: 2,
              LastPlayedDate: '2026-08-13T12:00:00Z',
            },
          },
          {
            Id: 'episode-1',
            Name: 'Episode',
            Type: 'Episode',
            SeriesId: 'series-1',
            SeriesName: 'Played Show',
            ParentIndexNumber: 1,
            IndexNumber: 2,
            UserData: { Played: true, PlayCount: 1 },
          },
        ],
        TotalRecordCount: 2,
      })
      .mockResolvedValueOnce({
        Items: [
          {
            Id: 'series-1',
            Name: 'Played Show',
            Type: 'Series',
            ProviderIds: { Tvdb: '20' },
            UserData: { IsFavorite: true },
          },
        ],
        TotalRecordCount: 1,
      })
      .mockResolvedValueOnce({
        Items: [
          {
            Id: 'series-1',
            Name: 'Played Show',
            Type: 'Series',
            ProviderIds: { Tvdb: '20' },
          },
        ],
        TotalRecordCount: 1,
      })
      .mockResolvedValueOnce({
        Items: [{ Id: 'box-1', Name: 'Emby Collection', Type: 'BoxSet' }],
        TotalRecordCount: 1,
      })
      .mockResolvedValueOnce({
        Items: [
          {
            Id: 'movie-1',
            Name: 'Played Movie',
            Type: 'Movie',
            ProviderIds: { Tmdb: '10' },
          },
        ],
        TotalRecordCount: 1,
      });
    const client = new EmbyClient(createServerConfig());

    const result = await client.sync({
      serverUrl: 'http://emby.local',
      accessToken: 'token',
      userId: 'user-1',
      serverId: 'server-1',
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'WATCHED_MOVIE',
          watchCount: 2,
          sourceKey: 'emby:movie:movie-1:watched',
        }),
        expect.objectContaining({
          entityType: 'WATCHED_EPISODE',
          ids: { tvdb: 20 },
          season: 1,
          episode: 2,
        }),
        expect.objectContaining({
          entityType: 'WATCHLIST_SHOW',
          sourceKey: 'emby:series:series-1:favorite',
        }),
        expect.objectContaining({
          entityType: 'LIST',
          listTitle: 'Emby Collection',
        }),
        expect.objectContaining({
          entityType: 'LIST_ITEM',
          sourceKey: 'emby:boxset:box-1:item:movie-1',
        }),
      ]),
    );
    expect(result.snapshotEntityTypes).toEqual(
      expect.arrayContaining(['WATCHED_MOVIE', 'WATCHLIST_SHOW', 'LIST', 'LIST_ITEM']),
    );
    expect(providerJson).toHaveBeenNthCalledWith(
      1,
      'Emby',
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Emby-Authorization': expect.stringContaining('Emby UserId="user-1"'),
        }),
      }),
    );
  });

  it('builds Emby details links and extracts synced item IDs', () => {
    expect(embyItemIdFromSourceKey('emby:series:series-1:episode:episode-1:watched')).toBe(
      'series-1',
    );
    expect(embyWebUrl('https://media.example.com/emby', 'server-1', 'series-1')).toBe(
      'https://media.example.com/web/index.html#!/item?id=series-1&serverId=server-1',
    );
    expect(embyIosItemUrl('server-1', 'series-1')).toBe(
      'emby://items?serverId=server-1&itemId=series-1',
    );
    expect(embyAndroidItemUrl('server-1', 'series-1')).toBe('emby://items/server-1/series-1');
  });

  it('skips Emby collection requests when collection import is disabled', async () => {
    (providerJson as jest.Mock)
      .mockResolvedValueOnce({ Items: [], TotalRecordCount: 0 })
      .mockResolvedValueOnce({ Items: [], TotalRecordCount: 0 })
      .mockResolvedValueOnce({ Items: [], TotalRecordCount: 0 });
    const client = new EmbyClient(createServerConfig());

    const result = await client.sync(
      {
        serverUrl: 'http://emby.local',
        accessToken: 'token',
        userId: 'user-1',
        serverId: 'server-1',
      },
      { includeCollections: false },
    );

    expect(providerJson).toHaveBeenCalledTimes(3);
    expect(result.snapshotEntityTypes).toEqual(expect.arrayContaining(['LIST', 'LIST_ITEM']));
  });

  it('returns a pending result while a Plex strong PIN is still unclaimed', async () => {
    (providerJson as jest.Mock).mockResolvedValueOnce({ authToken: null });
    const client = new PlexClient(createServerConfig());

    await expect(
      client.completeLink({ id: '123', code: 'ABCD', clientIdentifier: 'client-1' }),
    ).resolves.toBeNull();
    expect(providerJson).toHaveBeenCalledWith(
      'Plex',
      'https://plex.tv/api/v2/pins/123?code=ABCD',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Plex-Client-Identifier': 'client-1' }),
      }),
    );
  });

  it('syncs a Plex cloud Watchlist without resolving a media server', async () => {
    (providerJson as jest.Mock).mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          {
            guid: 'plex://movie/cloud-1',
            type: 'movie',
            title: 'Cloud Movie',
            year: 2026,
            Guid: [{ id: 'tmdb://10' }],
          },
        ],
      },
    });
    const client = new PlexClient(createServerConfig());

    const result = await client.syncAccount({
      accountToken: 'account-token',
      clientIdentifier: 'client-1',
      machineIdentifier: 'unreachable-machine',
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        entityType: 'WATCHLIST_MOVIE',
        title: 'Cloud Movie',
        ids: { tmdb: 10 },
      }),
    ]);
    expect(result.snapshotScopes).toEqual(
      expect.arrayContaining([
        { entityType: 'WATCHLIST_MOVIE', sourceKeyPrefix: 'plex:watchlist:' },
        { entityType: 'WATCHLIST_SHOW', sourceKeyPrefix: 'plex:watchlist:' },
      ]),
    );
    expect(String((providerJson as jest.Mock).mock.calls[0][1])).toContain(
      'https://discover.provider.plex.tv/library/sections/watchlist/all',
    );
  });

  it('imports Plex server data plus account watchlist and watched episodes without a TV section', async () => {
    const client = new PlexClient(createServerConfig());
    (providerJson as jest.Mock).mockResolvedValueOnce({
      id: 123,
      code: 'plex-code',
      expiresIn: 600,
    });
    const link = await client.startLink();
    expect(link.verificationUrl).toContain('https://app.plex.tv/auth#?');
    expect(link.clientIdentifier).toBeTruthy();

    (providerJson as jest.Mock)
      .mockResolvedValueOnce([
        {
          name: 'Living Room',
          clientIdentifier: 'machine-1',
          provides: 'server',
          owned: true,
          accessToken: 'server-token',
          connections: [{ uri: 'http://plex.local:32400', local: true }],
        },
      ])
      .mockResolvedValueOnce({
        MediaContainer: { Directory: [{ key: '1', type: 'movie' }] },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'movie-1',
              key: '/library/metadata/movie-1',
              type: 'movie',
              title: 'Plex Movie',
              year: 2025,
              viewCount: 2,
              lastViewedAt: 1_755_086_400,
              Guid: [{ id: 'tmdb://10' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'collection-1',
              key: '/library/collections/collection-1',
              type: 'collection',
              title: 'Plex Collection',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'movie-1',
              key: '/library/metadata/movie-1',
              type: 'movie',
              title: 'Plex Movie',
              year: 2025,
              Guid: [{ id: 'tmdb://10' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'playlist-1',
              key: '/playlists/playlist-1/items',
              type: 'playlist',
              playlistType: 'video',
              title: 'Plex Playlist',
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'movie-2',
              key: '/library/metadata/movie-2',
              type: 'movie',
              title: 'Playlist Movie',
              year: 2024,
              Guid: [{ id: 'tmdb://11' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'watchlist-1',
              key: '/library/metadata/watchlist-1',
              guid: 'imdb://tt1234567',
              type: 'movie',
              title: 'Watchlist Movie',
              year: 2024,
            },
            {
              ratingKey: 'online-show-1',
              key: '/library/metadata/online-show-1',
              guid: 'plex://show/online-show-1',
              type: 'show',
              title: 'Account Show',
              year: 2020,
              Guid: [{ id: 'tvdb://100' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'online-show-1',
              type: 'show',
              title: 'Account Show',
              year: 2020,
              viewedLeafCount: 2,
              Guid: [{ id: 'tvdb://100' }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'online-season-1',
              type: 'season',
              index: 1,
              viewedLeafCount: 2,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              ratingKey: 'online-episode-1',
              type: 'episode',
              index: 1,
              viewCount: 1,
              Guid: [{ id: 'tvdb://1001' }],
            },
            {
              ratingKey: 'online-episode-2',
              type: 'episode',
              index: 2,
              viewCount: 2,
              Guid: [{ id: 'tvdb://1002' }],
            },
          ],
        },
      });

    const result = await client.sync({
      accountToken: 'account-token',
      clientIdentifier: link.clientIdentifier,
      machineIdentifier: 'machine-1',
    });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: 'WATCHED_MOVIE',
          ids: { tmdb: 10 },
          watchCount: 2,
        }),
        expect.objectContaining({
          entityType: 'LIST',
          listTitle: 'Plex Collection',
        }),
        expect.objectContaining({
          entityType: 'LIST_ITEM',
          sourceKey: 'plex:machine-1:collection:collection-1:item:movie-1',
        }),
        expect.objectContaining({
          entityType: 'LIST',
          listTitle: 'Plex Playlist',
          sourceKey: 'plex:machine-1:playlist:playlist-1:list',
        }),
        expect.objectContaining({
          entityType: 'LIST_ITEM',
          ids: { tmdb: 11 },
          sourceKey: 'plex:machine-1:playlist:playlist-1:item:movie-2',
        }),
        expect.objectContaining({
          entityType: 'WATCHLIST_MOVIE',
          ids: { imdb: 'tt1234567' },
        }),
        expect.objectContaining({
          entityType: 'WATCHLIST_SHOW',
          ids: { tvdb: 100 },
        }),
        expect.objectContaining({
          entityType: 'WATCHED_EPISODE',
          ids: { tvdb: 100 },
          episodeIds: { tvdb: 1001 },
          season: 1,
          episode: 1,
          sourceKey: 'plex:account:show:online-show-1:episode:online-episode-1:watched',
        }),
      ]),
    );
    expect(result.snapshotScopes).toEqual(
      expect.arrayContaining([
        {
          entityType: 'WATCHED_MOVIE',
          sourceKeyPrefix: 'plex:machine-1:movie:',
        },
        {
          entityType: 'WATCHLIST_MOVIE',
          sourceKeyPrefix: 'plex:watchlist:',
        },
        {
          entityType: 'WATCHED_EPISODE',
          sourceKeyPrefix: 'plex:account:show:online-show-1:episode:',
        },
        {
          entityType: 'LIST',
          sourceKeyPrefix: 'plex:machine-1:playlist:',
        },
      ]),
    );
    const discoverCalls = (providerJson as jest.Mock).mock.calls.filter(([, url]) =>
      String(url).startsWith('https://discover.provider.plex.tv/'),
    );
    expect(discoverCalls).not.toHaveLength(0);
    for (const [, , init] of discoverCalls) {
      expect(init.headers).not.toHaveProperty('X-Plex-Container-Start');
      expect(init.headers).not.toHaveProperty('X-Plex-Container-Size');
    }
  });

  it('resolves a Plex universal watch link from a trusted external ID', async () => {
    (providerJson as jest.Mock).mockResolvedValueOnce({
      MediaContainer: { Metadata: [{ slug: 'example-movie' }] },
    });
    const client = new PlexClient(createServerConfig());

    await expect(
      client.findWatchUrl(
        { accountToken: 'account-token', clientIdentifier: 'client-1' },
        { mediaType: 'MOVIE', ids: { imdb: 'tt1234567', tmdb: 10 } },
      ),
    ).resolves.toBe('https://watch.plex.tv/movie/example-movie');

    const [, rawUrl, init] = (providerJson as jest.Mock).mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.origin).toBe('https://metadata.provider.plex.tv');
    expect(url.pathname).toBe('/library/metadata/matches');
    expect(url.searchParams.get('guid')).toBe('imdb://tt1234567');
    expect(url.searchParams.get('type')).toBe('1');
    expect(init.headers).toEqual(
      expect.objectContaining({
        'X-Plex-Client-Identifier': 'client-1',
        'X-Plex-Token': 'account-token',
      }),
    );
    expect(plexWatchUrl('SHOW', 'example-show')).toBe('https://watch.plex.tv/show/example-show');
  });

  it('falls back from an unmatched IMDb identity to the trusted TMDb identity', async () => {
    (providerJson as jest.Mock)
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
      .mockResolvedValueOnce({
        MediaContainer: { Metadata: [{ slug: 'example-show' }] },
      });
    const client = new PlexClient(createServerConfig());

    await expect(
      client.findWatchUrl(
        { accountToken: 'account-token', clientIdentifier: 'client-1' },
        { mediaType: 'SHOW', ids: { imdb: 'tt1234567', tmdb: 20 } },
      ),
    ).resolves.toBe('https://watch.plex.tv/show/example-show');
    expect(new URL((providerJson as jest.Mock).mock.calls[1][1]).searchParams.get('guid')).toBe(
      'tmdb://20',
    );
  });

  it('does not title-match a Plex watch link without an officially supported ID', async () => {
    const client = new PlexClient(createServerConfig());

    await expect(
      client.findWatchUrl(
        { accountToken: 'account-token', clientIdentifier: 'client-1' },
        { mediaType: 'SHOW', ids: { tvdb: 100 } },
      ),
    ).resolves.toBeNull();
    expect(providerJson).not.toHaveBeenCalled();
  });

  it('skips Plex server collection requests when collection import is disabled', async () => {
    (providerJson as jest.Mock)
      .mockResolvedValueOnce([
        {
          name: 'Home',
          clientIdentifier: 'machine-1',
          provides: 'server',
          owned: true,
          accessToken: 'server-token',
          connections: [{ uri: 'http://plex.local', local: true }],
        },
      ])
      .mockResolvedValueOnce({ MediaContainer: { Directory: [], totalSize: 0 } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [], totalSize: 0 } });
    const client = new PlexClient(createServerConfig());

    const result = await client.sync(
      {
        accountToken: 'account-token',
        clientIdentifier: 'client-1',
        machineIdentifier: 'machine-1',
      },
      { includeCollections: false },
    );

    const urls = (providerJson as jest.Mock).mock.calls.map(([, url]) => String(url));
    expect(urls.some((url) => url.includes('/collections'))).toBe(false);
    expect(urls.some((url) => url.includes('/playlists'))).toBe(false);
    expect(result.snapshotScopes).toEqual(
      expect.arrayContaining([
        { entityType: 'LIST', sourceKeyPrefix: 'plex:machine-1:collection:' },
        { entityType: 'LIST_ITEM', sourceKeyPrefix: 'plex:machine-1:collection:' },
        { entityType: 'LIST', sourceKeyPrefix: 'plex:machine-1:playlist:' },
        { entityType: 'LIST_ITEM', sourceKeyPrefix: 'plex:machine-1:playlist:' },
      ]),
    );
  });

  it('continues Plex pagination when the server caps a page below the requested size', async () => {
    (providerJson as jest.Mock)
      .mockResolvedValueOnce([
        {
          name: 'Home',
          clientIdentifier: 'machine-1',
          provides: 'server',
          owned: true,
          accessToken: 'server-token',
          connections: [{ uri: 'http://plex.local', local: true }],
        },
      ])
      .mockResolvedValueOnce({
        MediaContainer: { Directory: [{ key: '1', type: 'movie' }] },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          offset: 0,
          totalSize: 3,
          Metadata: [
            { ratingKey: '1', type: 'movie', title: 'One', viewCount: 1 },
            { ratingKey: '2', type: 'movie', title: 'Two', viewCount: 1 },
          ],
        },
      })
      .mockResolvedValueOnce({
        MediaContainer: {
          offset: 2,
          totalSize: 3,
          Metadata: [{ ratingKey: '3', type: 'movie', title: 'Three', viewCount: 1 }],
        },
      })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [], totalSize: 0 } });
    const client = new PlexClient(createServerConfig());

    const result = await client.sync(
      {
        accountToken: 'account-token',
        clientIdentifier: 'client-1',
        machineIdentifier: 'machine-1',
      },
      { includeCollections: false },
    );

    expect(result.items.filter((item) => item.entityType === 'WATCHED_MOVIE')).toHaveLength(3);
    expect((providerJson as jest.Mock).mock.calls[3][2].headers).toMatchObject({
      'X-Plex-Container-Start': '2',
    });
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
