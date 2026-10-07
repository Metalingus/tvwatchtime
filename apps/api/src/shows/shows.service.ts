import { canonicalCopyId } from '../media-metadata/util/canonical-media';
import { applyLocalVote } from '../common/local-vote-mutation';
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../media-metadata/providers/tvdb.provider';
import { mapEpisode, watchProvidersOf } from '../common/utils/mapper.util';
import { localized } from '../common/utils/localization.util';
import { MediaVotesService } from '../common/media-votes.service';
import { CommsUniVotingService } from '../commsuni/commsuni.voting.service';
import { CommsUniPublicationService } from '../commsuni/commsuni.publication.service';
import type { Prisma } from '@prisma/client';
import type { CommsUniEngagementKind } from '@tvwatch/shared';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { CharacterArtworkService } from '../media-metadata/character-artwork.service';
import { ArtworkGalleryService } from '../media-metadata/artwork-gallery.service';
import {
  averageEpisodeUserRating,
  resolveEpisodeRating,
} from '../common/utils/episode-rating.util';

@Injectable()
export class ShowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly mediaVotes?: MediaVotesService,
    private readonly canonical?: MediaCanonicalizationService,
    @Optional() private readonly characterArtwork?: CharacterArtworkService,
    @Optional() private readonly artworkGallery?: ArtworkGalleryService,
    @Optional() private readonly publication?: CommsUniPublicationService,
    @Optional() private readonly community?: CommsUniVotingService,
  ) {}

  private voteWrite<T>(
    userId: string,
    episodeId: string,
    kind: CommsUniEngagementKind,
    value: string | null,
    selected: boolean,
    change: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.publication
      ? this.publication.voteTransaction(
          userId,
          'EPISODE',
          episodeId,
          kind,
          value,
          selected,
          change,
        )
      : this.prisma.$transaction(change);
  }

  private async canonicalMediaId(mediaId: string) {
    return this.canonical ? this.canonical.resolveMediaId(mediaId, 'SHOW') : mediaId;
  }

  private async canonicalEpisodeId(episodeId: string) {
    return this.canonical ? this.canonical.resolveEpisodeId(episodeId) : episodeId;
  }

  private async withShowInteractions(detail: any, userId?: string) {
    if (!detail || typeof detail !== 'object') return detail;
    const [interactions, commentCount] = await Promise.all([
      this.mediaVotes
        ? this.mediaVotes.getShowInteractions(detail.id, userId, false)
        : detail.interactions,
      this.prisma.comment.count({
        where: {
          threadType: 'SHOW',
          threadId: detail.id,
          parentId: null,
          commsUniParentId: null,
          externalReviewId: null,
          hidden: false,
          adminDeleted: false,
          deletedByUser: false,
        },
      }),
    ]);
    return {
      ...detail,
      interactions,
      communityDetailsDeferred: true,
      commentsCount: commentCount,
      commentsCountApproximate: false,
    };
  }

  async getShowInteractions(id: string, userId?: string) {
    id = await this.canonicalMediaId(id);
    return this.mediaVotes?.getShowInteractions(id, userId);
  }

  async getShow(id: string, userId?: string) {
    if (!/^\d+$/.test(id)) id = await this.canonicalMediaId(id);
    const media = await this.prisma.mediaItem.findUnique({
      where: { id },
      include: { externalIds: true, show: true },
    });
    if (!media) {
      // allow fetching by tmdb numeric id when live metadata available
      if (this.tmdb.enabled && /^\d+$/.test(id)) {
        const hydratedId = await this.meta.ensureShowFull(Number(id), undefined, {
          skipAiredSeasons: true,
        });
        const fullId = await this.canonicalMediaId(hydratedId);

        return this.withShowInteractions(await this.meta.getShowDetail(fullId, userId), userId);
      }
    } else {
      const lang = currentLanguage();
      // Re-hydrate when metadata is stale OR the request locale's title override
      // is missing (so already-hydrated shows still get localized on first view) —
      // locales the provider provably lacks are parked for 7 days instead of re-fetching
      // the same English fallback on EVERY open.
      const localeMissing =
        lang !== 'en' &&
        !(media.titles as any)?.[lang] &&
        !this.meta.isLocaleFetchParked(media.metadataProvenance, lang);
      const needsHydration =
        !media.metadataRefreshedAt ||
        Date.now() - media.metadataRefreshedAt.getTime() > 1000 * 60 * 60 * 24 ||
        localeMissing;
      const metadataStale =
        !!media.metadataRefreshedAt &&
        Date.now() - media.metadataRefreshedAt.getTime() > 1000 * 60 * 60 * 24;
      const tmdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
      const tvdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB);
      // Refresh from the persisted structural owner. The legacy JSON value is read only
      // during the additive rollout; discovery signals never switch providers here.
      const legacyOwner = String(
        (media.metadataProvenance as Record<string, unknown> | null)?.structureProvider ?? '',
      ).toUpperCase();
      const isTvdbOwned =
        media.show?.structureProvider === 'TVDB' ||
        (!media.show?.structureProvider && legacyOwner === 'TVDB') ||
        (!tmdbExt && !!tvdbExt);
      const refresh = async () => {
        if (needsHydration) {
          if (isTvdbOwned && this.tvdb?.enabled && tvdbExt) {
            // Degrade gracefully on hydration failure (don't 500 the detail page).
            const refreshedId = await this.meta
              .ensureShowFullTvdb(Number(tvdbExt.value))
              .catch(() => null);
            if (refreshedId && metadataStale) {
              await this.meta.scheduleStructureEvaluation(refreshedId).catch(() => undefined);
            }
          } else if (!isTvdbOwned && this.tmdb.enabled && tmdbExt) {
            // Degrade gracefully on hydration failure (don't 500 the detail page).
            await this.meta
              .ensureShowFull(Number(tmdbExt.value), undefined, { skipAiredSeasons: true })
              .catch(() => undefined);
          } else if (this.tvdb?.enabled && tvdbExt) {
            // TVDB-only hydration: degrade gracefully on rate-limit/outage (don't 500 the page).
            await this.meta.ensureShowFullTvdb(Number(tvdbExt.value)).catch(() => undefined);
          }
        }

        // Classify on every detail view (cheap + deduped per hydration version).
        await this.meta.scheduleClassification(id).catch(() => undefined);
      };
      let metadataPending = false;
      if (!media.metadataRefreshedAt) {
        // Never hydrated: block the first view or the page renders empty.
        await refresh();
      } else {
        // Stale-while-revalidate: answer from last-known data immediately and
        // refresh in the background — awaiting rate-limited TMDb/TVDB hydration
        // here added seconds to every show open. Structural reconciliation is
        // deliberately excluded from read paths: it runs only through the explicit
        // admin repair or the separately enabled scheduled job.
        if (needsHydration) {
          if (this.meta.startShowMetadataRefresh) {
            metadataPending = await this.meta.startShowMetadataRefresh(id, refresh);
          } else {
            void refresh().catch(() => undefined);
            metadataPending = true;
          }
        }
      }
      if (!needsHydration) await this.meta.scheduleClassification(id).catch(() => undefined);
      if (!metadataPending)
        metadataPending = (await this.meta.scheduleIncompleteEpisodeRefresh?.([], id)) ?? false;
      const detail = await this.meta.getShowDetail(id, userId);
      return this.withShowInteractions({ ...detail, metadataPending }, userId);
    }
    return this.withShowInteractions(await this.meta.getShowDetail(id, userId), userId);
  }

  async refreshShow(id: string, userId?: string) {
    if (/^\d+$/.test(id)) {
      const detail = await this.getShow(id, userId);
      id = detail.id;
    } else {
      id = await this.canonicalMediaId(id);
    }
    const media = await this.prisma.mediaItem.findUnique({
      where: { id },
      select: { id: true, type: true },
    });
    if (!media || media.type !== 'SHOW') throw new NotFoundException('Show not found');
    return {
      mediaId: id,
      ...(await this.meta.refreshRecentIncompleteEpisodes(id)),
    };
  }

  async voteShowRating(userId: string, mediaId: string, value: number) {
    return this.mediaVotes!.voteShowRating(userId, await this.canonicalMediaId(mediaId), value);
  }

  async getSeasons(id: string, userId?: string) {
    if (!/^\d+$/.test(id)) id = await this.canonicalMediaId(id);
    // Numeric TMDB ids (e.g. tapped from the Similar rail): hydrate + resolve to the
    // internal id first — the detail endpoint does the same in getShow.
    const media = await this.prisma.mediaItem.findUnique({ where: { id }, select: { id: true } });
    if (!media && this.tmdb.enabled && /^\d+$/.test(id)) {
      id = await this.meta.ensureShowFull(Number(id));
      id = await this.canonicalMediaId(id);
    }
    const seasons = await this.meta.getShowSeasons(id, userId);
    const result = seasons.map((s) => ({
      id: s.id,
      number: s.number,
      isSpecial: s.isSpecial,
      title: localized(s as any, 'titles', 'title') ?? s.title,
      posterUrl: localized(s as any, 'posterUrls', 'posterUrl') ?? s.posterUrl ?? null,
      episodeCount: s.episodeCount,
      episodes: s.episodes.map((e) => {
        const us = userId ? (e as any).userStatuses?.[0] : undefined;
        return mapEpisode(e, us);
      }),
    }));
    return result;
  }

  /**
   * Ordered ids of the episodes in the same season — powers the episode pager without
   * downloading the show's entire season/episode structure (hundreds of KB for
   * long-running shows) just to compute sibling ids.
   */
  async getEpisodeSiblings(episodeId: string) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      select: { seasonId: true },
    });
    if (!episode) throw new NotFoundException('Episode not found');
    const siblings = await this.prisma.episode.findMany({
      where: { seasonId: episode.seasonId, structureState: 'ACTIVE' },
      select: { id: true },
      orderBy: { number: 'asc' },
    });
    return { seasonId: episode.seasonId, episodeIds: siblings.map((s) => s.id) };
  }

  async getEpisodeInteractions(episodeId: string, userId?: string) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      select: { season: { select: { show: { select: { mediaId: true } } } } },
    });
    if (!episode) throw new NotFoundException('Episode not found');
    const [device, rating, reaction, character, cast] = await Promise.all([
      this.getDeviceSection(episodeId, userId),
      this.getRatingSection(episodeId, userId),
      this.getReactionSection(episodeId, userId),
      this.getCharacterSection(episodeId, userId),
      this.prisma.mediaCast.findFirst({
        where: { mediaId: episode.season.show.mediaId },
        select: { id: true },
      }),
    ]);
    const local = { device, rating, reaction, character: cast ? character : null };
    return this.community
      ? this.community.merge(userId, 'EPISODE', episodeId, local, { cached: true })
      : local;
  }

  async getEpisodeDetail(episodeId: string, userId?: string) {
    episodeId = await this.canonicalEpisodeId(episodeId);
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
                    externalIds: true,
                    cast: {
                      include: { castMember: true },
                      orderBy: { sortOrder: 'asc' },
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
    const metadataPending =
      (await this.meta.scheduleIncompleteEpisodeRefresh?.([episodeId])) ?? false;
    const artworkStateP = this.characterArtwork
      ? this.characterArtwork.scheduleIfNeeded(media as any)
      : Promise.resolve({ pending: false });
    // Kick off the locale-independent lookups immediately (they don't touch the
    // locale-override tables), overlap them with the locale ensures, then re-read
    // the fresh localized JSON — two waves instead of six sequential ones.
    const userStatusP = userId
      ? this.prisma.userEpisodeStatus.findUnique({
          where: { userId_episodeId: { userId, episodeId } },
        })
      : Promise.resolve(null);
    const commentsCountP = this.prisma.comment.count({
      where: {
        threadType: 'EPISODE',
        threadId: episodeId,
        parentId: null,
        commsUniParentId: null,
        externalReviewId: null,
        hidden: false,
        adminDeleted: false,
        deletedByUser: false,
      },
    });
    const voteGroupsP = this.prisma.characterVote.groupBy({
      by: ['castId'],
      where: { episodeId },
      _count: { _all: true },
    });
    const charVoteP = userId
      ? this.prisma.characterVote.findUnique({ where: { userId_episodeId: { userId, episodeId } } })
      : Promise.resolve(null);

    // Populate locale overrides for the show + this episode (title/overview/still),
    // then read fresh localized JSON so the episode detail shows in the request language.
    await Promise.all([
      this.meta.ensureListLocaleOverrides([media.id]),
      this.meta.ensureEpisodeLocaleOverrides([episodeId]),
    ]);
    const [freshEp, freshMedia, userStatus, commentsCount, voteGroups, charVote] =
      await Promise.all([
        this.prisma.episode.findUnique({
          where: { id: episodeId },
          select: {
            title: true,
            overview: true,
            stillUrl: true,
            runtimeMinutes: true,
            airDate: true,
            airTime: true,
            titles: true,
            overviews: true,
            stillUrls: true,
          },
        }),
        this.prisma.mediaItem.findUnique({
          where: { id: media.id },
          select: { titles: true, posterUrls: true, backdropUrls: true },
        }),
        userStatusP,
        commentsCountP,
        voteGroupsP,
        charVoteP,
      ]);
    // Locale persistence may update the episode row. Fingerprint/schedule the gallery
    // only after that write so the first queued job cannot become stale immediately.
    const [artworkState, galleryState] = await Promise.all([
      artworkStateP,
      this.artworkGallery
        ? this.artworkGallery.getEpisodeGallery(episodeId)
        : Promise.resolve({ gallery: [], pending: false }),
    ]);
    const epLocalized = freshEp
      ? ({
          ...episode,
          ...freshEp,
          titles: freshEp.titles,
          overviews: freshEp.overviews,
          stillUrls: freshEp.stillUrls,
        } as any)
      : (episode as any);
    const mediaLoc = (freshMedia ?? {}) as any;
    const watchProviders = watchProvidersOf(media);

    // Aggregate favorite-character votes keyed by the stable MediaCast credit id.
    const voteMap = new Map<string, number>();
    let charTotal = 0;
    for (const g of voteGroups) {
      voteMap.set(g.castId, g._count._all);
      charTotal += g._count._all;
    }

    // Every persisted credit is votable. Provider hydration remains bounded upstream,
    // but imported/supplemental credits must not disappear merely because they bill lower.
    const baseCastRows = media.cast ?? [];
    const baseCastIds = new Set(baseCastRows.map((c: any) => c.id));
    const votedCastIds = voteGroups.map((g) => g.castId).filter((id) => !baseCastIds.has(id));
    const votedCastRows = votedCastIds.length
      ? await this.prisma.mediaCast.findMany({
          where: { id: { in: votedCastIds }, mediaId: media.id },
          include: { castMember: true },
        })
      : [];

    const cast = [...baseCastRows, ...votedCastRows]
      .map((c: any) => ({
        id: c.castMember.id,
        // Stable per-show credit identifier (MediaCast id) used for favorite voting.
        creditId: c.id,
        name: c.castMember.name,
        character: localized(c, 'characters', 'character') ?? c.character ?? null,
        characterImageUrl: c.characterImageUrl ?? null,
        profileUrl: c.castMember.profileUrl ?? null,
        order: c.sortOrder,
        votes: voteMap.get(c.id) ?? 0,
      }))
      .sort((a: any, b: any) => b.votes - a.votes || a.order - b.order);

    const [deviceSection, ratingSection, reactionSection] = await Promise.all([
      this.getDeviceSection(episodeId, userId, userStatus),
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
    const interactions = {
      device: deviceSection,
      rating: ratingSection,
      reaction: reactionSection,
      character: characterSection,
    };
    const mappedEpisode = mapEpisode(epLocalized, userStatus as any);
    const effectiveRating = resolveEpisodeRating(
      mappedEpisode.rating,
      averageEpisodeUserRating(ratingSection.options),
    );

    return {
      ...mappedEpisode,
      metadataPending,
      rating: effectiveRating?.ratingTen ?? null,
      showId: media.id,
      showTitle: localized(mediaLoc, 'titles', 'title') ?? media.title,
      showImages: {
        poster: localized(mediaLoc, 'posterUrls', 'posterUrl') ?? media.posterUrl,
        backdrop: localized(mediaLoc, 'backdropUrls', 'backdropUrl') ?? media.backdropUrl,
      },
      network: episode.season.show.network ?? null,
      providers: watchProviders?.stream ?? [],
      watchProviders,
      cast,
      interactions,
      communityDetailsDeferred: true,
      commentsCount,
      commentsCountApproximate: false,
      characterArtworkPending: artworkState.pending,
      gallery: galleryState.gallery,
      galleryPending: galleryState.pending,
    };
  }

  // ---------------------------------------------------------------------------
  // Voting sections (read): raw counts + total only; percentages are derived
  // client-side via largest-remainder so every section sums to exactly 100%.
  // ---------------------------------------------------------------------------

  private readonly DEVICE_OPTIONS = ['PHONE', 'TABLET', 'COMPUTER', 'TV'] as const;
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

  private buildSection(
    values: readonly string[],
    counts: Map<string, number>,
    userVote: string | null,
  ) {
    const options = values.map((v) => ({ value: v, count: counts.get(v) ?? 0 }));
    const total = options.reduce((acc, o) => acc + o.count, 0);
    // Clamp userVote to the displayed set (e.g. legacy OTHER device is hidden).
    const safeUserVote =
      userVote && (values as readonly string[]).includes(userVote) ? userVote : null;
    return { userVote: safeUserVote, total, options };
  }

  private async getDeviceSection(episodeId: string, userId?: string, preloadedStatus?: any) {
    // preloadedStatus avoids re-fetching the same userEpisodeStatus row when the
    // caller (episode detail) already loaded it. Explicit undefined check: a
    // preloaded null IS the answer (user has no status row), not a cache miss.
    const status = userId
      ? preloadedStatus !== undefined
        ? preloadedStatus
        : await this.prisma.userEpisodeStatus.findUnique({
            where: { userId_episodeId: { userId, episodeId } },
          })
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
      this.prisma.reaction.groupBy({
        by: ['userId'],
        where: { episodeId },
        _count: { _all: true },
      }),
      this.prisma.reaction.groupBy({
        by: ['reaction'],
        where: { episodeId },
        _count: { _all: true },
      }),
    ]);
    const total = distinctUsers.length;
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g.reaction as string, g._count._all);
    return {
      userVotes,
      total,
      options: (this.REACTION_OPTIONS as readonly string[]).map((v) => ({
        value: v,
        count: counts.get(v) ?? 0,
      })),
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
    return this.buildSection(
      this.RATING_OPTIONS,
      counts,
      userRating ? String(userRating.rating) : null,
    );
  }

  private async getCharacterSection(episodeId: string, userId?: string) {
    const charVote = userId
      ? await this.prisma.characterVote.findUnique({
          where: { userId_episodeId: { userId, episodeId } },
        })
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
    episodeId = await this.canonicalEpisodeId(episodeId);
    await this.requireWatched(userId, episodeId);
    if (!(this.DEVICE_OPTIONS as readonly string[]).includes(value)) {
      throw new BadRequestException('Invalid device');
    }
    await this.voteWrite(userId, episodeId, 'watch_device', value, true, (tx) =>
      applyLocalVote(tx, userId, { episodeId }, 'watch_device', value, true),
    );
    const local = { device: await this.getDeviceSection(episodeId, userId) };
    return (
      this.community ? await this.community.merge(userId, 'EPISODE', episodeId, local) : local
    ).device;
  }

  async voteRating(userId: string, episodeId: string, value: number) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    await this.requireWatched(userId, episodeId);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new BadRequestException('Rating must be an integer between 1 and 5');
    }
    // Episode ratings key on episodeId and leave mediaId null, so the
    // @@unique([userId, mediaId]) constraint (intended for show/movie-level ratings)
    // can't collide with another episode of the same show or a show-level rating.
    await this.voteWrite(userId, episodeId, 'star_rating', String(value), true, (tx) =>
      applyLocalVote(tx, userId, { episodeId }, 'star_rating', String(value), true),
    );
    const local = { rating: await this.getRatingSection(episodeId, userId) };
    return (
      this.community ? await this.community.merge(userId, 'EPISODE', episodeId, local) : local
    ).rating;
  }

  async voteReaction(userId: string, episodeId: string, value: string) {
    episodeId = await this.canonicalEpisodeId(episodeId);
    await this.requireWatched(userId, episodeId);
    if (!(this.REACTION_OPTIONS as readonly string[]).includes(value)) {
      throw new BadRequestException('Invalid reaction');
    }
    // Multi-select toggle: create the reaction if absent, otherwise remove it.
    // The unique (userId, episodeId, reaction) constraint keeps this idempotent.
    const existing = await this.prisma.reaction.findUnique({
      where: { userId_episodeId_reaction: { userId, episodeId, reaction: value as any } },
    });
    await this.voteWrite(userId, episodeId, 'emotion', value, !existing, (tx) =>
      applyLocalVote(tx, userId, { episodeId }, 'emotion', value, !existing),
    );
    const local = { reaction: await this.getReactionSection(episodeId, userId) };
    return (
      this.community ? await this.community.merge(userId, 'EPISODE', episodeId, local) : local
    ).reaction;
  }

  async voteFavoriteCharacter(userId: string, episodeId: string, castId: string | null) {
    if (castId) castId = await canonicalCopyId(this.prisma, 'CAST', castId);
    episodeId = await this.canonicalEpisodeId(episodeId);
    await this.requireWatched(userId, episodeId);
    const episode = await this.prisma.episode.findUnique({
      where: { id: episodeId },
      select: { season: { select: { show: { select: { mediaId: true } } } } },
    });
    const mediaId = episode?.season?.show?.mediaId;
    if (!mediaId) throw new NotFoundException('Could not resolve show for episode');
    if (castId !== null) {
      const eligible = await this.prisma.mediaCast.findFirst({
        where: { id: castId, mediaId },
        select: { id: true },
      });
      if (!eligible) throw new BadRequestException('Character is not part of this show');
      await this.voteWrite(userId, episodeId, 'cast_vote', castId, true, (tx) =>
        applyLocalVote(tx, userId, { episodeId }, 'cast_vote', castId, true),
      );
    } else {
      await this.voteWrite(userId, episodeId, 'cast_vote', null, false, (tx) =>
        applyLocalVote(tx, userId, { episodeId }, 'cast_vote', null, false),
      );
    }
    const local = { character: await this.getCharacterSection(episodeId, userId) };
    return (
      this.community ? await this.community.merge(userId, 'EPISODE', episodeId, local) : local
    ).character;
  }
}
