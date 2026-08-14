import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cleanExternalIds, isoOrNull, providerJson } from './provider-http';
import type { InboundShowTrackingState, InboundSyncItem, ProviderSyncPayload } from './types';

const API_URL = 'https://api.simkl.com';
const WATCHLIST_STATUSES = new Set(['plantowatch', 'watching', 'hold', 'dropped']);
const ACTIVE_SHOW_STATUSES = new Set(['plantowatch', 'watching', 'completed']);
const ACTIVITY_THROTTLE_MS = 15 * 60_000;
const CHECKED_AT_CURSOR_KEY = '_tvwatchCheckedAt';
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

export function normalizeSimklItems(payload: SimklAllItems | null): InboundSyncItem[] {
  if (!payload) return [];
  const result: InboundSyncItem[] = [];

  const addShows = (rows: SimklListItem[] = []) => {
    for (const row of rows) {
      const media = row.show;
      if (!media?.title) continue;
      const ids = cleanExternalIds(media.ids);
      const identity = String((media.ids as any)?.simkl ?? ids.imdb ?? media.title);
      const status = String(row.status ?? '');
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
        });
      }
      if (Number.isFinite(Number(row.user_rating))) {
        result.push({
          entityType: 'SHOW_RATING',
          mediaType: 'SHOW',
          title: media.title,
          year: media.year ?? null,
          ids,
          rating: Number(row.user_rating),
          watchedAt: isoOrNull(row.user_rated_at),
          sourceKey: `show:${identity}:rating`,
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
          });
        }
      }
    }
  };
  addShows(payload.shows);
  addShows(payload.anime);

  for (const row of payload.movies ?? []) {
    const media = row.movie;
    if (!media?.title) continue;
    const ids = cleanExternalIds(media.ids);
    const identity = String((media.ids as any)?.simkl ?? ids.imdb ?? media.title);
    if (WATCHLIST_STATUSES.has(String(row.status))) {
      result.push({
        entityType: 'WATCHLIST_MOVIE',
        mediaType: 'MOVIE',
        title: media.title,
        year: media.year ?? null,
        ids,
        sourceKey: `movie:${identity}:watchlist`,
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
      });
    }
    if (Number.isFinite(Number(row.user_rating))) {
      result.push({
        entityType: 'MOVIE_RATING',
        mediaType: 'MOVIE',
        title: media.title,
        year: media.year ?? null,
        ids,
        rating: Number(row.user_rating),
        watchedAt: isoOrNull(row.user_rated_at),
        sourceKey: `movie:${identity}:rating`,
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

  private cursorWithCheck(activities: Record<string, unknown>): Record<string, unknown> {
    return { ...activities, [CHECKED_AT_CURSOR_KEY]: new Date().toISOString() };
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

  async sync(
    accessToken: string,
    cursor?: Record<string, unknown> | null,
    options: SimklSyncOptions = {},
  ): Promise<ProviderSyncPayload> {
    const previous = typeof cursor?.all === 'string' ? cursor.all : null;
    if (!previous) {
      // SIMKL requires the first full pull to be split by type and awaited sequentially.
      // TVWatch tracks episodes, so the one-time baseline includes complete episode arrays.
      const shows = await providerJson<SimklAllItems>(
        'SIMKL',
        this.requestUrl('/sync/all-items/shows', EPISODE_SYNC_PARAMS),
        { headers: this.requestHeaders(accessToken) },
      );
      const movies = await providerJson<SimklAllItems>(
        'SIMKL',
        this.requestUrl('/sync/all-items/movies'),
        { headers: this.requestHeaders(accessToken) },
      );
      const anime = await providerJson<SimklAllItems>(
        'SIMKL',
        this.requestUrl('/sync/all-items/anime', EPISODE_SYNC_PARAMS),
        { headers: this.requestHeaders(accessToken) },
      );
      // The bootstrap watermark is intentionally fetched after all three libraries.
      const bootstrapActivities = await this.activities(accessToken);
      return {
        items: normalizeSimklItems({
          shows: shows.shows ?? [],
          movies: movies.movies ?? [],
          anime: anime.anime ?? [],
        }),
        cursor: this.cursorWithCheck(bootstrapActivities),
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
    const nextCursor = this.cursorWithCheck(latestActivities);
    if (latestActivities.all === previous) return { items: [], cursor: nextCursor };

    // Preserve the exact timestamp returned by SIMKL; never parse or reformat date_from.
    const payload = await providerJson<SimklAllItems | null>(
      'SIMKL',
      this.requestUrl('/sync/all-items', { ...EPISODE_SYNC_PARAMS, date_from: previous }),
      { headers: this.requestHeaders(accessToken) },
    );
    return { items: normalizeSimklItems(payload), cursor: nextCursor };
  }
}
