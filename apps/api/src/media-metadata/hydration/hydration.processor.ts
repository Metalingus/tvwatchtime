import { IdentityRepairService, IdentityVerificationDeferred } from '../identity-repair.service';
import { IdentityAuditStore } from '../identity-audit.store';
import { assertMediaIdentityWrite } from '../util/identity-write-guard';
import { ConflictException } from '@nestjs/common';
import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Worker, type Job } from 'bullmq';
import { ContentClassification } from '@prisma/client';
import { RedisService } from '../../common/redis/redis.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CandidateDetectorService } from '../classification/candidate-detector.service';
import { ClassifierService } from '../classification/classifier.service';
import type { CandidateInput } from '../classification/types';
import { AnimeMatchService } from '../matching/anime-match.service';
import { TvdbProvider } from '../providers/tvdb.provider';
import { TmdbProvider } from '../providers/tmdb.provider';
import { MediaMetadataService } from '../media-metadata.service';
import { MediaCanonicalizationService } from '../media-canonicalization.service';
import {
  METADATA_QUEUE,
  INTERACTIVE_METADATA_QUEUE,
  type ArtworkGalleryJobData,
  HydrationQueue,
  type CharacterArtworkJobData,
  type IdentityJobData,
  type NewTvdbShowHydrationJobData,
  type TmdbShowSupplementJobData,
  type TvdbSearchJobData,
} from './hydration.queue';
import { CharacterArtworkService } from '../character-artwork.service';
import { ArtworkGalleryService } from '../artwork-gallery.service';

const STRUCTURE_PROVIDER_RETRY_DELAY_MS = 30 * 60_000;
/** Identity repairs waiting on WatchForge quota/cooldown: park, then give up after 3 days. */
const MIN_IDENTITY_DEFERRAL_DELAY_MS = 30_000;
const MAX_IDENTITY_DEFERRAL_DELAY_MS = 6 * 3_600_000;
const MAX_IDENTITY_DEFERRAL_MS = 3 * 86_400_000;

class RetryableStructureEvaluationError extends Error {
  constructor(mediaId: string) {
    super(`Structure evaluation deferred for ${mediaId}: provider unavailable`);
    this.name = 'RetryableStructureEvaluationError';
  }
}

/**
 * Background metadata enrichment worker (queue `metadata`). Stages are chained via stable
 * job ids and are idempotent. Identity-only stages (no mediaId) write evidence to Redis and
 * never create a DB row; promotion (Phase 11) transfers that evidence onto the real record.
 */
@Injectable()
export class HydrationProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HydrationProcessor.name);
  private worker!: Worker;
  private interactiveWorker!: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly detector: CandidateDetectorService,
    private readonly classifier: ClassifierService,
    private readonly animeMatch: AnimeMatchService,
    private readonly tvdb: TvdbProvider,
    private readonly tmdb: TmdbProvider,
    private readonly queue: HydrationQueue,
    private readonly meta: MediaMetadataService,
    private readonly config: ConfigService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly canonical?: MediaCanonicalizationService,
    @Optional() private readonly characterArtwork?: CharacterArtworkService,
    @Optional() private readonly artworkGallery?: ArtworkGalleryService,
    @Optional() private readonly identityRepair?: IdentityRepairService,
  ) {}

  onModuleInit() {
    const connection = this.redis.client as any;
    this.worker = new Worker(METADATA_QUEUE, async (job, token) => this.processJob(job, token), {
      connection,
      concurrency: 4,
    });
    // Visible metadata must not wait behind a bulk import/classification backlog.
    this.interactiveWorker = new Worker(
      INTERACTIVE_METADATA_QUEUE,
      async (job, token) => this.processJob(job, token),
      { connection, concurrency: 2 },
    );
    this.interactiveWorker.on('failed', (job, err) => {
      void this.handleJobFailure(job, err).catch(() => undefined);
    });
    this.worker.on('failed', (job, err) => {
      void this.handleJobFailure(job, err).catch((failure) =>
        this.logger.error(
          `metadata failure handler for ${job?.name}#${job?.id} failed: ${(failure as Error).message}`,
        ),
      );
    });
  }

  /**
   * Worker entry. A deferred identity verification (quota, cooldown, outage) is parked until
   * the provider can answer, without consuming a retry attempt; after
   * MAX_IDENTITY_DEFERRAL_MS it falls through to the normal failure path.
   */
  async processJob(job: Job, token?: string): Promise<unknown> {
    try {
      return await this.dispatch(job.name, job.data);
    } catch (error) {
      if (!(error instanceof IdentityVerificationDeferred) || !token) throw error;
      const since = Number(job.data?.deferredSince) || Date.now();
      if (Date.now() - since > MAX_IDENTITY_DEFERRAL_MS) throw error;
      const delay = Math.min(
        Math.max(error.retryAfterMs ?? 60_000, MIN_IDENTITY_DEFERRAL_DELAY_MS),
        MAX_IDENTITY_DEFERRAL_DELAY_MS,
      );
      await job.updateData({ ...job.data, deferredSince: since });
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }
  }

  private async handleJobFailure(job: Job | undefined, err: Error): Promise<void> {
    this.logger.warn(`metadata job ${job?.name}#${job?.id} failed: ${err.message}`);
    if (
      job?.name === 'identity-apply' &&
      job.attemptsMade >= Math.max(1, Number(job.opts.attempts ?? 1))
    ) {
      await new IdentityAuditStore(this.prisma).state(job.data.operationId, 'failed', {
        error:
          'Repair worker stopped before completion. Preview again; any committed receipt is preserved.',
      });
      return;
    }
    if (
      job?.name === 'identity-refresh' &&
      job.data.operationId &&
      job.attemptsMade >= Math.max(1, Number(job.opts.attempts ?? 1))
    ) {
      await new IdentityAuditStore(this.prisma).followUp(job.data.operationId, job.data.mediaId, {
        status: 'failed',
        reason: 'Metadata worker exhausted retries. Retry metadata cleanup.',
      });
      return;
    }
    if (
      job?.name === 'identity-repair' &&
      job.attemptsMade >= Math.max(1, Number(job.opts.attempts ?? 1))
    ) {
      await this.events?.emitAsync('metadata.identity-repaired', {
        mediaId: job.data.mediaId,
        repaired: false,
        reason: 'Identity verification is temporarily unavailable',
      });
      return;
    }
    if (job?.name !== 'structure-evaluate') return;

    const attempts = Math.max(1, Number(job.opts.attempts ?? 1));
    if (job.attemptsMade < attempts) return;
    const mediaId = (job.data as IdentityJobData | undefined)?.mediaId;
    if (!mediaId) return;

    if (
      err.name === 'RetryableStructureEvaluationError' ||
      err.message.startsWith('Structure evaluation deferred for ')
    ) {
      this.logger.warn(
        `structure-evaluate: ${mediaId} exhausted transient retries; queued another provider retry in ${STRUCTURE_PROVIDER_RETRY_DELAY_MS / 60_000} minutes`,
      );
      await this.queue.enqueueStructureEvaluation(mediaId, STRUCTURE_PROVIDER_RETRY_DELAY_MS);
      return;
    }

    // A deterministic identity/remap failure must not strand eligible import rows in
    // PENDING_MATCH forever. Reuse the normal replay path in blocked mode: exact aliases
    // still apply, comments retain their show-level fallback, and unprovable artifacts
    // become hidden audit rows without weakening the atomic structure guard.
    this.events?.emit('metadata.structure-evaluated', {
      mediaId,
      evaluated: false,
      changed: false,
      blocked: true,
      terminalFailure: true,
    });
  }

  private async dispatch(name: string, data: any): Promise<unknown> {
    switch (name) {
      case 'identity-repair': {
        if (!this.identityRepair) throw new Error('Identity repair handler unavailable');
        const result = await this.identityRepair.repairAutomatically(data.mediaId);
        if (result.repaired || result.followUps.length) {
          for (const mediaId of result.mediaIds) {
            const operations = result.followUps.filter((row) => row.mediaId === mediaId);
            try {
              const media = await this.prisma.mediaItem.findUnique({
                where: { id: mediaId },
                select: { type: true },
              });
              if (!media) continue;
              try {
                await assertMediaIdentityWrite(this.prisma, mediaId, media.type, []);
              } catch (error) {
                if (!(error instanceof ConflictException)) throw error;
                for (const operation of operations)
                  await new IdentityAuditStore(this.prisma).followUp(
                    operation.operationId,
                    mediaId,
                    {
                      status: 'blocked',
                      reason: result.reason ?? 'Identity still needs verification',
                    },
                  );
                continue;
              }
              const refreshed = await this.identityRefresh({ mediaId, version: 'automatic' });
              for (const operation of operations)
                await new IdentityAuditStore(this.prisma).followUp(operation.operationId, mediaId, {
                  status: refreshed.refreshed ? 'completed' : 'blocked',
                  ...refreshed,
                });
            } catch (error) {
              for (const operation of operations)
                await new IdentityAuditStore(this.prisma).followUp(operation.operationId, mediaId, {
                  status: 'failed',
                  reason: 'Metadata refresh will retry',
                });
              throw error;
            }
          }
        }
        await this.events?.emitAsync('metadata.identity-repaired', {
          ...result,
          mediaId: data.mediaId,
        });
        return result;
      }
      case 'identity-apply':
        if (!this.identityRepair) throw new Error('Identity repair handler unavailable');
        return this.identityRepair.apply(data.operationId, data.actorId);
      case 'identity-refresh':
        return this.trackedIdentityRefresh(data);
      case 'classify-candidate':
        return this.classifyCandidate(data as IdentityJobData);
      case 'anime-match':
        return this.animeMatchStage(data as IdentityJobData);
      case 'anime-hydrate':
        return this.animeHydrate((data as IdentityJobData).mediaId!);
      case 'structure-evaluate':
        return this.structureEvaluate((data as IdentityJobData).mediaId!);
      case 'new-tvdb-show-hydrate':
        return this.newTvdbShowHydrate(data as NewTvdbShowHydrationJobData);
      case 'tvdb-search':
        return this.tvdbSearch(data as TvdbSearchJobData);
      case 'tvdb-rehydrate':
        return this.tvdbRehydrate(data as { mediaId: string; tvdbId: number });
      case 'episode-metadata':
        return this.meta.runEpisodeMetadataRefresh(data);
      case 'tmdb-show-supplement':
        return this.tmdbShowSupplement(data as TmdbShowSupplementJobData);
      case 'tvdb-movie-cast':
        return this.tvdbMovieCast(data as { mediaId: string });
      case 'character-artwork': {
        if (!this.characterArtwork) {
          throw new Error('Character artwork worker is not configured');
        }
        return this.characterArtwork.enrich(
          (data as CharacterArtworkJobData).mediaId,
          (data as CharacterArtworkJobData).fingerprint,
        );
      }
      case 'artwork-gallery': {
        if (!this.artworkGallery) throw new Error('Artwork gallery worker is not configured');
        const job = data as ArtworkGalleryJobData;
        return job.ownerType === 'MEDIA'
          ? this.artworkGallery.hydrateMedia(job.ownerId, job.fingerprint)
          : this.artworkGallery.hydrateEpisode(job.ownerId, job.fingerprint);
      }
      default:
        this.logger.debug(`unknown metadata job: ${name}`);
    }
  }

  private async trackedIdentityRefresh(data: {
    mediaId: string;
    version: string;
    operationId?: string;
  }) {
    try {
      const result = await this.identityRefresh(data);
      if (data.operationId)
        await new IdentityAuditStore(this.prisma).followUp(data.operationId, data.mediaId, {
          status: result.refreshed ? 'completed' : 'blocked',
          ...result,
        });
      return result;
    } catch (error) {
      if (data.operationId)
        await new IdentityAuditStore(this.prisma).followUp(data.operationId, data.mediaId, {
          status: 'failed',
          reason: 'Metadata refresh failed; retry remains available',
        });
      throw error;
    }
  }

  private async identityRefresh(data: { mediaId: string; version: string }) {
    const mediaId = this.canonical
      ? await this.canonical.resolveMediaId(data.mediaId)
      : data.mediaId;
    let media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true, show: true },
    });
    if (!media) return { refreshed: false, reason: 'not-found' };
    const kind = media.type === 'SHOW' ? 'SERIES' : 'MOVIE';
    const id = (provider: string) =>
      Number(
        media!.externalIds.find((e) => e.provider === provider && e.providerEntityKind === kind)
          ?.value,
      ) || null;
    let tmdb = id('TMDB'),
      tvdb = id('THE_TVDB');
    if (!tmdb && !tvdb) return { refreshed: false, mediaId, reason: 'missing-provider-identity' };
    if (media.type === 'MOVIE') {
      const hydrated = tmdb
        ? await this.meta.ensureMovieFull(tmdb, { forceRefresh: true })
        : await this.meta.ensureMovieFullTvdb(tvdb!);
      if (hydrated !== mediaId)
        return { refreshed: false, mediaId, reason: 'identity-family-needs-consolidation' };
      if (tvdb && this.tvdb.enabled) await this.meta.enrichMovieCastForPendingVotes(mediaId);
      return { refreshed: true, mediaId };
    }
    if (tmdb) {
      const evaluation = await this.meta.evaluateShowStructureAuthority(mediaId, {
        verifiedIdentity: { tmdbId: tmdb, ...(tvdb ? { tvdbId: tvdb } : {}) },
      });
      if (evaluation.deferred) throw new RetryableStructureEvaluationError(mediaId);
      if (evaluation.blocked) return { refreshed: false, mediaId, reason: 'protected-structure' };
    }
    media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true, show: true },
    });
    if (!media) return { refreshed: false, mediaId, reason: 'not-found' };
    tmdb = id('TMDB');
    tvdb = id('THE_TVDB');
    let hydrated: string | undefined;
    if (media.show?.structureProvider === 'TVDB' && tvdb) {
      hydrated = await this.meta.ensureShowFullTvdb(tvdb, undefined, { forceRefresh: true });
    } else if (tmdb) {
      hydrated = await this.meta.ensureShowFull(tmdb, undefined, { forceRefresh: true });
    } else if (tvdb) {
      hydrated = await this.meta.ensureShowFullTvdb(tvdb, undefined, { forceRefresh: true });
    }
    if (hydrated !== mediaId)
      return { refreshed: false, mediaId, reason: 'identity-family-needs-consolidation' };
    if (tmdb && media?.show?.structureProvider === 'TVDB')
      await this.meta.refreshTmdbShowSupplements(mediaId);
    if (tvdb && media?.show?.structureProvider === 'TMDB')
      await this.tvdbRehydrate({ mediaId, tvdbId: tvdb });
    return { refreshed: true, mediaId };
  }

  async structureEvaluate(mediaId: string) {
    const result = await this.meta.evaluateShowStructureAuthority(mediaId);
    this.logger.log(
      `structure-evaluate: ${mediaId} evaluated=${result.evaluated} changed=${result.changed} blocked=${result.blocked} deferred=${result.deferred === true}`,
    );
    // Provider outages are retryable queue failures, not a terminal manual-review result.
    if (result.deferred) {
      throw new RetryableStructureEvaluationError(mediaId);
    }
    // Import replay is follow-up work, not part of this provider job. Holding this BullMQ
    // slot until every listener finishes can starve imports and all other metadata jobs.
    this.events?.emit('metadata.structure-evaluated', {
      mediaId,
      evaluated: result.evaluated,
      changed: result.changed,
      blocked: result.blocked,
    });
    // This is intentionally after the authority job and remains fully backgrounded: imports
    // never wait for cross-media copying. ACTIVE cutover happens only after copy verification.
    const canonical =
      this.canonical && this.config.get<boolean>('jobs.structureRepairEnabled') === true
        ? await this.canonical.evaluateTvdbAggregate(mediaId, 'repair')
        : undefined;
    if (this.canonical && !canonical) {
      this.logger.debug(
        `media-canonicalize: ${mediaId} automatic activation disabled by STRUCTURE_REPAIR_ENABLED`,
      );
    }
    if (canonical?.candidates) {
      this.logger.log(
        `media-canonicalize: ${mediaId} candidates=${canonical.candidates} activated=${canonical.activated} blocked=${canonical.blocked}`,
      );
    }
    if (
      canonical &&
      canonical.blocked > 0 &&
      (canonical.candidates === 0 || canonical.activated < canonical.candidates)
    ) {
      throw new Error(
        `Cross-media canonicalization blocked for ${mediaId}: ${canonical.blocked} proof/copy failure(s)`,
      );
    }
    return { ...result, canonical };
  }

  async newTvdbShowHydrate(data: NewTvdbShowHydrationJobData): Promise<void> {
    const hydrated = await this.meta.hydrateNewTvdbShowAsAnime(data.mediaId, data.tvdbId);
    this.logger.debug(
      `new-tvdb-show-hydrate: ${data.mediaId} TVDB ${data.tvdbId} anime=${hydrated}`,
    );
  }

  /** Background TVDB re-hydration of one show (queued by import character-vote apply).
   *  Bypasses the 24h staleness gate (queued specifically to rewrite stale data such as
   *  missing cast character ids); rate-limit errors rethrow so BullMQ retries.
   *  skipClassification: cast-purpose rehydration — anime evidence is unchanged, and the
   *  classification enqueue storm would saturate Kitsu/Jikan during import waves. */
  async tvdbRehydrate(data: { mediaId: string; tvdbId: number }): Promise<void> {
    if (!this.tvdb.enabled) return;
    await this.meta.ensureShowFullTvdb(data.tvdbId, undefined, {
      skipClassification: true,
      writeScope: 'CAST_ONLY',
      forceRefresh: true,
    });
    this.logger.debug(`tvdb-rehydrate: ${data.mediaId} refreshed TVDB cast ${data.tvdbId}`);
  }

  async tmdbShowSupplement(data: TmdbShowSupplementJobData): Promise<void> {
    if (!this.tmdb.enabled) return;
    const mediaId = this.canonical
      ? await this.canonical.resolveMediaId(data.mediaId)
      : data.mediaId;
    const result = await this.meta.refreshTmdbShowSupplements(mediaId);
    this.logger.debug(
      `tmdb-show-supplement: ${mediaId} refreshed=${result.refreshed} reason=${result.reason ?? 'ok'}`,
    );
  }

  async tvdbMovieCast(data: { mediaId: string }): Promise<void> {
    if (!this.tvdb.enabled) return;
    const result = await this.meta.enrichMovieCastForPendingVotes(data.mediaId);
    this.logger.debug(
      `tvdb-movie-cast: ${data.mediaId} resolved ${result.resolved}/${result.requested} role aliases`,
    );
  }

  /** Stage 1: candidate detection. For a local row, chains into hydration; for an
   *  identity-only provisional candidate, stores candidate evidence in Redis (no DB row). */
  async classifyCandidate(data: IdentityJobData): Promise<void> {
    if (data.mediaId) {
      const media = await this.loadMedia(data.mediaId);
      if (!media) return;
      if (media.type === 'SHOW' && media.show?.structureReason === 'ANIME_TVDB') {
        await this.persist(
          data.mediaId,
          'ANIME' as ContentClassification,
          'confirmed',
          1,
          { source: 'structure_authority', reason: 'ANIME_TVDB' },
          media.manualClassification,
        );
        return;
      }
      const candidate = this.detector.detect(this.inputFromMedia(media));
      if (candidate.isCandidate) {
        await this.queue.enqueueAnimeHydrate(data.mediaId);
      } else if (!media.manualClassification) {
        await this.persist(
          data.mediaId,
          'GENERAL' as ContentClassification,
          'confirmed',
          0,
          { reason: 'not_a_candidate' },
          media.manualClassification,
        );
      }
      return;
    }
    // Identity-only: read provisional snapshot, store candidate evidence (no DB row).
    const snap = await this.redis.get<any>(this.provKey(data));
    if (!snap) return;
    const candidate = this.detector.detect(this.inputFromSnapshot(snap));
    await this.redis.set(
      `cand:${data.provider}:${data.providerEntityKind}:${data.value}`,
      { candidate, at: Date.now() },
      600,
    );
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
      await this.redis.set(
        `match:${data.provider}:${data.providerEntityKind}:${data.value}`,
        { candidate, match, at: Date.now() },
        600,
      );
    } catch (e) {
      this.logger.debug(`identity anime-match failed: ${(e as Error).message}`);
    }
  }

  /** Stage 3 (terminal, mediaId): strict TMDB classification. Kitsu/Jikan are never
   * consulted here; their matches are optional identity/enrichment evidence only. */
  async animeHydrate(mediaId: string): Promise<void> {
    const media = await this.loadMedia(mediaId);
    if (!media || media.manualClassification) return;
    if (media.type === 'SHOW' && media.show?.structureReason === 'ANIME_TVDB') {
      await this.persist(
        mediaId,
        'ANIME' as ContentClassification,
        'confirmed',
        1,
        { source: 'structure_authority', reason: 'ANIME_TVDB' },
        false,
      );
      return;
    }
    const input = this.inputFromMedia(media);
    const tmdbExt = media.externalIds.find(
      (e: any) =>
        e.provider === 'TMDB' &&
        e.providerEntityKind === (media.type === 'MOVIE' ? 'MOVIE' : 'SERIES'),
    );
    if (!tmdbExt || !this.tmdb.enabled) return;
    try {
      const profile =
        media.type === 'MOVIE'
          ? await this.tmdb.getMovieRoutingProfile(Number(tmdbExt.value))
          : await this.tmdb.getShowRoutingProfile(Number(tmdbExt.value));
      input.tmdbGenreIds = profile.genreIds;
      input.keywords = profile.keywords;
      if (media.type === 'MOVIE') {
        await this.prisma.movie
          .update({ where: { mediaId }, data: { keywords: profile.keywords } })
          .catch(() => undefined);
      } else {
        await this.prisma.show
          .update({ where: { mediaId }, data: { keywords: profile.keywords } })
          .catch(() => undefined);
      }
    } catch {
      return; // provider unavailable: do not persist a false GENERAL verdict
    }
    const candidate = this.detector.detect(input);
    const result = this.classifier.classify(candidate, null);
    await this.persist(
      mediaId,
      result.classification as ContentClassification,
      result.tier,
      result.confidence,
      result.evidence,
      media.manualClassification,
    );
  }

  /** Background TVDB search: store TVDB-only results as provisional candidates (Redis TTL),
   *  then run candidate detection on them (may enqueue identity-only classify-candidate). */
  async tvdbSearch(data: TvdbSearchJobData): Promise<void> {
    if (!this.tvdb.enabled) return;
    try {
      const res =
        data.structuralType === 'SHOW'
          ? await this.tvdb.searchShows(data.query, 1)
          : await this.tvdb.searchMovies(data.query, 1);
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

  private inputFromMedia(m: any): CandidateInput {
    return {
      genres: (m.genres ?? []).map((g: any) => g?.genre?.name).filter(Boolean) as string[],
      // Origin/language remain enrichment evidence only. They cannot classify anime or
      // select structural ownership without the strict TMDB genre+keyword rule.
      originalLanguage: m.show?.originalLanguage ?? null,
      originCountries: m.show?.originCountries ?? [],
      // TMDB keyword signal (persisted by TMDB hydration; the `anime` keyword is strong).
      keywords: (m.show?.keywords ?? m.movie?.keywords ?? []) as string[],
      externalIds: (m.externalIds ?? []).map((e: any) => ({
        provider: e.provider,
        providerEntityKind: e.providerEntityKind,
        value: e.value,
      })),
      manualCandidate: m.manualCandidate === true,
      structuralType: m.type,
    };
  }

  private inputFromSnapshot(s: any): CandidateInput {
    return {
      genres: s.genres ?? [],
      tmdbGenreIds: s.genreIds ?? [],
      keywords: s.keywords ?? [],
      externalIds: s.externalIds ?? [
        { provider: s.provider, providerEntityKind: s.providerEntityKind, value: s.value },
      ],
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
  async onModuleDestroy() {
    await Promise.all([this.worker?.close(), this.interactiveWorker?.close()]);
  }
}
