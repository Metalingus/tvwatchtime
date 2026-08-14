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

export interface InboundSyncItem {
  entityType: InboundEntityType;
  mediaType: 'SHOW' | 'MOVIE';
  title: string;
  year?: number | null;
  ids: InboundExternalIds;
  episodeIds?: InboundExternalIds;
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
}

export interface ProviderSyncPayload {
  items: InboundSyncItem[];
  cursor?: Record<string, unknown> | null;
}
