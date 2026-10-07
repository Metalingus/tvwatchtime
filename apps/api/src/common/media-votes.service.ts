import { canonicalCopyId, canonicalMediaId } from '../media-metadata/util/canonical-media';
import { applyLocalVote } from './local-vote-mutation';
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma/prisma.service';
import { CommsUniVotingService } from '../commsuni/commsuni.voting.service';
import { CommsUniPublicationService } from '../commsuni/commsuni.publication.service';
import type { Prisma } from '@prisma/client';
import type { CommsUniEngagementKind } from '@tvwatch/shared';

@Injectable()
export class MediaVotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @Optional() private readonly publication?: CommsUniPublicationService,
    @Optional() private readonly community?: CommsUniVotingService,
  ) {}

  private voteWrite<T>(
    userId: string,
    type: 'SHOW' | 'MOVIE',
    mediaId: string,
    kind: CommsUniEngagementKind,
    value: string | null,
    selected: boolean,
    change: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.publication
      ? this.publication.voteTransaction(userId, type, mediaId, kind, value, selected, change)
      : this.prisma.$transaction(change);
  }

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

  async getMovieInteractions(mediaId: string, userId?: string, includeCommunity = true) {
    mediaId = await canonicalMediaId(this.prisma, mediaId, 'MOVIE');
    const [rating, reaction, character] = await Promise.all([
      this.getMediaRatingSection(mediaId, userId),
      this.getMediaReactionSection(mediaId, userId),
      this.getMovieCharacterSection(mediaId, userId),
    ]);
    const local = { rating, reaction, character };
    return includeCommunity && this.community
      ? this.community.merge(userId, 'MOVIE', mediaId, local, { cached: true })
      : local;
  }

  async getShowInteractions(mediaId: string, userId?: string, includeCommunity = true) {
    mediaId = await canonicalMediaId(this.prisma, mediaId, 'SHOW');
    const local = { rating: await this.getMediaRatingSection(mediaId, userId) };
    return includeCommunity && this.community
      ? this.community.merge(userId, 'SHOW', mediaId, local, { cached: true })
      : local;
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
    mediaId = await canonicalMediaId(this.prisma, mediaId, 'MOVIE');
    await this.requireWatchedMovie(userId, mediaId);
    await this.upsertMediaRating(userId, mediaId, value, 'MOVIE');
    this.events.emit('integration.local-media-changed', { userId, mediaId });
    const local = { rating: await this.getMediaRatingSection(mediaId, userId) };
    return (this.community ? await this.community.merge(userId, 'MOVIE', mediaId, local) : local)
      .rating;
  }

  async voteMovieReaction(userId: string, mediaId: string, value: string) {
    mediaId = await canonicalMediaId(this.prisma, mediaId, 'MOVIE');
    await this.requireWatchedMovie(userId, mediaId);
    if (!(this.REACTION_OPTIONS as readonly string[]).includes(value)) {
      throw new BadRequestException('Invalid reaction');
    }
    const existing = await this.prisma.reaction.findUnique({
      where: { userId_mediaId_reaction: { userId, mediaId, reaction: value as any } },
    });
    await this.voteWrite(userId, 'MOVIE', mediaId, 'emotion', value, !existing, (tx) =>
      applyLocalVote(tx, userId, { mediaId }, 'emotion', value, !existing),
    );
    const local = { reaction: await this.getMediaReactionSection(mediaId, userId) };
    return (this.community ? await this.community.merge(userId, 'MOVIE', mediaId, local) : local)
      .reaction;
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
    mediaId = await canonicalMediaId(this.prisma, mediaId, 'MOVIE');
    if (castId) castId = await canonicalCopyId(this.prisma, 'CAST', castId);
    await this.requireWatchedMovie(userId, mediaId);
    if (castId !== null) {
      const eligible = await this.prisma.mediaCast.findFirst({
        where: { id: castId, mediaId },
        select: { id: true },
      });
      if (!eligible) throw new BadRequestException('Character is not part of this movie');
      await this.voteWrite(userId, 'MOVIE', mediaId, 'cast_vote', castId, true, (tx) =>
        applyLocalVote(tx, userId, { mediaId }, 'cast_vote', castId, true),
      );
    } else {
      await this.voteWrite(userId, 'MOVIE', mediaId, 'cast_vote', null, false, (tx) =>
        applyLocalVote(tx, userId, { mediaId }, 'cast_vote', null, false),
      );
    }
    const local = { character: await this.getMovieCharacterSection(mediaId, userId) };
    return (this.community ? await this.community.merge(userId, 'MOVIE', mediaId, local) : local)
      .character;
  }

  async voteShowRating(userId: string, mediaId: string, value: number) {
    mediaId = await canonicalMediaId(this.prisma, mediaId, 'SHOW');
    await this.requireMedia(mediaId, 'SHOW');
    await this.upsertMediaRating(userId, mediaId, value, 'SHOW');
    this.events.emit('integration.local-media-changed', { userId, mediaId });
    const local = { rating: await this.getMediaRatingSection(mediaId, userId) };
    return (this.community ? await this.community.merge(userId, 'SHOW', mediaId, local) : local)
      .rating;
  }

  private async upsertMediaRating(
    userId: string,
    mediaId: string,
    value: number,
    type: 'SHOW' | 'MOVIE',
  ) {
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    await this.voteWrite(userId, type, mediaId, 'star_rating', String(value), true, (tx) =>
      applyLocalVote(tx, userId, { mediaId }, 'star_rating', String(value), true),
    );
  }
}
