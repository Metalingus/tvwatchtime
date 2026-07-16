import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../media-metadata/providers/tvdb.provider';
import { mapEpisode } from '../common/utils/mapper.util';
import { localized } from '../common/utils/localization.util';

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
        const fullId = await this.meta.ensureShowFull(Number(id));
        await this.meta.ensureAirtimes(fullId).catch(() => undefined);
        return this.meta.getShowDetail(fullId, userId);
      }
    } else {
      const lang = currentLanguage();
      // Re-hydrate when metadata is stale OR the request locale's title override
      // is missing (so already-hydrated shows still get localized on first view).
      const localeMissing = lang !== 'en' && !((media.titles as any)?.[lang]);
      const needsHydration =
        !media.metadataRefreshedAt ||
        Date.now() - media.metadataRefreshedAt.getTime() > 1000 * 60 * 60 * 24 ||
        localeMissing;
      const tmdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
      const tvdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB);
      if (needsHydration) {
        if (this.tmdb.enabled && tmdbExt) {
          await this.meta.ensureShowFull(Number(tmdbExt.value));
        } else if (this.tvdb?.enabled && tvdbExt) {
          // TVDB-only hydration: degrade gracefully on rate-limit/outage (don't 500 the page).
          await this.meta.ensureShowFullTvdb(Number(tvdbExt.value)).catch(() => undefined);
        }
      }
      await this.meta.ensureAirtimes(id).catch(() => undefined);
      // Classify on every detail view (cheap + deduped per hydration version).
      await this.meta.scheduleClassification(id).catch(() => undefined);
      return this.meta.getShowDetail(id, userId);
    }
    return this.meta.getShowDetail(id, userId);
  }

  async getSeasons(id: string, userId?: string) {
    const seasons = await this.meta.getShowSeasons(id, userId);
    const result = seasons.map((s) => ({
      id: s.id,
      number: s.number,
      title: localized(s as any, 'titles', 'title') ?? s.title,
      posterUrl: localized(s as any, 'posterUrls', 'posterUrl') ?? s.posterUrl ?? null,
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
    // Populate locale overrides for the show + this episode (title/overview/still),
    // then read fresh localized JSON so the episode detail shows in the request language.
    await this.meta.ensureListLocaleOverrides([media.id]);
    await this.meta.ensureEpisodeLocaleOverrides([episodeId]);
    const [freshEp, freshMedia] = await Promise.all([
      this.prisma.episode.findUnique({
        where: { id: episodeId },
        select: { titles: true, overviews: true, stillUrls: true },
      }),
      this.prisma.mediaItem.findUnique({
        where: { id: media.id },
        select: { titles: true, posterUrls: true, backdropUrls: true },
      }),
    ]);
    const epLocalized = freshEp
      ? ({ ...episode, titles: freshEp.titles, overviews: freshEp.overviews, stillUrls: freshEp.stillUrls } as any)
      : (episode as any);
    const mediaLoc = (freshMedia ?? {}) as any;
    const userStatus = userId
      ? await this.prisma.userEpisodeStatus.findUnique({
          where: { userId_episodeId: { userId, episodeId } },
        })
      : null;
    const commentsCount = await this.prisma.comment.count({ where: { threadType: 'EPISODE', threadId: episodeId } });

    // Aggregate favorite-character votes keyed by the stable MediaCast credit id.
    const voteGroups = await this.prisma.characterVote.groupBy({
      by: ['castId'],
      where: { episodeId },
      _count: { _all: true },
    });
    const voteMap = new Map<string, number>();
    let charTotal = 0;
    for (const g of voteGroups) {
      voteMap.set(g.castId, g._count._all);
      charTotal += g._count._all;
    }

    const cast = (media.cast ?? [])
      .map((c: any) => ({
        id: c.castMember.id,
        // Stable per-show credit identifier (MediaCast id) used for favorite voting.
        creditId: c.id,
        name: c.castMember.name,
        character: localized(c, 'characters', 'character') ?? c.character ?? null,
        profileUrl: c.castMember.profileUrl ?? null,
        order: c.sortOrder,
        votes: voteMap.get(c.id) ?? 0,
      }))
      .sort((a: any, b: any) => b.votes - a.votes || a.order - b.order);

    const charVote = userId
      ? await this.prisma.characterVote.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : null;

    const [deviceSection, ratingSection, reactionSection] = await Promise.all([
      this.getDeviceSection(episodeId, userId),
      this.getRatingSection(episodeId, userId),
      this.getReactionSection(episodeId, userId),
    ]);

    const characterSection = cast.length
      ? {
          userVote: charVote?.castId ?? null,
          total: charTotal,
          options: voteGroups.map((g) => ({ castId: g.castId, count: g._count._all })),
        }
      : null;

    return {
      ...mapEpisode(epLocalized, userStatus as any),
      showId: media.id,
      showTitle: localized(mediaLoc, 'titles', 'title') ?? media.title,
      showImages: {
        poster: localized(mediaLoc, 'posterUrls', 'posterUrl') ?? media.posterUrl,
        backdrop: localized(mediaLoc, 'backdropUrls', 'backdropUrl') ?? media.backdropUrl,
      },
      providers: media.providers.map((p: any) => ({ id: p.provider.id, name: p.provider.name, logoUrl: p.provider.logoUrl })),
      cast,
      interactions: {
        device: deviceSection,
        rating: ratingSection,
        reaction: reactionSection,
        character: characterSection,
      },
      commentsCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Voting sections (read): raw counts + total only; percentages are derived
  // client-side via largest-remainder so every section sums to exactly 100%.
  // ---------------------------------------------------------------------------

  private readonly DEVICE_OPTIONS = ['PHONE', 'TABLET', 'COMPUTER', 'TV'] as const;
  private readonly RATING_OPTIONS = ['1', '2', '3', '4', '5'] as const;
  private readonly REACTION_OPTIONS = [
    'SHOCKED', 'FRUSTRATED', 'SAD', 'REFLECTIVE', 'TOUCHED', 'AMUSED',
    'SCARED', 'BORED', 'UNDERSTANDING', 'THRILLED', 'CONFUSED', 'TENSE',
  ] as const;

  private buildSection(
    values: readonly string[],
    counts: Map<string, number>,
    userVote: string | null,
  ) {
    const options = values.map((v) => ({ value: v, count: counts.get(v) ?? 0 }));
    const total = options.reduce((acc, o) => acc + o.count, 0);
    // Clamp userVote to the displayed set (e.g. legacy OTHER device is hidden).
    const safeUserVote = userVote && (values as readonly string[]).includes(userVote) ? userVote : null;
    return { userVote: safeUserVote, total, options };
  }

  private async getDeviceSection(episodeId: string, userId?: string) {
    const status = userId
      ? await this.prisma.userEpisodeStatus.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : null;
    const groups = await this.prisma.userEpisodeStatus.groupBy({
      by: ['device'],
      where: { episodeId, device: { not: null } },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g.device as string, g._count._all);
    return this.buildSection(this.DEVICE_OPTIONS, counts, status?.device ?? null);
  }

  private async getReactionSection(episodeId: string, userId?: string) {
    // Multi-select: one Reaction row per (user, episode, reaction). A user may hold
    // several reactions; `total` = distinct users who picked at least one.
    const userRows = userId
      ? await this.prisma.reaction.findMany({
          where: { userId, episodeId },
          select: { reaction: true },
        })
      : [];
    const userVotes = userRows.map((r) => r.reaction as string);

    const [distinctUsers, groups] = await Promise.all([
      this.prisma.reaction.groupBy({ by: ['userId'], where: { episodeId }, _count: { _all: true } }),
      this.prisma.reaction.groupBy({ by: ['reaction'], where: { episodeId }, _count: { _all: true } }),
    ]);
    const total = distinctUsers.length;
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g.reaction as string, g._count._all);
    return {
      userVotes,
      total,
      options: (this.REACTION_OPTIONS as readonly string[]).map((v) => ({ value: v, count: counts.get(v) ?? 0 })),
    };
  }

  private async getRatingSection(episodeId: string, userId?: string) {
    const userRating = userId
      ? await this.prisma.rating.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : null;
    const groups = await this.prisma.rating.groupBy({
      by: ['rating'],
      where: { episodeId },
      _count: { _all: true },
    });
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(String(g.rating), g._count._all);
    return this.buildSection(this.RATING_OPTIONS, counts, userRating ? String(userRating.rating) : null);
  }

  private async getCharacterSection(episodeId: string, userId?: string) {
    const charVote = userId
      ? await this.prisma.characterVote.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : null;
    const groups = await this.prisma.characterVote.groupBy({
      by: ['castId'],
      where: { episodeId },
      _count: { _all: true },
    });
    const options = groups.map((g) => ({ castId: g.castId, count: g._count._all }));
    const total = options.reduce((acc, o) => acc + o.count, 0);
    return { userVote: charVote?.castId ?? null, total, options };
  }

  // ---------------------------------------------------------------------------
  // Voting writes: upsert a single active vote per user+episode+category, then
  // return the freshly recomputed section so the client can reconcile.
  // ---------------------------------------------------------------------------

  private async requireWatched(userId: string, episodeId: string) {
    const status = await this.prisma.userEpisodeStatus.findUnique({
      where: { userId_episodeId: { userId, episodeId } },
    });
    if (!status) throw new NotFoundException('Episode not tracked — mark as watched first');
    return status;
  }

  async voteDevice(userId: string, episodeId: string, value: string) {
    await this.requireWatched(userId, episodeId);
    if (!(this.DEVICE_OPTIONS as readonly string[]).includes(value)) {
      throw new BadRequestException('Invalid device');
    }
    await this.prisma.userEpisodeStatus.update({
      where: { userId_episodeId: { userId, episodeId } },
      data: { device: value as any },
    });
    return this.getDeviceSection(episodeId, userId);
  }

  async voteRating(userId: string, episodeId: string, value: number) {
    await this.requireWatched(userId, episodeId);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    // Episode ratings key on episodeId and leave mediaId null, so the
    // @@unique([userId, mediaId]) constraint (intended for show/movie-level ratings)
    // can't collide with another episode of the same show or a show-level rating.
    await this.prisma.rating.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId, rating: value },
      update: { rating: value },
    });
    return this.getRatingSection(episodeId, userId);
  }

  async voteReaction(userId: string, episodeId: string, value: string) {
    await this.requireWatched(userId, episodeId);
    if (!(this.REACTION_OPTIONS as readonly string[]).includes(value)) {
      throw new BadRequestException('Invalid reaction');
    }
    // Multi-select toggle: create the reaction if absent, otherwise remove it.
    // The unique (userId, episodeId, reaction) constraint keeps this idempotent.
    const existing = await this.prisma.reaction.findUnique({
      where: { userId_episodeId_reaction: { userId, episodeId, reaction: value as any } },
    });
    if (existing) {
      await this.prisma.reaction.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.reaction.create({ data: { userId, episodeId, reaction: value as any } });
    }
    return this.getReactionSection(episodeId, userId);
  }

  async voteFavoriteCharacter(userId: string, episodeId: string, castId: string | null) {
    await this.requireWatched(userId, episodeId);
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      select: { season: { select: { show: { select: { mediaId: true } } } } },
    });
    const mediaId = episode?.season?.show?.mediaId;
    if (!mediaId) throw new NotFoundException('Could not resolve show for episode');
    if (castId !== null) {
      const eligible = await this.prisma.mediaCast.findFirst({ where: { id: castId, mediaId }, select: { id: true } });
      if (!eligible) throw new BadRequestException('Character is not part of this show');
      await this.prisma.characterVote.upsert({
        where: { userId_episodeId: { userId, episodeId } },
        create: { userId, episodeId, castId },
        update: { castId },
      });
    } else {
      await this.prisma.characterVote.deleteMany({ where: { userId, episodeId } });
    }
    return this.getCharacterSection(episodeId, userId);
  }
}
