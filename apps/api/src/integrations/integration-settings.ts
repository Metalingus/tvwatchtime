import type {
  IntegrationCapability,
  IntegrationMediaSyncSettings,
  IntegrationOpenClient,
  IntegrationProvider,
  IntegrationSyncSettings,
  UpdateIntegrationSettingsDto,
} from '@tvwatch/shared';
import type { InboundSyncItem } from './providers/types';

export const INTEGRATION_CAPABILITIES: Record<IntegrationProvider, IntegrationCapability[]> = {
  SIMKL: ['WATCHED', 'WATCHLIST', 'RATINGS'],
  STREMIO: ['WATCHED', 'WATCHLIST'],
  JELLYFIN: ['WATCHED', 'WATCHLIST', 'COLLECTIONS'],
  PLEX: ['WATCHED', 'WATCHLIST', 'COLLECTIONS'],
  EMBY: ['WATCHED', 'WATCHLIST', 'COLLECTIONS'],
};

const EMPTY_MEDIA_SETTINGS: IntegrationMediaSyncSettings = {
  watched: false,
  watchlist: false,
  favorites: false,
  ratings: false,
};

const CAPABILITY_KEY: Partial<Record<IntegrationCapability, keyof IntegrationMediaSyncSettings>> = {
  WATCHED: 'watched',
  WATCHLIST: 'watchlist',
  FAVORITES: 'favorites',
  RATINGS: 'ratings',
};

export function normalizeIntegrationOpenClient(
  provider: IntegrationProvider,
  value: unknown,
): IntegrationOpenClient {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const configured = input.preferredOpenClient;
  if (configured === 'WEB') return configured;
  if (provider === 'EMBY' && configured === 'EMBY') return configured;
  if (provider === 'JELLYFIN' && configured === 'SWIFTFIN') return configured;
  return 'AUTO';
}

function supportedMediaSettings(
  provider: IntegrationProvider,
): Set<keyof IntegrationMediaSyncSettings> {
  return new Set(
    INTEGRATION_CAPABILITIES[provider].flatMap((capability) => {
      const setting = CAPABILITY_KEY[capability];
      return setting ? [setting] : [];
    }),
  );
}

export function defaultIntegrationSyncSettings(
  provider: IntegrationProvider,
): IntegrationSyncSettings {
  const supported = supportedMediaSettings(provider);
  const media = (): IntegrationMediaSyncSettings => ({
    watched: supported.has('watched'),
    watchlist: supported.has('watchlist'),
    favorites: supported.has('favorites'),
    ratings: supported.has('ratings'),
  });
  return {
    movies: media(),
    shows: media(),
    collections: INTEGRATION_CAPABILITIES[provider].includes('COLLECTIONS'),
  };
}

export function normalizeIntegrationSyncSettings(
  provider: IntegrationProvider,
  value: unknown,
): IntegrationSyncSettings {
  const defaults = defaultIntegrationSyncSettings(provider);
  const input = value && typeof value === 'object' ? (value as Record<string, any>) : {};
  const supported = supportedMediaSettings(provider);
  const media = (key: 'movies' | 'shows'): IntegrationMediaSyncSettings => {
    const configured =
      input[key] && typeof input[key] === 'object' ? (input[key] as Record<string, unknown>) : {};
    const migrateServerFavorites =
      (provider === 'JELLYFIN' || provider === 'EMBY') &&
      configured.favorites === true &&
      configured.watchlist === false;
    return Object.fromEntries(
      (Object.keys(EMPTY_MEDIA_SETTINGS) as Array<keyof IntegrationMediaSyncSettings>).map(
        (setting) => [
          setting,
          supported.has(setting)
            ? setting === 'watchlist' && migrateServerFavorites
              ? true
              : typeof configured[setting] === 'boolean'
                ? configured[setting]
                : defaults[key][setting]
            : false,
        ],
      ),
    ) as unknown as IntegrationMediaSyncSettings;
  };
  return {
    movies: media('movies'),
    shows: media('shows'),
    collections:
      INTEGRATION_CAPABILITIES[provider].includes('COLLECTIONS') &&
      (typeof input.collections === 'boolean' ? input.collections : defaults.collections),
  };
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
    collections: update?.collections ?? normalized.collections,
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
    if (item.entityType === 'LIST' || item.entityType === 'LIST_ITEM') {
      return settings.collections;
    }
    const media = item.mediaType === 'MOVIE' ? settings.movies : settings.shows;
    return media[itemSetting(item)];
  });
}
