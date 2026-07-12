import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { mapMovie, mapSeason, mapShow } from '../common/utils/mapper.util';
import {
  NormalizedMovie,
  NormalizedSeason,
  NormalizedShow,
  TmdbProvider,
} from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { TvmazeProvider } from './providers/tvmaze.provider';
import { slugify } from './util/slugify';

@Injectable()
export class MediaMetadataService {
  private readonly logger = new Logger(MediaMetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly tvmaze: TvmazeProvider,
    private readonly config: ConfigService,
  ) {}

  get tmdbEnabled() {
    return this.tmdb.enabled;
  }

  get tvdbEnabled() {
    return this.tvdb?.enabled ?? false;
  }

  // ---- External lookup ----
  async findMediaByExternal(provider: ExternalProvider, value: string) {
    const ext = await this.prisma.externalId.findUnique({
      where: { provider_value: { provider, value } },
      include: { media: true },
    });
    return ext?.media ?? null;
  }

  // ---- Light upsert for list endpoints ----
  async lightUpsertShow(item: {
    tmdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tmdbVal = String(item.tmdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    if (existing) {
      // Backfill a missing year on stubs created before search mapped the year.
      if (item.year) {
        await this.prisma.show
          .updateMany({ where: { mediaId: existing.id, yearStart: null }, data: { yearStart: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }
    const created = await this.prisma.mediaItem.create({
      data: {
        type: MediaType.SHOW,
        title: item.title,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        rating: item.rating ?? undefined,
        popularity: item.popularity ?? 0,
        show: {
          create: { yearStart: item.year ?? null, inProduction: true },
        },
        externalIds: {
          create: [{ provider: ExternalProvider.TMDB, value: tmdbVal }],
        },
      },
    });
    return created.id;
  }

  async lightUpsertMovie(item: {
    tmdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tmdbVal = String(item.tmdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    if (existing) {
      if (item.year) {
        await this.prisma.movie
          .updateMany({ where: { mediaId: existing.id, releaseYear: null }, data: { releaseYear: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }
    const created = await this.prisma.mediaItem.create({
      data: {
        type: MediaType.MOVIE,
        title: item.title,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        rating: item.rating ?? undefined,
        popularity: item.popularity ?? 0,
        movie: { create: { releaseYear: item.year ?? null } },
        externalIds: { create: [{ provider: ExternalProvider.TMDB, value: tmdbVal }] },
      },
    });
    return created.id;
  }

  async lightUpsertShowTvdb(item: {
    tvdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tvdbVal = String(item.tvdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    if (existing) {
      if (item.year) {
        await this.prisma.show
          .updateMany({ where: { mediaId: existing.id, yearStart: null }, data: { yearStart: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }

    const byTitle = await this.prisma.mediaItem.findFirst({
      where: { title: { equals: item.title, mode: 'insensitive' }, type: MediaType.SHOW },
    });
    if (byTitle) {
      await this.prisma.externalId
        .create({ data: { provider: ExternalProvider.THE_TVDB, value: tvdbVal, mediaId: byTitle.id } })
        .catch(() => undefined);
      return byTitle.id;
    }

    const created = await this.prisma.mediaItem.create({
      data: {
        type: MediaType.SHOW,
        title: item.title,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        popularity: item.popularity ?? 0,
        show: { create: { yearStart: item.year ?? null, inProduction: true } },
        externalIds: { create: [{ provider: ExternalProvider.THE_TVDB, value: tvdbVal }] },
      },
    });
    return created.id;
  }

  /** Light-upsert a movie resolved from TVDB (backup provider). */
  async lightUpsertMovieTvdb(item: {
    tvdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tvdbVal = String(item.tvdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    if (existing) {
      if (item.year) {
        await this.prisma.movie
          .updateMany({ where: { mediaId: existing.id, releaseYear: null }, data: { releaseYear: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }

    const byTitle = await this.prisma.mediaItem.findFirst({
      where: { title: { equals: item.title, mode: 'insensitive' }, type: MediaType.MOVIE },
    });
    if (byTitle) {
      await this.prisma.externalId
        .create({ data: { provider: ExternalProvider.THE_TVDB, value: tvdbVal, mediaId: byTitle.id } })
        .catch(() => undefined);
      return byTitle.id;
    }

    const created = await this.prisma.mediaItem.create({
      data: {
        type: MediaType.MOVIE,
        title: item.title,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        popularity: item.popularity ?? 0,
        movie: { create: { releaseYear: item.year ?? null } },
        externalIds: { create: [{ provider: ExternalProvider.THE_TVDB, value: tvdbVal }] },
      },
    });
    return created.id;
  }

  // ---- Full show/movie hydration ----
  async ensureShowFull(tmdbId: number, userId?: string): Promise<string> {
    const data = await this.tmdb.getShow(tmdbId);
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    const mediaId = await this.persistShow(data, existing?.id);
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    // Fill precise air times/dates from TVmaze (best-effort, outside the tx).
    await this.enrichAirtimes(mediaId, data.externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    return mediaId;
  }

  async ensureShowFullTvdb(tvdbId: number, userId?: string): Promise<string> {
    const data = await this.tvdb.getShow(tvdbId);
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    const mediaId = await this.persistShow(data, existing?.id);
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    await this.enrichAirtimes(mediaId, data.externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    return mediaId;
  }

  /** Fully hydrate a movie resolved from TVDB (backup provider). */
  async ensureMovieFullTvdb(tvdbId: number): Promise<string> {
    const data = await this.tvdb.getMovie(tvdbId);
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    return this.persistMovie(data, existing?.id);
  }

  private async enrichAirtimes(mediaId: string, externals: { provider: ExternalProvider; value: string }[]) {
    if (!this.tvmaze.enabled) return;
    const tvdb = externals.find((e) => e.provider === ExternalProvider.THE_TVDB)?.value;
    const imdb = externals.find((e) => e.provider === ExternalProvider.IMDB)?.value;
    const map = await this.tvmaze.getEpisodeAirTimes(tvdb, imdb);
    if (map.size === 0) return;
    const eps = await this.prisma.episode.findMany({
      where: { season: { show: { mediaId } } },
      select: { id: true, number: true, season: { select: { number: true } } },
    });
    for (const e of eps) {
      const air = map.get(`${e.season.number}-${e.number}`);
      if (!air) continue;
      await this.prisma.episode.update({
        where: { id: e.id },
        data: {
          airTime: air.airtime ?? null,
          ...(air.airstamp ? { airDate: new Date(air.airstamp) } : {}),
        },
      });
    }
  }

  /** Populate per-episode air times from TVmaze if any are missing (idempotent / cached). */
  async ensureAirtimes(mediaId: string) {
    if (!this.tvmaze.enabled) return;
    const missing = await this.prisma.episode.count({
      where: { season: { show: { mediaId } }, airTime: null },
    });
    if (missing === 0) return;
    const exts = await this.prisma.externalId.findMany({
      where: { mediaId },
      select: { provider: true, value: true },
    });
    await this.enrichAirtimes(mediaId, exts as any);
  }

  async ensureMovieFull(tmdbId: number): Promise<string> {
    const data = await this.tmdb.getMovie(tmdbId);
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    return this.persistMovie(data, existing?.id);
  }

  private async persistShow(data: NormalizedShow, existingId?: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const genres = await this.upsertGenres(tx, data.genres);
      const providers = await this.upsertProviders(tx, data.providers);
      const castMembers = await this.upsertCast(tx, data.cast);

      const mediaData = {
        title: data.title,
        overview: data.overview,
        posterUrl: data.posterUrl,
        backdropUrl: data.backdropUrl,
        rating: data.rating,
        status: data.status,
        popularity: data.popularity ?? 0,
        trailerUrl: data.trailerUrl,
        metadataRefreshedAt: new Date(),
      };

      let mediaId = existingId;
      if (existingId) {
        await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
      } else {
        const created = await tx.mediaItem.create({
          data: {
            ...mediaData,
            type: MediaType.SHOW,
            externalIds: {
              create: data.externals.map((e) => ({ provider: e.provider, value: e.value })),
            },
          },
        });
        mediaId = created.id;
      }

      // upsert externals (in case new ones appeared)
      for (const e of data.externals) {
        await tx.externalId
          .upsert({
            where: { provider_value: { provider: e.provider, value: e.value } },
            create: { mediaId: mediaId!, provider: e.provider, value: e.value },
            update: {},
          })
          .catch(() => undefined);
      }

      await tx.show.upsert({
        where: { mediaId: mediaId! },
        create: {
          mediaId: mediaId!,
          yearStart: data.yearStart,
          yearEnd: data.yearEnd,
          network: data.network,
          runtimeMinutes: data.runtimeMinutes,
          nextAirDate: data.nextAirDate ? new Date(data.nextAirDate) : null,
          seasonsCount: data.seasonsCount,
          episodesCount: data.episodesCount,
          inProduction: data.inProduction,
        },
        update: {
          yearStart: data.yearStart,
          yearEnd: data.yearEnd,
          network: data.network,
          runtimeMinutes: data.runtimeMinutes,
          nextAirDate: data.nextAirDate ? new Date(data.nextAirDate) : null,
          seasonsCount: data.seasonsCount,
          episodesCount: data.episodesCount,
          inProduction: data.inProduction,
        },
      });

      await this.syncGenres(tx, mediaId!, genres);
      await this.syncProviders(tx, mediaId!, providers);
      await this.syncCast(tx, mediaId!, castMembers, data.cast);
      await this.syncSeasons(tx, mediaId!, data.seasons);

      return mediaId!;
    });
  }

  private async persistMovie(data: NormalizedMovie, existingId?: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const genres = await this.upsertGenres(tx, data.genres);
      const providers = await this.upsertProviders(tx, data.providers);
      const castMembers = await this.upsertCast(tx, data.cast);

      const mediaData = {
        title: data.title,
        overview: data.overview,
        posterUrl: data.posterUrl,
        backdropUrl: data.backdropUrl,
        rating: data.rating,
        popularity: data.popularity ?? 0,
        trailerUrl: data.trailerUrl,
        metadataRefreshedAt: new Date(),
      };

      let mediaId = existingId;
      if (existingId) {
        await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
      } else {
        const created = await tx.mediaItem.create({
          data: {
            ...mediaData,
            type: MediaType.MOVIE,
            externalIds: { create: data.externals.map((e) => ({ provider: e.provider, value: e.value })) },
          },
        });
        mediaId = created.id;
      }

      await tx.movie.upsert({
        where: { mediaId: mediaId! },
        create: {
          mediaId: mediaId!,
          releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
          releaseYear: data.releaseYear,
          runtimeMinutes: data.runtimeMinutes,
          country: data.country,
          language: data.language,
        },
        update: {
          releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
          releaseYear: data.releaseYear,
          runtimeMinutes: data.runtimeMinutes,
          country: data.country,
          language: data.language,
        },
      });

      await this.syncGenres(tx, mediaId!, genres);
      await this.syncProviders(tx, mediaId!, providers);
      await this.syncCast(tx, mediaId!, castMembers, data.cast);

      return mediaId!;
    });
  }

  // ---- Read helpers ----
  private fullShowInclude(userId?: string) {
    return {
      show: { include: { seasons: { include: { episodes: true } } } },
      genres: { include: { genre: true } },
      providers: { include: { provider: true } },
      cast: { include: { castMember: true } },
      externalIds: true,
      ...(userId
        ? {
            watchlist: { where: { userId }, select: { id: true } },
            favorites: { where: { userId }, select: { id: true } },
            showStatuses: { where: { userId }, select: { id: true, watchedCount: true, totalCount: true } },
          }
        : {}),
    } as const;
  }

  async getShowDetail(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: this.fullShowInclude(userId),
    });
    if (!media || !media.show) throw new NotFoundException('Show not found');
    const dto = mapShow(media as any, userId);
    const seasons = (media.show.seasons || [])
      .filter((s) => !s.isSpecial)
      .map((s) => mapSeason(s as any, userId));
    const specials = (media.show.seasons || [])
      .filter((s) => s.isSpecial)
      .map((s) => mapSeason(s as any, userId));

    // Community ratings per episode, grouped by season (for the ratings chart).
    const seasonRatings = await this.computeSeasonRatings(mediaId);

    // Accurate progress from actual watched episodes, excluding specials (season 0).
    let userProgress = dto.userProgress ?? 0;
    if (userId) {
      const [watchedEp, totalEp] = await Promise.all([
        this.prisma.userEpisodeStatus.count({
          where: { userId, watched: true, episode: { season: { show: { mediaId }, isSpecial: false } } },
        }),
        this.prisma.episode.count({ where: { season: { show: { mediaId }, isSpecial: false } } }),
      ]);
      userProgress = totalEp > 0 ? watchedEp / totalEp : 0;
    }

    return { ...dto, seasons, seasonsWithSpecials: specials, seasonRatings, userProgress };
  }

  private async computeSeasonRatings(mediaId: string) {
    // Source of truth for the chart = YOUR app users' ratings.
    // Unrated episodes count as 0 unless USE_API_FOR_EPISODES_CHART=true (then TMDb fills gaps).
    const useApi = this.config.get<boolean>('metadata.useApiRatingsForChart') === true;
    const eps = await this.prisma.episode.findMany({
      where: { season: { show: { mediaId } } },
      select: {
        number: true,
        rating: true,
        season: { select: { number: true } },
        ratings: { select: { rating: true } },
      },
    });
    const bySeason = new Map<number, { number: number; rating: number; votes: number }[]>();
    for (const e of eps) {
      const votes = e.ratings.length;
      const userAvg = votes ? e.ratings.reduce((a, r) => a + r.rating, 0) / votes : null;
      let value: number;
      if (userAvg != null) {
        value = userAvg; // 1–5 from your users
      } else if (useApi && e.rating) {
        value = e.rating / 2; // TMDb 0–10 scaled to 0–5
      } else {
        value = 0; // no user ratings yet
      }
      const sn = e.season.number;
      if (!bySeason.has(sn)) bySeason.set(sn, []);
      bySeason.get(sn)!.push({ number: e.number, rating: Math.round(value * 10) / 10, votes });
    }
    return [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, episodes]) => ({
        seasonNumber,
        episodes: episodes.sort((a, b) => a.number - b.number),
      }));
  }

  async getShowSeasons(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        show: {
          include: {
            seasons: {
              orderBy: { number: 'asc' },
              include: {
                episodes: {
                  orderBy: { number: 'asc' },
                  ...(userId
                    ? {
                        include: {
                          userStatuses: {
                            where: { userId },
                            select: { watched: true, watchedAt: true, device: true },
                          },
                        },
                      }
                    : {}),
                },
              },
            },
          },
        },
      },
    });
    if (!media?.show) throw new NotFoundException('Show not found');
    return media.show.seasons;
  }

  async getMovieDetail(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        movie: true,
        genres: { include: { genre: true } },
        providers: { include: { provider: true } },
        cast: { include: { castMember: true } },
        externalIds: true,
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              movieStatuses: { where: { userId }, select: { id: true, watched: true, watchedAt: true } },
            }
          : {}),
      },
    });
    if (!media || !media.movie) throw new NotFoundException('Movie not found');
    return mapMovie(media as any, userId);
  }

  // ---- Mapping normalized seasons/episodes ----
  private async syncSeasons(tx: PrismaTransaction, mediaId: string, seasons: NormalizedSeason[]) {
    const show = await tx.show.findUnique({ where: { mediaId } });
    if (!show) return;
    // Upsert by (showId, number) / (seasonId, number) to PRESERVE user progress across refreshes.
    for (const s of seasons) {
      const season = await tx.season.upsert({
        where: { showId_number: { showId: show.id, number: s.number } },
        create: {
          showId: show.id,
          number: s.number,
          title: s.title,
          overview: s.overview,
          posterUrl: s.posterUrl,
          episodeCount: s.episodeCount,
          isSpecial: s.isSpecial,
          airedCount: s.episodes.filter((e) => e.airDate && new Date(e.airDate) <= new Date()).length,
        },
        update: {
          title: s.title,
          overview: s.overview,
          posterUrl: s.posterUrl,
          episodeCount: s.episodeCount,
          isSpecial: s.isSpecial,
          airedCount: s.episodes.filter((e) => e.airDate && new Date(e.airDate) <= new Date()).length,
        },
      });
      for (const e of s.episodes) {
        await tx.episode.upsert({
          where: { seasonId_number: { seasonId: season.id, number: e.number } },
          create: {
            seasonId: season.id,
            number: e.number,
            title: e.title,
            overview: e.overview,
            stillUrl: e.stillUrl,
            runtimeMinutes: e.runtimeMinutes,
            airDate: e.airDate ? new Date(e.airDate) : null,
            rating: e.rating,
            isFinale: e.isFinale,
          },
          update: {
            title: e.title,
            overview: e.overview,
            stillUrl: e.stillUrl,
            runtimeMinutes: e.runtimeMinutes,
            airDate: e.airDate ? new Date(e.airDate) : null,
            rating: e.rating,
            isFinale: e.isFinale,
          },
        });
      }
    }
  }

  async ensureUserShowTotals(userId: string, mediaId: string) {
    const total = await this.prisma.episode.count({
      where: { season: { show: { mediaId }, isSpecial: false } },
    });
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, totalCount: total },
      update: { totalCount: total },
    });
  }

  // ---- Genre / provider / cast dedupe ----
  private async upsertGenres(tx: PrismaTransaction, genres: { name: string }[]) {
    const ids: string[] = [];
    for (const g of genres) {
      const genre = await tx.genre.upsert({
        where: { slug: slugify(g.name) },
        create: { name: g.name, slug: slugify(g.name) },
        update: {},
      });
      ids.push(genre.id);
    }
    return ids;
  }

  private async upsertProviders(tx: PrismaTransaction, providers: { name: string; logoUrl?: string | null }[]) {
    const ids: string[] = [];
    for (const p of providers) {
      const provider = await tx.watchProvider.upsert({
        where: { slug: slugify(p.name) },
        create: { name: p.name, slug: slugify(p.name), logoUrl: p.logoUrl },
        update: { logoUrl: p.logoUrl ?? undefined },
      });
      ids.push(provider.id);
    }
    return ids;
  }

  private async upsertCast(tx: PrismaTransaction, cast: { tmdbPersonId: number; name: string; profileUrl?: string | null }[]) {
    const map = new Map<string, { name: string; profileUrl?: string | null }>();
    for (const c of cast) {
      map.set(`TMDB_${c.tmdbPersonId}`, { name: c.name, profileUrl: c.profileUrl });
    }
    const ids: string[] = [];
    for (const [externalId, info] of map) {
      const member = await tx.castMember.upsert({
        where: { externalId },
        create: { externalId, name: info.name, profileUrl: info.profileUrl },
        update: { name: info.name, profileUrl: info.profileUrl ?? undefined },
      });
      ids.push(member.id);
    }
    return ids;
  }

  private async syncGenres(tx: PrismaTransaction, mediaId: string, genreIds: string[]) {
    await tx.mediaGenre.deleteMany({ where: { mediaId } });
    for (const genreId of genreIds) {
      await tx.mediaGenre.create({ data: { mediaId, genreId } }).catch(() => undefined);
    }
  }

  private async syncProviders(tx: PrismaTransaction, mediaId: string, providerIds: string[]) {
    await tx.mediaWatchProvider.deleteMany({ where: { mediaId } });
    for (const providerId of providerIds) {
      await tx.mediaWatchProvider
        .create({ data: { mediaId, providerId } })
        .catch(() => undefined);
    }
  }

  private async syncCast(
    tx: PrismaTransaction,
    mediaId: string,
    castMemberIds: string[],
    cast: { character?: string | null; order: number }[],
  ) {
    await tx.mediaCast.deleteMany({ where: { mediaId } });
    for (let i = 0; i < castMemberIds.length; i++) {
      const id = castMemberIds[i];
      const c = cast[i];
      await tx.mediaCast.create({
        data: { mediaId, castMemberId: id, character: c?.character ?? null, sortOrder: c?.order ?? i },
      });
    }
  }
}

type PrismaTransaction = Omit<
  PrismaService,
  | '$connect'
  | '$disconnect'
  | '$on'
  | '$transaction'
  | '$use'
  | '$extends'
  | 'onModuleInit'
  | 'onModuleDestroy'
>;
