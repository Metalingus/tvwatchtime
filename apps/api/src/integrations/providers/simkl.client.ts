import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cleanExternalIds, isoOrNull, providerJson } from './provider-http';
import type {
  InboundEntityType,
  InboundShowTrackingState,
  InboundSyncItem,
  ProviderSnapshotScope,
  ProviderSyncPayload,
} from './types';

const API_URL = 'https://api.simkl.com';
const WATCHLIST_STATUSES = new Set(['plantowatch', 'watching', 'hold', 'dropped']);
const ACTIVE_SHOW_STATUSES = new Set(['plantowatch', 'watching', 'completed']);
const ACTIVITY_THROTTLE_MS = 15 * 60_000;
const CHECKED_AT_CURSOR_KEY = '_tvwatchCheckedAt';
const KNOWN_ITEMS_CURSOR_KEY = '_tvwatchKnownItems';
const PROVIDER_TIMEOUT_MS = 30_000;
const EPISODE_SYNC_PARAMS = {
  extended: 'full',
  episode_watched_at: 'yes',
  include_all_episodes: 'yes',
  episode_tvdb_id: 'yes',
};

export type SimklSyncOptions = {
  /** Explicit user actions may bypass the normal 15-minute activity-check throttle. */
  forceActivityCheck?: boolean;
};

export type SimklWriteIds = {
  simkl?: number;
  imdb?: string;
  tmdb?: string;
  tvdb?: string;
  mal?: string;
  kitsu?: string;
};

export type SimklWriteEpisode = {
  number: number;
  watched_at?: string;
};

export type SimklWriteItem = {
  ids: SimklWriteIds;
  title?: string;
  year?: number;
  watched_at?: string;
  status?: 'watching' | 'plantowatch' | 'hold' | 'dropped' | 'completed';
  rating?: number;
  to?: 'watching' | 'plantowatch' | 'hold' | 'dropped' | 'completed';
  use_tvdb_anime_seasons?: boolean;
  seasons?: Array<{ number: number; episodes?: SimklWriteEpisode[] }>;
};

export type SimklWritePayload = {
  movies?: SimklWriteItem[];
  shows?: SimklWriteItem[];
  anime?: SimklWriteItem[];
};

export type SimklWriteResponse = {
  added?: {
    movies?: number | unknown[];
    shows?: number | unknown[];
    episodes?: number;
    statuses?: Array<{
      request?: { ids?: Record<string, unknown> };
      response?: { status?: string; simkl_type?: string; anime_type?: string | null };
    }>;
  };
  deleted?: { movies?: number; shows?: number; episodes?: number };
  not_found?: { movies?: unknown[]; shows?: unknown[]; episodes?: unknown[] };
};

export function simklRatingToStars(value: unknown): number | null {
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) return null;
  return Math.ceil(rating / 2);
}

export function simklNotFoundCount(response: SimklWriteResponse): number {
  return Object.values(response.not_found ?? {}).reduce(
    (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
}

export class SimklApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SimklApiError';
  }

  get retryable(): boolean {
    return (
      this.status === 429 ||
      this.status === 500 ||
      this.status === 502 ||
      this.status === 503 ||
      (this.status === 400 && this.code === 'rate_limit')
    );
  }
}

type SimklMedia = {
  title?: string;
  year?: number;
  ids?: Record<string, unknown>;
};
type SimklListItem = {
  added_to_watchlist_at?: string | null;
  last_watched_at?: string | null;
  user_rated_at?: string | null;
  user_rating?: number | null;
  status?: string;
  show?: SimklMedia;
  movie?: SimklMedia;
  seasons?: Array<{
    number?: number;
    episodes?: Array<{
      number?: number;
      watched_at?: string | null;
      ids?: Record<string, unknown>;
      tvdb?: { season?: number; episode?: number };
    }>;
  }>;
};
type SimklAllItems = {
  shows?: SimklListItem[];
  anime?: SimklListItem[];
  movies?: SimklListItem[];
};

type SimklBaselineKey = keyof SimklAllItems;
type SimklKnownItems = {
  shows: string[];
  anime: string[];
  movies: string[];
};

const SIMKL_SNAPSHOT_TYPES: InboundEntityType[] = [
  'WATCHED_EPISODE',
  'WATCHED_MOVIE',
  'WATCHLIST_SHOW',
  'WATCHLIST_MOVIE',
  'SHOW_RATING',
  'MOVIE_RATING',
];

function simklId(media: SimklMedia | undefined): string | null {
  const value = Number(media?.ids?.simkl);
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function knownItems(payload: SimklAllItems): SimklKnownItems {
  const collect = (rows: SimklListItem[] | undefined, key: 'show' | 'movie') => [
    ...new Set(rows?.flatMap((row) => (simklId(row[key]) ? [simklId(row[key])!] : [])) ?? []),
  ];
  return {
    shows: collect(payload.shows, 'show'),
    anime: collect(payload.anime, 'show'),
    movies: collect(payload.movies, 'movie'),
  };
}

function readKnownItems(
  cursor: Record<string, unknown> | null | undefined,
): SimklKnownItems | null {
  const value = cursor?.[KNOWN_ITEMS_CURSOR_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const list = (key: keyof SimklKnownItems) =>
    Array.isArray(record[key])
      ? (record[key] as unknown[]).filter(
          (item): item is string => typeof item === 'string' && /^\d+$/.test(item),
        )
      : [];
  return { shows: list('shows'), anime: list('anime'), movies: list('movies') };
}

function mergeKnownItems(
  previous: SimklKnownItems | null,
  delta: SimklKnownItems,
): SimklKnownItems {
  if (!previous) return delta;
  return {
    shows: [...new Set([...previous.shows, ...delta.shows])],
    anime: [...new Set([...previous.anime, ...delta.anime])],
    movies: [...new Set([...previous.movies, ...delta.movies])],
  };
}

function removalMarker(activities: Record<string, unknown>): string {
  const value = (key: string) => {
    const block = activities[key];
    if (!block || typeof block !== 'object' || Array.isArray(block)) return '';
    const marker = (block as Record<string, unknown>).removed_from_list;
    return typeof marker === 'string' ? marker : '';
  };
  return [value('tv_shows'), value('anime'), value('movies')].join('|');
}

function scopesForProviderItems(
  shows: Iterable<string>,
  movies: Iterable<string>,
): ProviderSnapshotScope[] {
  const scopes: ProviderSnapshotScope[] = [];
  for (const id of new Set(shows)) {
    for (const entityType of ['WATCHED_EPISODE', 'WATCHLIST_SHOW', 'SHOW_RATING'] as const) {
      scopes.push({ entityType, sourceKeyPrefix: `show:${id}:` });
    }
  }
  for (const id of new Set(movies)) {
    for (const entityType of ['WATCHED_MOVIE', 'WATCHLIST_MOVIE', 'MOVIE_RATING'] as const) {
      scopes.push({ entityType, sourceKeyPrefix: `movie:${id}:` });
    }
  }
  return scopes;
}

function readSimklBaseline(payload: unknown, key: SimklBaselineKey): SimklListItem[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    return Array.isArray(record[key]) ? (record[key] as SimklListItem[]) : null;
  }
  // SIMKL omits an empty bucket instead of returning, for example, `anime: []`.
  return Object.keys(record).length === 0 ? [] : null;
}

export function normalizeSimklItems(payload: SimklAllItems | null): InboundSyncItem[] {
  if (!payload) return [];
  const result: InboundSyncItem[] = [];

  const addShows = (rows: SimklListItem[] = [], category: 'shows' | 'anime' = 'shows') => {
    for (const row of rows) {
      const media = row.show;
      if (!media?.title) continue;
      const ids = cleanExternalIds(media.ids);
      const providerItemId = String((media.ids as any)?.simkl ?? '');
      const identity = providerItemId || String(ids.imdb ?? media.title);
      const status = String(row.status ?? '');
      const providerFields = {
        ...(providerItemId ? { providerItemId } : {}),
        providerCategory: category,
        providerStatus: status || null,
        providerRating: row.user_rating == null ? null : Number(row.user_rating),
      } as const;
      const showState: InboundShowTrackingState | null =
        status === 'dropped'
          ? 'DROPPED'
          : status === 'hold'
            ? 'PAUSED'
            : ACTIVE_SHOW_STATUSES.has(status)
              ? 'ACTIVE'
              : null;
      if (showState) {
        result.push({
          entityType: 'SHOW_STATE',
          mediaType: 'SHOW',
          title: media.title,
          year: media.year ?? null,
          ids,
          showState,
          sourceKey: `show:${identity}:state`,
          ...providerFields,
        });
      }
      if (WATCHLIST_STATUSES.has(status)) {
        result.push({
          entityType: 'WATCHLIST_SHOW',
          mediaType: 'SHOW',
          title: media.title,
          year: media.year ?? null,
          ids,
          sourceKey: `show:${identity}:watchlist`,
          ...providerFields,
        });
      }
      const localRating = simklRatingToStars(row.user_rating);
      if (localRating != null) {
        result.push({
          entityType: 'SHOW_RATING',
          mediaType: 'SHOW',
          title: media.title,
          year: media.year ?? null,
          ids,
          rating: localRating,
          watchedAt: isoOrNull(row.user_rated_at),
          sourceKey: `show:${identity}:rating`,
          ...providerFields,
        });
      }
      for (const season of row.seasons ?? []) {
        for (const episode of season.episodes ?? []) {
          const seasonNumber = Number(episode.tvdb?.season ?? season.number);
          const episodeNumber = Number(episode.tvdb?.episode ?? episode.number);
          if (!Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) continue;
          result.push({
            entityType: 'WATCHED_EPISODE',
            mediaType: 'SHOW',
            title: media.title,
            year: media.year ?? null,
            ids,
            episodeIds: cleanExternalIds(episode.ids),
            season: seasonNumber,
            episode: episodeNumber,
            watchedAt: isoOrNull(episode.watched_at),
            watchCount: 1,
            sourceKey: `show:${identity}:s${seasonNumber}e${episodeNumber}`,
            ...providerFields,
          });
        }
      }
    }
  };
  addShows(payload.shows, 'shows');
  addShows(payload.anime, 'anime');

  for (const row of payload.movies ?? []) {
    const media = row.movie;
    if (!media?.title) continue;
    const ids = cleanExternalIds(media.ids);
    const providerItemId = String((media.ids as any)?.simkl ?? '');
    const identity = providerItemId || String(ids.imdb ?? media.title);
    const providerFields = {
      ...(providerItemId ? { providerItemId } : {}),
      providerCategory: 'movies' as const,
      providerStatus: String(row.status ?? '') || null,
      providerRating: row.user_rating == null ? null : Number(row.user_rating),
    };
    if (WATCHLIST_STATUSES.has(String(row.status))) {
      result.push({
        entityType: 'WATCHLIST_MOVIE',
        mediaType: 'MOVIE',
        title: media.title,
        year: media.year ?? null,
        ids,
        sourceKey: `movie:${identity}:watchlist`,
        ...providerFields,
      });
    }
    const lastWatchedAt = isoOrNull(row.last_watched_at);
    if (lastWatchedAt) {
      result.push({
        entityType: 'WATCHED_MOVIE',
        mediaType: 'MOVIE',
        title: media.title,
        year: media.year ?? null,
        ids,
        watchedAt: lastWatchedAt,
        watchCount: 1,
        sourceKey: `movie:${identity}:watched`,
        ...providerFields,
      });
    }
    const localRating = simklRatingToStars(row.user_rating);
    if (localRating != null) {
      result.push({
        entityType: 'MOVIE_RATING',
        mediaType: 'MOVIE',
        title: media.title,
        year: media.year ?? null,
        ids,
        rating: localRating,
        watchedAt: isoOrNull(row.user_rated_at),
        sourceKey: `movie:${identity}:rating`,
        ...providerFields,
      });
    }
  }
  return result;
}

@Injectable()
export class SimklClient {
  private get appName(): string {
    return this.config.get<string>('integrations.simklAppName')?.trim() || 'tvwatch';
  }

  private get appVersion(): string {
    return this.config.get<string>('integrations.simklAppVersion')?.trim() || '0.1.0';
  }

  constructor(private readonly config: ConfigService) {}

  private get clientId(): string {
    return this.config.get<string>('integrations.simklClientId') ?? '';
  }

  get available(): boolean {
    return Boolean(this.clientId);
  }

  private requireClientId(): string {
    if (!this.clientId) {
      throw new ServiceUnavailableException('SIMKL integration is not configured');
    }
    return this.clientId;
  }

  private requestUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(path, API_URL);
    url.searchParams.set('client_id', this.requireClientId());
    url.searchParams.set('app-name', this.appName);
    url.searchParams.set('app-version', this.appVersion);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  private requestHeaders(accessToken?: string): Record<string, string> {
    return {
      'User-Agent': `${this.appName}/${this.appVersion}`,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };
  }

  private async activities(accessToken: string): Promise<Record<string, unknown>> {
    const activities = await providerJson<Record<string, unknown>>(
      'SIMKL',
      this.requestUrl('/sync/activities'),
      { headers: this.requestHeaders(accessToken) },
    );
    if (typeof activities.all !== 'string' || !activities.all) {
      throw new BadGatewayException('SIMKL activities response did not include a sync timestamp');
    }
    return activities;
  }

  private cursorWithCheck(
    activities: Record<string, unknown>,
    known?: SimklKnownItems | null,
  ): Record<string, unknown> {
    return {
      ...activities,
      ...(known ? { [KNOWN_ITEMS_CURSOR_KEY]: known } : {}),
      [CHECKED_AT_CURSOR_KEY]: new Date().toISOString(),
    };
  }

  async startLink() {
    const response = await providerJson<{
      result: string;
      user_code: string;
      verification_url: string;
      expires_in: number;
      interval: number;
    }>('SIMKL', this.requestUrl('/oauth/pin'), { headers: this.requestHeaders() });
    if (response.result !== 'OK' || !response.user_code) {
      throw new BadRequestException('SIMKL did not create a connection code');
    }
    return {
      code: response.user_code,
      verificationUrl: response.verification_url || 'https://simkl.com/pin/',
      expiresAt: new Date(Date.now() + response.expires_in * 1000),
      pollAfterSeconds: Math.max(1, response.interval || 5),
    };
  }

  async completeLink(code: string): Promise<string> {
    const response = await providerJson<{
      result: string;
      access_token?: string;
      message?: string;
    }>('SIMKL', this.requestUrl(`/oauth/pin/${encodeURIComponent(code)}`), {
      headers: this.requestHeaders(),
    });
    if (response.result !== 'OK' || !response.access_token) {
      throw new BadRequestException(response.message || 'SIMKL authorization is still pending');
    }
    return response.access_token;
  }

  private async write(
    accessToken: string,
    path: string,
    payload: SimklWritePayload,
  ): Promise<SimklWriteResponse> {
    let response: Response;
    try {
      response = await fetch(this.requestUrl(path), {
        method: 'POST',
        headers: {
          ...this.requestHeaders(accessToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof SimklApiError) throw error;
      throw new SimklApiError('SIMKL could not be reached', 503);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SimklApiError('SIMKL returned an invalid write response', response.status || 502);
    }
    if (!response.ok) {
      const errorBody =
        body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
      const code = typeof errorBody?.error === 'string' ? errorBody.error : undefined;
      const message =
        typeof errorBody?.message === 'string'
          ? errorBody.message
          : typeof errorBody?.error_description === 'string'
            ? errorBody.error_description
            : `SIMKL returned HTTP ${response.status}`;
      throw new SimklApiError(message, response.status, code);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new SimklApiError('SIMKL returned an invalid write response', 502);
    }
    return body as SimklWriteResponse;
  }

  addHistory(accessToken: string, payload: SimklWritePayload) {
    return this.write(accessToken, '/sync/history', payload);
  }

  removeHistory(accessToken: string, payload: SimklWritePayload) {
    return this.write(accessToken, '/sync/history/remove', payload);
  }

  addToList(accessToken: string, payload: SimklWritePayload) {
    return this.write(accessToken, '/sync/add-to-list', payload);
  }

  addRatings(accessToken: string, payload: SimklWritePayload) {
    return this.write(accessToken, '/sync/ratings', payload);
  }

  removeRatings(accessToken: string, payload: SimklWritePayload) {
    return this.write(accessToken, '/sync/ratings/remove', payload);
  }

  async sync(
    accessToken: string,
    cursor?: Record<string, unknown> | null,
    options: SimklSyncOptions = {},
  ): Promise<ProviderSyncPayload> {
    const previous = typeof cursor?.all === 'string' ? cursor.all : null;
    if (!previous) {
      // SIMKL requires the first full pull to be split by type and awaited sequentially.
      // TVWatch tracks episodes, so the one-time baseline includes complete episode arrays.
      const showsPayload = await providerJson<unknown>(
        'SIMKL',
        this.requestUrl('/sync/all-items/shows', EPISODE_SYNC_PARAMS),
        { headers: this.requestHeaders(accessToken) },
      );
      const shows = readSimklBaseline(showsPayload, 'shows');
      if (!shows) {
        throw new BadGatewayException('SIMKL returned an invalid shows baseline');
      }
      const moviesPayload = await providerJson<unknown>(
        'SIMKL',
        this.requestUrl('/sync/all-items/movies'),
        { headers: this.requestHeaders(accessToken) },
      );
      const movies = readSimklBaseline(moviesPayload, 'movies');
      if (!movies) {
        throw new BadGatewayException('SIMKL returned an invalid movies baseline');
      }
      const animePayload = await providerJson<unknown>(
        'SIMKL',
        this.requestUrl('/sync/all-items/anime', EPISODE_SYNC_PARAMS),
        { headers: this.requestHeaders(accessToken) },
      );
      const anime = readSimklBaseline(animePayload, 'anime');
      if (!anime) {
        throw new BadGatewayException('SIMKL returned an invalid anime baseline');
      }
      // The bootstrap watermark is intentionally fetched after all three libraries.
      const bootstrapActivities = await this.activities(accessToken);
      const baseline = { shows, movies, anime };
      return {
        items: normalizeSimklItems(baseline),
        cursor: this.cursorWithCheck(bootstrapActivities, knownItems(baseline)),
        snapshotEntityTypes: SIMKL_SNAPSHOT_TYPES,
      };
    }

    const checkedAtRaw = cursor?.[CHECKED_AT_CURSOR_KEY];
    const checkedAt = typeof checkedAtRaw === 'string' ? new Date(checkedAtRaw).getTime() : NaN;
    if (
      !options.forceActivityCheck &&
      Number.isFinite(checkedAt) &&
      Date.now() - checkedAt < ACTIVITY_THROTTLE_MS
    ) {
      return { items: [], cursor };
    }

    // Every continuous sync is gated by the cheap activities request.
    const latestActivities = await this.activities(accessToken);
    const previousKnown = readKnownItems(cursor);
    if (latestActivities.all === previous) {
      return { items: [], cursor: this.cursorWithCheck(latestActivities, previousKnown) };
    }

    // Preserve the exact timestamp returned by SIMKL; never parse or reformat date_from.
    const payload = await providerJson<SimklAllItems | null>(
      'SIMKL',
      this.requestUrl('/sync/all-items', { ...EPISODE_SYNC_PARAMS, date_from: previous }),
      { headers: this.requestHeaders(accessToken) },
    );
    const delta = payload ?? {};
    const deltaKnown = knownItems(delta);
    let nextKnown = mergeKnownItems(previousKnown, deltaKnown);
    let removedShows: string[] = [];
    let removedMovies: string[] = [];
    if (!previousKnown || removalMarker(latestActivities) !== removalMarker(cursor ?? {})) {
      const currentPayload = await providerJson<SimklAllItems | null>(
        'SIMKL',
        this.requestUrl('/sync/all-items', { extended: 'simkl_ids_only' }),
        { headers: this.requestHeaders(accessToken) },
      );
      if (!currentPayload || typeof currentPayload !== 'object' || Array.isArray(currentPayload)) {
        throw new BadGatewayException('SIMKL returned an invalid deletion snapshot');
      }
      const current = knownItems(currentPayload);
      const currentShows = new Set([...current.shows, ...current.anime]);
      const currentMovies = new Set(current.movies);
      if (previousKnown) {
        removedShows = [...previousKnown.shows, ...previousKnown.anime].filter(
          (id) => !currentShows.has(id),
        );
        removedMovies = previousKnown.movies.filter((id) => !currentMovies.has(id));
      }
      nextKnown = current;
    }
    const changedShows = [...deltaKnown.shows, ...deltaKnown.anime];
    return {
      items: normalizeSimklItems(delta),
      cursor: this.cursorWithCheck(latestActivities, nextKnown),
      snapshotScopes: scopesForProviderItems(
        [...changedShows, ...removedShows],
        [...deltaKnown.movies, ...removedMovies],
      ),
    };
  }
}
