import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
      create: { userId, episodeId, watched: true, watchedAt: now, watchCount: 1, device: dto.device },
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
    return { watched: true, watchCount: becameWatched ? 1 : prev?.watchCount ?? 0 };
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
    for (const ep of season.episodes) {
      await this.markEpisodeWatched(userId, ep.id, {});
    }
    return { watched: true, count: season.episodes.length };
  }

  async unmarkSeasonWatched(userId: string, seasonId: string) {
    const season = await this.prisma.season.findUnique({
      where: { id: seasonId },
      include: { episodes: true },
    });
    if (!season) throw new NotFoundException('Season not found');
    for (const ep of season.episodes) {
      await this.unmarkEpisodeWatched(userId, ep.id);
    }
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
    }
    return { watched: true, watchCount: becameWatched ? 1 : prev?.watchCount ?? 0 };
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
    await this.prisma.watchHistory.deleteMany({ where: { userId, mediaId, mediaType: MediaType.MOVIE } });
    this.events.emit('unwatch.movie', { userId, mediaId });
    return { watched: false };
  }

  // ---------------- helpers ----------------
  /**
   * Maintain user_show_status.watchedCount (increment/decrement) and totalCount.
   * totalCount only changes when episodes air, so the expensive episode.count is run only
   * on first create and when watchedCount catches up to the known total (new episodes may
   * have aired) — not on every single watch.
   */
  private async bumpShowCount(userId: string, mediaId: string, delta: number, lastWatchedAt?: Date) {
    const existing = await this.prisma.userShowStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });
    const last = lastWatchedAt ? { lastWatchedAt } : {};

    if (existing) {
      const nextWatched = Math.max(0, (existing.watchedCount ?? 0) + delta);
      // Recompute the total only if we may have caught up (new episodes could have aired).
      const mayHaveNewEpisodes = nextWatched >= (existing.totalCount ?? 0);
      const total = mayHaveNewEpisodes
        ? await this.prisma.episode.count({
            where: { season: { show: { mediaId }, isSpecial: false }, airDate: { lte: new Date() } },
          })
        : existing.totalCount ?? 0;
      await this.prisma.userShowStatus.update({
        where: { id: existing.id },
        data: { watchedCount: nextWatched, totalCount: total, ...last },
      });
      return;
    }

    // First time tracking this show: compute the total and seed the row.
    const total = await this.prisma.episode.count({
      where: { season: { show: { mediaId }, isSpecial: false }, airDate: { lte: new Date() } },
    });
    await this.prisma.userShowStatus.create({
      data: { userId, mediaId, watchedCount: Math.max(0, delta), totalCount: total, ...last },
    });
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

  async updateEpisodeFeedback(userId: string, episodeId: string, dto: { rating?: number; reaction?: string; device?: string }) {
    const status = await this.prisma.userEpisodeStatus.findUnique({ where: { userId_episodeId: { userId, episodeId } } });
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
