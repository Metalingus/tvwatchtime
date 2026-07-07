import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { MarkWatchedDto } from './dto/tracking.dto';

@Injectable()
export class TrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------- Episodes ----------------
  async markEpisodeWatched(userId: string, episodeId: string, dto: MarkWatchedDto) {
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { show: true } } },
    });
    if (!episode) throw new NotFoundException('Episode not found');
    const mediaId = episode.season.show.mediaId;

    const prev = await this.prisma.userEpisodeStatus.findUnique({
      where: { userId_episodeId: { userId, episodeId } },
    });
    const becameWatched = !prev?.watched;

    await this.prisma.userEpisodeStatus.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId, watched: true, watchedAt: new Date(), device: dto.device },
      update: { watched: true, watchedAt: new Date(), device: dto.device },
    });

    if (becameWatched) {
      await this.prisma.watchHistory.create({
        data: {
          userId,
          mediaId,
          mediaType: MediaType.SHOW,
          episodeId,
          seasonNumber: episode.season.number,
          episodeNumber: episode.number,
          runtimeMinutes: episode.runtimeMinutes,
          watchedAt: new Date(),
        },
      });
      await this.bumpShowCount(userId, mediaId, 1);
      await this.prisma.userShowStatus.updateMany({
        where: { userId, mediaId },
        data: { lastWatchedAt: new Date() },
      });
      this.events.emit('watch.episode', { userId, mediaId, episodeId });
    }

    // Rating / reaction / favorite-character persist regardless of the watched transition.
    if (dto.rating) await this.upsertEpisodeRating(userId, episodeId, mediaId, dto.rating);
    if (dto.reaction) await this.upsertReaction(userId, episodeId, dto.reaction);
    if (dto.favoriteCharacter) {
      await this.prisma.characterVote.upsert({
        where: { userId_episodeId: { userId, episodeId } },
        create: { userId, episodeId, characterName: dto.favoriteCharacter },
        update: { characterName: dto.favoriteCharacter },
      });
    }
    return { watched: true };
  }

  async unmarkEpisodeWatched(userId: string, episodeId: string) {
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { show: true } } },
    });
    if (!episode) throw new NotFoundException('Episode not found');
    const mediaId = episode.season.show.mediaId;

    const prev = await this.prisma.userEpisodeStatus.findUnique({
      where: { userId_episodeId: { userId, episodeId } },
    });
    if (!prev?.watched) return { watched: false };

    await this.prisma.userEpisodeStatus.update({
      where: { userId_episodeId: { userId, episodeId } },
      data: { watched: false, watchedAt: null },
    });
    await this.prisma.watchHistory.deleteMany({
      where: { userId, episodeId },
    });
    await this.bumpShowCount(userId, mediaId, -1);
    this.events.emit('unwatch.episode', { userId, mediaId, episodeId });
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

    await this.prisma.userMovieStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, watched: true, watchedAt: new Date(), device: dto.device },
      update: { watched: true, watchedAt: new Date(), device: dto.device },
    });

    if (becameWatched) {
      await this.prisma.watchHistory.create({
        data: {
          userId,
          mediaId,
          mediaType: MediaType.MOVIE,
          runtimeMinutes: media.movie.runtimeMinutes,
          watchedAt: new Date(),
        },
      });
      if (dto.rating) await this.upsertMediaRating(userId, mediaId, dto.rating);
      this.events.emit('watch.movie', { userId, mediaId });
    }
    return { watched: true };
  }

  async unmarkMovieWatched(userId: string, mediaId: string) {
    const prev = await this.prisma.userMovieStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });
    if (!prev?.watched) return { watched: false };
    await this.prisma.userMovieStatus.update({
      where: { userId_mediaId: { userId, mediaId } },
      data: { watched: false, watchedAt: null },
    });
    await this.prisma.watchHistory.deleteMany({ where: { userId, mediaId, mediaType: MediaType.MOVIE } });
    this.events.emit('unwatch.movie', { userId, mediaId });
    return { watched: false };
  }

  // ---------------- helpers ----------------
  private async bumpShowCount(userId: string, mediaId: string, delta: number) {
    const total = await this.prisma.episode.count({
      where: { season: { show: { mediaId }, isSpecial: false }, airDate: { lte: new Date() } },
    });
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, watchedCount: Math.max(0, delta), totalCount: total },
      update: {
        watchedCount: { increment: delta },
        totalCount: total,
      },
    });
    const updated = await this.prisma.userShowStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });
    if (updated && updated.watchedCount < 0) {
      await this.prisma.userShowStatus.update({
        where: { id: updated.id },
        data: { watchedCount: 0 },
      });
    }
  }

  private async upsertEpisodeRating(userId: string, episodeId: string, mediaId: string, rating: number) {
    await this.prisma.rating.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId, mediaId, rating },
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
    await this.prisma.reaction.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId, reaction: reaction as any },
      update: { reaction: reaction as any },
    });
  }
}
