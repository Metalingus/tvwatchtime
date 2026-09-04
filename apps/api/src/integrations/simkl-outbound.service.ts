import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { IntegrationCredentialService } from './integration-credential.service';
import {
  SimklApiError,
  SimklClient,
  type SimklWriteIds,
  type SimklWriteItem,
  type SimklWritePayload,
  type SimklWriteResponse,
} from './providers/simkl.client';
import type { InboundSyncItem } from './providers/types';
import type { ProviderSnapshotScope } from './providers/types';

const QUEUE_NAME = 'simkl-outbound';
const WRITE_BATCH_SIZE = 50;
const STATE_BATCH_SIZE = 25;
const WRITE_INTERVAL_MS = 1_050;

type SimklStatus = 'watching' | 'plantowatch' | 'hold' | 'dropped' | 'completed';
type SimklState = {
  watchedMovie: boolean;
  watchedEpisodes: Record<string, string | null>;
  status: SimklStatus | null;
  rating: number | null;
  localWatchlist?: boolean;
};
type LocalEpisode = { season: number; episode: number; watchedAt: string | null };
type LocalState = {
  mediaId: string;
  mediaType: 'SHOW' | 'MOVIE';
  title: string;
  year: number | null;
  externalIds: Array<{ provider: string; providerEntityKind: string; value: string }>;
  watchedMovie: boolean;
  watchedAt: string | null;
  watchedEpisodes: LocalEpisode[];
  inWatchlist: boolean;
  dropped: boolean;
  paused: boolean;
  watchedCount: number;
  totalCount: number;
  rating: number | null;
  ratingSource: string | null;
};
type StateRow = {
  id: string;
  integrationId: string;
  mediaId: string;
  simklId: string | null;
  simklType: string | null;
  remoteState: unknown;
  managedState: unknown;
  revision: number;
};
type WriteEntry = {
  mediaId: string;
  mediaType: 'SHOW' | 'MOVIE';
  item: SimklWriteItem;
};

export type SimklOutboundSummary = {
  synced: number;
  unmatched: number;
  failed: number;
  pending: number;
};
export type IntegrationLocalMediaChange = {
  userId: string;
  mediaId?: string;
  mediaIds?: string[];
  origin?: string;
};

const emptySimklState = (): SimklState => ({
  watchedMovie: false,
  watchedEpisodes: {},
  status: null,
  rating: null,
});

function parseState(value: unknown): SimklState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySimklState();
  const raw = value as Record<string, unknown>;
  const watchedEpisodes =
    raw.watchedEpisodes &&
    typeof raw.watchedEpisodes === 'object' &&
    !Array.isArray(raw.watchedEpisodes)
      ? Object.fromEntries(
          Object.entries(raw.watchedEpisodes as Record<string, unknown>)
            .filter(([key]) => /^s\d+e\d+$/.test(key))
            .map(([key, timestamp]) => [key, typeof timestamp === 'string' ? timestamp : null]),
        )
      : {};
  const status = ['watching', 'plantowatch', 'hold', 'dropped', 'completed'].includes(
    String(raw.status),
  )
    ? (raw.status as SimklStatus)
    : null;
  const rating = Number(raw.rating);
  return {
    watchedMovie: raw.watchedMovie === true,
    watchedEpisodes,
    status,
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : null,
    ...(typeof raw.localWatchlist === 'boolean' ? { localWatchlist: raw.localWatchlist } : {}),
  };
}

const episodeKey = (season: number, episode: number) => `s${season}e${episode}`;

export function simklRatingFromStars(value: number | null): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5
    ? Number(value) * 2
    : null;
}

function positiveId(value: string): string | null {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? trimmed : null;
}

export function buildSimklIds(
  mediaType: 'SHOW' | 'MOVIE',
  externalIds: LocalState['externalIds'],
  simklId?: string | null,
): SimklWriteIds {
  const ids: SimklWriteIds = {};
  const allowedKinds =
    mediaType === 'SHOW' ? new Set(['SERIES', 'ANIME']) : new Set(['MOVIE', 'ANIME']);
  for (const externalId of externalIds) {
    if (!allowedKinds.has(externalId.providerEntityKind)) continue;
    if (externalId.provider === 'IMDB' && /^tt\d+$/i.test(externalId.value)) {
      ids.imdb = externalId.value;
    } else if (externalId.provider === 'TMDB') {
      const value = positiveId(externalId.value);
      if (value) ids.tmdb = value;
    } else if (externalId.provider === 'THE_TVDB') {
      const value = positiveId(externalId.value);
      if (value) ids.tvdb = value;
    } else if (externalId.provider === 'MYANIME_LIST') {
      const value = positiveId(externalId.value);
      if (value) ids.mal = value;
    } else if (externalId.provider === 'KITSU') {
      const value = positiveId(externalId.value);
      if (value) ids.kitsu = value;
    }
  }
  // One local TVDB/TMDB show can span several cour-specific SIMKL anime records. In that
  // shape a single remembered SIMKL id would override the parent TVDB cross-map and route later
  // seasons to the wrong cour, so prefer the documented parent IDs for shows.
  if (simklId && /^\d+$/.test(simklId) && (mediaType === 'MOVIE' || (!ids.tmdb && !ids.tvdb))) {
    const value = Number(simklId);
    if (Number.isSafeInteger(value) && value > 0) ids.simkl = value;
  }
  return ids;
}

export function desiredSimklStatus(local: LocalState): SimklStatus | null {
  if (local.mediaType === 'MOVIE') {
    if (local.watchedMovie) return 'completed';
    return local.inWatchlist ? 'plantowatch' : null;
  }
  if (local.dropped) return 'dropped';
  if (local.paused) return 'hold';
  if (local.totalCount > 0 && local.watchedCount >= local.totalCount) return 'completed';
  if (local.watchedEpisodes.length > 0) return 'watching';
  return local.inWatchlist ? 'plantowatch' : null;
}

function payloadFor(entries: WriteEntry[]): SimklWritePayload {
  const movies = entries.filter((entry) => entry.mediaType === 'MOVIE').map((entry) => entry.item);
  const shows = entries.filter((entry) => entry.mediaType === 'SHOW').map((entry) => entry.item);
  return {
    ...(movies.length ? { movies } : {}),
    ...(shows.length ? { shows } : {}),
  };
}

function writeIdentity(ids: Record<string, unknown> | undefined): string | null {
  if (!ids) return null;
  for (const key of ['simkl', 'imdb', 'tmdb', 'tvdb', 'mal', 'kitsu']) {
    const value = ids[key];
    if (typeof value === 'string' || typeof value === 'number') return `${key}:${value}`;
  }
  return null;
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

@Injectable()
export class SimklOutboundService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SimklOutboundService.name);
  private queue!: Queue<{ integrationId: string }>;
  private worker!: Worker<{ integrationId: string }>;
  private readonly active = new Map<string, Promise<SimklOutboundSummary>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly secrets: IntegrationCredentialService,
    private readonly simkl: SimklClient,
  ) {}

  async onModuleInit() {
    const connection = this.redis.client as any;
    this.queue = new Queue(QUEUE_NAME, { connection });
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        try {
          return await this.flushIntegration(job.data.integrationId);
        } catch (error) {
          if (
            error instanceof SimklApiError &&
            error.status === 400 &&
            error.code === 'rate_limit' &&
            job.attemptsMade >= 1
          ) {
            throw new UnrecoverableError(error.message);
          }
          if (error instanceof SimklApiError && !error.retryable) {
            throw new UnrecoverableError(error.message);
          }
          throw error;
        }
      },
      { connection, concurrency: 4 },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `SIMKL outbound job ${job?.data.integrationId ?? 'unknown'} failed: ${error.message}`,
      );
    });
    const pending = await this.prisma.simklSyncItemState.findMany({
      where: {
        dirty: true,
        integration: {
          outboundEnabled: true,
          connectedAt: { not: null },
          paused: false,
          itemsDisabled: false,
        },
      },
      distinct: ['integrationId'],
      select: { integrationId: true },
    });
    await Promise.all(pending.map((row) => this.schedule(row.integrationId, 0)));
  }

  async onModuleDestroy() {
    await Promise.all([this.worker?.close(), this.queue?.close()]);
  }

  private schedule(integrationId: string, delay = 750): Promise<unknown> {
    return this.queue.add(
      'flush',
      { integrationId },
      {
        jobId: `simkl-${integrationId}-${Date.now()}`,
        delay,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  private async mediaIdsForUser(userId: string): Promise<string[]> {
    const [watchlist, movies, episodes, ratings, shows] = await Promise.all([
      this.prisma.watchlistItem.findMany({ where: { userId }, select: { mediaId: true } }),
      this.prisma.userMovieStatus.findMany({
        where: { userId, watched: true },
        select: { mediaId: true },
      }),
      this.prisma.userEpisodeStatus.findMany({
        where: { userId, watched: true },
        select: {
          episode: {
            select: { season: { select: { show: { select: { mediaId: true } } } } },
          },
        },
      }),
      this.prisma.rating.findMany({
        where: { userId, mediaId: { not: null } },
        select: { mediaId: true },
      }),
      this.prisma.userShowStatus.findMany({
        where: { userId, OR: [{ dropped: true }, { pausedAt: { not: null } }] },
        select: { mediaId: true },
      }),
    ]);
    return [
      ...new Set([
        ...watchlist.map((row) => row.mediaId),
        ...movies.map((row) => row.mediaId),
        ...episodes.map((row) => row.episode.season.show.mediaId),
        ...ratings.flatMap((row) => (row.mediaId ? [row.mediaId] : [])),
        ...shows.map((row) => row.mediaId),
      ]),
    ];
  }

  async bootstrap(userId: string): Promise<void> {
    const integration = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider: 'SIMKL' } },
      select: { id: true, connectedAt: true, outboundEnabled: true },
    });
    if (!integration?.connectedAt || !integration.outboundEnabled) return;
    await this.prisma.userIntegration.update({
      where: { id: integration.id },
      data: {
        outboundStatus: 'SYNCING',
        outboundBootstrapAt: null,
        lastOutboundError: null,
      },
    });
    const mediaIds = await this.mediaIdsForUser(userId);
    if (!mediaIds.length) {
      await this.prisma.userIntegration.update({
        where: { id: integration.id },
        data: {
          outboundStatus: 'SUCCESS',
          outboundBootstrapAt: new Date(),
          lastOutboundSyncedAt: new Date(),
        },
      });
      return;
    }
    await this.markDirty(integration.id, mediaIds);
  }

  private async markDirty(integrationId: string, mediaIds: string[]): Promise<void> {
    const unique = [...new Set(mediaIds.filter(Boolean))];
    if (!unique.length) return;
    for (const batch of chunk(unique, 100)) {
      await this.prisma.$transaction(
        batch.map((mediaId) =>
          this.prisma.simklSyncItemState.upsert({
            where: { integrationId_mediaId: { integrationId, mediaId } },
            create: {
              integrationId,
              mediaId,
              dirty: true,
              revision: 1,
              syncStatus: 'PENDING',
            },
            update: {
              dirty: true,
              revision: { increment: 1 },
              syncStatus: 'PENDING',
              lastError: null,
            },
          }),
        ),
      );
    }
    await this.schedule(integrationId);
  }

  @OnEvent('watch.episode', { async: true })
  @OnEvent('unwatch.episode', { async: true })
  @OnEvent('watch.movie', { async: true })
  @OnEvent('unwatch.movie', { async: true })
  @OnEvent('watchlist.added', { async: true })
  @OnEvent('watchlist.removed', { async: true })
  @OnEvent('integration.local-media-changed', { async: true })
  async onLocalMediaChange(payload: IntegrationLocalMediaChange) {
    if (!payload?.userId || payload.origin?.toUpperCase() === 'SIMKL') return;
    const integration = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId: payload.userId, provider: 'SIMKL' } },
      select: {
        id: true,
        connectedAt: true,
        outboundEnabled: true,
        paused: true,
        itemsDisabled: true,
      },
    });
    if (
      !integration?.connectedAt ||
      !integration.outboundEnabled ||
      integration.paused ||
      integration.itemsDisabled
    ) {
      return;
    }
    const mediaIds = [...(payload.mediaId ? [payload.mediaId] : []), ...(payload.mediaIds ?? [])];
    await this.markDirty(
      integration.id,
      mediaIds.length ? mediaIds : await this.mediaIdsForUser(payload.userId),
    );
  }

  @OnEvent('import.applied', { async: true })
  async onImportApplied(payload: IntegrationLocalMediaChange) {
    return this.onLocalMediaChange(payload);
  }

  private async reconcileUser(integrationId: string, userId: string): Promise<void> {
    const [currentMediaIds, stateRows] = await Promise.all([
      this.mediaIdsForUser(userId),
      this.prisma.simklSyncItemState.findMany({
        where: { integrationId },
        select: { mediaId: true, managedState: true },
      }),
    ]);
    const statesByMediaId = new Map(stateRows.map((row) => [row.mediaId, row.managedState]));
    const candidates = [
      ...new Set([
        ...currentMediaIds,
        ...stateRows.flatMap((row) => (row.managedState ? [row.mediaId] : [])),
      ]),
    ];
    const dirty: string[] = [];
    for (const batch of chunk(candidates, 500)) {
      const localById = await this.buildLocalStates(userId, batch);
      for (const mediaId of batch) {
        const local = localById.get(mediaId);
        const managedRaw = statesByMediaId.get(mediaId);
        if (local && !managedRaw) {
          dirty.push(mediaId);
          continue;
        }
        if (!local && !managedRaw) continue;
        const expected = this.expectedState(local);
        const managed = parseState(managedRaw);
        if (JSON.stringify(expected) !== JSON.stringify(managed)) dirty.push(mediaId);
      }
    }
    await this.markDirty(integrationId, dirty);
  }

  async flushForUser(userId: string, reconcile = false): Promise<SimklOutboundSummary> {
    const integration = await this.prisma.userIntegration.findUnique({
      where: { userId_provider: { userId, provider: 'SIMKL' } },
      select: { id: true, outboundEnabled: true, connectedAt: true },
    });
    if (!integration?.connectedAt || !integration.outboundEnabled) {
      return { synced: 0, unmatched: 0, failed: 0, pending: 0 };
    }
    if (reconcile) {
      await this.reconcileUser(integration.id, userId);
    }
    return this.flushIntegration(integration.id);
  }

  private async buildLocalStates(
    userId: string,
    mediaIds: string[],
  ): Promise<Map<string, LocalState>> {
    const [media, watchlist, movieStatuses, showStatuses, ratings, episodeStatuses] =
      await Promise.all([
        this.prisma.mediaItem.findMany({
          where: { id: { in: mediaIds } },
          select: {
            id: true,
            type: true,
            title: true,
            externalIds: {
              select: { provider: true, providerEntityKind: true, value: true },
            },
            show: { select: { yearStart: true } },
            movie: { select: { releaseYear: true } },
          },
        }),
        this.prisma.watchlistItem.findMany({
          where: { userId, mediaId: { in: mediaIds } },
          select: { mediaId: true },
        }),
        this.prisma.userMovieStatus.findMany({
          where: { userId, mediaId: { in: mediaIds } },
          select: { mediaId: true, watched: true, watchedAt: true },
        }),
        this.prisma.userShowStatus.findMany({
          where: { userId, mediaId: { in: mediaIds } },
          select: {
            mediaId: true,
            dropped: true,
            pausedAt: true,
            watchedCount: true,
            totalCount: true,
          },
        }),
        this.prisma.rating.findMany({
          where: { userId, mediaId: { in: mediaIds } },
          select: { mediaId: true, rating: true, source: true },
        }),
        this.prisma.userEpisodeStatus.findMany({
          where: {
            userId,
            watched: true,
            episode: { season: { show: { mediaId: { in: mediaIds } } } },
          },
          select: {
            watchedAt: true,
            episode: {
              select: {
                number: true,
                season: {
                  select: { number: true, show: { select: { mediaId: true } } },
                },
              },
            },
          },
        }),
      ]);
    const watchlistIds = new Set(watchlist.map((row) => row.mediaId));
    const moviesById = new Map(movieStatuses.map((row) => [row.mediaId, row]));
    const showsById = new Map(showStatuses.map((row) => [row.mediaId, row]));
    const ratingsById = new Map(
      ratings.flatMap((row) => (row.mediaId ? [[row.mediaId, row] as const] : [])),
    );
    const episodesByMedia = new Map<string, LocalEpisode[]>();
    for (const row of episodeStatuses) {
      const mediaId = row.episode.season.show.mediaId;
      const values = episodesByMedia.get(mediaId) ?? [];
      values.push({
        season: row.episode.season.number,
        episode: row.episode.number,
        watchedAt: row.watchedAt?.toISOString() ?? null,
      });
      episodesByMedia.set(mediaId, values);
    }
    const result = new Map<string, LocalState>();
    for (const item of media) {
      const movie = moviesById.get(item.id);
      const show = showsById.get(item.id);
      const rating = ratingsById.get(item.id);
      const watchedEpisodes = (episodesByMedia.get(item.id) ?? []).sort(
        (left, right) => left.season - right.season || left.episode - right.episode,
      );
      result.set(item.id, {
        mediaId: item.id,
        mediaType: item.type,
        title: item.title,
        year:
          item.type === 'MOVIE'
            ? (item.movie?.releaseYear ?? null)
            : (item.show?.yearStart ?? null),
        externalIds: item.externalIds,
        watchedMovie: movie?.watched === true,
        watchedAt: movie?.watchedAt?.toISOString() ?? null,
        watchedEpisodes,
        inWatchlist: watchlistIds.has(item.id),
        dropped: show?.dropped === true,
        paused: Boolean(show?.pausedAt),
        watchedCount: show?.watchedCount ?? watchedEpisodes.length,
        totalCount: show?.totalCount ?? 0,
        rating: rating?.rating ?? null,
        ratingSource: rating?.source ?? null,
      });
    }
    return result;
  }

  private item(local: LocalState, ids: SimklWriteIds): SimklWriteItem {
    return {
      ids,
      title: local.title,
      ...(local.year ? { year: local.year } : {}),
      ...(local.mediaType === 'SHOW' ? { use_tvdb_anime_seasons: true } : {}),
    };
  }

  private async sendBatches(
    entries: WriteEntry[],
    sender: (payload: SimklWritePayload) => Promise<SimklWriteResponse>,
    pace: () => Promise<void>,
  ): Promise<Set<string>> {
    const unmatched = new Set<string>();
    for (const batch of chunk(entries, WRITE_BATCH_SIZE)) {
      await pace();
      const response = await sender(payloadFor(batch));
      for (const [bucket, missingItems] of Object.entries(response.not_found ?? {})) {
        if (!Array.isArray(missingItems)) continue;
        const mediaType = bucket === 'movies' ? 'MOVIE' : 'SHOW';
        for (const missing of missingItems) {
          const record =
            missing && typeof missing === 'object' && !Array.isArray(missing)
              ? (missing as Record<string, unknown>)
              : undefined;
          const identity = writeIdentity(
            record?.ids && typeof record.ids === 'object'
              ? (record.ids as Record<string, unknown>)
              : undefined,
          );
          const match = identity
            ? batch.find(
                (entry) =>
                  entry.mediaType === mediaType && writeIdentity(entry.item.ids) === identity,
              )
            : undefined;
          if (match) unmatched.add(match.mediaId);
          else {
            batch
              .filter((entry) => entry.mediaType === mediaType)
              .forEach((entry) => unmatched.add(entry.mediaId));
          }
        }
      }
    }
    return unmatched;
  }

  private expectedState(local: LocalState | undefined): SimklState {
    if (!local) return emptySimklState();
    return {
      watchedMovie: local.watchedMovie,
      watchedEpisodes: Object.fromEntries(
        local.watchedEpisodes.map((episode) => [
          episodeKey(episode.season, episode.episode),
          episode.watchedAt,
        ]),
      ),
      status: desiredSimklStatus(local),
      rating: simklRatingFromStars(local.rating),
      localWatchlist: local.inWatchlist,
    };
  }

  private flushIntegration(integrationId: string): Promise<SimklOutboundSummary> {
    const active = this.active.get(integrationId);
    if (active) return active;
    const promise = this.doFlushIntegration(integrationId).finally(() => {
      this.active.delete(integrationId);
    });
    this.active.set(integrationId, promise);
    return promise;
  }

  private async processRows(
    accessToken: string,
    rows: StateRow[],
    localById: Map<string, LocalState>,
    mergeOnly: boolean,
  ): Promise<{ synced: StateRow[]; unmatched: StateRow[] }> {
    const valid: StateRow[] = [];
    const unmatched: StateRow[] = [];
    const removeHistory: WriteEntry[] = [];
    const addHistory: WriteEntry[] = [];
    const addRatings: WriteEntry[] = [];
    const removeRatings: WriteEntry[] = [];
    const addToList: WriteEntry[] = [];
    const wholeRemoved = new Set<string>();
    const ratingInHistory = new Set<string>();
    const statusInHistory = new Set<string>();

    for (const row of rows) {
      const local = localById.get(row.mediaId);
      if (!local) {
        const previous = parseState(row.remoteState ?? row.managedState);
        const inferredType = row.simklType === 'movie' ? 'MOVIE' : 'SHOW';
        const ids = buildSimklIds(inferredType, [], row.simklId);
        if (!Object.keys(ids).length) {
          unmatched.push(row);
          continue;
        }
        if (
          !mergeOnly &&
          (previous.status ||
            previous.watchedMovie ||
            Object.keys(previous.watchedEpisodes).length ||
            previous.rating)
        ) {
          removeHistory.push({ mediaId: row.mediaId, mediaType: inferredType, item: { ids } });
          wholeRemoved.add(row.mediaId);
        }
        valid.push(row);
        continue;
      }
      const ids = buildSimklIds(local.mediaType, local.externalIds, row.simklId);
      if (!Object.keys(ids).length) {
        unmatched.push(row);
        continue;
      }
      valid.push(row);
      const previous = parseState(row.remoteState ?? row.managedState);
      const base = this.item(local, ids);
      const desiredStatus = desiredSimklStatus(local);
      const simklRating = simklRatingFromStars(local.rating);
      const noLocalState =
        !local.watchedMovie &&
        local.watchedEpisodes.length === 0 &&
        !local.inWatchlist &&
        !local.dropped &&
        !local.paused &&
        simklRating == null;
      const hadRemoteState =
        previous.watchedMovie ||
        Object.keys(previous.watchedEpisodes).length > 0 ||
        previous.status != null ||
        previous.rating != null;

      if (!mergeOnly && noLocalState && hadRemoteState) {
        removeHistory.push({ mediaId: row.mediaId, mediaType: local.mediaType, item: base });
        wholeRemoved.add(row.mediaId);
        continue;
      }

      if (local.mediaType === 'MOVIE') {
        if (local.watchedMovie && !previous.watchedMovie) {
          const item: SimklWriteItem = {
            ...base,
            ...(local.watchedAt ? { watched_at: local.watchedAt } : {}),
            ...(desiredStatus ? { status: desiredStatus } : {}),
          };
          if (
            simklRating != null &&
            local.ratingSource !== 'SIMKL' &&
            simklRating !== previous.rating
          ) {
            item.rating = simklRating;
            ratingInHistory.add(row.mediaId);
          }
          if (desiredStatus) statusInHistory.add(row.mediaId);
          addHistory.push({ mediaId: row.mediaId, mediaType: local.mediaType, item });
        } else if (!mergeOnly && previous.watchedMovie && !local.watchedMovie) {
          removeHistory.push({ mediaId: row.mediaId, mediaType: local.mediaType, item: base });
          wholeRemoved.add(row.mediaId);
        }
      } else {
        const desiredEpisodes = new Map(
          local.watchedEpisodes.map((episode) => [
            episodeKey(episode.season, episode.episode),
            episode,
          ]),
        );
        const added = [...desiredEpisodes.entries()]
          .filter(([key]) => !(key in previous.watchedEpisodes))
          .map(([, episode]) => episode);
        const removed = Object.keys(previous.watchedEpisodes)
          .filter((key) => !desiredEpisodes.has(key))
          .map((key) => /^s(\d+)e(\d+)$/.exec(key))
          .filter((match): match is RegExpExecArray => Boolean(match))
          .map((match) => ({ season: Number(match[1]), episode: Number(match[2]) }));
        const seasonsFor = (
          episodes: Array<{ season: number; episode: number; watchedAt?: string | null }>,
        ) =>
          [...new Set(episodes.map((episode) => episode.season))].map((season) => ({
            number: season,
            episodes: episodes
              .filter((episode) => episode.season === season)
              .map((episode) => ({
                number: episode.episode,
                ...(episode.watchedAt ? { watched_at: episode.watchedAt } : {}),
              })),
          }));
        if (added.length) {
          const item: SimklWriteItem = {
            ...base,
            seasons: seasonsFor(added),
            ...(desiredStatus ? { status: desiredStatus } : {}),
          };
          if (
            simklRating != null &&
            local.ratingSource !== 'SIMKL' &&
            simklRating !== previous.rating
          ) {
            item.rating = simklRating;
            ratingInHistory.add(row.mediaId);
          }
          if (desiredStatus) statusInHistory.add(row.mediaId);
          addHistory.push({ mediaId: row.mediaId, mediaType: local.mediaType, item });
        }
        if (!mergeOnly && removed.length) {
          removeHistory.push({
            mediaId: row.mediaId,
            mediaType: local.mediaType,
            item: { ...base, seasons: seasonsFor(removed) },
          });
        }
      }

      if (
        simklRating != null &&
        !ratingInHistory.has(row.mediaId) &&
        (wholeRemoved.has(row.mediaId) ||
          (local.ratingSource !== 'SIMKL' && simklRating !== previous.rating))
      ) {
        addRatings.push({
          mediaId: row.mediaId,
          mediaType: local.mediaType,
          item: { ...base, rating: simklRating },
        });
      } else if (
        !mergeOnly &&
        simklRating == null &&
        previous.rating != null &&
        parseState(row.managedState).rating != null &&
        !wholeRemoved.has(row.mediaId)
      ) {
        removeRatings.push({ mediaId: row.mediaId, mediaType: local.mediaType, item: base });
      }

      if (
        desiredStatus &&
        !statusInHistory.has(row.mediaId) &&
        (wholeRemoved.has(row.mediaId) || desiredStatus !== previous.status)
      ) {
        addToList.push({
          mediaId: row.mediaId,
          mediaType: local.mediaType,
          item: { ...base, to: desiredStatus },
        });
      }
    }

    let lastWriteAt = 0;
    const pace = async () => {
      const wait = WRITE_INTERVAL_MS - (Date.now() - lastWriteAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastWriteAt = Date.now();
    };
    const unmatchedIds = new Set(unmatched.map((row) => row.mediaId));
    const collect = (ids: Set<string>) => ids.forEach((id) => unmatchedIds.add(id));
    collect(
      await this.sendBatches(
        removeHistory,
        (payload) => this.simkl.removeHistory(accessToken, payload),
        pace,
      ),
    );
    collect(
      await this.sendBatches(
        addHistory,
        (payload) => this.simkl.addHistory(accessToken, payload),
        pace,
      ),
    );
    collect(
      await this.sendBatches(
        removeRatings,
        (payload) => this.simkl.removeRatings(accessToken, payload),
        pace,
      ),
    );
    collect(
      await this.sendBatches(
        addRatings,
        (payload) => this.simkl.addRatings(accessToken, payload),
        pace,
      ),
    );
    collect(
      await this.sendBatches(
        addToList,
        (payload) => this.simkl.addToList(accessToken, payload),
        pace,
      ),
    );
    return {
      synced: valid.filter((row) => !unmatchedIds.has(row.mediaId)),
      unmatched: [...unmatched, ...valid.filter((row) => unmatchedIds.has(row.mediaId))],
    };
  }

  private async doFlushIntegration(integrationId: string): Promise<SimklOutboundSummary> {
    const integration = await this.prisma.userIntegration.findUnique({
      where: { id: integrationId },
    });
    if (
      !integration ||
      integration.provider !== 'SIMKL' ||
      !integration.connectedAt ||
      !integration.outboundEnabled ||
      integration.paused ||
      integration.itemsDisabled
    ) {
      return { synced: 0, unmatched: 0, failed: 0, pending: 0 };
    }
    const rows = (await this.prisma.simklSyncItemState.findMany({
      where: { integrationId, dirty: true },
      orderBy: { updatedAt: 'asc' },
      take: STATE_BATCH_SIZE,
    })) as unknown as StateRow[];
    if (!rows.length) {
      await this.prisma.userIntegration.update({
        where: { id: integrationId },
        data: {
          outboundStatus: 'SUCCESS',
          outboundBootstrapAt: integration.outboundBootstrapAt ?? new Date(),
          lastOutboundError: null,
        },
      });
      return { synced: 0, unmatched: 0, failed: 0, pending: 0 };
    }

    await Promise.all([
      this.prisma.userIntegration.update({
        where: { id: integrationId },
        data: { outboundStatus: 'SYNCING', lastOutboundError: null },
      }),
      this.prisma.simklSyncItemState.updateMany({
        where: { id: { in: rows.map((row) => row.id) } },
        data: { syncStatus: 'SYNCING', lastAttemptAt: new Date(), lastError: null },
      }),
    ]);
    const credentials = this.secrets.decrypt<Record<string, unknown>>(
      integration.credentialsEncrypted,
    );
    const accessToken = String(credentials.accessToken ?? '');
    const localById = await this.buildLocalStates(
      integration.userId,
      rows.map((row) => row.mediaId),
    );

    try {
      const result = await this.processRows(
        accessToken,
        rows,
        localById,
        !integration.outboundBootstrapAt,
      );
      const now = new Date();
      for (const row of result.synced) {
        const local = localById.get(row.mediaId);
        const expected = this.expectedState(local);
        await this.prisma.simklSyncItemState.updateMany({
          where: { id: row.id, revision: row.revision },
          data: {
            dirty: false,
            syncStatus: 'SUCCESS',
            remoteState: expected as unknown as Prisma.InputJsonValue,
            managedState: expected as unknown as Prisma.InputJsonValue,
            suppressWatchlistEcho:
              Boolean(local) &&
              !local!.inWatchlist &&
              (local!.watchedMovie || local!.watchedEpisodes.length > 0 || local!.rating != null),
            lastSyncedAt: now,
            lastError: null,
          },
        });
      }
      for (const row of result.unmatched) {
        await this.prisma.simklSyncItemState.updateMany({
          where: { id: row.id, revision: row.revision },
          data: {
            dirty: false,
            syncStatus: 'UNMATCHED',
            lastError: 'No supported SIMKL identifier is available',
          },
        });
      }
      const pending = await this.prisma.simklSyncItemState.count({
        where: { integrationId, dirty: true },
      });
      await this.prisma.userIntegration.update({
        where: { id: integrationId },
        data: {
          outboundStatus: pending ? 'SYNCING' : result.unmatched.length ? 'FAILED' : 'SUCCESS',
          lastOutboundSyncedAt: now,
          outboundBootstrapAt:
            pending === 0
              ? (integration.outboundBootstrapAt ?? now)
              : integration.outboundBootstrapAt,
          lastOutboundError: result.unmatched.length
            ? `${result.unmatched.length} item(s) have no supported SIMKL ID`
            : null,
        },
      });
      if (pending) await this.schedule(integrationId, WRITE_INTERVAL_MS);
      return {
        synced: result.synced.length,
        unmatched: result.unmatched.length,
        failed: 0,
        pending,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'SIMKL write failed';
      const permanent = error instanceof SimklApiError && !error.retryable;
      await Promise.all([
        ...rows.map((row) =>
          this.prisma.simklSyncItemState.updateMany({
            where: { id: row.id, revision: row.revision },
            data: {
              ...(permanent ? { dirty: false } : {}),
              syncStatus: 'FAILED',
              lastError: message,
            },
          }),
        ),
        this.prisma.userIntegration.update({
          where: { id: integrationId },
          data: { outboundStatus: 'FAILED', lastOutboundError: message },
        }),
      ]);
      if (permanent) {
        const pending = await this.prisma.simklSyncItemState.count({
          where: { integrationId, dirty: true },
        });
        return {
          synced: 0,
          unmatched: 0,
          failed: rows.length,
          pending,
        };
      }
      throw error;
    }
  }

  async filterInboundWatchlistEcho(
    integrationId: string,
    items: InboundSyncItem[],
  ): Promise<InboundSyncItem[]> {
    const states = await this.prisma.simklSyncItemState.findMany({
      where: { integrationId, suppressWatchlistEcho: true },
      select: { mediaId: true, simklId: true, managedState: true },
    });
    if (!states.length) return items;
    const expectedBySimkl = new Map(
      states.map((state) => [state.simklId, parseState(state.managedState).status]),
    );
    const media = await this.prisma.mediaItem.findMany({
      where: { id: { in: states.map((state) => state.mediaId) } },
      select: {
        id: true,
        type: true,
        externalIds: { select: { provider: true, value: true } },
      },
    });
    const stateByMediaId = new Map(states.map((state) => [state.mediaId, state]));
    const expectedByExternal = new Map<string, SimklStatus | null>();
    for (const item of media) {
      const expected = parseState(stateByMediaId.get(item.id)?.managedState).status;
      for (const id of item.externalIds) {
        const key =
          id.provider === 'IMDB'
            ? 'imdb'
            : id.provider === 'TMDB'
              ? 'tmdb'
              : id.provider === 'THE_TVDB'
                ? 'tvdb'
                : null;
        if (key) expectedByExternal.set(`${item.type}:${key}:${id.value}`, expected);
      }
    }
    return items.filter((item) => {
      if (item.entityType !== 'WATCHLIST_SHOW' && item.entityType !== 'WATCHLIST_MOVIE') {
        return true;
      }
      const expected =
        (item.providerItemId ? expectedBySimkl.get(item.providerItemId) : undefined) ??
        (item.ids.imdb
          ? expectedByExternal.get(`${item.mediaType}:imdb:${item.ids.imdb}`)
          : undefined) ??
        (item.ids.tmdb
          ? expectedByExternal.get(`${item.mediaType}:tmdb:${item.ids.tmdb}`)
          : undefined) ??
        (item.ids.tvdb
          ? expectedByExternal.get(`${item.mediaType}:tvdb:${item.ids.tvdb}`)
          : undefined);
      const providerAdjustedCompletion =
        expected === 'completed' && item.providerStatus === 'watching';
      return (
        expected === undefined || (expected !== item.providerStatus && !providerAdjustedCompletion)
      );
    });
  }

  async observeInbound(
    integrationId: string,
    items: InboundSyncItem[],
    snapshotScopes: ProviderSnapshotScope[] = [],
  ): Promise<void> {
    const completeEpisodeProviderIds = new Set(
      snapshotScopes
        .filter((scope) => scope.entityType === 'WATCHED_EPISODE')
        .map((scope) => /^show:(\d+):$/.exec(scope.sourceKeyPrefix)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
    const observedProviderIds = new Set(
      items.flatMap((item) => (item.providerItemId ? [item.providerItemId] : [])),
    );
    const removedProviderIds = [
      ...new Set(
        snapshotScopes
          .map((scope) => /^(?:show|movie):(\d+):$/.exec(scope.sourceKeyPrefix)?.[1])
          .filter((id): id is string => Boolean(id))
          .filter((id) => !observedProviderIds.has(id)),
      ),
    ];
    if (removedProviderIds.length) {
      await this.prisma.simklSyncItemState.updateMany({
        where: { integrationId, simklId: { in: removedProviderIds } },
        data: {
          remoteState: emptySimklState() as unknown as Prisma.InputJsonValue,
          suppressWatchlistEcho: false,
        },
      });
    }
    const sourceKeys = [...new Set(items.map((item) => item.sourceKey))];
    if (!sourceKeys.length) return;
    const mappings = await this.prisma.integrationSyncedItem.findMany({
      where: { integrationId, sourceKey: { in: sourceKeys } },
      select: { sourceKey: true, mediaId: true },
    });
    const mediaBySourceKey = new Map(mappings.map((row) => [row.sourceKey, row.mediaId]));
    const mediaByProviderId = new Map<string, string>();
    for (const item of items) {
      const mediaId = mediaBySourceKey.get(item.sourceKey);
      if (mediaId && item.providerItemId) mediaByProviderId.set(item.providerItemId, mediaId);
    }
    const stateByMedia = new Map<
      string,
      { simklId: string; simklType: string | null; state: SimklState }
    >();
    for (const item of items) {
      if (!item.providerItemId) continue;
      const mediaId =
        mediaBySourceKey.get(item.sourceKey) ?? mediaByProviderId.get(item.providerItemId);
      if (!mediaId) continue;
      const current = stateByMedia.get(mediaId) ?? {
        simklId: item.providerItemId,
        simklType:
          item.providerCategory === 'anime'
            ? 'anime'
            : item.providerCategory === 'movies'
              ? 'movie'
              : 'tv',
        state: emptySimklState(),
      };
      current.state.status =
        item.providerStatus &&
        ['watching', 'plantowatch', 'hold', 'dropped', 'completed'].includes(item.providerStatus)
          ? (item.providerStatus as SimklStatus)
          : current.state.status;
      if (item.providerRating == null) {
        current.state.rating = null;
      } else if (
        Number.isInteger(item.providerRating) &&
        item.providerRating >= 1 &&
        item.providerRating <= 10
      ) {
        current.state.rating = item.providerRating;
      }
      if (item.entityType === 'WATCHED_MOVIE') current.state.watchedMovie = true;
      if (item.entityType === 'WATCHED_EPISODE' && item.season != null && item.episode != null) {
        current.state.watchedEpisodes[episodeKey(item.season, item.episode)] =
          item.watchedAt ?? null;
      }
      stateByMedia.set(mediaId, current);
    }
    for (const [mediaId, observed] of stateByMedia) {
      const existing = await this.prisma.simklSyncItemState.findUnique({
        where: { integrationId_mediaId: { integrationId, mediaId } },
        select: { remoteState: true },
      });
      const previous = parseState(existing?.remoteState);
      const remoteState: SimklState = {
        ...previous,
        ...observed.state,
        watchedEpisodes: completeEpisodeProviderIds.has(observed.simklId)
          ? observed.state.watchedEpisodes
          : {
              ...previous.watchedEpisodes,
              ...observed.state.watchedEpisodes,
            },
      };
      await this.prisma.simklSyncItemState.upsert({
        where: { integrationId_mediaId: { integrationId, mediaId } },
        create: {
          integrationId,
          mediaId,
          simklId: observed.simklId,
          simklType: observed.simklType,
          remoteState: remoteState as unknown as Prisma.InputJsonValue,
        },
        update: {
          simklId: observed.simklId,
          simklType: observed.simklType,
          remoteState: remoteState as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }
}
