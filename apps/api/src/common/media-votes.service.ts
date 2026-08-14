import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class MediaVotesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly RATING_OPTIONS = ['1', '2', '3', '4', '5'] as const;
  private readonly REACTION_OPTIONS = [
    'SHOCKED',
    'FRUSTRATED',
    'SAD',
    'REFLECTIVE',
    'TOUCHED',
    'AMUSED',
    'SCARED',
    'BORED',
    'UNDERSTANDING',
    'THRILLED',
    'CONFUSED',
    'TENSE',
  ] as const;

  private buildRatingSection(counts: Map<string, number>, userVote: string | null) {
    const options = this.RATING_OPTIONS.map((value) => ({ value, count: counts.get(value) ?? 0 }));
    const total = options.reduce((acc, option) => acc + option.count, 0);
    const safeUserVote =
      userVote && (this.RATING_OPTIONS as readonly string[]).includes(userVote) ? userVote : null;
    return { userVote: safeUserVote, total, options };
  }

  private async requireMedia(mediaId: string, type: 'SHOW' | 'MOVIE') {
    const media = await this.prisma.mediaItem.findFirst({ where: { id: mediaId, type } });
    if (!media) throw new NotFoundException(`${type === 'MOVIE' ? 'Movie' : 'Show'} not found`);
    return media;
  }

  private async requireWatchedMovie(userId: string, mediaId: string) {
    await this.requireMedia(mediaId, 'MOVIE');
    const status = await this.prisma.userMovieStatus.findUnique({
      where: { userId_mediaId: { userId, mediaId } },
    });
    if (!status?.watched) throw new NotFoundException('Movie not tracked - mark as watched first');
  }

  async getMovieInteractions(mediaId: string, userId?: string) {
    const [rating, reaction, character] = await Promise.all([
      this.getMediaRatingSection(mediaId, userId),
      this.getMediaReactionSection(mediaId, userId),
      this.getMovieCharacterSection(mediaId, userId),
    ]);
    return { rating, reaction, character };
  }

  async getShowInteractions(mediaId: string, userId?: string) {
    return { rating: await this.getMediaRatingSection(mediaId, userId) };
  }

  private async getMediaRatingSection(mediaId: string, userId?: string) {
    const userRating = userId
      ? await this.prisma.rating.findUnique({ where: { userId_mediaId: { userId, mediaId } } })
      : null;
    const groups = await this.prisma.rating.groupBy({
      by: ['rating'],
      where: { mediaId },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const group of groups) counts.set(String(group.rating), group._count._all);
    return this.buildRatingSection(counts, userRating ? String(userRating.rating) : null);
  }

  private async getMediaReactionSection(mediaId: string, userId?: string) {
    const userRows = userId
      ? await this.prisma.reaction.findMany({
          where: { userId, mediaId },
          select: { reaction: true },
        })
      : [];
    const userVotes = userRows.map((row) => row.reaction as string);

    const [distinctUsers, groups] = await Promise.all([
      this.prisma.reaction.groupBy({ by: ['userId'], where: { mediaId }, _count: { _all: true } }),
      this.prisma.reaction.groupBy({
        by: ['reaction'],
        where: { mediaId },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map<string, number>();
    for (const group of groups) counts.set(group.reaction as string, group._count._all);
    return {
      userVotes,
      total: distinctUsers.length,
      options: (this.REACTION_OPTIONS as readonly string[]).map((value) => ({
        value,
        count: counts.get(value) ?? 0,
      })),
    };
  }

  async voteMovieRating(userId: string, mediaId: string, value: number) {
    await this.requireWatchedMovie(userId, mediaId);
    await this.upsertMediaRating(userId, mediaId, value);
    return this.getMediaRatingSection(mediaId, userId);
  }

  async voteMovieReaction(userId: string, mediaId: string, value: string) {
    await this.requireWatchedMovie(userId, mediaId);
    if (!(this.REACTION_OPTIONS as readonly string[]).includes(value)) {
      throw new BadRequestException('Invalid reaction');
    }
    const existing = await this.prisma.reaction.findUnique({
      where: { userId_mediaId_reaction: { userId, mediaId, reaction: value as any } },
    });
    if (existing) {
      await this.prisma.reaction.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.reaction.create({ data: { userId, mediaId, reaction: value as any } });
    }
    return this.getMediaReactionSection(mediaId, userId);
  }

  private async getMovieCharacterSection(mediaId: string, userId?: string) {
    const [castCount, userVote, groups] = await Promise.all([
      this.prisma.mediaCast.count({ where: { mediaId } }),
      userId
        ? this.prisma.characterVote.findUnique({
            where: { userId_mediaId: { userId, mediaId } },
          })
        : null,
      this.prisma.characterVote.groupBy({
        by: ['castId'],
        where: { mediaId },
        _count: { _all: true },
      }),
    ]);
    if (castCount === 0) return null;
    const options = groups.map((group) => ({
      castId: group.castId,
      count: group._count._all,
    }));
    return {
      userVote: userVote?.castId ?? null,
      total: options.reduce((sum, option) => sum + option.count, 0),
      options,
    };
  }

  async voteMovieCharacter(userId: string, mediaId: string, castId: string | null) {
    await this.requireWatchedMovie(userId, mediaId);
    if (castId !== null) {
      const eligible = await this.prisma.mediaCast.findFirst({
        where: { id: castId, mediaId },
        select: { id: true },
      });
      if (!eligible) throw new BadRequestException('Character is not part of this movie');
      await this.prisma.characterVote.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: { userId, mediaId, castId },
        update: { castId },
      });
    } else {
      await this.prisma.characterVote.deleteMany({ where: { userId, mediaId } });
    }
    return this.getMovieCharacterSection(mediaId, userId);
  }

  async voteShowRating(userId: string, mediaId: string, value: number) {
    await this.requireMedia(mediaId, 'SHOW');
    await this.upsertMediaRating(userId, mediaId, value);
    return this.getMediaRatingSection(mediaId, userId);
  }

  private async upsertMediaRating(userId: string, mediaId: string, value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    await this.prisma.rating.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, rating: value, source: 'MANUAL' },
      update: { rating: value, source: 'MANUAL', sourceKey: null },
    });
  }
}
