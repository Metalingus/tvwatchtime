import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MarkWatchedDto } from './dto/tracking.dto';

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly redis: RedisService,
  ) {}

  private async invalidateUserCache(userId: string) {
    // The per-user watch-next / upcoming caches are language-suffixed
    // (watchnext:userId:<lang>, upcoming:userId:<lang>), so delete by pattern to
    // purge every locale variant — a bare del() of the unsuffixed key is a no-op
    // and leaves stale buckets that revert optimistic client updates.
    await Promise.all([
      this.redis.delByPattern(`watchnext:${userId}:*`),
      this.redis.delByPattern(`upcoming:${userId}:*`),
      this.redis.delByPattern(`showsprogress:${userId}:*`),
      // Personalized show/movie rankings (genres/keywords affinity from history).
      this.redis.delByPattern(`foryou:v3:${userId}:*`),
      this.redis.del(`watchnext:${userId}`),
      this.redis.del(`upcoming:${userId}`),
    ]);
  }

  // ---------------- Episodes ----------------
  async markEpisodeWatched(userId: string, episodeId: string, dto: MarkWatchedDto) {
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
    const mediaId = episode.season.show.mediaId;
    const becameWatched = !prev?.watched;
    const now = new Date();

    // watchedAt always records the FIRST watch date, so it is only written on the
    // watched→unwatched→watched transition (or first-ever create). Re-marking an
    // already-watched episode leaves watchedAt and watchCount untouched.
    await this.prisma.userEpisodeStatus.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: {
        userId,
        episodeId,
        watched: true,
        watchedAt: now,
        watchCount: 1,
        device: dto.device,
      },
      update: becameWatched
        ? { watched: true, watchedAt: now, watchCount: 1, device: dto.device }
        : { device: dto.device },
    });

    if (becameWatched) {
      // Independent writes (different tables) run in parallel; lastWatchedAt is folded into
      // bumpShowCount so we no longer need a separate userShowStatus update.
      await Promise.all([
        this.prisma.watchHistory.create({
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
        this.bumpShowCount(userId, mediaId, 1, now),
      ]);
      this.events.emit('watch.episode', { userId, mediaId, episodeId });
    }

    // Rating / reaction persist regardless of the watched transition. The dedicated
    // PUT /vote/* endpoints are the primary path; these keep the legacy mark-watched
    // payload consistent with the new single-active-vote model.
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
        airDate: { lte: now },
        season: { showId: current.season.showId, isSpecial: false },
        OR: [
          { season: { number: { lt: current.season.number } } },
          { season: { number: current.season.number }, number: { lt: current.number } },
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
                  device: dto.device,
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
                data: { watched: true, watchedAt: now, watchCount: 1, device: dto.device },
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
      await this.bumpShowCount(userId, mediaId, newlyWatched.length, now);
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
    if (!prev?.watched) throw new BadRequestException('Mark the episode as watched first');
    const mediaId = episode.season.show.mediaId;
    const now = new Date();

    const nextCount = (prev.watchCount ?? 1) + 1;
    await Promise.all([
      this.prisma.userEpisodeStatus.update({
        where: { userId_episodeId: { userId, episodeId } },
        data: { watchCount: { increment: 1 } },
      }),
      this.prisma.watchHistory.create({
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
    this.events.emit('rewatch.episode', { userId, mediaId, episodeId });
    await this.invalidateUserCache(userId);
    return { watched: true, watchCount: nextCount };
  }

  /**
   * Undo ONE viewing of an episode with multiple recorded watches: watchCount
   * decrements and the LATEST watchHistory row is removed, but the episode stays
   * watched (watchedAt keeps the first-watch date). Full reset stays on
   * unmarkEpisodeWatched.
   */
  async unwatchEpisodeOnce(userId: string, episodeId: string) {
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
    await this.prisma.$transaction([
      this.prisma.userEpisodeStatus.update({
        where: { userId_episodeId: { userId, episodeId } },
        data: { watchCount: { decrement: 1 } },
      }),
      ...(latest ? [this.prisma.watchHistory.delete({ where: { id: latest.id } })] : []),
    ]);
    this.events.emit('unwatch.episode', { userId, mediaId, episodeId });
    await this.invalidateUserCache(userId);
    return { watched: true, watchCount: prev.watchCount - 1 };
  }

  async unmarkEpisodeWatched(userId: string, episodeId: string) {
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
    const mediaId = episode.season.show.mediaId;
    if (!prev?.watched) return { watched: false };

    // Three independent tables — run in parallel.
    await Promise.all([
      this.prisma.userEpisodeStatus.update({
        where: { userId_episodeId: { userId, episodeId } },
        data: { watched: false, watchedAt: null, watchCount: 0 },
      }),
      this.prisma.watchHistory.deleteMany({ where: { userId, episodeId } }),
      this.bumpShowCount(userId, mediaId, -1),
    ]);
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
    const mediaId = season.show.mediaId;
    const now = new Date();
    const episodeIds = season.episodes.map((e) => e.id);

    // Batched: the old per-episode markEpisodeWatched loop cost ~8 queries + a badge
    // evaluation + 2 Redis keyspace scans PER EPISODE on a single tap.
    let newlyWatched: typeof season.episodes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        newlyWatched = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.userEpisodeStatus.findMany({
              where: { userId, episodeId: { in: episodeIds } },
              select: { episodeId: true, watched: true },
            });
            const existingById = new Map(existing.map((status) => [status.episodeId, status]));
            // Mirrors markEpisodeWatched's upsert: create missing rows, flip unwatched ones;
            // already-watched rows stay untouched (watchedAt keeps the FIRST watch date).
            const toCreate = season.episodes.filter((episode) => !existingById.has(episode.id));
            const toMark = season.episodes.filter(
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
                data: { watched: true, watchedAt: now, watchCount: 1 },
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
      await this.bumpShowCount(userId, mediaId, newlyWatched.length, now);
      // One event for the whole season: badge evaluation and stats invalidation are
      // user-level + idempotent, and the leaderboard bust is debounced — the old loop
      // re-fired all three per episode.
      this.events.emit('watch.episode', { userId, mediaId });
    }
    await this.invalidateUserCache(userId);
    return { watched: true, count: season.episodes.length };
  }

  /**
   * Record another viewing of every already-watched, aired episode of a season.
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
    const mediaId = season.show.mediaId;
    const now = new Date();
    const aired = season.episodes.filter((e) => e.airDate && e.airDate <= now);
    if (aired.length === 0) return { watched: true, count: 0 };

    const watched = await this.prisma.userEpisodeStatus.findMany({
      where: { userId, episodeId: { in: aired.map((e) => e.id) }, watched: true },
      select: { episodeId: true },
    });
    if (watched.length === 0) {
      throw new BadRequestException('Mark at least one episode as watched first');
    }
    const ids = new Set(watched.map((w) => w.episodeId));
    const rewatched = aired.filter((e) => ids.has(e.id));

    await this.prisma.$transaction([
      this.prisma.userEpisodeStatus.updateMany({
        where: { userId, episodeId: { in: rewatched.map((e) => e.id) } },
        data: { watchCount: { increment: 1 } },
      }),
      this.prisma.watchHistory.createMany({
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
    // One event for the whole season (same batching rationale as markSeasonWatched).
    this.events.emit('rewatch.episode', { userId, mediaId });
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
    const mediaId = season.show.mediaId;
    const now = new Date();
    const aired = season.episodes.filter((e) => e.airDate && e.airDate <= now);
    if (aired.length === 0) return { watched: true, count: 0 };

    const rewatched = await this.prisma.userEpisodeStatus.findMany({
      where: {
        userId,
        episodeId: { in: aired.map((e) => e.id) },
        watched: true,
        watchCount: { gte: 2 },
      },
      select: { episodeId: true },
    });
    if (rewatched.length === 0) {
      throw new BadRequestException('No rewatches to undo — unwatch instead');
    }
    const ids = rewatched.map((w) => w.episodeId);

    await this.prisma.$transaction([
      this.prisma.userEpisodeStatus.updateMany({
        where: { userId, episodeId: { in: ids } },
        data: { watchCount: { decrement: 1 } },
      }),
      // Latest history row per decremented episode (Postgres DISTINCT ON).
      this.prisma.$executeRaw`
        DELETE FROM watch_history WHERE id IN (
          SELECT DISTINCT ON (episode_id) id FROM watch_history
          WHERE user_id = ${userId} AND episode_id IN (${Prisma.join(ids)})
          ORDER BY episode_id, watched_at DESC
        )
      `,
    ]);
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
    const mediaId = season.show.mediaId;
    const episodeIds = season.episodes.map((e) => e.id);

    const watched = await this.prisma.userEpisodeStatus.findMany({
      where: { userId, episodeId: { in: episodeIds }, watched: true },
      select: { episodeId: true },
    });
    if (watched.length) {
      const ids = watched.map((w) => w.episodeId);
      await this.prisma.$transaction([
        this.prisma.userEpisodeStatus.updateMany({
          where: { userId, episodeId: { in: ids } },
          data: { watched: false, watchedAt: null, watchCount: 0 },
        }),
        this.prisma.watchHistory.deleteMany({ where: { userId, episodeId: { in: ids } } }),
      ]);
      await this.bumpShowCount(userId, mediaId, -ids.length);
      this.events.emit('unwatch.episode', { userId, mediaId });
    }
    await this.invalidateUserCache(userId);
    return { watched: false, count: season.episodes.length };
  }

  // ---------------- Movies ----------------
  async markMovieWatched(userId: string, mediaId: string, dto: MarkWatchedDto) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { movie: true },
    });
    if (!media?.movie) throw new NotFoundException('Movie not found');

    const prev = await this.prisma.userMovieStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });
    const becameWatched = !prev?.watched;
    const now = new Date();

    await this.prisma.userMovieStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, watched: true, watchedAt: now, watchCount: 1, device: dto.device },
      update: becameWatched
        ? { watched: true, watchedAt: now, watchCount: 1, device: dto.device }
        : { device: dto.device },
    });

    if (becameWatched) {
      await this.prisma.watchHistory.create({
        data: {
          userId,
          mediaId,
          mediaType: MediaType.MOVIE,
          runtimeMinutes: media.movie.runtimeMinutes,
          watchedAt: now,
        },
      });
      if (dto.rating) await this.upsertMediaRating(userId, mediaId, dto.rating);
      this.events.emit('watch.movie', { userId, mediaId });
      await this.invalidateUserCache(userId);
    }
    return { watched: true, watchCount: becameWatched ? 1 : (prev?.watchCount ?? 0) };
  }

  /** Record another viewing of an already-watched movie (see rewatchEpisode). */
  async rewatchMovie(userId: string, mediaId: string) {
    const [media, prev] = await Promise.all([
      this.prisma.mediaItem.findUnique({ where: { id: mediaId }, include: { movie: true } }),
      this.prisma.userMovieStatus.findUnique({ where: { userId_mediaId: { userId, mediaId } } }),
    ]);
    if (!media?.movie) throw new NotFoundException('Movie not found');
    if (!prev?.watched) throw new BadRequestException('Mark the movie as watched first');
    const now = new Date();
    const nextCount = (prev.watchCount ?? 1) + 1;
    await Promise.all([
      this.prisma.userMovieStatus.update({
        where: { userId_mediaId: { userId, mediaId } },
        data: { watchCount: { increment: 1 } },
      }),
      this.prisma.watchHistory.create({
        data: {
          userId,
          mediaId,
          mediaType: MediaType.MOVIE,
          runtimeMinutes: media.movie.runtimeMinutes,
          watchedAt: now,
        },
      }),
    ]);
    this.events.emit('rewatch.movie', { userId, mediaId });
    return { watched: true, watchCount: nextCount };
  }

  async unmarkMovieWatched(userId: string, mediaId: string) {
    const prev = await this.prisma.userMovieStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });
    if (!prev?.watched) return { watched: false };
    await this.prisma.userMovieStatus.update({
      where: { userId_mediaId: { userId, mediaId } },
      data: { watched: false, watchedAt: null, watchCount: 0 },
    });
    await this.prisma.watchHistory.deleteMany({
      where: { userId, mediaId, mediaType: MediaType.MOVIE },
    });
    this.events.emit('unwatch.movie', { userId, mediaId });
    await this.invalidateUserCache(userId);
    return { watched: false };
  }

  // ---------------- helpers ----------------
  /**
   * Maintain user_show_status.watchedCount (increment/decrement) and totalCount.
   * totalCount only changes when episodes air, so the expensive episode.count is run only
   * on first create and when watchedCount catches up to the known total (new episodes may
   * have aired) — not on every single watch.
   */
  private async bumpShowCount(
    userId: string,
    mediaId: string,
    delta: number,
    lastWatchedAt?: Date,
  ) {
    const updateExisting = async (existing: {
      id: string;
      watchedCount: number;
      totalCount: number;
      dropped: boolean;
    }) => {
      const nextWatched = Math.max(0, (existing.watchedCount ?? 0) + delta);
      // Recompute the total only if we may have caught up (new episodes could have aired).
      const mayHaveNewEpisodes = nextWatched >= (existing.totalCount ?? 0);
      const total = mayHaveNewEpisodes
        ? await this.prisma.episode.count({
            where: {
              structureState: 'ACTIVE',
              season: { show: { mediaId }, isSpecial: false },
              airDate: { lte: new Date() },
            },
          })
        : (existing.totalCount ?? 0);
      // Dropped is STICKY: watching an episode does NOT resurface the show in
      // watch-next/upcoming. Only an explicit restore clears the flag, preventing
      // stray rewatches or imports from silently changing the user's library state.
      const last = lastWatchedAt ? { lastWatchedAt } : {};
      await this.prisma.userShowStatus.update({
        where: { id: existing.id },
        data: { watchedCount: nextWatched, totalCount: total, ...last },
      });
    };

    const existing = await this.prisma.userShowStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });

    if (existing) {
      await updateExisting(existing);
      return;
    }

    // First time tracking this show: compute the total and seed the row.
    const total = await this.prisma.episode.count({
      where: {
        structureState: 'ACTIVE',
        season: { show: { mediaId }, isSpecial: false },
        airDate: { lte: new Date() },
      },
    });
    try {
      await this.prisma.userShowStatus.create({
        data: {
          userId,
          mediaId,
          watchedCount: Math.max(0, delta),
          totalCount: total,
          ...(lastWatchedAt ? { lastWatchedAt } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const raced = await this.prisma.userShowStatus.findUnique({
          where: { userId_mediaId: { userId, mediaId } },
        });
        if (raced) {
          await updateExisting(raced);
          return;
        }
      }
      throw e;
    }
  }

  private async upsertEpisodeRating(userId: string, episodeId: string, rating: number) {
    // Episode ratings key on episodeId and leave mediaId null, so the
    // @@unique([userId, mediaId]) constraint can't collide with another episode of
    // the same show or a show-level rating.
    await this.prisma.rating.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId, rating },
      update: { rating },
    });
  }

  private async upsertMediaRating(userId: string, mediaId: string, rating: number) {
    await this.prisma.rating.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, rating },
      update: { rating },
    });
  }

  private async upsertReaction(userId: string, episodeId: string, reaction: string) {
    // Multi-select reactions live in the `reactions` table (one row per
    // user+episode+reaction). The mark-watched payload just ensures the reaction exists.
    await this.prisma.reaction.upsert({
      where: { userId_episodeId_reaction: { userId, episodeId, reaction: reaction as any } },
      create: { userId, episodeId, reaction: reaction as any },
      update: {},
    });
  }

  async updateEpisodeFeedback(
    userId: string,
    episodeId: string,
    dto: { rating?: number; reaction?: string; device?: string },
  ) {
    const status = await this.prisma.userEpisodeStatus.findUnique({
      where: { userId_episodeId: { userId, episodeId } },
    });
    if (!status) throw new NotFoundException('Episode not tracked — mark as watched first');

    if (dto.rating !== undefined) await this.upsertEpisodeRating(userId, episodeId, dto.rating);
    if (dto.reaction) await this.upsertReaction(userId, episodeId, dto.reaction);
    if (dto.device) {
      await this.prisma.userEpisodeStatus.update({
        where: { userId_episodeId: { userId, episodeId } },
        data: { device: dto.device as any },
      });
    }
    return { ok: true };
  }
}
