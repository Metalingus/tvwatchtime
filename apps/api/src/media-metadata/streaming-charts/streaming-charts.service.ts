import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { HydrationJobType } from '@prisma/client';
import { ExternalProvider, ProviderEntityKind, type StreamingTopService } from '@tvwatch/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { MediaMetadataService } from '../media-metadata.service';
import { MediaReconciler, type IdentityRef } from '../reconcile/media-reconciler.service';
import { TmdbProvider } from '../providers/tmdb.provider';
import { MotnClient, type MotnTopItem } from '../providers/motn.client';

/** Services whose chart mixes rentals/purchases; only subscription titles are kept. */
const SUBSCRIPTION_ONLY = new Set<StreamingTopService>(['prime', 'apple']);
/** A chart older than this is not served (the daily job has stopped). */
export const STREAMING_TOP_MAX_AGE_MS = 72 * 3600 * 1000;
const AVAILABLE_KEY = 'streaming-top:available:v1';

export function streamingTopRailKey(service: StreamingTopService, country: string): string {
  return `motn:${service}:${country.toUpperCase()}`;
}

export interface StreamingChartItem {
  /** 1-based rank after the subscription filter. */
  rank: number;
  tmdbId: number;
  mediaType: 'SHOW' | 'MOVIE';
  mediaId: string | null;
  imdbId: string | null;
  status: 'pending' | 'skipped';
  /** `unresolved:<why>` / `conflict:<why>` for skipped items. */
  errorMessage?: string;
  created: boolean;
}

export interface StreamingChartCollection {
  items: StreamingChartItem[];
  dropped: number;
  filtered: number;
  existing: number;
  created: number;
  skipped: number;
  conflicts: number;
  /** Items shown through one of several duplicate local rows (queued for identity repair). */
  duplicates: number;
}

type Resolution =
  { mediaId: string; created: boolean; duplicate?: boolean } | { skip: string; conflict: boolean };

/** Local owners of an id set: owner media id → the providers it owns. */
type Owners = Map<string, Set<string>>;

/**
 * Official streaming top charts (Movie of the Night) mapped onto our media rows.
 *
 * Identity only: rows are found or created through the shared crosswalk and never get a
 * structure owner here (StructureAuthorityService decides at hydration). No title matching.
 */
@Injectable()
export class StreamingChartsService {
  private readonly logger = new Logger(StreamingChartsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly motn: MotnClient,
    private readonly meta: MediaMetadataService,
    private readonly reconciler: MediaReconciler,
    private readonly tmdb: TmdbProvider,
  ) {}

  /** One paid MOTN call, then per-item resolution. A failed item is skipped, never fatal. */
  async collect(
    country: string,
    service: StreamingTopService,
    opts: { watchforge: boolean },
  ): Promise<StreamingChartCollection> {
    const list = await this.motn.topShows(country, service);
    const kept = SUBSCRIPTION_ONLY.has(service)
      ? list.items.filter((item) => item.optionTypes.includes('subscription'))
      : list.items;
    const out: StreamingChartCollection = {
      items: [],
      dropped: list.dropped,
      filtered: list.items.length - kept.length,
      existing: 0,
      created: 0,
      skipped: 0,
      conflicts: 0,
      duplicates: 0,
    };
    for (const [index, item] of kept.entries()) {
      let resolution: Resolution;
      try {
        resolution =
          item.kind === 'MOVIE'
            ? await this.resolveMovie(item)
            : await this.resolveSeries(item, opts.watchforge);
      } catch (error) {
        resolution =
          error instanceof ConflictException
            ? { skip: 'conflict:' + error.message, conflict: true }
            : { skip: 'unresolved:' + (error as Error).message, conflict: false };
      }
      const base = {
        rank: index + 1,
        tmdbId: item.tmdbId,
        mediaType: item.kind,
        imdbId: item.imdbId,
      };
      if ('mediaId' in resolution) {
        out.items.push({
          ...base,
          mediaId: resolution.mediaId,
          status: 'pending',
          created: resolution.created,
        });
        if (resolution.created) out.created++;
        else out.existing++;
        if (resolution.duplicate) out.duplicates++;
      } else {
        out.items.push({
          ...base,
          mediaId: null,
          status: 'skipped',
          errorMessage: resolution.skip.slice(0, 500),
          created: false,
        });
        out.skipped++;
        if (resolution.conflict) out.conflicts++;
      }
    }
    return out;
  }

  /** Movies are TMDB-owned: TMDB id with an IMDb cross-check. */
  private async resolveMovie(item: MotnTopItem): Promise<Resolution> {
    const ids: IdentityRef[] = [this.ref(ExternalProvider.TMDB, 'MOVIE', String(item.tmdbId))];
    if (item.imdbId) ids.push(this.ref(ExternalProvider.IMDB, 'MOVIE', item.imdbId));
    const local = await this.existing(ids, 'MOVIE');
    if (local) return local;
    const profile = await this.tmdb.getMovieRoutingProfile(item.tmdbId);
    if (item.imdbId && profile.imdbId && profile.imdbId !== item.imdbId)
      return { skip: 'conflict:imdb_mismatch', conflict: true };
    const mediaId = await this.meta.lightUpsertMovie({
      tmdbId: profile.tmdbId,
      title: profile.title,
      year: profile.releaseYear,
    });
    return { mediaId, created: true };
  }

  /**
   * Series: an existing row owning the chart's TMDB or IMDb id is used as is (no provider
   * calls). A new title goes through the IMDb crosswalk (TVDB remote-id → TMDB /find with a
   * verified tvdb link → WatchForge repair lane), which also finds TVDB-only rows.
   */
  private async resolveSeries(item: MotnTopItem, watchforge: boolean): Promise<Resolution> {
    const tmdbRef = this.ref(ExternalProvider.TMDB, 'SHOW', String(item.tmdbId));
    const direct = [tmdbRef];
    if (item.imdbId) direct.push(this.ref(ExternalProvider.IMDB, 'SHOW', item.imdbId));
    const local = await this.existing(direct, 'SHOW');
    if (local) return local;

    let bundle: IdentityRef[] = [tmdbRef];
    if (item.imdbId) {
      bundle = await this.seriesCrosswalk(item.imdbId, watchforge);
      const crosswalkTmdb = bundle.find((id) => id.provider === ExternalProvider.TMDB)?.value;
      if (crosswalkTmdb && crosswalkTmdb !== tmdbRef.value)
        return { skip: 'conflict:tmdb_mismatch', conflict: true };
      if (!crosswalkTmdb) {
        // TMDB had no IMDb mapping; the chart's TMDB id must not point at another title.
        const profile = await this.tmdb.getShowRoutingProfile(item.tmdbId);
        if (profile.imdbId && profile.imdbId !== item.imdbId)
          return { skip: 'conflict:imdb_mismatch', conflict: true };
        bundle = [tmdbRef, ...bundle];
      }
      // The crosswalk may surface a row known only by its TVDB id.
      const viaTvdb = await this.existing(bundle, 'SHOW');
      if (viaTvdb) return viaTvdb;
    }
    const mediaId = await this.meta.lightUpsertShow(
      { tmdbId: item.tmdbId, title: item.title, year: item.year },
      { verifyTvdbLink: true, watchforgeLane: watchforge ? 'repair' : null },
    );
    // Verified bundle aliases the new row lacks are attached through the guarded path.
    const known = await this.prisma.externalId.findMany({
      where: { mediaId, providerEntityKind: ProviderEntityKind.SERIES },
      select: { provider: true },
    });
    for (const id of bundle) {
      if (known.some((k) => k.provider === id.provider)) continue;
      await this.reconciler.attachExternalId(mediaId, id).catch(async (error) => {
        this.logger.warn(
          `Streaming chart alias ${id.provider}:${id.value} not attached to ${mediaId}: ${(error as Error).message}`,
        );
        await this.reconciler.requestIdentityRepair(mediaId).catch(() => undefined);
      });
    }
    return { mediaId, created: true };
  }

  /**
   * A WatchForge disagreement only means its TVDB evidence can't be trusted; the TVDB and
   * TMDB crosswalk alone still decides (and is itself verified), so retry without it.
   */
  private async seriesCrosswalk(imdbId: string, watchforge: boolean): Promise<IdentityRef[]> {
    const imdb = this.ref(ExternalProvider.IMDB, 'SHOW', imdbId);
    const run = (lane: 'repair' | null) =>
      this.reconciler.creationIdentities(imdb, ExternalProvider.THE_TVDB, {
        verifyTvdbLink: true,
        watchforgeLane: lane,
      });
    if (!watchforge) return run(null);
    try {
      return await run('repair');
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      return run(null);
    }
  }

  /**
   * The local row for a chart item, or null for a new title. Several rows owning the ids is a
   * catalog duplicate: it is queued for verified repair and the chart shows a deterministic
   * row without writing anything (a TVDB row the authority already gave TVDB ownership, else
   * the row owning the chart's TMDB id). With no safe pick the item is skipped.
   */
  private async existing(ids: IdentityRef[], type: 'SHOW' | 'MOVIE'): Promise<Resolution | null> {
    const owners: Owners = new Map();
    for (const id of ids) {
      const found = await this.meta.findMediaByExternal(
        id.provider as ExternalProvider,
        id.value,
        id.providerEntityKind as ProviderEntityKind,
      );
      if (found) owners.set(found.id, new Set([...(owners.get(found.id) ?? []), id.provider]));
    }
    if (owners.size === 0) return null;
    if (owners.size === 1) return { mediaId: [...owners.keys()][0]!, created: false };
    for (const owner of owners.keys())
      await this.reconciler.requestIdentityRepair(owner).catch(() => undefined);
    const survivor = await this.duplicateSurvivor(owners, type);
    return survivor
      ? { mediaId: survivor, created: false, duplicate: true }
      : { skip: 'conflict:local_duplicate', conflict: true };
  }

  private async duplicateSurvivor(owners: Owners, type: 'SHOW' | 'MOVIE'): Promise<string | null> {
    const ownerOf = (provider: string) =>
      [...owners].find(([, providers]) => providers.has(provider))?.[0] ?? null;
    if (type === 'SHOW') {
      const shows = await this.prisma.show.findMany({
        where: { mediaId: { in: [...owners.keys()] } },
        select: { mediaId: true, structureProvider: true, structureReason: true },
      });
      const tvdbOwned = shows.find(
        (show) =>
          owners.get(show.mediaId)?.has(ExternalProvider.THE_TVDB) &&
          show.structureProvider === 'TVDB' &&
          (show.structureReason === 'GENERAL_TVDB' || show.structureReason === 'ANIME_TVDB'),
      );
      if (tvdbOwned) return tvdbOwned.mediaId;
    }
    return ownerOf(ExternalProvider.TMDB);
  }

  private ref(provider: ExternalProvider, type: 'SHOW' | 'MOVIE', value: string): IdentityRef {
    return {
      provider,
      providerEntityKind: type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE,
      value,
    };
  }

  /** Charts are served only while the provider is configured and the job keeps them fresh. */
  async isAvailable(): Promise<boolean> {
    const cached = await this.redis.get<boolean>(AVAILABLE_KEY).catch(() => null);
    if (cached !== null) return cached;
    let available = false;
    try {
      available =
        (await this.motn.configured()) &&
        (await this.prisma.hydrationJob.count({
          where: {
            type: HydrationJobType.streaming_top,
            railSnapshot: true,
            status: 'completed',
            completedAt: { gte: new Date(Date.now() - STREAMING_TOP_MAX_AGE_MS) },
          },
        })) > 0;
    } catch (error) {
      this.logger.debug(`Streaming chart availability check failed: ${(error as Error).message}`);
    }
    await this.redis.set(AVAILABLE_KEY, available, 300).catch(() => undefined);
    return available;
  }

  /** Called after a run so a freshly enabled job shows up without waiting for the cache. */
  async invalidateAvailability(): Promise<void> {
    await this.redis.del(AVAILABLE_KEY).catch(() => undefined);
  }
}
