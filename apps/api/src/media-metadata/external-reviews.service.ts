import { Injectable, Logger } from '@nestjs/common';
import { CommentThreadType, ExternalProvider, MediaType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isProviderError } from './providers/shared/provider-errors';
import { TmdbProvider, type NormalizedReview } from './providers/tmdb.provider';

/** Reviews are re-synced lazily once they are older than this. */
const REVIEW_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * TMDB review persistence + lazy backfill.
 *
 * Reviews ride the one-call TMDB hydration (`append_to_response=reviews`) for new
 * hydrations; media/episodes hydrated before that get a light standalone fetch the first
 * time someone opens their comments thread (never-synced → inline, stale → background).
 * Page-1 replace semantics: rows that vanish from the provider's first page are pruned.
 */
@Injectable()
export class ExternalReviewsService {
  private readonly logger = new Logger(ExternalReviewsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
  ) {}

  /** Replace a media's page-1 review set (TMDB hydration path — reviews already fetched). */
  async syncMediaReviews(mediaId: string, reviews: NormalizedReview[]): Promise<void> {
    await this.replace('media', mediaId, reviews);
    await this.prisma.mediaItem
      .update({ where: { id: mediaId }, data: { reviewsSyncedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Stable page-1 sync. Existing ids, likes, replies, and translations survive unchanged content. */
  private async replace(kind: 'media' | 'episode', targetId: string, reviews: NormalizedReview[]) {
    const rows = reviews.map((r) => ({
      provider: ExternalProvider.TMDB,
      externalId: r.externalId,
      mediaId: kind === 'media' ? targetId : null,
      episodeId: kind === 'episode' ? targetId : null,
      author: r.author,
      username: r.username,
      avatarUrl: r.avatarUrl,
      rating: r.rating,
      content: r.content,
      url: r.url,
      reviewCreatedAt: r.createdAt ? new Date(r.createdAt) : new Date(),
      reviewUpdatedAt: r.updatedAt ? new Date(r.updatedAt) : null,
    }));
    const existing = await this.prisma.externalReview.findMany({
      where: kind === 'media' ? { mediaId: targetId } : { episodeId: targetId },
      select: { externalId: true, content: true },
    });
    const contentByExternalId = new Map(existing.map((row) => [row.externalId, row.content]));
    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const contentChanged = contentByExternalId.get(row.externalId) !== row.content;
        await tx.externalReview.upsert({
          where: {
            provider_externalId: { provider: ExternalProvider.TMDB, externalId: row.externalId },
          },
          create: row,
          update: {
            ...row,
            ...(contentChanged ? { language: null, translations: {} } : {}),
          },
        });
      }
      await tx.externalReview.deleteMany({
        where: {
          ...(kind === 'media' ? { mediaId: targetId } : { episodeId: targetId }),
          externalId: { notIn: rows.map((row) => row.externalId) },
          // Provider rows with user interaction become durable thread roots. Removing
          // them would cascade likes and detach replies into unrelated top-level posts.
          comments: { none: {} },
          likes: { none: {} },
        },
      });
    });
  }

  /**
   * Lazy sync for a comments-thread open. Returns true when the target is fresh (rows
   * readable NOW). Never-synced targets are fetched inline (one light call, awaited);
   * stale targets refresh in the background (the caller serves current rows immediately).
   */
  async ensureFreshForThread(threadType: CommentThreadType, threadId: string): Promise<void> {
    if (!this.tmdb.enabled) return;
    if (threadType === 'EPISODE') {
      // TMDB documents movie/show review endpoints, but no episode-review endpoint.
      // Keep any legacy cached rows readable; never manufacture a sync stamp from an
      // unsupported route.
      return;
    }

    if (threadType === 'SHOW' || threadType === 'MOVIE') {
      const media = await this.prisma.mediaItem.findUnique({
        where: { id: threadId },
        select: {
          type: true,
          reviewsSyncedAt: true,
          externalIds: {
            where: { provider: ExternalProvider.TMDB },
            take: 1,
            select: { value: true },
          },
        },
      });
      if (!media) return;
      const tmdbId = media.externalIds?.[0]?.value;
      if (!tmdbId) return;
      const run = async () => {
        const reviews = await this.fetchSafe(() =>
          media.type === MediaType.MOVIE
            ? this.tmdb.getMovieReviews(Number(tmdbId))
            : this.tmdb.getShowReviews(Number(tmdbId)),
        );
        if (reviews != null) await this.syncMediaReviews(threadId, reviews);
      };
      if (!media.reviewsSyncedAt) await run();
      else if (Date.now() - media.reviewsSyncedAt.getTime() > REVIEW_STALE_MS) void run();
    }
  }

  /** Read the stored page-1 set for a thread (newest first), with user reply counts. */
  async listForThread(threadType: CommentThreadType, threadId: string) {
    if (threadType !== 'SHOW' && threadType !== 'MOVIE' && threadType !== 'EPISODE') return [];
    const rows = await this.prisma.externalReview.findMany({
      where: threadType === 'EPISODE' ? { episodeId: threadId } : { mediaId: threadId },
      orderBy: { reviewCreatedAt: 'desc' },
      take: 20,
    });
    if (!rows.length) return [];
    const replyCounts = await this.prisma.comment.groupBy({
      by: ['externalReviewId'],
      where: {
        externalReviewId: { in: rows.map((r) => r.id) },
        deletedByUser: false,
        adminDeleted: false,
        hidden: false,
      },
      _count: { _all: true },
    });
    const countById = new Map(replyCounts.map((r) => [r.externalReviewId, r._count._all]));
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      author: r.author,
      username: r.username,
      avatarUrl: r.avatarUrl,
      rating: r.rating,
      content: r.content,
      url: r.url,
      createdAt: r.reviewCreatedAt,
      repliesCount: countById.get(r.id) ?? 0,
    }));
  }

  /** A 404 means the entity has no review page on TMDB — sync as empty (don't retry).
   *  Any other error leaves the target unsynced so a later open retries. */
  private async fetchSafe(
    fn: () => Promise<NormalizedReview[]>,
  ): Promise<NormalizedReview[] | null> {
    try {
      return await fn();
    } catch (e) {
      if (isProviderError(e) && e.category === 'not_found') return [];
      this.logger.debug(`TMDB reviews fetch failed: ${(e as Error).message}`);
      return null;
    }
  }
}
