import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import { ContentClassification } from '@prisma/client';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CandidateDetectorService } from '../classification/candidate-detector.service';
import { ClassifierService } from '../classification/classifier.service';
import { AnimeMatchService } from '../matching/anime-match.service';
import { TvdbProvider } from '../providers/tvdb.provider';
import { METADATA_QUEUE, HydrationQueue, type IdentityJobData, type TvdbSearchJobData } from './hydration.queue';

/**
 * Background metadata enrichment worker (queue `metadata`). Stages are chained via stable
 * job ids and are idempotent. Identity-only stages (no mediaId) write evidence to Redis and
 * never create a DB row; promotion (Phase 11) transfers that evidence onto the real record.
 */
@Injectable()
export class HydrationProcessor implements OnModuleInit {
  private readonly logger = new Logger(HydrationProcessor.name);
  private worker!: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly detector: CandidateDetectorService,
    private readonly classifier: ClassifierService,
    private readonly animeMatch: AnimeMatchService,
    private readonly tvdb: TvdbProvider,
    private readonly queue: HydrationQueue,
  ) {}

  onModuleInit() {
    const connection = this.redis.client as any;
    this.worker = new Worker(
      METADATA_QUEUE,
      async (job) => this.dispatch(job.name, job.data),
      { connection, concurrency: 4 },
    );
    this.worker.on('failed', (job, err) => this.logger.warn(`metadata job ${job?.name}#${job?.id} failed: ${err.message}`));
  }

  private async dispatch(name: string, data: any): Promise<void> {
    switch (name) {
      case 'classify-candidate':
        return this.classifyCandidate(data as IdentityJobData);
      case 'anime-match':
        return this.animeMatchStage(data as IdentityJobData);
      case 'anime-hydrate':
        return this.animeHydrate((data as IdentityJobData).mediaId!);
      case 'tvdb-search':
        return this.tvdbSearch(data as TvdbSearchJobData);
      default:
        this.logger.debug(`unknown metadata job: ${name}`);
    }
  }

  /** Stage 1: candidate detection. For a local row, chains into hydration; for an
   *  identity-only provisional candidate, stores candidate evidence in Redis (no DB row). */
  async classifyCandidate(data: IdentityJobData): Promise<void> {
    if (data.mediaId) {
      const media = await this.loadMedia(data.mediaId);
      if (!media) return;
      const candidate = this.detector.detect(this.inputFromMedia(media));
      if (candidate.isCandidate) {
        await this.queue.enqueueAnimeHydrate(data.mediaId);
      } else if (!media.manualClassification) {
        await this.persist(data.mediaId, 'GENERAL' as ContentClassification, 'confirmed', 0, { reason: 'not_a_candidate' }, media.manualClassification);
      }
      return;
    }
    // Identity-only: read provisional snapshot, store candidate evidence (no DB row).
    const snap = await this.redis.get<any>(this.provKey(data));
    if (!snap) return;
    const candidate = this.detector.detect(this.inputFromSnapshot(snap));
    await this.redis.set(`cand:${data.provider}:${data.providerEntityKind}:${data.value}`, { candidate, at: Date.now() }, 600);
    if (candidate.isCandidate) await this.queue.enqueueAnimeMatch(data);
  }

  /** Stage 2 (identity-only): run Kitsu/Jikan matching against the provisional snapshot,
   *  cache the typed match result for transfer on promotion. No DB row. */
  async animeMatchStage(data: IdentityJobData): Promise<void> {
    const snap = await this.redis.get<any>(this.provKey(data));
    if (!snap) return;
    const candidate = this.detector.detect(this.inputFromSnapshot(snap));
    if (!candidate.isCandidate) return;
    try {
      const match = await this.animeMatch.matchAnime({
        title: snap.title,
        year: snap.year ?? null,
        structuralType: snap.structuralType ?? 'SHOW',
        episodeCount: snap.episodeCount ?? null,
      });
      await this.redis.set(`match:${data.provider}:${data.providerEntityKind}:${data.value}`, { candidate, match, at: Date.now() }, 600);
    } catch (e) {
      this.logger.debug(`identity anime-match failed: ${(e as Error).message}`);
    }
  }

  /** Stage 3 (terminal, mediaId): detect → match → classify → persist. Reuses cached
   *  provider search so it is cheap + idempotent. */
  async animeHydrate(mediaId: string): Promise<void> {
    const media = await this.loadMedia(mediaId);
    if (!media || media.manualClassification) return;
    const candidate = this.detector.detect(this.inputFromMedia(media));
    let match = null;
    if (candidate.isCandidate) {
      try {
        match = await this.animeMatch.matchAnime({
          title: media.title,
          year: media.show?.yearStart ?? media.movie?.releaseYear ?? null,
          structuralType: media.type,
        });
      } catch (e) {
        this.logger.debug(`anime-match for ${mediaId} failed: ${(e as Error).message}`);
      }
    }
    const result = this.classifier.classify(candidate, match);
    await this.persist(mediaId, result.classification as ContentClassification, result.tier, result.confidence, result.evidence, media.manualClassification);
  }

  /** Background TVDB search: store TVDB-only results as provisional candidates (Redis TTL),
   *  then run candidate detection on them (may enqueue identity-only classify-candidate). */
  async tvdbSearch(data: TvdbSearchJobData): Promise<void> {
    if (!this.tvdb.enabled) return;
    try {
      const res =
        data.structuralType === 'SHOW' ? await this.tvdb.searchShows(data.query, 1) : await this.tvdb.searchMovies(data.query, 1);
      const kind = data.structuralType === 'SHOW' ? 'SERIES' : 'MOVIE';
      for (const item of res.items.slice(0, 10)) {
        if (!item.tvdbId) continue;
        const provKey = `prov:THE_TVDB:${kind}:${item.tvdbId}:${data.locale}`;
        await this.redis.set(
          provKey,
          {
            provider: 'THE_TVDB',
            providerEntityKind: kind,
            value: String(item.tvdbId),
            title: item.title,
            overview: item.overview ?? null,
            posterUrl: item.posterUrl ?? null,
            backdropUrl: item.backdropUrl ?? null,
            year: item.year ?? null,
            structuralType: data.structuralType,
          },
          300,
        );
        // Candidate detection on the provisional snapshot (identity-only; no DB row).
        await this.queue.enqueueClassifyCandidate({
          provider: 'THE_TVDB' as any,
          providerEntityKind: kind as any,
          value: String(item.tvdbId),
          locale: data.locale,
        });
      }
    } catch (e) {
      this.logger.warn(`tvdb-search "${data.query}" failed: ${(e as Error).message}`);
    }
  }

  // ---- helpers ----

  private provKey(d: IdentityJobData): string {
    return `prov:${d.provider}:${d.providerEntityKind}:${d.value}:${d.locale ?? 'en'}`;
  }

  private async loadMedia(mediaId: string) {
    return this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { genres: { include: { genre: true } }, externalIds: true, show: true, movie: true },
    });
  }

  private inputFromMedia(m: any) {
    return {
      genres: (m.genres ?? []).map((g: any) => g?.genre?.name).filter(Boolean) as string[],
      externalIds: (m.externalIds ?? []).map((e: any) => ({
        provider: e.provider,
        providerEntityKind: e.providerEntityKind,
        value: e.value,
      })),
      structuralType: m.type,
    };
  }

  private inputFromSnapshot(s: any) {
    return {
      genres: s.genres ?? [],
      externalIds: s.externalIds ?? [{ provider: s.provider, providerEntityKind: s.providerEntityKind, value: s.value }],
      structuralType: s.structuralType,
    };
  }

  private async persist(
    mediaId: string,
    classification: ContentClassification,
    tier: string,
    confidence: number,
    evidence: Record<string, unknown>,
    manual: boolean,
  ): Promise<void> {
    if (manual) return; // never overwrite a manual classification
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: {
        contentClassification: classification,
        classificationTier: tier,
        classificationConfidence: confidence,
        classifiedAt: new Date(),
        classificationEvidence: evidence as any,
      },
    });
  }
}
