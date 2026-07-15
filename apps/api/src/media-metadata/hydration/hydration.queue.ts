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
    return this.queue.add('anime-hydrate', { mediaId }, {
      jobId: HydrationQueue.jobId('anime-hydrate', `media-${mediaId}`),
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
  }

  enqueueTvdbSearch(query: string, structuralType: 'SHOW' | 'MOVIE', locale: string): Promise<unknown> {
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
}
