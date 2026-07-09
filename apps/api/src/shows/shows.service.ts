import { Injectable } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../media-metadata/providers/tvdb.provider';
import { mapEpisode } from '../common/utils/mapper.util';

@Injectable()
export class ShowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  async getShow(id: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({ where: { id }, include: { externalIds: true } });
    if (!media) {
      // allow fetching by tmdb numeric id when live metadata available
      if (this.tmdb.enabled && /^\d+$/.test(id)) {
        const fullId = await this.meta.ensureShowFull(Number(id), userId);
        await this.meta.ensureAirtimes(fullId).catch(() => undefined);
        return this.meta.getShowDetail(fullId, userId);
      }
    } else {
      const needsHydration = !media.metadataRefreshedAt || Date.now() - media.metadataRefreshedAt.getTime() > 1000 * 60 * 60 * 24;
      const tmdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
      const tvdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB);
      if (needsHydration) {
        if (this.tmdb.enabled && tmdbExt) {
          await this.meta.ensureShowFull(Number(tmdbExt.value), userId);
        } else if (this.tvdb?.enabled && tvdbExt) {
          await this.meta.ensureShowFullTvdb(Number(tvdbExt.value), userId);
        }
      }
      await this.meta.ensureAirtimes(id).catch(() => undefined);
      return this.meta.getShowDetail(id, userId);
    }
    return this.meta.getShowDetail(id, userId);
  }

  async getSeasons(id: string, userId?: string) {
    const seasons = await this.meta.getShowSeasons(id, userId);
    const result = seasons.map((s) => ({
      id: s.id,
      number: s.number,
      title: s.title,
      posterUrl: s.posterUrl,
      episodeCount: s.episodeCount,
      episodes: s.episodes.map((e) => {
        const us = userId
          ? (e as any).userStatuses?.[0]
          : undefined;
        return mapEpisode(e, us);
      }),
    }));
    return result;
  }

  async getEpisodeDetail(episodeId: string, userId?: string) {
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      include: {
        season: {
          include: {
            show: {
              include: {
                media: {
                  include: {
                    providers: { include: { provider: true } },
                    genres: { include: { genre: true } },
                    cast: {
                      include: { castMember: true },
                      orderBy: { sortOrder: 'asc' },
                      take: 15,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!episode) return null;
    const media = episode.season.show.media;
    const userStatus = userId
      ? await this.prisma.userEpisodeStatus.findUnique({
          where: { userId_episodeId: { userId, episodeId } },
        })
      : null;
    const userRating = userId
      ? await this.prisma.rating.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : null;
    const userReaction = userId
      ? await this.prisma.reaction.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : null;
    const charVote = userId
      ? await this.prisma.characterVote.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : null;
    const commentsCount = await this.prisma.comment.count({ where: { threadType: 'EPISODE', threadId: episodeId } });

    // Aggregate favorite-character votes for this episode -> attach % to cast, sort by votes.
    const voteGroups = await this.prisma.characterVote.groupBy({
      by: ['characterName'],
      where: { episodeId },
      _count: { _all: true },
    });
    const norm = (s: string) => s.trim().toLowerCase();
    const voteMap = new Map<string, number>();
    let totalVotes = 0;
    for (const g of voteGroups) {
      const n = g.characterName ? norm(g.characterName) : '';
      const c = g._count._all;
      voteMap.set(n, (voteMap.get(n) ?? 0) + c);
      totalVotes += c;
    }

    const cast = (media.cast ?? [])
      .map((c: any) => {
        const key = c.character ? norm(c.character) : '';
        const votes = voteMap.get(key) ?? 0;
        return {
          id: c.castMember.id,
          name: c.castMember.name,
          character: c.character ?? null,
          profileUrl: c.castMember.profileUrl ?? null,
          order: c.sortOrder,
          votes,
          votePct: totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0,
        };
      })
      .sort((a: any, b: any) => b.votes - a.votes || a.order - b.order);

    return {
      ...mapEpisode(episode, userStatus as any),
      showId: media.id,
      showTitle: media.title,
      showImages: { poster: media.posterUrl, backdrop: media.backdropUrl },
      providers: media.providers.map((p: any) => ({ id: p.provider.id, name: p.provider.name, logoUrl: p.provider.logoUrl })),
      cast,
      userRating: userRating?.rating ?? null,
      userDevice: userStatus?.device ?? null,
      userReaction: userReaction?.reaction ?? null,
      favoriteCharacterId: charVote?.characterName ?? null,
      commentsCount,
    };
  }

  async voteFavoriteCharacter(userId: string, episodeId: string, characterName: string) {
    await this.prisma.characterVote.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId, characterName },
      update: { characterName },
    });
    return { ok: true };
  }
}
