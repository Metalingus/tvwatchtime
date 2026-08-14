import {
  defaultIntegrationSyncSettings,
  filterIntegrationItems,
  mergeIntegrationSyncSettings,
  normalizeIntegrationSyncSettings,
} from './integration-settings';
import type { InboundSyncItem } from './providers/types';

const item = (
  entityType: InboundSyncItem['entityType'],
  mediaType: InboundSyncItem['mediaType'],
): InboundSyncItem => ({
  entityType,
  mediaType,
  title: `${mediaType} ${entityType}`,
  ids: {},
  sourceKey: `${mediaType}:${entityType}`,
});

describe('integration sync settings', () => {
  it('enables every supported provider capability by default', () => {
    expect(defaultIntegrationSyncSettings('SIMKL')).toEqual({
      movies: { watched: true, watchlist: true, favorites: false, ratings: true },
      shows: { watched: true, watchlist: true, favorites: false, ratings: true },
    });
    expect(defaultIntegrationSyncSettings('JELLYFIN')).toEqual({
      movies: { watched: true, watchlist: true, favorites: false, ratings: false },
      shows: { watched: true, watchlist: true, favorites: false, ratings: false },
    });
  });

  it('migrates legacy Jellyfin favorite toggles to watchlist toggles', () => {
    expect(
      normalizeIntegrationSyncSettings('JELLYFIN', {
        movies: { watched: true, watchlist: false, favorites: true, ratings: false },
        shows: { watched: true, watchlist: false, favorites: true, ratings: false },
      }),
    ).toEqual({
      movies: { watched: true, watchlist: true, favorites: false, ratings: false },
      shows: { watched: true, watchlist: true, favorites: false, ratings: false },
    });
  });

  it('never enables a capability the provider cannot supply', () => {
    expect(
      normalizeIntegrationSyncSettings('STREMIO', {
        movies: { favorites: true, ratings: true },
        shows: { favorites: true, ratings: true },
      }),
    ).toEqual({
      movies: { watched: true, watchlist: true, favorites: false, ratings: false },
      shows: { watched: true, watchlist: true, favorites: false, ratings: false },
    });
  });

  it('merges one media-type setting without resetting the others', () => {
    const settings = mergeIntegrationSyncSettings('SIMKL', null, {
      movies: { ratings: false },
    });
    expect(settings.movies.ratings).toBe(false);
    expect(settings.movies.watched).toBe(true);
    expect(settings.shows.ratings).toBe(true);
  });

  it('filters normalized provider items by media type and activity', () => {
    const items = [
      item('WATCHED_MOVIE', 'MOVIE'),
      item('MOVIE_RATING', 'MOVIE'),
      item('WATCHED_EPISODE', 'SHOW'),
      item('SHOW_RATING', 'SHOW'),
    ];
    const settings = mergeIntegrationSyncSettings('SIMKL', null, {
      movies: { watched: false },
      shows: { ratings: false },
    });
    expect(filterIntegrationItems(items, settings).map((entry) => entry.entityType)).toEqual([
      'MOVIE_RATING',
      'WATCHED_EPISODE',
    ]);
  });

  it('treats SIMKL show state as a show watchlist capability', () => {
    const showState = item('SHOW_STATE', 'SHOW');
    expect(filterIntegrationItems([showState], defaultIntegrationSyncSettings('SIMKL'))).toEqual([
      showState,
    ]);
    const disabled = mergeIntegrationSyncSettings('SIMKL', null, {
      shows: { watchlist: false },
    });
    expect(filterIntegrationItems([showState], disabled)).toEqual([]);
  });

  it('keeps provider list metadata and items independent of watchlist membership toggles', () => {
    const list = item('LIST', 'MOVIE');
    const listItem = item('LIST_ITEM', 'SHOW');
    const disabled = mergeIntegrationSyncSettings('JELLYFIN', null, {
      movies: { watchlist: false },
      shows: { watchlist: false },
    });
    expect(filterIntegrationItems([list, listItem], disabled)).toEqual([list, listItem]);
  });
});
