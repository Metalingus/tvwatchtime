import type {
  IntegrationCapability,
  IntegrationMediaSyncSettings,
  IntegrationProvider,
  IntegrationSyncSettings,
  UpdateIntegrationSettingsDto,
} from '@tvwatch/shared';
import type { InboundSyncItem } from './providers/types';

export const INTEGRATION_CAPABILITIES: Record<IntegrationProvider, IntegrationCapability[]> = {
  SIMKL: ['WATCHED', 'WATCHLIST', 'RATINGS'],
  STREMIO: ['WATCHED', 'WATCHLIST'],
  JELLYFIN: ['WATCHED', 'WATCHLIST'],
};

const EMPTY_MEDIA_SETTINGS: IntegrationMediaSyncSettings = {
  watched: false,
  watchlist: false,
  favorites: false,
  ratings: false,
};

const CAPABILITY_KEY: Record<IntegrationCapability, keyof IntegrationMediaSyncSettings> = {
  WATCHED: 'watched',
  WATCHLIST: 'watchlist',
  FAVORITES: 'favorites',
  RATINGS: 'ratings',
};

export function defaultIntegrationSyncSettings(
  provider: IntegrationProvider,
): IntegrationSyncSettings {
  const supported = new Set(INTEGRATION_CAPABILITIES[provider].map((item) => CAPABILITY_KEY[item]));
  const media = (): IntegrationMediaSyncSettings => ({
    watched: supported.has('watched'),
    watchlist: supported.has('watchlist'),
    favorites: supported.has('favorites'),
    ratings: supported.has('ratings'),
  });
  return { movies: media(), shows: media() };
}

export function normalizeIntegrationSyncSettings(
  provider: IntegrationProvider,
  value: unknown,
): IntegrationSyncSettings {
  const defaults = defaultIntegrationSyncSettings(provider);
  const input = value && typeof value === 'object' ? (value as Record<string, any>) : {};
  const supported = new Set(INTEGRATION_CAPABILITIES[provider].map((item) => CAPABILITY_KEY[item]));
  const media = (key: 'movies' | 'shows'): IntegrationMediaSyncSettings => {
    const configured =
      input[key] && typeof input[key] === 'object' ? (input[key] as Record<string, unknown>) : {};
    const migrateJellyfinFavorites =
      provider === 'JELLYFIN' && configured.favorites === true && configured.watchlist === false;
    return Object.fromEntries(
      (Object.keys(EMPTY_MEDIA_SETTINGS) as Array<keyof IntegrationMediaSyncSettings>).map(
        (setting) => [
          setting,
          supported.has(setting)
            ? setting === 'watchlist' && migrateJellyfinFavorites
              ? true
              : typeof configured[setting] === 'boolean'
                ? configured[setting]
                : defaults[key][setting]
            : false,
        ],
      ),
    ) as unknown as IntegrationMediaSyncSettings;
  };
  return { movies: media('movies'), shows: media('shows') };
}

export function mergeIntegrationSyncSettings(
  provider: IntegrationProvider,
  current: unknown,
  update: UpdateIntegrationSettingsDto['syncSettings'],
): IntegrationSyncSettings {
  const normalized = normalizeIntegrationSyncSettings(provider, current);
  return normalizeIntegrationSyncSettings(provider, {
    movies: { ...normalized.movies, ...(update?.movies ?? {}) },
    shows: { ...normalized.shows, ...(update?.shows ?? {}) },
  });
}

function itemSetting(item: InboundSyncItem): keyof IntegrationMediaSyncSettings {
  if (item.entityType === 'LIST' || item.entityType === 'LIST_ITEM') return 'watchlist';
  if (item.entityType === 'SHOW_STATE') return 'watchlist';
  if (item.entityType.startsWith('WATCHED_')) return 'watched';
  if (item.entityType.startsWith('WATCHLIST_')) return 'watchlist';
  if (item.entityType.startsWith('FAVORITE_')) return 'favorites';
  return 'ratings';
}

export function filterIntegrationItems(
  items: InboundSyncItem[],
  settings: IntegrationSyncSettings,
): InboundSyncItem[] {
  return items.filter((item) => {
    // Provider collections are their own private lists, not watchlist membership.
    if (item.entityType === 'LIST' || item.entityType === 'LIST_ITEM') return true;
    const media = item.mediaType === 'MOVIE' ? settings.movies : settings.shows;
    return media[itemSetting(item)];
  });
}
