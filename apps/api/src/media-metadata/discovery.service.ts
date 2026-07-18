import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MediaType } from '@tvwatch/shared';
import type { MediaCardLiteDto } from '@tvwatch/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { RedisService } from '../common/redis/redis.service';
import { mapMediaCardLite, mapMovie, mapShow } from '../common/utils/mapper.util';
import { MediaMetadataService } from './media-metadata.service';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { HydrationQueue } from './hydration/hydration.queue';
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
    private readonly hydration: HydrationQueue,
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
    // Honor the requested page size (the PaginationDto caps it at 100). Key the cache by
    // language AND size so different locales/page sizes don't share orderings/titles.
    const lang = currentLanguage();
    const want = Math.max(1, Math.min(q.pageSize ?? 20, 100));
    const cacheKey = `search:v3:${q.type ?? 'all'}:${term}:${q.page ?? 1}:${want}:${lang}`;
    const cached = await this.redis.get<{ ids: string[] }>(cacheKey);
    if (cached?.ids?.length) {
      const items = await this.fetchListDtos(cached.ids, userId, want);
      return paginate(items, 1, items.length, cached.ids.length);
    }

    const wantShows = !q.type || q.type === MediaType.SHOW;
    const wantMovies = !q.type || q.type === MediaType.MOVIE;

    // Step 1: LOCAL DB search (fast, finds TVDB-only content that already exists).
    // Two passes: exact title matches first (high priority), then contains matches.
    const dbWhere = {
      ...(wantShows && !wantMovies ? { type: MediaType.SHOW } : {}),
      ...(wantMovies && !wantShows ? { type: MediaType.MOVIE } : {}),
    };
    const exactRows = await this.prisma.mediaItem.findMany({
      where: { ...dbWhere, title: { equals: term, mode: 'insensitive' as const } },
      take: 50, orderBy: { popularity: 'desc' }, select: { id: true },
    });
    const exactIds = exactRows.map((r) => r.id);
    const containsRows = await this.prisma.mediaItem.findMany({
      where: { ...dbWhere, title: { contains: term, mode: 'insensitive' as const }, id: { notIn: exactIds } },
      take: 100, orderBy: { popularity: 'desc' }, select: { id: true },
    });
    const localIds = [...exactIds, ...containsRows.map((r) => r.id)];

    // Step 2: TMDB API search (finds new content not in DB yet). TMDB returns a fixed 20
    // results per page, so fetch ceil(want/20) pages to satisfy the requested page size.
    const TMDB_PAGE_SIZE = 20;
    const pagesNeeded = Math.max(1, Math.ceil(want / TMDB_PAGE_SIZE));
    const startPage = q.page ?? 1;
    const fetchTmdbPages = async (
      fetcher: (p: number) => Promise<{ items: any[]; total: number }>,
      upsert: (i: any) => Promise<string>,
    ): Promise<string[]> => {
      // Fetch the needed pages concurrently (TMDB's rate limiter tolerates a few parallel
      // requests) to keep cold-search latency flat, then stop at the first short/empty page.
      const pages = await Promise.all(
        Array.from({ length: pagesNeeded }, (_, p) => fetcher(startPage + p)),
      );
      const ids: string[] = [];
      for (const r of pages) {
        if (r.items.length === 0) break;
        ids.push(...(await Promise.all(r.items.map(upsert))));
        if (r.items.length < TMDB_PAGE_SIZE) break; // last page reached
      }
      return ids;
    };

    const tasks: Promise<{ source: string; ids: string[] }>[] = [];
    if (wantShows && this.tmdb.enabled) {
      tasks.push(
        fetchTmdbPages((pg) => this.tmdb.searchShows(term, pg), (i) => this.meta.lightUpsertShow(i)).then((ids) => ({
          source: 'tmdb-shows',
          ids,
        })),
      );
    }
    if (wantMovies && this.tmdb.enabled) {
      tasks.push(
        fetchTmdbPages((pg) => this.tmdb.searchMovies(term, pg), (i) => this.meta.lightUpsertMovie(i)).then((ids) => ({
          source: 'tmdb-movies',
          ids,
        })),
      );
    }
    const results = await Promise.all(tasks);
    const tmdbIds = results.flatMap((r) => r.ids);

    // Merge: local results first (includes TVDB-only), then TMDB-only (deduped).
    const orderedIds = [...new Set([...localIds, ...tmdbIds])];

    // Step 3: If NO results from local + TMDB, fall back to TVDB API (synchronous).
    if (orderedIds.length === 0 && this.tvdb?.enabled) {
      if (wantShows) {
        try {
          const r = await this.tvdb.searchShows(term, 1);
          orderedIds.push(...await Promise.all(
            r.items.filter((i) => i.tvdbId).map((i) => this.meta.lightUpsertShowTvdb(
              { tvdbId: i.tvdbId!, title: i.title, overview: i.overview, posterUrl: i.posterUrl, backdropUrl: null, popularity: 0, year: i.year ?? null },
            )),
          ));
        } catch (e) { this.logger.warn(`TVDB show fallback failed: ${(e as Error).message}`); }
      }
      if (wantMovies && orderedIds.length === 0) {
        try {
          const r = await this.tvdb.searchMovies(term, 1);
          orderedIds.push(...await Promise.all(
            r.items.filter((i) => i.tvdbId).map((i) => this.meta.lightUpsertMovieTvdb(
              { tvdbId: i.tvdbId!, title: i.title, overview: i.overview, posterUrl: i.posterUrl, backdropUrl: null, popularity: 0, year: i.year ?? null },
            )),
          ));
        } catch (e) { this.logger.warn(`TVDB movie fallback failed: ${(e as Error).message}`); }
      }
    }

    // Only cache NON-EMPTY results with a SHORT TTL — don't trap users in stale empty results.
    if (orderedIds.length >= 3) await this.redis.set(cacheKey, { ids: orderedIds }, 120);

    // Enqueue background enrichment.
    if (wantShows && this.tvdb?.enabled) this.hydration.enqueueTvdbSearch(term, 'SHOW', lang).catch(() => undefined);
    if (wantMovies && this.tvdb?.enabled) this.hydration.enqueueTvdbSearch(term, 'MOVIE', lang).catch(() => undefined);
    for (const id of orderedIds) this.hydration.enqueueClassifyCandidate({ mediaId: id }).catch(() => undefined);

    const items = await this.fetchListDtos(orderedIds, userId, want);
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

  /**
   * Lightweight cards for LARGE user lists (watchlist/favorites, up to 500 per page).
   * Same localization + aired-progress semantics as fetchListDtos, but skips the
   * cast/genres/provider/externalId includes and full DTO mapping — those turned
   * pageSize=500 watchlist responses into multi-second, multi-MB payloads for rows
   * that only ever render poster + title + progress.
   */
  async fetchCardDtos(ids: string[], userId?: string, limit = 20): Promise<MediaCardLiteDto[]> {
    if (ids.length === 0) return [];
    const limitedIds = ids.slice(0, limit);
    // Populate the request-locale override for items missing it (same as fetchListDtos).
    await this.meta.ensureListLocaleOverrides(limitedIds);
    const media = await this.prisma.mediaItem.findMany({
      where: { id: { in: limitedIds } },
      include: {
        show: { select: { episodesCount: true } },
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              showStatuses: { where: { userId }, select: { id: true, watchedCount: true, totalCount: true } },
              movieStatuses: { where: { userId }, select: { id: true, watched: true } },
            }
          : {}),
      },
    });
    const byId = new Map(media.map((m) => [m.id, m]));

    // Batch-query accurate aired episode counts for shows (excludes future + null air dates)
    const showMediaIds = media.filter((m) => m.type === MediaType.SHOW).map((m) => m.id);
    const airedCounts = showMediaIds.length > 0
      ? await this.prisma.$queryRaw<{ mediaId: string; airedCount: number }[]>`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "airedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.air_date IS NOT NULL
            AND e.air_date <= NOW()
          GROUP BY sh.media_id
        `
      : [];
    const airedMap = new Map(airedCounts.map((r) => [r.mediaId, r.airedCount]));

    return limitedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((m) => {
        const dto = mapMediaCardLite(m as any, userId);
        // Override progress with accurate aired count (same as fetchListDtos)
        if (userId && m!.type === MediaType.SHOW) {
          const watched = (m as any).showStatuses?.[0]?.watchedCount ?? 0;
          const airedTotal = airedMap.get(m!.id) ?? 0;
          dto.userProgress = airedTotal > 0 ? Math.min(1, watched / airedTotal) : 0;
        }
        return dto;
      });
  }

  async fetchListDtos(ids: string[], userId?: string, limit = 20) {
    if (ids.length === 0) return [];
    const limitedIds = ids.slice(0, limit);
    // Populate the request-locale override for items missing it (watchlist/favorites/
    // library) so lists localize without each item having been opened in detail.
    await this.meta.ensureListLocaleOverrides(limitedIds);
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

    // Batch-query accurate aired episode counts for shows (excludes future + null air dates)
    const showMediaIds = media.filter((m) => m.type === MediaType.SHOW).map((m) => m.id);
    const airedCounts = showMediaIds.length > 0
      ? await this.prisma.$queryRaw<{ mediaId: string; airedCount: number }[]>`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "airedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.air_date IS NOT NULL
            AND e.air_date <= NOW()
          GROUP BY sh.media_id
        `
      : [];
    const airedMap = new Map(airedCounts.map((r) => [r.mediaId, r.airedCount]));

    return limitedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((m) => {
        if (m!.type === MediaType.SHOW) {
          const dto = mapShow(m as any, userId);
          // Override progress with accurate aired count
          if (userId) {
            const userStatus = (m as any).showStatuses?.[0];
            const watched = userStatus?.watchedCount ?? 0;
            const airedTotal = airedMap.get(m!.id) ?? 0;
            dto.userProgress = airedTotal > 0 ? Math.min(1, watched / airedTotal) : 0;
          }
          return dto;
        }
        return mapMovie(m as any, userId);
      });
  }
}
