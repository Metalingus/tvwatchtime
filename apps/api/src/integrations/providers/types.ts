export type InboundEntityType =
  | 'SHOW_STATE'
  | 'LIST'
  | 'LIST_ITEM'
  | 'WATCHED_EPISODE'
  | 'WATCHED_MOVIE'
  | 'WATCHLIST_SHOW'
  | 'WATCHLIST_MOVIE'
  | 'FAVORITE_SHOW'
  | 'FAVORITE_MOVIE'
  | 'SHOW_RATING'
  | 'EPISODE_RATING'
  | 'MOVIE_RATING';

export type InboundShowTrackingState = 'ACTIVE' | 'PAUSED' | 'DROPPED';

export interface InboundExternalIds {
  imdb?: string | null;
  tmdb?: number | null;
  tvdb?: number | null;
}

export function hasTrustedExternalId(ids: InboundExternalIds): boolean {
  const imdb = typeof ids.imdb === 'string' ? ids.imdb.trim() : '';
  const validNumericId = (value: number | null | undefined) =>
    Number.isSafeInteger(value) && Number(value) > 0;
  return /^tt\d+$/i.test(imdb) || validNumericId(ids.tmdb) || validNumericId(ids.tvdb);
}

export interface InboundSyncItem {
  entityType: InboundEntityType;
  mediaType: 'SHOW' | 'MOVIE';
  title: string;
  year?: number | null;
  ids: InboundExternalIds;
  episodeIds?: InboundExternalIds;
  /** Episode name, when the source has one (fallback evidence without episode ids). */
  episodeTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  watchedAt?: string | null;
  watchCount?: number | null;
  rating?: number | null;
  showState?: InboundShowTrackingState;
  listKey?: string;
  listTitle?: string;
  listOrder?: number;
  sourceKey: string;
  /** Provider-native identity/state used internally for bidirectional reconciliation. */
  providerItemId?: string;
  providerCategory?: 'shows' | 'movies' | 'anime';
  providerStatus?: string | null;
  providerRating?: number | null;
}

export interface ProviderSnapshotScope {
  entityType: InboundEntityType;
  /** Only contributions whose source key starts with this value belong to the snapshot. */
  sourceKeyPrefix: string;
}

export interface ProviderSyncPayload {
  items: InboundSyncItem[];
  cursor?: Record<string, unknown> | null;
  /** Entity types for which this payload is a complete provider snapshot. */
  snapshotEntityTypes?: InboundEntityType[];
  /** Narrow complete snapshots for providers with multiple independently fetched surfaces. */
  snapshotScopes?: ProviderSnapshotScope[];
}
