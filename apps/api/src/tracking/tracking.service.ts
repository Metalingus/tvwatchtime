import { fenceIdentityWrite } from '../media-metadata/util/identity-write-fence';
import {
  canonicalCopyId,
  canonicalMediaId as resolveCanonicalMediaId,
} from '../media-metadata/util/canonical-media';
import { episodeAiredWhere } from '../common/utils/episode-progress.util';
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, ReactionType, WatchDevice } from '@prisma/client';
import { CommsUniPublicationService } from '../commsuni/commsuni.publication.service';
import type { ConversationType, CommsUniEngagementKind } from '@tvwatch/shared';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import {
  episodeProgressEligibilityWhere,
  isEpisodeBulkWatchEligible,
  isEpisodeProgressEligible,
} from '../common/utils/episode-progress.util';
import { markPersonalizationDirty } from '../media-metadata/personalization-cache';
import { MarkWatchedDto } from './dto/tracking.dto';

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly redis: RedisService,
    @Optional() private readonly publication?: CommsUniPublicationService,
  ) {}

  private async canonicalEpisodeId(episodeId: string): Promise<string> {
    return canonicalCopyId(this.prisma, 'EPISODE', episodeId);
  }

  private async canonicalMediaId(
    mediaId: string,
    type: 'SHOW' | 'MOVIE' = 'SHOW',
  ): Promise<string> {
    return resolveCanonicalMediaId(this.prisma, mediaId, type);
  }

  private async canStartRewatching(userId: string, mediaId: string, now = new Date()) {
    const episodeWhere = {
      structureState: 'ACTIVE' as const,
      season: { show: { mediaId }, isSpecial: false },
      ...episodeProgressEligibilityWhere(now),
    };
    const [total, watched] = await Promise.all([
      this.prisma.episode.count({ where: episodeWhere }),
      this.prisma.userEpisodeStatus.count({
        where: { userId, watched: true, episode: episodeWhere },
      }),
    ]);
    return total > 0 && watched >= total;
  }

  private async completeRewatchIfFinished(userId: string, mediaId: string, now = new Date()) {
    mediaId = await this.canonicalMediaId(mediaId);
    return this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });

      const status = await tx.userShowStatus.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
        select: { rewatchStartedAt: true },
      });
      if (!status?.rewatchStartedAt) return false;

      const episodes = await tx.episode.findMany({
        where: {
          structureState: 'ACTIVE',
          ...episodeAiredWhere(now),
          season: { show: { mediaId }, isSpecial: false },
        },
        select: { id: true },
      });
      if (!episodes.length) {
        await tx.userShowStatus.update({
          where: { userId_mediaId: { userId, mediaId } },
          data: { rewatchStartedAt: null },
        });
        return true;
      }

      const rows = await tx.watchHistory.findMany({
        where: {
          userId,
          mediaId,
          episodeId: { in: episodes.map((episode) => episode.id) },
          watchedAt: { gte: status.rewatchStartedAt },
        },
        distinct: ['episodeId'],
        select: { episodeId: true },
      });
      if (rows.length < episodes.length) return false;

      await tx.userShowStatus.update({
        where: { userId_mediaId: { userId, mediaId } },
        data: { rewatchStartedAt: null },
      });
      return true;
    });
  }

  private async invalidateUserCache(userId: string) {
    // The per-user watch-next / upcoming caches are language-suffixed
    // (watchnext:userId:<lang>, upcoming:userId:<lang>), so delete by pattern to
    // purge every locale variant — a bare del() of the unsuffixed key is a no-op
    // and leaves stale buckets that revert optimistic client updates.
    await Promise.all([
      this.redis.delByPattern(`watchnext:${userId}:*`),
      this.redis.delByPattern(`upcoming:${userId}:*`),
      this.redis.delByPattern(`showsprogress:${userId}:*`),
      // Preserve the last good recommendations while their background replacement is built.
      markPersonalizationDirty(this.redis, userId),
      this.redis.del(`watchnext:${userId}`),
      this.redis.del(`upcoming:${userId}`),
    ]);
  }

  // ---------------- Episodes ----------------
  async markEpisodeWatched(userId: string, episodeId: string, dto: MarkWatchedDto) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const { mediaId, becameWatched, prev } = await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, episodeIds: [episodeId], type: 'SHOW' });
      const [episode, prev] = await Promise.all([
        tx.episode.findUnique({
          where: { id: episodeId },
          include: { season: { include: { show: true } } },
        }),
        tx.userEpisodeStatus.findUnique({
          where: { userId_episodeId: { userId, episodeId } },
        }),
      ]);
      if (!episode) throw new NotFoundException('Episode not found');
      const mediaId = episode.season.show.mediaId;
      const becameWatched = !prev?.watched;
      const now = new Date();
      const countsTowardProgress =
        episode.structureState === 'ACTIVE' &&
        !episode.season.isSpecial &&
        isEpisodeProgressEligible(episode.airDate, now, episode.airTime);

      // watchedAt always records the FIRST watch date, so it is only written on the
      // watched→unwatched→watched transition (or first-ever create). Re-marking an
      // already-watched episode leaves watchedAt and watchCount untouched.
      await tx.userEpisodeStatus.upsert({
        where: { userId_episodeId: { userId, episodeId } },
        create: {
          userId,
          episodeId,
          watched: true,
          watchedAt: now,
          watchCount: 1,
          source: 'MANUAL',
        },
        update: becameWatched
          ? {
              watched: true,
              watchedAt: now,
              watchCount: 1,
              source: 'MANUAL',
              sourceKey: null,
            }
          : { source: 'MANUAL', sourceKey: null },
      });

      if (becameWatched) {
        // Independent writes (different tables) run in parallel; lastWatchedAt is folded into
        // bumpShowCount so we no longer need a separate userShowStatus update.
        await Promise.all([
          tx.watchHistory.create({
            data: {
              userId,
              mediaId,
              mediaType: MediaType.SHOW,
              episodeId,
              seasonNumber: episode.season.number,
              episodeNumber: episode.number,
              runtimeMinutes: episode.runtimeMinutes,
              watchedAt: now,
            },
          }),
          countsTowardProgress
            ? this.bumpShowCount(userId, mediaId, 1, now, tx)
            : Promise.resolve(),
        ]);
      }

      return { mediaId, becameWatched, prev };
    });
    if (becameWatched) this.events.emit('watch.episode', { userId, mediaId, episodeId });
    // Rating / reaction persist regardless of the watched transition. The dedicated
    // PUT /vote/* endpoints are the primary path; these keep the legacy mark-watched
    // payload consistent with the new single-active-vote model.
    if (dto.device) await this.setDevice(userId, 'EPISODE', episodeId, dto.device);
    if (dto.rating) await this.upsertEpisodeRating(userId, episodeId, dto.rating);
    if (dto.reaction) await this.upsertReaction(userId, episodeId, dto.reaction);
    await this.invalidateUserCache(userId);
    return { watched: true, watchCount: becameWatched ? 1 : (prev?.watchCount ?? 0) };
  }

  /**
   * Mark the selected episode and every earlier aired episode in its show as watched.
   * Specials never participate in progress, so callers fall back to the single-episode
   * mutation when the selected episode belongs to a special season.
   */
  async markEpisodeAndPreviousWatched(userId: string, episodeId: string, dto: MarkWatchedDto) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const current = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { show: true } } },
    });
    if (!current) throw new NotFoundException('Episode not found');
    if (current.season.isSpecial) {
      return this.markEpisodeWatched(userId, episodeId, dto);
    }

    const now = new Date();
    const previous = await this.prisma.episode.findMany({
      where: {
        structureState: 'ACTIVE',
        season: { showId: current.season.showId, isSpecial: false },
        AND: [
          episodeProgressEligibilityWhere(now),
          {
            OR: [
              { season: { number: { lt: current.season.number } } },
              { season: { number: current.season.number }, number: { lt: current.number } },
            ],
          },
        ],
      },
      include: { season: true },
      orderBy: [{ season: { number: 'asc' } }, { number: 'asc' }],
    });
    const episodes = [...previous, current];
    const episodeIds = episodes.map((episode) => episode.id);
    const mediaId = current.season.show.mediaId;
    let newlyWatched: typeof episodes = [];
    let currentWatchCount = 1;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
            const existing = await tx.userEpisodeStatus.findMany({
              where: { userId, episodeId: { in: episodeIds } },
              select: { episodeId: true, watched: true, watchCount: true },
            });
            const existingById = new Map(existing.map((status) => [status.episodeId, status]));
            const toCreate = episodes.filter((episode) => !existingById.has(episode.id));
            const toMark = episodes.filter(
              (episode) => existingById.get(episode.id)?.watched === false,
            );
            const transitioned = [...toCreate, ...toMark];

            if (toCreate.length) {
              await tx.userEpisodeStatus.createMany({
                data: toCreate.map((episode) => ({
                  userId,
                  episodeId: episode.id,
                  watched: true,
                  watchedAt: now,
                  watchCount: 1,
                })),
              });
            }
            if (toMark.length) {
              await tx.userEpisodeStatus.updateMany({
                where: {
                  userId,
                  episodeId: { in: toMark.map((episode) => episode.id) },
                  watched: false,
                },
                data: {
                  watched: true,
                  watchedAt: now,
                  watchCount: 1,
                  source: 'MANUAL',
                  sourceKey: null,
                },
              });
            }
            if (transitioned.length) {
              await tx.watchHistory.createMany({
                data: transitioned.map((episode) => ({
                  userId,
                  mediaId,
                  mediaType: MediaType.SHOW,
                  episodeId: episode.id,
                  seasonNumber: episode.season.number,
                  episodeNumber: episode.number,
                  runtimeMinutes: episode.runtimeMinutes,
                  watchedAt: now,
                })),
              });
            }

            if (dto.device) {
              for (const selectedId of new Set([...transitioned.map((row) => row.id), episodeId]))
                await this.setDevice(userId, 'EPISODE', selectedId, dto.device, tx);
            }
            const currentStatus = existingById.get(episodeId);
            return {
              transitioned,
              currentWatchCount: currentStatus?.watched ? currentStatus.watchCount : 1,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        newlyWatched = result.transitioned;
        currentWatchCount = result.currentWatchCount;
        break;
      } catch (error) {
        const isRetryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034');
        if (!isRetryable || attempt === 2) throw error;
      }
    }

    if (newlyWatched.length) {
      const progressDelta = newlyWatched.filter(
        (episode) =>
          episode.structureState === 'ACTIVE' &&
          !episode.season.isSpecial &&
          isEpisodeProgressEligible(episode.airDate, now, episode.airTime),
      ).length;
      if (progressDelta > 0) await this.bumpShowCount(userId, mediaId, progressDelta, now);
      this.events.emit('watch.episode', { userId, mediaId, episodeId });
    }
    if (dto.rating) await this.upsertEpisodeRating(userId, episodeId, dto.rating);
    if (dto.reaction) await this.upsertReaction(userId, episodeId, dto.reaction);
    await this.invalidateUserCache(userId);
    return {
      watched: true,
      watchCount: currentWatchCount,
      count: newlyWatched.length,
      previousCount: newlyWatched.filter((episode) => episode.id !== episodeId).length,
    };
  }

  /**
   * Record another viewing of an already-watched episode. watchCount increments, a new
   * watchHistory row is appended (so stats/badges count the rewatch), but watchedAt (the
   * first-watch date) and the show's distinct watchedCount are left untouched.
   */
  async rewatchEpisode(userId: string, episodeId: string) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const { episode, mediaId, now, nextCount, history } = await this.prisma.$transaction(
      async (tx) => {
        await fenceIdentityWrite(tx, { userId, episodeIds: [episodeId], type: 'SHOW' });
        const [episode, prev] = await Promise.all([
          tx.episode.findUnique({
            where: { id: episodeId },
            include: { season: { include: { show: true } } },
          }),
          tx.userEpisodeStatus.findUnique({
            where: { userId_episodeId: { userId, episodeId } },
          }),
        ]);
        if (!episode) throw new NotFoundException('Episode not found');
        if (!prev?.watched) throw new BadRequestException('Mark the episode as watched first');
        const mediaId = episode.season.show.mediaId;
        const now = new Date();

        const nextCount = (prev.watchCount ?? 1) + 1;
        const [, history] = await Promise.all([
          tx.userEpisodeStatus.update({
            where: { userId_episodeId: { userId, episodeId } },
            data: { watchCount: { increment: 1 }, source: 'MANUAL', sourceKey: null },
          }),
          tx.watchHistory.create({
            data: {
              userId,
              mediaId,
              mediaType: MediaType.SHOW,
              episodeId,
              seasonNumber: episode.season.number,
              episodeNumber: episode.number,
              runtimeMinutes: episode.runtimeMinutes,
              watchedAt: now,
            },
          }),
        ]);

        return { episode, mediaId, now, nextCount, history };
      },
    );
    const status = await this.prisma.userShowStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
      select: { rewatchStartedAt: true },
    });
    let offerStartRewatching = false;
    let rewatchCompleted = false;
    if (status?.rewatchStartedAt) {
      rewatchCompleted = await this.completeRewatchIfFinished(userId, mediaId, now);
    } else if (
      episode.structureState === 'ACTIVE' &&
      !episode.season.isSpecial &&
      isEpisodeBulkWatchEligible(episode.airDate, now, episode.airTime)
    ) {
      const first = await this.prisma.episode.findFirst({
        where: {
          structureState: 'ACTIVE',
          ...episodeAiredWhere(now),
          season: { show: { mediaId }, isSpecial: false },
        },
        orderBy: [{ season: { number: 'asc' } }, { number: 'asc' }],
        select: { id: true },
      });
      offerStartRewatching =
        first?.id === episodeId && (await this.canStartRewatching(userId, mediaId, now));
    }
    this.events.emit('rewatch.episode', { userId, mediaId, episodeId });
    await this.invalidateUserCache(userId);
    return {
      watched: true,
      watchCount: nextCount,
      historyId: history.id,
      watchedAt: history.watchedAt.toISOString(),
      showId: mediaId,
      offerStartRewatching,
      rewatchCompleted,
    };
  }

  async startRewatching(userId: string, mediaId: string, seedHistoryId?: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    const [media, existing] = await Promise.all([
      this.prisma.mediaItem.findUnique({
        where: { id: mediaId },
        select: { id: true, type: true },
      }),
      this.prisma.userShowStatus.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
        select: { rewatchStartedAt: true },
      }),
    ]);
    if (!media || media.type !== MediaType.SHOW) throw new NotFoundException('Show not found');
    if (existing?.rewatchStartedAt) {
      return {
        rewatching: true,
        rewatchStartedAt: existing.rewatchStartedAt.toISOString(),
        inWatchlist: true,
      };
    }

    const now = new Date();
    if (!(await this.canStartRewatching(userId, mediaId, now))) {
      throw new BadRequestException('Finish the currently aired episodes before rewatching');
    }
    const first = await this.prisma.episode.findFirst({
      where: {
        structureState: 'ACTIVE',
        ...episodeAiredWhere(now),
        season: { show: { mediaId }, isSpecial: false },
      },
      orderBy: [{ season: { number: 'asc' } }, { number: 'asc' }],
      select: { id: true },
    });
    if (!first) throw new BadRequestException('No aired episode is available to rewatch');

    let startedAt = now;
    if (seedHistoryId) {
      const seed = await this.prisma.watchHistory.findUnique({
        where: { id: seedHistoryId },
        select: { userId: true, mediaId: true, episodeId: true, watchedAt: true },
      });
      if (
        !seed ||
        seed.userId !== userId ||
        seed.mediaId !== mediaId ||
        seed.episodeId !== first.id
      ) {
        throw new BadRequestException('Invalid rewatch seed');
      }
      startedAt = seed.watchedAt;
    }

    let addedToWatchlist = false;
    await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
      const watchlist = await tx.watchlistItem.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
        select: { id: true },
      });
      if (!watchlist) {
        await tx.watchlistItem.create({ data: { userId, mediaId, source: 'MANUAL' } });
        await tx.mediaItem.update({
          where: { id: mediaId },
          data: { addedCount: { increment: 1 } },
        });
        addedToWatchlist = true;
      }
      await tx.userShowStatus.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: { userId, mediaId, rewatchStartedAt: startedAt },
        update: { rewatchStartedAt: startedAt, pausedAt: null, dropped: false },
      });
    });
    if (addedToWatchlist) {
      this.events.emit('watchlist.added', { userId, mediaId, mediaType: MediaType.SHOW });
    }
    const completed = seedHistoryId
      ? await this.completeRewatchIfFinished(userId, mediaId, now)
      : false;
    await this.invalidateUserCache(userId);
    return {
      rewatching: !completed,
      rewatchStartedAt: completed ? null : startedAt.toISOString(),
      inWatchlist: true,
    };
  }

  async stopRewatching(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId);
    await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
      return tx.userShowStatus.updateMany({
        where: { userId, mediaId, rewatchStartedAt: { not: null } },
        data: { rewatchStartedAt: null },
      });
    });
    await this.invalidateUserCache(userId);
    return { rewatching: false, rewatchStartedAt: null };
  }

  /**
   * Undo ONE viewing of an episode with multiple recorded watches: watchCount
   * decrements and the LATEST watchHistory row is removed, but the episode stays
   * watched (watchedAt keeps the first-watch date). Full reset stays on
   * unmarkEpisodeWatched.
   */
  async unwatchEpisodeOnce(userId: string, episodeId: string) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const [episode, prev] = await Promise.all([
      this.prisma.episode.findUnique({
        where: { id: episodeId },
        include: { season: { include: { show: true } } },
      }),
      this.prisma.userEpisodeStatus.findUnique({
        where: { userId_episodeId: { userId, episodeId } },
      }),
    ]);
    if (!episode) throw new NotFoundException('Episode not found');
    if (!prev?.watched) throw new BadRequestException('Episode is not watched');
    if ((prev.watchCount ?? 0) < 2) {
      throw new BadRequestException('Only one viewing recorded — unwatch instead');
    }
    const mediaId = episode.season.show.mediaId;

    const latest = await this.prisma.watchHistory.findFirst({
      where: { userId, episodeId },
      orderBy: { watchedAt: 'desc' },
      select: { id: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
      return Promise.all([
        tx.userEpisodeStatus.update({
          where: { userId_episodeId: { userId, episodeId } },
          data: { watchCount: { decrement: 1 }, source: 'MANUAL', sourceKey: null },
        }),
        ...(latest ? [tx.watchHistory.delete({ where: { id: latest.id } })] : []),
      ]);
    });
    this.events.emit('unwatch.episode', { userId, mediaId, episodeId });
    await this.invalidateUserCache(userId);
    return { watched: true, watchCount: prev.watchCount - 1 };
  }

  async unmarkEpisodeWatched(userId: string, episodeId: string) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const { mediaId } = await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, episodeIds: [episodeId], type: 'SHOW' });
      const [episode, prev] = await Promise.all([
        tx.episode.findUnique({
          where: { id: episodeId },
          include: { season: { include: { show: true } } },
        }),
        tx.userEpisodeStatus.findUnique({
          where: { userId_episodeId: { userId, episodeId } },
        }),
      ]);
      if (!episode) throw new NotFoundException('Episode not found');
      const mediaId = episode.season.show.mediaId;
      if (!prev?.watched) return { mediaId };
      const countsTowardProgress =
        episode.structureState === 'ACTIVE' &&
        !episode.season.isSpecial &&
        isEpisodeProgressEligible(episode.airDate, new Date(), episode.airTime);

      // Three independent tables — run in parallel.
      await Promise.all([
        tx.userEpisodeStatus.update({
          where: { userId_episodeId: { userId, episodeId } },
          data: {
            watched: false,
            watchedAt: null,
            watchCount: 0,
            source: 'MANUAL',
            sourceKey: null,
          },
        }),
        tx.watchHistory.deleteMany({ where: { userId, episodeId } }),
        countsTowardProgress
          ? this.bumpShowCount(userId, mediaId, -1, undefined, tx)
          : Promise.resolve(),
      ]);

      return { mediaId };
    });
    this.events.emit('unwatch.episode', { userId, mediaId, episodeId });
    await this.invalidateUserCache(userId);
    return { watched: false };
  }

  async markSeasonWatched(userId: string, seasonId: string) {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
      include: { episodes: true, show: true },
    });
    if (!season) throw new NotFoundException('Season not found');
    if ((await this.canonicalMediaId(season.show.mediaId)) !== season.show.mediaId) {
      throw new BadRequestException(
        'This season was reconciled. Refresh the show before changing its progress.',
      );
    }
    const mediaId = season.show.mediaId;
    const now = new Date();
    const eligibleEpisodes = season.episodes.filter(
      (episode) =>
        episode.structureState === 'ACTIVE' &&
        isEpisodeBulkWatchEligible(episode.airDate, now, episode.airTime),
    );
    const episodeIds = eligibleEpisodes.map((e) => e.id);

    // Batched: the old per-episode markEpisodeWatched loop cost ~8 queries + a badge
    // evaluation + 2 Redis keyspace scans PER EPISODE on a single tap.
    let newlyWatched: typeof season.episodes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        newlyWatched = await this.prisma.$transaction(
          async (tx) => {
            await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
            const existing = await tx.userEpisodeStatus.findMany({
              where: { userId, episodeId: { in: episodeIds } },
              select: { episodeId: true, watched: true },
            });
            const existingById = new Map(existing.map((status) => [status.episodeId, status]));
            // Mirrors markEpisodeWatched's upsert: create missing rows, flip unwatched ones;
            // already-watched rows stay untouched (watchedAt keeps the FIRST watch date).
            const toCreate = eligibleEpisodes.filter((episode) => !existingById.has(episode.id));
            const toMark = eligibleEpisodes.filter(
              (episode) => existingById.get(episode.id)?.watched === false,
            );
            const transitioned = [...toCreate, ...toMark];

            if (toCreate.length) {
              await tx.userEpisodeStatus.createMany({
                data: toCreate.map((episode) => ({
                  userId,
                  episodeId: episode.id,
                  watched: true,
                  watchedAt: now,
                  watchCount: 1,
                })),
              });
            }
            if (toMark.length) {
              await tx.userEpisodeStatus.updateMany({
                where: {
                  userId,
                  episodeId: { in: toMark.map((episode) => episode.id) },
                  watched: false,
                },
                data: {
                  watched: true,
                  watchedAt: now,
                  watchCount: 1,
                  source: 'MANUAL',
                  sourceKey: null,
                },
              });
            }
            if (transitioned.length) {
              await tx.watchHistory.createMany({
                data: transitioned.map((episode) => ({
                  userId,
                  mediaId,
                  mediaType: MediaType.SHOW,
                  episodeId: episode.id,
                  seasonNumber: season.number,
                  episodeNumber: episode.number,
                  runtimeMinutes: episode.runtimeMinutes,
                  watchedAt: now,
                })),
              });
            }
            return transitioned;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        const isRetryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034');
        if (!isRetryable || attempt === 2) throw error;
      }
    }

    if (newlyWatched.length) {
      if (!season.isSpecial) {
        await this.bumpShowCount(userId, mediaId, newlyWatched.length, now);
      }
      // One event for the whole season: badge evaluation and stats invalidation are
      // user-level + idempotent, and the leaderboard bust is debounced — the old loop
      // re-fired all three per episode.
      this.events.emit('watch.episode', { userId, mediaId });
    }
    await this.invalidateUserCache(userId);
    return { watched: true, count: eligibleEpisodes.length };
  }

  /**
   * Record another viewing of every already-watched, progress-eligible episode of a season.
   * Mirrors rewatchEpisode per episode: watchCount increments and a watchHistory row
   * is appended (stats count the rewatch), but watchedAt and the show's distinct
   * watchedCount are left untouched. Unwatched episodes stay unwatched — a rewatch
   * never creates first watches.
   */
  async rewatchSeason(userId: string, seasonId: string) {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
      include: { episodes: true, show: true },
    });
    if (!season) throw new NotFoundException('Season not found');
    if ((await this.canonicalMediaId(season.show.mediaId)) !== season.show.mediaId) {
      throw new BadRequestException(
        'This season was reconciled. Refresh the show before changing its progress.',
      );
    }
    const mediaId = season.show.mediaId;
    const now = new Date();
    const eligible = season.episodes.filter(
      (episode) =>
        episode.structureState === 'ACTIVE' &&
        isEpisodeBulkWatchEligible(episode.airDate, now, episode.airTime),
    );
    if (eligible.length === 0) return { watched: true, count: 0 };

    const watched = await this.prisma.userEpisodeStatus.findMany({
      where: { userId, episodeId: { in: eligible.map((e) => e.id) }, watched: true },
      select: { episodeId: true },
    });
    if (watched.length === 0) {
      throw new BadRequestException('Mark at least one episode as watched first');
    }
    const ids = new Set(watched.map((w) => w.episodeId));
    const rewatched = eligible.filter((e) => ids.has(e.id));

    await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
      return Promise.all([
        tx.userEpisodeStatus.updateMany({
          where: { userId, episodeId: { in: rewatched.map((e) => e.id) } },
          data: { watchCount: { increment: 1 }, source: 'MANUAL', sourceKey: null },
        }),
        tx.watchHistory.createMany({
          data: rewatched.map((e) => ({
            userId,
            mediaId,
            mediaType: MediaType.SHOW,
            episodeId: e.id,
            seasonNumber: season.number,
            episodeNumber: e.number,
            runtimeMinutes: e.runtimeMinutes,
            watchedAt: now,
          })),
        }),
      ]);
    });
    // One event for the whole season (same batching rationale as markSeasonWatched).
    this.events.emit('rewatch.episode', { userId, mediaId });
    await this.completeRewatchIfFinished(userId, mediaId, now);
    await this.invalidateUserCache(userId);
    return { watched: true, count: rewatched.length };
  }

  /**
   * Undo ONE viewing of every re-watched episode of a season: watchCount decrements
   * (only for episodes watched 2+ times — episodes on their first watch stay watched)
   * and each decremented episode loses its LATEST watchHistory row. This lowers the
   * season's complete-viewing count by one without unwatching anything.
   */
  async unwatchSeasonOnce(userId: string, seasonId: string) {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
      include: { episodes: true, show: true },
    });
    if (!season) throw new NotFoundException('Season not found');
    if ((await this.canonicalMediaId(season.show.mediaId)) !== season.show.mediaId) {
      throw new BadRequestException(
        'This season was reconciled. Refresh the show before changing its progress.',
      );
    }
    const mediaId = season.show.mediaId;
    const now = new Date();
    const eligible = season.episodes.filter(
      (episode) =>
        episode.structureState === 'ACTIVE' &&
        isEpisodeProgressEligible(episode.airDate, now, episode.airTime),
    );
    if (eligible.length === 0) return { watched: true, count: 0 };

    const rewatched = await this.prisma.userEpisodeStatus.findMany({
      where: {
        userId,
        episodeId: { in: eligible.map((e) => e.id) },
        watched: true,
        watchCount: { gte: 2 },
      },
      select: { episodeId: true },
    });
    if (rewatched.length === 0) {
      throw new BadRequestException('No rewatches to undo — unwatch instead');
    }
    const ids = rewatched.map((w) => w.episodeId);

    await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
      return Promise.all([
        tx.userEpisodeStatus.updateMany({
          where: { userId, episodeId: { in: ids } },
          data: { watchCount: { decrement: 1 }, source: 'MANUAL', sourceKey: null },
        }),
        // Latest history row per decremented episode (Postgres DISTINCT ON).
        tx.$executeRaw`
        DELETE FROM watch_history WHERE id IN (
          SELECT DISTINCT ON (episode_id) id FROM watch_history
          WHERE user_id = ${userId} AND episode_id IN (${Prisma.join(ids)})
          ORDER BY episode_id, watched_at DESC
        )
      `,
      ]);
    });
    this.events.emit('unwatch.episode', { userId, mediaId });
    await this.invalidateUserCache(userId);
    return { watched: true, count: ids.length };
  }

  async unmarkSeasonWatched(userId: string, seasonId: string) {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
      include: { episodes: true, show: true },
    });
    if (!season) throw new NotFoundException('Season not found');
    if ((await this.canonicalMediaId(season.show.mediaId)) !== season.show.mediaId) {
      throw new BadRequestException(
        'This season was reconciled. Refresh the show before changing its progress.',
      );
    }
    const mediaId = season.show.mediaId;
    const activeEpisodes = season.episodes.filter((episode) => episode.structureState === 'ACTIVE');
    const episodeIds = activeEpisodes.map((e) => e.id);
    const eligibleIds = new Set(
      activeEpisodes
        .filter((episode) =>
          isEpisodeProgressEligible(episode.airDate, new Date(), episode.airTime),
        )
        .map((episode) => episode.id),
    );

    const watched = await this.prisma.userEpisodeStatus.findMany({
      where: { userId, episodeId: { in: episodeIds }, watched: true },
      select: { episodeId: true },
    });
    if (watched.length) {
      const ids = watched.map((w) => w.episodeId);
      await this.prisma.$transaction(async (tx) => {
        await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'SHOW' });
        return Promise.all([
          tx.userEpisodeStatus.updateMany({
            where: { userId, episodeId: { in: ids } },
            data: {
              watched: false,
              watchedAt: null,
              watchCount: 0,
              source: 'MANUAL',
              sourceKey: null,
            },
          }),
          tx.watchHistory.deleteMany({ where: { userId, episodeId: { in: ids } } }),
        ]);
      });
      const progressDelta = ids.filter((id) => eligibleIds.has(id)).length;
      if (progressDelta > 0 && !season.isSpecial) {
        await this.bumpShowCount(userId, mediaId, -progressDelta);
      }
      this.events.emit('unwatch.episode', { userId, mediaId });
    }
    await this.invalidateUserCache(userId);
    return { watched: false, count: activeEpisodes.length };
  }

  // ---------------- Movies ----------------
  async markMovieWatched(userId: string, mediaId: string, dto: MarkWatchedDto) {
    mediaId = await this.canonicalMediaId(mediaId, 'MOVIE');
    const { becameWatched, prev } = await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'MOVIE' });
      const media = await tx.mediaItem.findUnique({
        where: { id: mediaId },
        include: { movie: true },
      });
      if (!media?.movie) throw new NotFoundException('Movie not found');

      const prev = await tx.userMovieStatus.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
      });
      const becameWatched = !prev?.watched;
      const now = new Date();

      await tx.userMovieStatus.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: {
          userId,
          mediaId,
          watched: true,
          watchedAt: now,
          watchCount: 1,
          source: 'MANUAL',
        },
        update: becameWatched
          ? {
              watched: true,
              watchedAt: now,
              watchCount: 1,
              source: 'MANUAL',
              sourceKey: null,
            }
          : { source: 'MANUAL', sourceKey: null },
      });

      if (becameWatched) {
        await tx.watchHistory.create({
          data: {
            userId,
            mediaId,
            mediaType: MediaType.MOVIE,
            runtimeMinutes: media.movie.runtimeMinutes,
            watchedAt: now,
          },
        });
      }

      return { becameWatched, prev };
    });
    if (becameWatched) {
      this.events.emit('watch.movie', { userId, mediaId });
      await this.invalidateUserCache(userId);
    }
    if (dto.device) await this.setDevice(userId, 'MOVIE', mediaId, dto.device);
    if (dto.rating) await this.upsertMediaRating(userId, mediaId, dto.rating);
    return { watched: true, watchCount: becameWatched ? 1 : (prev?.watchCount ?? 0) };
  }

  /** Record another viewing of an already-watched movie (see rewatchEpisode). */
  async rewatchMovie(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId, 'MOVIE');
    const { nextCount } = await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'MOVIE' });
      const [media, prev] = await Promise.all([
        tx.mediaItem.findUnique({ where: { id: mediaId }, include: { movie: true } }),
        tx.userMovieStatus.findUnique({ where: { userId_mediaId: { userId, mediaId } } }),
      ]);
      if (!media?.movie) throw new NotFoundException('Movie not found');
      if (!prev?.watched) throw new BadRequestException('Mark the movie as watched first');
      const now = new Date();
      const nextCount = (prev.watchCount ?? 1) + 1;
      await Promise.all([
        tx.userMovieStatus.update({
          where: { userId_mediaId: { userId, mediaId } },
          data: { watchCount: { increment: 1 }, source: 'MANUAL', sourceKey: null },
        }),
        tx.watchHistory.create({
          data: {
            userId,
            mediaId,
            mediaType: MediaType.MOVIE,
            runtimeMinutes: media.movie.runtimeMinutes,
            watchedAt: now,
          },
        }),
      ]);

      return { nextCount };
    });
    this.events.emit('rewatch.movie', { userId, mediaId });
    return { watched: true, watchCount: nextCount };
  }

  async unmarkMovieWatched(userId: string, mediaId: string) {
    mediaId = await this.canonicalMediaId(mediaId, 'MOVIE');
    const { changed } = await this.prisma.$transaction(async (tx) => {
      await fenceIdentityWrite(tx, { userId, mediaIds: [mediaId], type: 'MOVIE' });
      const prev = await tx.userMovieStatus.findUnique({
        where: { userId_mediaId: { userId, mediaId } },
      });
      if (!prev?.watched) return { changed: false };
      await tx.userMovieStatus.update({
        where: { userId_mediaId: { userId, mediaId } },
        data: { watched: false, watchedAt: null, watchCount: 0, source: 'MANUAL', sourceKey: null },
      });
      await tx.watchHistory.deleteMany({
        where: { userId, mediaId, mediaType: MediaType.MOVIE },
      });

      return { changed: true };
    });
    if (!changed) return { watched: false };
    this.events.emit('unwatch.movie', { userId, mediaId });
    await this.invalidateUserCache(userId);
    return { watched: false };
  }

  // ---------------- helpers ----------------
  /**
   * Maintain user_show_status.watchedCount (increment/decrement) and totalCount.
   * totalCount changes when the official structure changes or dated episodes become eligible,
   * so the expensive episode.count is run only on first create and when watchedCount catches
   * up to the known total — not on every single watch.
   */
  private async bumpShowCount(
    userId: string,
    mediaId: string,
    _delta: number,
    lastWatchedAt?: Date,
    db?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!db) {
      const canonicalId = await this.canonicalMediaId(mediaId);
      return this.prisma.$transaction(async (tx) => {
        await fenceIdentityWrite(tx, { userId, mediaIds: [canonicalId], type: 'SHOW' });
        await this.bumpShowCount(userId, canonicalId, _delta, lastWatchedAt, tx);
      });
    }
    // Lock the per-user progress row before counting. Concurrent watches cannot
    // overwrite a newer count, and a catalog cutover can recompute this safely.
    await db.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, watchedCount: 0, totalCount: 0 },
      update: { watchedCount: { increment: 0 } },
    });
    const episodeWhere = {
      structureState: 'ACTIVE' as const,
      season: { show: { mediaId }, isSpecial: false },
      ...episodeProgressEligibilityWhere(),
    };
    const [totalCount, watchedCount] = await Promise.all([
      db.episode.count({ where: episodeWhere }),
      db.userEpisodeStatus.count({ where: { userId, watched: true, episode: episodeWhere } }),
    ]);
    await db.userShowStatus.update({
      where: { userId_mediaId: { userId, mediaId } },
      data: { watchedCount, totalCount, ...(lastWatchedAt ? { lastWatchedAt } : {}) },
    });
  }

  private voteWrite<T>(
    userId: string,
    type: ConversationType,
    id: string,
    kind: CommsUniEngagementKind,
    value: string | null,
    selected: boolean,
    change: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const guarded = async (tx: Prisma.TransactionClient) => {
      await fenceIdentityWrite(
        tx,
        type === 'EPISODE'
          ? { userId, episodeIds: [id], type: 'SHOW' }
          : { userId, mediaIds: [id], type: 'MOVIE' },
      );
      return change(tx);
    };
    return this.publication
      ? this.publication.voteTransaction(userId, type, id, kind, value, selected, guarded)
      : this.prisma.$transaction(guarded);
  }

  private async setDevice(
    userId: string,
    type: 'EPISODE' | 'MOVIE',
    id: string,
    value: string,
    tx?: Prisma.TransactionClient,
  ) {
    if (!Object.values(WatchDevice).includes(value as WatchDevice))
      throw new BadRequestException('Invalid device');
    const change = (client: Prisma.TransactionClient): Promise<unknown> =>
      type === 'EPISODE'
        ? client.userEpisodeStatus.update({
            where: { userId_episodeId: { userId, episodeId: id } },
            data: { device: value as WatchDevice, deviceSource: 'MANUAL' },
          })
        : client.userMovieStatus.update({
            where: { userId_mediaId: { userId, mediaId: id } },
            data: { device: value as WatchDevice, deviceSource: 'MANUAL' },
          });
    if (tx) {
      await change(tx);
      await this.publication?.captureVote(tx, userId, type, id, 'watch_device', value, true);
    } else await this.voteWrite(userId, type, id, 'watch_device', value, true, change);
  }

  private async upsertEpisodeRating(userId: string, episodeId: string, rating: number) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      throw new BadRequestException('Invalid rating');
    await this.voteWrite(userId, 'EPISODE', episodeId, 'star_rating', String(rating), true, (tx) =>
      tx.rating.upsert({
        where: { userId_episodeId: { userId, episodeId } },
        create: { userId, episodeId, rating, source: 'MANUAL' },
        update: { rating, source: 'MANUAL', sourceKey: null },
      }),
    );
  }

  private async upsertMediaRating(userId: string, mediaId: string, rating: number) {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5)
      throw new BadRequestException('Invalid rating');
    await this.voteWrite(userId, 'MOVIE', mediaId, 'star_rating', String(rating), true, (tx) =>
      tx.rating.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: { userId, mediaId, rating, source: 'MANUAL' },
        update: { rating, source: 'MANUAL', sourceKey: null },
      }),
    );
  }

  private async upsertReaction(userId: string, episodeId: string, reaction: string) {
    if (!Object.values(ReactionType).includes(reaction as ReactionType))
      throw new BadRequestException('Invalid reaction');
    await this.voteWrite(userId, 'EPISODE', episodeId, 'emotion', reaction, true, (tx) =>
      tx.reaction.upsert({
        where: { userId_episodeId_reaction: { userId, episodeId, reaction: reaction as any } },
        create: { userId, episodeId, reaction: reaction as any, source: 'MANUAL' },
        update: { source: 'MANUAL', sourceKey: null },
      }),
    );
  }

  async updateEpisodeFeedback(
    userId: string,
    episodeId: string,
    dto: { rating?: number; reaction?: string; device?: string },
  ) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const status = await this.prisma.userEpisodeStatus.findUnique({
      where: { userId_episodeId: { userId, episodeId } },
    });
    if (!status) throw new NotFoundException('Episode not tracked — mark as watched first');

    if (dto.rating !== undefined) await this.upsertEpisodeRating(userId, episodeId, dto.rating);
    if (dto.reaction) await this.upsertReaction(userId, episodeId, dto.reaction);
    if (dto.device) {
      await this.setDevice(userId, 'EPISODE', episodeId, dto.device);
    }
    return { ok: true };
  }
}
