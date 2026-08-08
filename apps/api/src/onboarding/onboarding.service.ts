import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExternalProvider, Prisma } from '@prisma/client';
import {
  MediaType,
  ONBOARDING_VERSION,
  OnboardingApplyResultDto,
  OnboardingStateDto,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { episodeProgressEligibilityWhere } from '../common/utils/episode-progress.util';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbClient } from '../media-metadata/providers/tmdb.client';
import { TvdbClient } from '../media-metadata/providers/tvdb.client';
import { ApplyOnboardingDto, OnboardingShowItem } from './dto/apply-onboarding.dto';
import { UpdateOnboardingStateDto } from './dto/update-onboarding-state.dto';

type EligibleEpisode = {
  id: string;
  number: number;
  seasonNumber: number;
  runtimeMinutes: number | null;
};

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly redis: RedisService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbClient,
    private readonly tvdb: TvdbClient,
  ) {}

  // ---------------- State ----------------
  async getState(userId: string): Promise<OnboardingStateDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { onboardingStatus: true, onboardingVersion: true },
    });
    return {
      status: user?.onboardingStatus ?? 'NOT_STARTED',
      version: user?.onboardingVersion ?? null,
      requiredVersion: ONBOARDING_VERSION,
    };
  }

  async updateState(userId: string, dto: UpdateOnboardingStateDto): Promise<OnboardingStateDto> {
    const terminal = dto.status === 'COMPLETED' || dto.status === 'SKIPPED';
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        onboardingStatus: dto.status,
        onboardingVersion: dto.version,
        ...(terminal ? { onboardingCompletedAt: new Date() } : {}),
      },
    });
    return this.getState(userId);
  }

  // ---------------- Apply ----------------
  /**
   * Bulk-apply onboarding selections. Behaves exactly like the user marked every
   * title manually: watchedAt = now, one watchHistory row per newly watched
   * episode/movie, one event per show/movie/watchlist add. Watched titles are
   * also watchlisted (tracked-library convention — removing from the watchlist
   * is how the app marks "dropped"). Idempotent — only unwatched→watched
   * transitions write anything, so replaying the same payload is a no-op.
   * Per-title failures are isolated and reported in `unresolved`.
   */
  async apply(userId: string, dto: ApplyOnboardingDto): Promise<OnboardingApplyResultDto> {
    const shows = dedupe(dto.shows ?? []);
    const movies = dedupe(dto.movies ?? []);
    if (
      shows.some(
        (s) =>
          s.action === 'WATCHED_THROUGH' &&
          (s.throughSeasonNumber == null || s.throughEpisodeNumber == null),
      )
    ) {
      throw new BadRequestException(
        'WATCHED_THROUGH requires throughSeasonNumber and throughEpisodeNumber',
      );
    }

    const result: OnboardingApplyResultDto = {
      applied: { showsProcessed: 0, episodesMarked: 0, moviesWatched: 0, watchlistAdded: 0 },
      unresolved: [],
    };

    // Watchlist adds are merge-only: pre-read existing items so addedCount is only
    // incremented for genuinely new rows (keeps apply replay a no-op). Watched
    // titles are watchlisted too (tracked-library convention), so the pre-read
    // covers every selected id, not just explicit WATCHLIST picks.
    const watchlistIds = [...shows.map((s) => s.mediaId), ...movies.map((m) => m.mediaId)];
    const existingWatchlist = watchlistIds.length
      ? await this.prisma.watchlistItem.findMany({
          where: { userId, mediaId: { in: watchlistIds } },
          select: { mediaId: true },
        })
      : [];
    const inWatchlist = new Set(existingWatchlist.map((w) => w.mediaId));

    for (const item of shows) {
      try {
        await this.applyShow(userId, item, inWatchlist, result);
      } catch {
        result.unresolved.push({ mediaId: item.mediaId, reason: 'ERROR' });
      }
    }
    for (const item of movies) {
      try {
        await this.applyMovie(userId, item, inWatchlist, result);
      } catch {
        result.unresolved.push({ mediaId: item.mediaId, reason: 'ERROR' });
      }
    }

    await this.invalidateUserCache(userId);
    // A successful apply completes onboarding atomically; a client-side PATCH to
    // the same state afterwards is harmless.
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        onboardingStatus: 'COMPLETED',
        onboardingVersion: ONBOARDING_VERSION,
        onboardingCompletedAt: new Date(),
      },
    });
    return result;
  }

  private async applyShow(
    userId: string,
    item: OnboardingShowItem,
    inWatchlist: Set<string>,
    result: OnboardingApplyResultDto,
  ) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: item.mediaId },
      include: { show: true },
    });
    if (!media?.show) {
      result.unresolved.push({ mediaId: item.mediaId, reason: 'NOT_FOUND' });
      return;
    }

    if (item.action === 'WATCHLIST') {
      await this.addToWatchlist(userId, media.id, MediaType.SHOW, inWatchlist, result);
      result.applied.showsProcessed++;
      return;
    }

    // On-demand hydration for shows that have a MediaItem but no episodes yet
    // (same fallback chain as the import matcher: TMDB first, then TVDB).
    let epCount = await this.prisma.episode.count({
      where: { structureState: 'ACTIVE', season: { show: { mediaId: media.id } } },
    });
    if (epCount === 0) {
      await this.ensureShowHydrated(media.id);
      epCount = await this.prisma.episode.count({
        where: { structureState: 'ACTIVE', season: { show: { mediaId: media.id } } },
      });
      if (epCount === 0) {
        result.unresolved.push({ mediaId: media.id, reason: 'HYDRATION_FAILED' });
        return;
      }
    }

    // Eligible = active, non-special episodes that are not explicitly in the future.
    // TVDB official episodes with no air date remain part of progress.
    const now = new Date();
    const seasons = await this.prisma.season.findMany({
      where: {
        show: { mediaId: media.id },
        isSpecial: false,
        episodes: { some: { structureState: 'ACTIVE' } },
      },
      include: {
        episodes: {
          where: { structureState: 'ACTIVE', ...episodeProgressEligibilityWhere(now) },
        },
      },
      orderBy: { number: 'asc' },
    });
    const eligible: EligibleEpisode[] = seasons
      .flatMap((s) =>
        s.episodes.map((e) => ({
          id: e.id,
          number: e.number,
          seasonNumber: s.number,
          runtimeMinutes: e.runtimeMinutes,
        })),
      )
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);

    const target =
      item.action === 'CAUGHT_UP'
        ? eligible
        : eligible.filter(
            (e) =>
              e.seasonNumber < item.throughSeasonNumber! ||
              (e.seasonNumber === item.throughSeasonNumber! &&
                e.number <= item.throughEpisodeNumber!),
          );
    if (target.length === 0) {
      result.unresolved.push({ mediaId: media.id, reason: 'NO_AIRED_EPISODES' });
      return;
    }

    // Diff against existing statuses (markSeasonWatched semantics): only
    // unwatched→watched transitions write; already-watched rows keep their
    // FIRST watchedAt and are never silently unwatched.
    const existing = await this.prisma.userEpisodeStatus.findMany({
      where: { userId, episodeId: { in: target.map((e) => e.id) } },
      select: { episodeId: true, watched: true },
    });
    const existingById = new Map(existing.map((s) => [s.episodeId, s]));
    const toCreate = target.filter((e) => !existingById.has(e.id));
    const toMark = target.filter((e) => existingById.get(e.id)?.watched === false);
    const newlyWatched = [...toCreate, ...toMark];

    if (newlyWatched.length) {
      const ops: Prisma.PrismaPromise<any>[] = [
        this.prisma.watchHistory.createMany({
          data: newlyWatched.map((e) => ({
            userId,
            mediaId: media.id,
            mediaType: MediaType.SHOW,
            episodeId: e.id,
            seasonNumber: e.seasonNumber,
            episodeNumber: e.number,
            runtimeMinutes: e.runtimeMinutes,
            watchedAt: now,
          })),
        }),
      ];
      if (toCreate.length) {
        ops.unshift(
          this.prisma.userEpisodeStatus.createMany({
            data: toCreate.map((e) => ({
              userId,
              episodeId: e.id,
              watched: true,
              watchedAt: now,
              watchCount: 1,
            })),
          }),
        );
      }
      if (toMark.length) {
        ops.unshift(
          this.prisma.userEpisodeStatus.updateMany({
            where: { userId, episodeId: { in: toMark.map((e) => e.id) }, watched: false },
            data: { watched: true, watchedAt: now, watchCount: 1 },
          }),
        );
      }
      await this.prisma.$transaction(ops);
      // One event per show (same batching rationale as markSeasonWatched):
      // badge evaluation + stats invalidation are user-level and idempotent.
      this.events.emit('watch.episode', { userId, mediaId: media.id });
      result.applied.episodesMarked += newlyWatched.length;
    }

    // Rebuild the denormalized show status from aggregates (import-style) rather
    // than bumpShowCount deltas — correct for arbitrary partial progress and
    // aired-only totals. Onboarding EXPLICITLY un-drops the show (the user just
    // chose to track it) — ordinary episode watches no longer do that.
    await this.rebuildShowStatus(userId, media.id, now);
    // Library convention: a watched show is a tracked show, so it also lands in
    // the watchlist (merge-only — never removes, never double-counts).
    await this.addToWatchlist(userId, media.id, MediaType.SHOW, inWatchlist, result);
    result.applied.showsProcessed++;
  }

  private async applyMovie(
    userId: string,
    item: { mediaId: string; action: 'WATCHLIST' | 'WATCHED' },
    inWatchlist: Set<string>,
    result: OnboardingApplyResultDto,
  ) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: item.mediaId },
      include: { movie: true },
    });
    if (!media?.movie) {
      result.unresolved.push({ mediaId: item.mediaId, reason: 'NOT_FOUND' });
      return;
    }

    if (item.action === 'WATCHLIST') {
      await this.addToWatchlist(userId, media.id, MediaType.MOVIE, inWatchlist, result);
      return;
    }

    // markMovieWatched semantics: upsert the status, write history + emit only
    // on the unwatched→watched transition.
    const prev = await this.prisma.userMovieStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId: media.id } },
    });
    const becameWatched = !prev?.watched;
    const now = new Date();
    await this.prisma.userMovieStatus.upsert({
      where: { userId_mediaId: { userId, mediaId: media.id } },
      create: { userId, mediaId: media.id, watched: true, watchedAt: now, watchCount: 1 },
      update: becameWatched ? { watched: true, watchedAt: now, watchCount: 1 } : {},
    });
    if (becameWatched) {
      await this.prisma.watchHistory.create({
        data: {
          userId,
          mediaId: media.id,
          mediaType: MediaType.MOVIE,
          runtimeMinutes: media.movie.runtimeMinutes,
          watchedAt: now,
        },
      });
      this.events.emit('watch.movie', { userId, mediaId: media.id });
      result.applied.moviesWatched++;
    }
    // Same library convention as shows: watched movies are tracked, so they are
    // watchlisted too (merge-only).
    await this.addToWatchlist(userId, media.id, MediaType.MOVIE, inWatchlist, result);
  }

  private async addToWatchlist(
    userId: string,
    mediaId: string,
    mediaType: MediaType,
    inWatchlist: Set<string>,
    result: OnboardingApplyResultDto,
  ) {
    if (inWatchlist.has(mediaId)) return; // merge-only: never remove, never double-count
    await this.prisma.watchlistItem.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId },
      update: {},
    });
    await this.prisma.mediaItem.update({
      where: { id: mediaId },
      data: { addedCount: { increment: 1 } },
    });
    // Re-adding a show un-drops it (collections.service parity).
    if (mediaType === MediaType.SHOW) {
      await this.prisma.userShowStatus.updateMany({
        where: { userId, mediaId, dropped: true },
        data: { dropped: false },
      });
    }
    this.events.emit('watchlist.added', { userId, mediaId, mediaType });
    inWatchlist.add(mediaId);
    result.applied.watchlistAdded++;
  }

  /** Aggregate rebuild of user_show_status using the canonical progress eligibility rule. */
  private async rebuildShowStatus(userId: string, mediaId: string, now: Date) {
    const [watchedCount, maxWatched, totalCount] = await Promise.all([
      this.prisma.userEpisodeStatus.count({
        where: {
          userId,
          watched: true,
          episode: {
            structureState: 'ACTIVE',
            season: { show: { mediaId }, isSpecial: false },
            ...episodeProgressEligibilityWhere(now),
          },
        },
      }),
      this.prisma.userEpisodeStatus.aggregate({
        where: {
          userId,
          watched: true,
          episode: {
            structureState: 'ACTIVE',
            season: { show: { mediaId }, isSpecial: false },
            ...episodeProgressEligibilityWhere(now),
          },
        },
        _max: { watchedAt: true },
      }),
      this.prisma.episode.count({
        where: {
          structureState: 'ACTIVE',
          season: { show: { mediaId }, isSpecial: false },
          ...episodeProgressEligibilityWhere(now),
        },
      }),
    ]);
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: {
        userId,
        mediaId,
        watchedCount,
        totalCount,
        lastWatchedAt: maxWatched._max.watchedAt ?? null,
      },
      update: {
        watchedCount,
        totalCount,
        lastWatchedAt: maxWatched._max.watchedAt ?? null,
        dropped: false,
      },
    });
  }

  /** TMDB-first hydration fallback chain (mirrors ImportMatcher.ensureShowHydrated,
   *  without the anime provider-preference override used during imports). */
  private async ensureShowHydrated(mediaId: string) {
    const [tmdbExt, tvdbExt] = await Promise.all([
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.TMDB } }),
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.THE_TVDB } }),
    ]);
    if (tmdbExt && this.tmdb.enabled) {
      try {
        await this.meta.ensureShowFull(Number(tmdbExt.value));
        return;
      } catch {
        // fall through to TVDB
      }
    }
    if (tvdbExt && this.tvdb?.enabled) {
      try {
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
      } catch {
        // unresolved — caller reports HYDRATION_FAILED
      }
    }
  }

  private async invalidateUserCache(userId: string) {
    // Same pattern as TrackingService.invalidateUserCache: per-user caches are
    // language-suffixed, so purge by pattern.
    await Promise.all([
      this.redis.delByPattern(`watchnext:${userId}:*`),
      this.redis.delByPattern(`upcoming:${userId}:*`),
      this.redis.delByPattern(`showsprogress:${userId}:*`),
      // The apply writes the user's first taste signal — recompute for-you.
      this.redis.delByPattern(`foryou:v3:${userId}:*`),
      this.redis.del(`watchnext:${userId}`),
      this.redis.del(`upcoming:${userId}`),
    ]);
  }
}

function dedupe<T extends { mediaId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.mediaId) ? false : (seen.add(i.mediaId), true)));
}
