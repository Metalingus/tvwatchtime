import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { RedisService } from '../../common/redis/redis.service';

export const METADATA_QUEUE = 'metadata';

export interface IdentityJobData {
  mediaId?: string;
  provider?: ExternalProvider;
  providerEntityKind?: ProviderEntityKind;
  value?: string;
  locale?: string;
}
export interface TvdbSearchJobData {
  query: string;
  structuralType: 'SHOW' | 'MOVIE';
  locale: string;
}

/**
 * Enqueue-only handle for the metadata enrichment pipeline. All jobs use stable,
 * deterministic BullMQ job ids so equivalent work is deduplicated across search/import/
 * rehydration (8,000 import rows of one show → one enrichment).
 */
@Injectable()
export class HydrationQueue implements OnModuleInit {
  private readonly logger = new Logger(HydrationQueue.name);
  private queue!: Queue;

  constructor(private readonly redis: RedisService) {}

  onModuleInit() {
    this.queue = new Queue(METADATA_QUEUE, { connection: this.redis.client as any });
  }

  private static identityKey(d: IdentityJobData): string {
    if (d.mediaId) return `media-${d.mediaId}`;
    // BullMQ jobIds cannot contain ':', so use '-' as the namespace separator.
    return `${d.provider}-${d.providerEntityKind}-${d.value}`;
  }

  /** Stable, deterministic job id for a stage + identity/query. */
  static jobId(stage: string, key: string): string {
    return `${stage}-${key}`;
  }

  /**
   * Enqueue candidate classification. `version` (typically the media's metadataRefreshedAt
   * epoch ms) makes the job re-run after each re-hydration — without it, a search-time stub
   * classify would dedupe-block the authoritative post-hydration classify.
   */
  enqueueClassifyCandidate(data: IdentityJobData, version?: string): Promise<unknown> {
    const key = HydrationQueue.identityKey(data);
    const base = `classify-candidate-${key}`;
    const jobId = version ? `${base}-v${version}` : base;
    return this.queue.add('classify-candidate', data, {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
  }

  enqueueAnimeMatch(data: IdentityJobData): Promise<unknown> {
    const key = HydrationQueue.identityKey(data);
    return this.queue.add('anime-match', data, {
      jobId: HydrationQueue.jobId('anime-match', key),
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
  }

  enqueueAnimeHydrate(mediaId: string): Promise<unknown> {
    return this.queue.add(
      'anime-hydrate',
      { mediaId },
      {
        jobId: HydrationQueue.jobId('anime-hydrate', `media-${mediaId}`),
        // Anime matching hits external services (Kitsu/Jikan): transient failures retry
        // instead of persisting a degraded classification. The long exponential backoff
        // spreads retries over ~an hour so a provider-saturation wave (import/backfill
        // storms) doesn't turn into a retry storm of its own.
        attempts: 5,
        backoff: { type: 'exponential', delay: 120000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
      },
    );
  }

  enqueueTvdbSearch(
    query: string,
    structuralType: 'SHOW' | 'MOVIE',
    locale: string,
  ): Promise<unknown> {
    const norm = query.trim().toLowerCase();
    return this.queue.add(
      'tvdb-search',
      { query: norm, structuralType, locale } satisfies TvdbSearchJobData,
      {
        jobId: HydrationQueue.jobId('tvdb-search', `${norm}-${structuralType}-${locale}`),
        removeOnComplete: 1000,
        removeOnFail: 2000,
      },
    );
  }

  /**
   * Background TVDB re-hydration of one show (e.g. to fill cast character ids for import
   * character-vote resolution). Stable job id dedupes concurrent triggers for the same
   * show; transient failures (incl. TVDB rate limits) retry with a long exponential
   * backoff instead of blocking the caller.
   */
  async enqueueTvdbRehydrate(mediaId: string, tvdbId: number): Promise<unknown> {
    const jobId = HydrationQueue.jobId('tvdb-rehydrate', `media-${mediaId}`);
    // BullMQ retains a bounded number of completed jobs. Active work should dedupe,
    // but a completed/failed job must not suppress a deliberate later refresh (for
    // example when its completion raced an import's transition to COMPLETED).
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove().catch(() => undefined);
      }
    }
    return this.queue.add(
      'tvdb-rehydrate',
      { mediaId, tvdbId },
      {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 120000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
      },
    );
  }

  /** Cast-only reconciliation for a TMDB-canonical movie. The worker reads all pending
   * role ids for the movie in one batch and never replaces its canonical metadata. */
  async enqueueTvdbMovieCastEnrichment(mediaId: string): Promise<unknown> {
    const jobId = HydrationQueue.jobId('tvdb-movie-cast', `media-${mediaId}`);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove().catch(() => undefined);
      }
    }
    return this.queue.add(
      'tvdb-movie-cast',
      { mediaId },
      {
        jobId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 120000 },
        removeOnComplete: 1000,
        removeOnFail: 2000,
      },
    );
  }
}
