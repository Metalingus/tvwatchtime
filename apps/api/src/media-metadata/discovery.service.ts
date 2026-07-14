import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MediaType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { RedisService } from '../common/redis/redis.service';
import { mapMovie, mapShow } from '../common/utils/mapper.util';
import { MediaMetadataService } from './media-metadata.service';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { DiscoverQueryDto, SearchQueryDto } from './dto/discover.dto';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly meta: MediaMetadataService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private requireTmdb() {
    if (!this.tmdb.enabled) throw new ServiceUnavailableException('Live metadata not configured');
  }

  async search(q: SearchQueryDto, userId?: string) {
    const term = q.q?.trim();
    if (!term) return paginate([], q.page, q.pageSize, 0);
    if (this.tmdb.enabled || this.tvdb?.enabled) {
      return this.searchViaProviders(term, q, userId);
    }
    return this.searchViaDb(term, q, userId);
  }

  private async searchViaProviders(term: string, q: SearchQueryDto, userId?: string) {
    // Key the cache by language so different locales don't share result orderings/titles.
    const lang = currentLanguage();
    const cacheKey = `search:v2:${q.type ?? 'all'}:${term}:${q.page}:${lang}`;
    const cached = await this.redis.get<{ ids: string[] }>(cacheKey);
    if (cached?.ids?.length) {
      const items = await this.fetchListDtos(cached.ids, userId);
      return paginate(items, 1, items.length, cached.ids.length);
    }

    const wantShows = !q.type || q.type === MediaType.SHOW;
    const wantMovies = !q.type || q.type === MediaType.MOVIE;

    const tasks: Promise<{ source: string; ids: string[] }>[] = [];

    if (wantShows && this.tmdb.enabled) {
      tasks.push(
        this.tmdb.searchShows(term, q.page).then(async (r) => ({
          source: 'tmdb-shows',
          ids: await Promise.all(r.items.map((i) => this.meta.lightUpsertShow(i))),
        })),
      );
    }
    if (wantMovies && this.tmdb.enabled) {
      tasks.push(
        this.tmdb.searchMovies(term, q.page).then(async (r) => ({
          source: 'tmdb-movies',
          ids: await Promise.all(r.items.map((i) => this.meta.lightUpsertMovie(i))),
        })),
      );
    }
    if (wantShows && this.tvdb?.enabled) {
      tasks.push(
        this.tvdb
          .searchShows(term, q.page)
          .then(async (r) => ({
            source: 'tvdb-shows',
            ids: await Promise.all(
              r.items
                .filter((i) => i.tvdbId)
                .map((i) => this.meta.lightUpsertShowTvdb({ tvdbId: i.tvdbId!, title: i.title, overview: i.overview, posterUrl: i.posterUrl, backdropUrl: i.backdropUrl, popularity: i.popularity, year: i.year ?? null })),
            ),
          }))
          .catch((e: unknown) => {
            // TVDB is a backup provider — never let it break the primary TMDB search.
            this.logger.warn(`TVDB show search failed for "${term}": ${(e as Error).message}`);
            return { source: 'tvdb-shows', ids: [] as string[] };
          }),
      );
    }
    if (wantMovies && this.tvdb?.enabled) {
      tasks.push(
        this.tvdb
          .searchMovies(term, q.page)
          .then(async (r) => ({
            source: 'tvdb-movies',
            ids: await Promise.all(
              r.items
                .filter((i) => i.tvdbId)
                .map((i) => this.meta.lightUpsertMovieTvdb({ tvdbId: i.tvdbId!, title: i.title, overview: i.overview, posterUrl: i.posterUrl, backdropUrl: i.backdropUrl, popularity: i.popularity, year: i.year ?? null })),
            ),
          }))
          .catch((e: unknown) => {
            this.logger.warn(`TVDB movie search failed for "${term}": ${(e as Error).message}`);
            return { source: 'tvdb-movies', ids: [] as string[] };
          }),
      );
    }

    const results = await Promise.all(tasks);

    // TMDb results first, then TVDB-only (deduped)
    const tmdbIds = results.filter((r) => r.source !== 'tvdb-shows' && r.source !== 'tvdb-movies').flatMap((r) => r.ids);
    const allIds = results.flatMap((r) => r.ids);
    const tmdbSet = new Set(tmdbIds);
    const tvdbOnlyIds = allIds.filter((id) => !tmdbSet.has(id));
    const orderedIds = [...new Set([...tmdbIds, ...tvdbOnlyIds])];

    if (orderedIds.length) {
      await this.redis.set(cacheKey, { ids: orderedIds }, 600);
    }

    const items = await this.fetchListDtos(orderedIds, userId);
    return paginate(items, 1, items.length, orderedIds.length);
  }

  private async searchViaDb(term: string, q: SearchQueryDto, userId?: string) {
    const where = {
      title: { contains: term, mode: 'insensitive' as const },
      ...(q.type ? { type: q.type } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        skip: ((q.page || 1) - 1) * (q.pageSize || 20),
        take: q.pageSize,
        orderBy: { popularity: 'desc' },
      }),
      this.prisma.mediaItem.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const items = await this.fetchListDtos(ids, userId);
    return paginate(items, q.page, q.pageSize, total);
  }

  async discoverShows(q: DiscoverQueryDto, userId?: string) {
    if (!this.tmdb.enabled) return this.discoverViaDb(MediaType.SHOW, q, userId);
    const res = await this.tmdb.discoverShows({
      genre: q.genre ? Number(q.genre) : undefined,
      year: q.yearFrom,
      sort: q.sort,
      page: q.page,
    });
    const ids = await Promise.all(res.items.map((i) => this.meta.lightUpsertShow(i)));
    const items = await this.fetchListDtos(ids, userId);
    return paginate(items, q.page, q.pageSize, res.total);
  }

  async discoverMovies(q: DiscoverQueryDto, userId?: string) {
    if (!this.tmdb.enabled) return this.discoverViaDb(MediaType.MOVIE, q, userId);
    const res = await this.tmdb.discoverMovies({
      genre: q.genre ? Number(q.genre) : undefined,
      year: q.yearFrom,
      sort: q.sort,
      page: q.page,
    });
    const ids = await Promise.all(res.items.map((i) => this.meta.lightUpsertMovie(i)));
    const items = await this.fetchListDtos(ids, userId);
    return paginate(items, q.page, q.pageSize, res.total);
  }

  async trendingShows(userId?: string, page = 1, pageSize = 20) {
    if (!this.tmdb.enabled) return { items: await this.topDb(MediaType.SHOW, pageSize, userId), page, hasMore: false };
    const items = await this.tmdb.trendingShows('week', page);
    const ids = await Promise.all(items.map((i) => this.meta.lightUpsertShow(i)));
    const listItems = await this.fetchListDtos(ids, userId, pageSize);
    return { items: listItems, page, hasMore: items.length === 20 };
  }

  async trendingMovies(userId?: string, page = 1, pageSize = 20) {
    if (!this.tmdb.enabled) return { items: await this.topDb(MediaType.MOVIE, pageSize, userId), page, hasMore: false };
    const items = await this.tmdb.trendingMovies('week', page);
    const ids = await Promise.all(items.map((i) => this.meta.lightUpsertMovie(i)));
    const listItems = await this.fetchListDtos(ids, userId, pageSize);
    return { items: listItems, page, hasMore: items.length === 20 };
  }

  async discoverSections(userId?: string) {
    const [trendingShows, trendingMovies] = await Promise.all([
      this.tmdb.enabled
        ? this.trendingShows(userId, 1, 20)
        : { items: await this.topDb(MediaType.SHOW, 20, userId), page: 1, hasMore: false },
      this.tmdb.enabled
        ? this.trendingMovies(userId, 1, 20)
        : { items: await this.topDb(MediaType.MOVIE, 20, userId), page: 1, hasMore: false },
    ]);
    const topForYou = userId ? await this.recommendedForYou(userId) : trendingShows.items.slice(0, 10);
    return { topForYou, trendingShows: trendingShows.items, trendingMovies: trendingMovies.items };
  }

  private async recommendedForYou(userId: string) {
    // Score genres: watch history counts double, favorites +1 each.
    const [histGenres, favGenres] = await Promise.all([
      this.prisma.mediaGenre.findMany({
        where: { media: { watchHistory: { some: { userId } } } },
        select: { genre: { select: { name: true } } },
      }),
      this.prisma.mediaGenre.findMany({
        where: { media: { favorites: { some: { userId } } } },
        select: { genre: { select: { name: true } } },
      }),
    ]);
    const scores = new Map<string, number>();
    const add = (rows: { genre: { name: string } }[], weight: number) =>
      rows.forEach((g) => scores.set(g.genre.name, (scores.get(g.genre.name) ?? 0) + weight));
    add(histGenres as any, 2);
    add(favGenres as any, 1);
    const genreNames = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
    if (genreNames.length === 0) return [];
    const watchedIds = (
      await this.prisma.watchHistory.findMany({
        where: { userId },
        select: { mediaId: true },
        distinct: ['mediaId'],
      })
    ).map((w) => w.mediaId);
    const rows = await this.prisma.mediaItem.findMany({
      where: {
        type: MediaType.SHOW,
        genres: { some: { genre: { name: { in: genreNames } } } },
        id: { notIn: watchedIds },
      },
      orderBy: { popularity: 'desc' },
      take: 10,
    });
    return this.fetchListDtos(rows.map((r) => r.id), userId);
  }

  private async discoverViaDb(type: MediaType, q: DiscoverQueryDto, userId?: string) {
    return this.topDb(type, q.pageSize || 20, userId, q);
  }

  private async topDb(type: MediaType, limit: number, userId?: string, q?: DiscoverQueryDto) {
    const where = {
      type,
      ...(q?.genre ? { genres: { some: { genre: { name: q.genre } } } } : {}),
      ...(q?.minRating ? { rating: { gte: q.minRating } } : {}),
    };
    const rows = await this.prisma.mediaItem.findMany({
      where,
      orderBy: { popularity: 'desc' },
      take: limit,
    });
    return this.fetchListDtos(rows.map((r) => r.id), userId);
  }

  async fetchListDtos(ids: string[], userId?: string, limit = 20) {
    if (ids.length === 0) return [];
    const limitedIds = ids.slice(0, limit);
    const media = await this.prisma.mediaItem.findMany({
      where: { id: { in: limitedIds } },
      include: {
        show: true,
        movie: true,
        genres: { include: { genre: true } },
        providers: { include: { provider: true } },
        cast: { include: { castMember: true } },
        externalIds: true,
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              showStatuses: { where: { userId }, select: { id: true, watchedCount: true, totalCount: true } },
              movieStatuses: { where: { userId }, select: { id: true, watched: true, watchedAt: true } },
            }
          : {}),
      },
    });
    const byId = new Map(media.map((m) => [m.id, m]));
    return limitedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((m) => (m!.type === MediaType.SHOW ? mapShow(m as any, userId) : mapMovie(m as any, userId)));
  }
}
