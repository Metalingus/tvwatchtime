import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MediaType } from '@tvwatch/shared';
import type { GenreFilterDto, MediaCardLiteDto } from '@tvwatch/shared';
import { HydrationJobType, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { RedisService } from '../common/redis/redis.service';
import { localized } from '../common/utils/localization.util';
import { mapMediaCardLite, mapMovie, mapShow } from '../common/utils/mapper.util';
import { MediaMetadataService } from './media-metadata.service';
import { TmdbProvider, NormalizedSearchItem } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { HydrationQueue } from './hydration/hydration.queue';
import { isProviderError } from './providers/shared/provider-errors';
import { DiscoverQueryDto, ExploreFiltersDto, SearchQueryDto } from './dto/discover.dto';
import { paginate } from '../common/dto/pagination.dto';

/** Trending window entry: media id + the TMDB payload signals used for cheap
 *  list-time filtering (genre ids for genre chips, origin countries for anime). */
interface TrendingEntry {
  id: string;
  g: number[];
  oc?: string[];
}

interface SearchCacheEntry {
  /** Merged ordered media ids (local DB first, then TMDb pages). */
  ids: string[];
  /** TMDB genre ids per media id from the search payload — genre filters on light rows. */
  genreIds: Record<string, number[]>;
  /** Origin countries per media id from the search payload — anime signal on light rows. */
  originCountries?: Record<string, string[]>;
  tmdbPagesFetched: number;
  /** True once every enabled source returned a short/empty page. */
  exhausted: boolean;
}

/**
 * Forgiving-search normalization: NFKD + strip diacritics, punctuation/hyphens →
 * spaces, collapse whitespace, lowercase. Applied to the raw term so "W-Two" and
 * "W: Two" tokenize like "w two" — provider APIs and DB ILIKE see word boundaries
 * instead of glued punctuation.
 */
function normalizeSearchTerm(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Distinct normalized tokens of a search term (capped to bound query complexity). */
function searchTokens(term: string, cap = 6): string[] {
  return [...new Set(normalizeSearchTerm(term).split(' ').filter(Boolean))].slice(0, cap);
}

/** Structural filter input accepted by the DB browse paths (both discover DTOs fit). */
interface ExploreFilterInput {
  genre?: string;
  excludeGenres?: string;
  sort?: string;
  country?: string;
  hideAnime?: boolean;
  minRating?: number;
}

interface RailListOptions {
  railType: HydrationJobType;
  idsNs: string;
  windowNs: string;
  kind: 'show' | 'movie';
  fetchPage: (page: number) => Promise<NormalizedSearchItem[]>;
}

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

  /** Per-user "hide anime in explore" preference (false when absent/anonymous). */
  private async resolveHideAnime(userId?: string): Promise<boolean> {
    if (!userId) return false;
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { hideAnimeInExplore: true },
    });
    return profile?.hideAnimeInExplore ?? false;
  }

  /**
   * Drop confirmed anime from trending entries. TMDB list payloads do not contain
   * keywords, so the strict genre+keyword rule is evaluated during routing/hydration.
   */
  private async filterAnimeEntries(entries: TrendingEntry[]): Promise<TrendingEntry[]> {
    const dbAnime = new Set(
      (
        await this.prisma.mediaItem.findMany({
          where: { id: { in: entries.map((e) => e.id) }, contentClassification: 'ANIME' },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    return entries.filter((e) => !dbAnime.has(e.id));
  }

  async search(q: SearchQueryDto, userId?: string) {
    const term = q.q?.trim();
    if (!term) return paginate([], q.page, q.pageSize, 0);
    if (this.tmdb.enabled || this.tvdb?.enabled) {
      return this.searchViaProviders(term, q, userId);
    }
    return this.searchViaDb(term, q, userId);
  }

  /**
   * Search result window cached per (type, term, lang): the merged ordering (local DB
   * first, then TMDb pages) lives in `ids`, and later pages expand the window on
   * demand — so paging returns real ordered results instead of re-fetching arbitrary
   * TMDb pages (the old key included the page, so page 2+ restarted mid-list).
   */
  private async searchViaProviders(term: string, q: SearchQueryDto, userId?: string) {
    const lang = currentLanguage();
    const want = Math.max(1, Math.min(q.pageSize ?? 20, 50));
    const page = Math.max(1, q.page ?? 1);
    // v7: forgiving search — originalTitle column + normalized token-AND tier joined
    // the local match, and providers receive the punctuation-normalized term.
    const cacheKey = `search:v7:${q.type ?? 'all'}:${term}:${lang}`;

    let entry = await this.redis.get<SearchCacheEntry>(cacheKey);
    if (!entry) {
      entry = await this.initialSearch(term, q);
      await this.redis.set(cacheKey, entry, 120);
    }
    // Expand the window until the requested page is covered or sources are exhausted
    // (bounded per request so a deep page jump can't hammer TMDb).
    let rounds = 0;
    while (entry.ids.length < page * want && !entry.exhausted && rounds < 3) {
      entry = await this.fetchNextTmdbPage(term, q, entry);
      rounds++;
      await this.redis.set(cacheKey, entry, 120);
    }

    const start = (page - 1) * want;
    // Rank media without posters last (stable: the merged local+TMDB relevance order is
    // preserved within each group). Done at read time so late-hydrated posters count.
    let orderedIds = await this.posterLast(entry.ids);
    // Genre filter: hydrated rows match via the DB join, light rows via the TMDB
    // payload genre ids cached alongside the window (zero extra provider calls).
    const genre = q.genre?.trim();
    if (genre) orderedIds = await this.filterIdsByGenre(orderedIds, genre, entry.genreIds ?? {});
    // Exclusion (multi-select): same dual resolution, inverted.
    const exclude = this.parseSlugList(q.excludeGenres);
    if (exclude.length)
      orderedIds = await this.excludeIdsByGenres(orderedIds, exclude, entry.genreIds ?? {});
    const country = q.country?.trim().toUpperCase();
    if (country) orderedIds = await this.filterIdsByCountry(orderedIds, country);
    // Hide anime: explicit UI toggle OR the profile flag — payload signal for light
    // rows (cached genre ids + origin countries), DB classification for hydrated ones.
    const hideAnime = q.hideAnime || (await this.resolveHideAnime(userId));
    if (hideAnime) {
      orderedIds = (
        await this.filterAnimeEntries(
          orderedIds.map((id) => ({
            id,
            g: entry.genreIds?.[id] ?? [],
            oc: entry.originCountries?.[id] ?? [],
          })),
        )
      ).map((e) => e.id);
    }
    // releaseDate sort: order the (bounded) window newest-first before slicing —
    // provider relevance can't carry dates, so we resolve years for the window ids
    // in one DB round trip. Unknown years sink to the bottom.
    if (q.sort === 'releaseDate') orderedIds = await this.sortIdsByReleaseDesc(orderedIds);
    const slice = orderedIds.slice(start, start + want);
    const items = await this.fetchListDtos(slice, userId, want);
    // hasMore via paginate's formula: +1 while more pages may exist upstream.
    const total = orderedIds.length + (entry.exhausted ? 0 : 1);
    return paginate(items, page, want, total);
  }

  /** First search round: local DB (exact then contains) + TMDb page 1 + fallbacks. */
  private async initialSearch(term: string, q: SearchQueryDto): Promise<SearchCacheEntry> {
    const lang = currentLanguage();
    const wantShows = !q.type || q.type === MediaType.SHOW;
    const wantMovies = !q.type || q.type === MediaType.MOVIE;

    // LOCAL DB search (fast, finds TVDB-only content that already exists).
    const dbWhere = {
      ...(wantShows && !wantMovies ? { type: MediaType.SHOW } : {}),
      ...(wantMovies && !wantShows ? { type: MediaType.MOVIE } : {}),
    };
    const exactRows = await this.prisma.mediaItem.findMany({
      where: {
        ...dbWhere,
        OR: [
          { title: { equals: term, mode: 'insensitive' as const } },
          // Original-language title lives on the show relation (shows only).
          { show: { is: { originalTitle: { equals: term, mode: 'insensitive' as const } } } },
        ],
      },
      take: 50,
      orderBy: { popularity: 'desc' },
      select: { id: true },
    });
    const exactIds = exactRows.map((r) => r.id);
    const containsRows = await this.prisma.mediaItem.findMany({
      where: {
        ...dbWhere,
        OR: [
          { title: { contains: term, mode: 'insensitive' as const } },
          { show: { is: { originalTitle: { contains: term, mode: 'insensitive' as const } } } },
        ],
        id: { notIn: exactIds },
      },
      take: 100,
      orderBy: { popularity: 'desc' },
      select: { id: true },
    });
    const containsIds = containsRows.map((r) => r.id);
    // Token tier (forgiving): every normalized word of the term must appear in the
    // title or originalTitle — "Two Worlds" matches "W-Two Worlds" regardless of
    // leading tokens, punctuation, or word order.
    const tokens = searchTokens(term);
    const skipIds = [...exactIds, ...containsIds];
    const tokenRows =
      tokens.length > 1
        ? await this.prisma.mediaItem.findMany({
            where: {
              ...dbWhere,
              AND: tokens.map((tok) => ({
                OR: [
                  { title: { contains: tok, mode: 'insensitive' as const } },
                  {
                    show: {
                      is: { originalTitle: { contains: tok, mode: 'insensitive' as const } },
                    },
                  },
                ],
              })),
              ...(skipIds.length ? { id: { notIn: skipIds } } : {}),
            },
            take: 100,
            orderBy: { popularity: 'desc' },
            select: { id: true },
          })
        : [];
    const localIds = [...exactIds, ...containsIds, ...tokenRows.map((r) => r.id)];

    let entry: SearchCacheEntry = {
      ids: localIds,
      genreIds: {},
      tmdbPagesFetched: 0,
      exhausted: false,
    };
    entry = await this.fetchNextTmdbPage(term, q, entry);

    // If NO results from local + TMDB, fall back to TVDB API (synchronous).
    if (entry.ids.length === 0 && this.tvdb?.enabled) {
      const providerTerm = normalizeSearchTerm(term) || term;
      if (wantShows) {
        try {
          const r = await this.tvdb.searchShows(providerTerm, 1);
          entry.ids.push(
            ...(await Promise.all(
              r.items
                .filter((i) => i.tvdbId)
                .map((i) =>
                  this.meta.lightUpsertShowTvdb({
                    tvdbId: i.tvdbId!,
                    title: i.title,
                    overview: i.overview,
                    posterUrl: i.posterUrl,
                    backdropUrl: null,
                    popularity: 0,
                    year: i.year ?? null,
                    genres: i.providerGenres,
                  }),
                ),
            )),
          );
        } catch (e) {
          this.logger.warn(`TVDB show fallback failed: ${(e as Error).message}`);
        }
      }
      if (wantMovies && entry.ids.length === 0) {
        try {
          const r = await this.tvdb.searchMovies(providerTerm, 1);
          entry.ids.push(
            ...(await Promise.all(
              r.items
                .filter((i) => i.tvdbId)
                .map((i) =>
                  this.meta.lightUpsertMovieTvdb({
                    tvdbId: i.tvdbId!,
                    title: i.title,
                    overview: i.overview,
                    posterUrl: i.posterUrl,
                    backdropUrl: null,
                    popularity: 0,
                    year: i.year ?? null,
                  }),
                ),
            )),
          );
        } catch (e) {
          this.logger.warn(`TVDB movie fallback failed: ${(e as Error).message}`);
        }
      }
      entry.exhausted = true;
    }

    entry.ids = [...new Set(entry.ids)];

    // Enqueue background enrichment.
    if (wantShows && this.tvdb?.enabled)
      this.hydration.enqueueTvdbSearch(term, 'SHOW', lang).catch(() => undefined);
    if (wantMovies && this.tvdb?.enabled)
      this.hydration.enqueueTvdbSearch(term, 'MOVIE', lang).catch(() => undefined);
    for (const id of entry.ids)
      this.hydration.enqueueClassifyCandidate({ mediaId: id }).catch(() => undefined);

    return entry;
  }

  /** Append the next TMDb page (per requested type) to the cached window. */
  private async fetchNextTmdbPage(
    term: string,
    q: SearchQueryDto,
    entry: SearchCacheEntry,
  ): Promise<SearchCacheEntry> {
    if (entry.exhausted) return entry;
    if (!this.tmdb.enabled) return { ...entry, exhausted: true };
    const wantShows = !q.type || q.type === MediaType.SHOW;
    const wantMovies = !q.type || q.type === MediaType.MOVIE;
    const nextPage = entry.tmdbPagesFetched + 1;
    // Normalized term (hyphens/colons → spaces) — TMDb tokenizes on punctuation, so
    // "W-Two" glued input would otherwise miss what "W Two" finds.
    const providerTerm = normalizeSearchTerm(term) || term;

    const tasks: Promise<{ kind: 'show' | 'movie'; items: any[] }>[] = [];
    if (wantShows)
      tasks.push(
        this.tmdb
          .searchShows(providerTerm, nextPage)
          .then((r) => ({ kind: 'show' as const, items: r.items })),
      );
    if (wantMovies)
      tasks.push(
        this.tmdb
          .searchMovies(providerTerm, nextPage)
          .then((r) => ({ kind: 'movie' as const, items: r.items })),
      );
    const settled = await Promise.allSettled(tasks);
    const results: { kind: 'show' | 'movie'; items: any[] }[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
        continue;
      }
      if (!isProviderError(result.reason)) throw result.reason;
      this.logger.warn(
        `TMDB search unavailable (${result.reason.category}): ${result.reason.message}`,
      );
    }

    // A provider outage must not discard local catalog matches or prevent the TVDB
    // fallback in initialSearch. Mark this window exhausted when every requested
    // TMDB branch failed so the same request does not spin through more retries.
    if (results.length === 0) {
      return {
        ...entry,
        tmdbPagesFetched: nextPage,
        exhausted: true,
      };
    }

    let allShort = true;
    for (const { kind, items } of results) {
      if (!items.length) continue;
      const upserted = await Promise.all(
        items.map((i) =>
          kind === 'show' ? this.meta.lightUpsertShow(i) : this.meta.lightUpsertMovie(i),
        ),
      );
      items.forEach((item, idx) => {
        entry.genreIds[upserted[idx]] = item.genreIds ?? [];
        if (item.originCountries?.length)
          (entry.originCountries ??= {})[upserted[idx]] = item.originCountries;
      });
      entry.ids.push(...upserted);
      if (items.length >= 20) allShort = false; // a full page means there may be more
    }
    return {
      ids: [...new Set(entry.ids)],
      genreIds: entry.genreIds,
      tmdbPagesFetched: nextPage,
      exhausted: allShort,
    };
  }

  /**
   * Stable poster-last ordering for a merged id window: ids whose media row has a poster
   * keep their existing (relevance) order, ids without one are pushed to the end.
   * One batched read per search request.
   */
  async posterLast(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return ids;
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, posterUrl: true },
    });
    const withPoster = new Set(rows.filter((r) => r.posterUrl).map((r) => r.id));
    const poster: string[] = [];
    const noPoster: string[] = [];
    for (const id of ids) (withPoster.has(id) ? poster : noPoster).push(id);
    return [...poster, ...noPoster];
  }

  /** Newest-first ordering for an id window (one query; unknown years sink last). */
  private async sortIdsByReleaseDesc(ids: string[]): Promise<string[]> {
    if (ids.length < 2) return ids;
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        show: { select: { yearStart: true } },
        movie: { select: { releaseYear: true } },
      },
    });
    const year = new Map(rows.map((r) => [r.id, r.show?.yearStart ?? r.movie?.releaseYear ?? 0]));
    return [...ids].sort((a, b) => (year.get(b) ?? 0) - (year.get(a) ?? 0));
  }

  private async searchViaDb(term: string, q: SearchQueryDto, userId?: string) {
    const hideAnime = q.hideAnime || (await this.resolveHideAnime(userId));
    const exclude = this.parseSlugList(q.excludeGenres);
    const country = q.country?.trim().toUpperCase();
    // some + none combine on the genres relation: inclusion chip AND multi-exclusion.
    const genreSome = q.genre?.trim()
      ? { some: { genre: { slug: { equals: q.genre.trim(), mode: 'insensitive' as const } } } }
      : undefined;
    const where: Prisma.MediaItemWhereInput = {
      OR: [
        { title: { contains: term, mode: 'insensitive' as const } },
        { show: { is: { originalTitle: { contains: term, mode: 'insensitive' as const } } } },
      ],
      ...(q.type ? { type: q.type } : {}),
      ...(hideAnime ? { contentClassification: { not: 'ANIME' as const } } : {}),
      ...(genreSome || exclude.length
        ? {
            genres: {
              ...(genreSome ?? {}),
              ...(exclude.length
                ? { none: { genre: { slug: { in: exclude, mode: 'insensitive' as const } } } }
                : {}),
            },
          }
        : {}),
      // Country: known-mismatch semantics via countryWhere (unknown origin is kept).
      ...(country ? this.countryWhere(country, q.type) : {}),
    };
    // releaseDate sort is year-granular for shows (yearStart — shows store no full
    // release date); a mixed-type search keeps popularity (two relation order-bys
    // would sink every movie below every show).
    const orderBy: Prisma.MediaItemOrderByWithRelationInput =
      q.sort === 'releaseDate'
        ? q.type === MediaType.MOVIE
          ? { movie: { releaseDate: 'desc' } }
          : q.type === MediaType.SHOW
            ? { show: { yearStart: 'desc' } }
            : { popularity: 'desc' }
        : { popularity: 'desc' };
    const [rows, total] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where,
        skip: ((q.page || 1) - 1) * (q.pageSize || 20),
        take: q.pageSize,
        orderBy,
      }),
      this.prisma.mediaItem.count({ where }),
    ]);
    // Poster-last within the page (same ranking rule as the provider search).
    const ordered = [...rows.filter((r) => r.posterUrl), ...rows.filter((r) => !r.posterUrl)];
    const ids = ordered.map((r) => r.id);
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
      excludeGenres: await this.tmdbIdsForSlugs(this.parseSlugList(q.excludeGenres)),
      country: q.country?.trim().toUpperCase() || undefined,
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
      excludeGenres: await this.tmdbIdsForSlugs(this.parseSlugList(q.excludeGenres)),
      country: q.country?.trim().toUpperCase() || undefined,
    });
    const ids = await Promise.all(res.items.map((i) => this.meta.lightUpsertMovie(i)));
    const items = await this.fetchListDtos(ids, userId);
    return paginate(items, q.page, q.pageSize, res.total);
  }

  /**
   * List entries with a short cache: resolving a page costs a TMDb call plus one
   * lightUpsert per item (each = 1 externalId read + a mediaItem write), so an
   * uncached Discover open did ~80 queries, half of them writes. Entries are
   * user-agnostic and carry the payload's TMDB genre ids so genre filters need no
   * extra provider call; user-specific flags are applied by fetchListDtos afterwards.
   * Shared by trending and the curated lists (top-rated / now-playing / upcoming).
   */
  private async cachedListEntries(
    cacheNs: string,
    kind: 'show' | 'movie',
    page: number,
    fetchPage: (page: number) => Promise<NormalizedSearchItem[]>,
  ): Promise<TrendingEntry[]> {
    const key = `${cacheNs}:${kind}:${currentLanguage()}:${page}`;
    const cached = await this.redis.get<TrendingEntry[]>(key);
    if (cached?.length) return cached;
    const items = await fetchPage(page);
    const entries = await Promise.all(
      items.map(async (i) => ({
        id: await (kind === 'show' ? this.meta.lightUpsertShow(i) : this.meta.lightUpsertMovie(i)),
        g: i.genreIds ?? [],
        oc: i.originCountries ?? [],
      })),
    );
    if (entries.length) await this.redis.set(key, entries, 300);
    return entries;
  }

  /** Latest completed scheduled hydration for a rail; running/failed refreshes never activate. */
  private async completedRailSnapshot(railType: HydrationJobType, snapshotId?: string) {
    const job = await this.prisma.hydrationJob.findFirst({
      where: {
        type: railType,
        status: 'completed',
        railSnapshot: true,
        ...(snapshotId ? { id: snapshotId } : {}),
      },
      orderBy: { completedAt: 'desc' },
      select: {
        id: true,
        items: {
          where: { status: 'done', mediaId: { not: null }, rank: { not: null } },
          orderBy: [{ rank: 'asc' }, { id: 'asc' }],
          select: { mediaId: true },
        },
      },
    });
    if (!job) return null;
    const ids = job.items.flatMap((item) => (item.mediaId ? [item.mediaId] : []));
    return ids.length ? { id: job.id, ids } : null;
  }

  private exploreMediaWhere(
    type: MediaType,
    q: ExploreFilterInput | undefined,
    hideAnime: boolean,
  ): Prisma.MediaItemWhereInput {
    const exclude = this.parseSlugList(q?.excludeGenres);
    const country = q?.country?.trim().toUpperCase();
    const genreSome = q?.genre?.trim()
      ? { some: { genre: { slug: { equals: q.genre.trim(), mode: 'insensitive' as const } } } }
      : undefined;
    return {
      type,
      ...(hideAnime ? { contentClassification: { not: 'ANIME' as const } } : {}),
      ...(genreSome || exclude.length
        ? {
            genres: {
              ...(genreSome ?? {}),
              ...(exclude.length
                ? { none: { genre: { slug: { in: exclude, mode: 'insensitive' as const } } } }
                : {}),
            },
          }
        : {}),
      ...(q?.minRating ? { rating: { gte: q.minRating } } : {}),
      ...(country ? this.countryWhere(country, type) : {}),
    };
  }

  private exploreOrderBy(
    type: MediaType,
    q?: ExploreFilterInput,
  ): Prisma.MediaItemOrderByWithRelationInput {
    return q?.sort === 'releaseDate'
      ? type === MediaType.MOVIE
        ? { movie: { releaseDate: 'desc' } }
        : { show: { yearStart: 'desc' } }
      : { popularity: 'desc' };
  }

  /** Page a durable rail snapshot while applying filters against hydrated DB metadata. */
  private async snapshotListPage(
    opts: RailListOptions,
    userId: string | undefined,
    page: number,
    pageSize: number,
    genre: string | undefined,
    filters: ExploreFiltersDto | undefined,
    compact: boolean,
    snapshotId?: string,
  ) {
    const snapshot = await this.completedRailSnapshot(opts.railType, snapshotId);
    if (!snapshot) return null;
    const type = opts.kind === 'show' ? MediaType.SHOW : MediaType.MOVIE;
    const hideAnime = (filters?.hideAnime ?? false) || (await this.resolveHideAnime(userId));
    const where = this.exploreMediaWhere(type, { ...filters, genre }, hideAnime);
    const matching = await this.prisma.mediaItem.findMany({
      where: { ...where, id: { in: snapshot.ids } },
      select: { id: true },
    });
    const matchingIds = new Set(matching.map((item) => item.id));
    let ordered = snapshot.ids.filter((id) => matchingIds.has(id));
    if (filters?.sort === 'releaseDate') ordered = await this.sortIdsByReleaseDesc(ordered);

    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, pageSize);
    const start = (safePage - 1) * safePageSize;
    const pageIds = ordered.slice(start, start + safePageSize);
    const items = compact
      ? await this.fetchCardDtos(pageIds, userId, safePageSize)
      : await this.fetchListDtos(pageIds, userId, safePageSize);
    return {
      items,
      page: safePage,
      hasMore: ordered.length > start + safePageSize,
      snapshotId: snapshot.id,
    };
  }

  /** Ranked-catalog fallback used only before a rail has its first snapshot or during rollout. */
  private async databaseListPage(
    type: MediaType,
    page: number,
    pageSize: number,
    userId?: string,
    q?: ExploreFilterInput,
    compact = false,
  ) {
    const hideAnime = (q?.hideAnime ?? false) || (await this.resolveHideAnime(userId));
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, pageSize);
    const rows = await this.prisma.mediaItem.findMany({
      where: this.exploreMediaWhere(type, q, hideAnime),
      orderBy: this.exploreOrderBy(type, q),
      skip: (safePage - 1) * safePageSize,
      take: safePageSize + 1,
      select: { id: true },
    });
    const pageIds = rows.slice(0, safePageSize).map((row) => row.id);
    const items = compact
      ? await this.fetchCardDtos(pageIds, userId, safePageSize)
      : await this.fetchListDtos(pageIds, userId, safePageSize);
    return { items, page: safePage, hasMore: rows.length > safePageSize };
  }

  /**
   * Shared paged-list flow (trending + curated lists): unfiltered pages come from
   * the short entry cache; genre/exclusion/country filters accumulate a filtered
   * upstream window; sort=releaseDate re-orders the window newest-first.
   */
  private async listPage(
    opts: RailListOptions,
    userId?: string,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
    compact = false,
    snapshotId?: string,
  ) {
    const snapshot = await this.snapshotListPage(
      opts,
      userId,
      page,
      pageSize,
      genre,
      filters,
      compact,
      snapshotId,
    );
    if (snapshot) return snapshot;

    const type = opts.kind === 'show' ? MediaType.SHOW : MediaType.MOVIE;
    if (!this.tmdb.enabled)
      return this.databaseListPage(type, page, pageSize, userId, { ...filters, genre }, compact);

    try {
      const hideAnime = (filters?.hideAnime ?? false) || (await this.resolveHideAnime(userId));
      const releaseSort = filters?.sort === 'releaseDate';
      const g = genre?.trim();
      if (g || this.parseSlugList(filters?.excludeGenres).length > 0 || filters?.country?.trim()) {
        const entriesFor = (p: number) =>
          this.cachedListEntries(opts.idsNs, opts.kind, p, opts.fetchPage);
        const win = await this.listWindow(
          opts.windowNs,
          opts.kind,
          g,
          page * pageSize,
          hideAnime,
          filters,
          entriesFor,
        );
        const ids = releaseSort ? await this.sortIdsByReleaseDesc(win.ids) : win.ids;
        const pageIds = ids.slice((page - 1) * pageSize, page * pageSize);
        const items = compact
          ? await this.fetchCardDtos(pageIds, userId, pageSize)
          : await this.fetchListDtos(pageIds, userId, pageSize);
        return { items, page, hasMore: ids.length > page * pageSize || !win.exhausted };
      }
      const entries = await this.cachedListEntries(opts.idsNs, opts.kind, page, opts.fetchPage);
      const visible = hideAnime ? await this.filterAnimeEntries(entries) : entries;
      const ids = visible.map((e) => e.id);
      const ordered = releaseSort ? await this.sortIdsByReleaseDesc(ids) : ids;
      const listItems = compact
        ? await this.fetchCardDtos(ordered, userId, pageSize)
        : await this.fetchListDtos(ordered, userId, pageSize);
      return { items: listItems, page, hasMore: entries.length === 20 };
    } catch (error) {
      if (!isProviderError(error)) throw error;
      this.logger.warn(
        `Explore rail ${opts.railType} fell back to the catalog (${error.category}): ${error.message}`,
      );
      return this.databaseListPage(type, page, pageSize, userId, { ...filters, genre }, compact);
    }
  }

  private trendingListOpts(kind: 'show' | 'movie') {
    return {
      railType:
        kind === 'show' ? HydrationJobType.trending_shows : HydrationJobType.trending_movies,
      idsNs: 'trending:ids:v3',
      windowNs: 'trending:filtered:v1',
      kind,
      fetchPage: (p: number) =>
        kind === 'show' ? this.tmdb.trendingShows('week', p) : this.tmdb.trendingMovies('week', p),
    };
  }

  async trendingShows(
    userId?: string,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
    compact = false,
    snapshotId?: string,
  ) {
    // NOTE: TMDB trending has no server-side sort — with sort=releaseDate the
    // filtered window / page is re-ordered newest-first locally (sortIdsByReleaseDesc).
    return this.listPage(
      this.trendingListOpts('show'),
      userId,
      page,
      pageSize,
      genre,
      filters,
      compact,
      snapshotId,
    );
  }

  async trendingMovies(
    userId?: string,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
    compact = false,
    snapshotId?: string,
  ) {
    return this.listPage(
      this.trendingListOpts('movie'),
      userId,
      page,
      pageSize,
      genre,
      filters,
      compact,
      snapshotId,
    );
  }

  async topRatedShows(
    userId?: string,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
    compact = false,
    snapshotId?: string,
  ) {
    return this.listPage(
      {
        railType: HydrationJobType.top_rated_shows,
        idsNs: 'list:ids:v1:top-rated',
        windowNs: 'list:filtered:v1:top-rated',
        kind: 'show',
        fetchPage: (p) => this.tmdb.topRatedShows(p),
      },
      userId,
      page,
      pageSize,
      genre,
      filters,
      compact,
      snapshotId,
    );
  }

  async topRatedMovies(
    userId?: string,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
    compact = false,
    snapshotId?: string,
  ) {
    return this.listPage(
      {
        railType: HydrationJobType.top_rated_movies,
        idsNs: 'list:ids:v1:top-rated',
        windowNs: 'list:filtered:v1:top-rated',
        kind: 'movie',
        fetchPage: (p) => this.tmdb.topRatedMovies(p),
      },
      userId,
      page,
      pageSize,
      genre,
      filters,
      compact,
      snapshotId,
    );
  }

  async nowPlayingMovies(
    userId?: string,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
    compact = false,
    snapshotId?: string,
  ) {
    return this.listPage(
      {
        railType: HydrationJobType.now_playing_movies,
        idsNs: 'list:ids:v1:now-playing',
        windowNs: 'list:filtered:v1:now-playing',
        kind: 'movie',
        fetchPage: (p) => this.tmdb.nowPlayingMovies(p),
      },
      userId,
      page,
      pageSize,
      genre,
      filters,
      compact,
      snapshotId,
    );
  }

  /**
   * Filtered list window: a genre chip (or exclusion/country filter) applied to
   * a single 20-item list page leaves only a handful of cards (and an
   * unscrollable see-all — short content never fires onEndReached), so filtered
   * results are accumulated across upstream pages (cap 10) and cached per
   * (source, kind, lang, genre, filter fingerprint). The window expands on demand
   * when deeper pages are requested. Shared by trending and the curated lists.
   */
  private async listWindow(
    windowNs: string,
    kind: 'show' | 'movie',
    genre: string | undefined,
    target: number,
    hideAnime = false,
    filters: ExploreFiltersDto | undefined,
    entriesFor: (page: number) => Promise<TrendingEntry[]>,
  ): Promise<{ ids: string[]; upstreamPages: number; exhausted: boolean }> {
    // Filter fingerprint: exclusion slugs + country scope the cached window —
    // same pattern as the :noanime|:all segment.
    const exclude = this.parseSlugList(filters?.excludeGenres);
    const country = filters?.country?.trim().toUpperCase();
    const key = `${windowNs}:${kind}:${currentLanguage()}:${genre?.toLowerCase() || 'all'}:${hideAnime ? 'noanime' : 'all'}:${exclude.join(',') || '-'}:${country || '-'}`;
    const win = (await this.redis.get<{ ids: string[]; upstreamPages: number; exhausted: boolean }>(
      key,
    )) ?? { ids: [], upstreamPages: 0, exhausted: false };
    let rounds = 0;
    while (win.ids.length < target && !win.exhausted && rounds < 5) {
      if (win.upstreamPages >= 10) {
        win.exhausted = true;
        break;
      }
      const entries = await entriesFor(win.upstreamPages + 1);
      win.upstreamPages += 1;
      rounds += 1;
      if (!entries.length) {
        win.exhausted = true;
        break;
      }
      const visible = hideAnime ? await this.filterAnimeEntries(entries) : entries;
      const kept = await this.filterEntriesExcluding(visible, exclude, country, kind);
      win.ids.push(...(await this.applyGenreToEntries(kept, genre)));
      if (entries.length < 20) win.exhausted = true;
    }
    win.ids = [...new Set(win.ids)];
    await this.redis.set(key, win, 300);
    return win;
  }

  private async applyGenreToEntries(entries: TrendingEntry[], genre?: string): Promise<string[]> {
    const ids = entries.map((e) => e.id);
    if (!genre?.trim()) return ids;
    const payload: Record<string, number[]> = {};
    for (const e of entries) payload[e.id] = e.g;
    return this.filterIdsByGenre(ids, genre.trim(), payload);
  }

  /**
   * TMDB genre ids (tv + movie lists) matching a genre name — used to filter light
   * rows by the genre ids carried in provider payloads. Lists cached 24h.
   */
  private async tmdbGenreIds(name: string): Promise<number[]> {
    const key = 'tmdb:genre-lists:v1';
    let lists = await this.redis.get<{
      tv: { id: number; name: string }[];
      movie: { id: number; name: string }[];
    }>(key);
    if (!lists) {
      const [tv, movie] = this.tmdb.enabled
        ? await Promise.all([
            this.tmdb.genres('tv').catch(() => [] as { id: number; name: string }[]),
            this.tmdb.genres('movie').catch(() => [] as { id: number; name: string }[]),
          ])
        : [[], []];
      lists = { tv, movie };
      await this.redis.set(key, lists, 86400);
    }
    const needle = name.trim().toLowerCase();
    return [...lists.tv, ...lists.movie]
      .filter((g) => g.name.toLowerCase() === needle)
      .map((g) => g.id);
  }

  /**
   * Genre filter over an id window. The filter value is a genre SLUG (locale-
   * independent): hydrated rows match through the media_genres join on slug,
   * light rows through the TMDB genre ids cached from the provider payload
   * (the row's English base name maps slug → TMDB genre id).
   */
  private async filterIdsByGenre(
    ids: string[],
    genre: string,
    payloadGenreIds: Record<string, number[]>,
  ): Promise<string[]> {
    if (ids.length === 0) return ids;
    const [row, dbRows] = await Promise.all([
      this.prisma.genre.findFirst({
        where: { slug: { equals: genre, mode: 'insensitive' } },
        select: { name: true },
      }),
      this.prisma.mediaItem.findMany({
        where: {
          id: { in: ids },
          genres: { some: { genre: { slug: { equals: genre, mode: 'insensitive' } } } },
        },
        select: { id: true },
      }),
    ]);
    const tmdbIds = await this.tmdbGenreIds(row?.name ?? genre);
    const dbMatched = new Set(dbRows.map((r) => r.id));
    return ids.filter(
      (id) => dbMatched.has(id) || (payloadGenreIds[id] ?? []).some((g) => tmdbIds.includes(g)),
    );
  }

  /** Comma-separated slug list → trimmed, lowercased, deduped. */
  private parseSlugList(value?: string): string[] {
    return [
      ...new Set(
        (value ?? '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
  }

  /**
   * Genre slugs → TMDB genre ids, reusing the same mapping as filterIdsByGenre:
   * the row's English base name maps slug → TMDB genre id (unknown slugs fall back
   * to the raw slug as a name, matching filterIdsByGenre's row?.name ?? genre).
   */
  private async tmdbIdsForSlugs(slugs: string[]): Promise<number[]> {
    if (slugs.length === 0) return [];
    const rows = await this.prisma.genre.findMany({
      where: { slug: { in: slugs, mode: 'insensitive' } },
      select: { slug: true, name: true },
    });
    const found = new Set(rows.map((r) => r.slug.toLowerCase()));
    const names = [...rows.map((r) => r.name), ...slugs.filter((s) => !found.has(s))];
    const ids = (await Promise.all(names.map((n) => this.tmdbGenreIds(n)))).flat();
    return [...new Set(ids)];
  }

  /**
   * Inverse of filterIdsByGenre: drop ids matching ANY of the excluded slugs —
   * hydrated rows via the media_genres join, light rows via cached TMDB payload ids.
   */
  private async excludeIdsByGenres(
    ids: string[],
    slugs: string[],
    payloadGenreIds: Record<string, number[]>,
  ): Promise<string[]> {
    if (ids.length === 0 || slugs.length === 0) return ids;
    const [tmdbIds, dbRows] = await Promise.all([
      this.tmdbIdsForSlugs(slugs),
      this.prisma.mediaItem.findMany({
        where: {
          id: { in: ids },
          genres: { some: { genre: { slug: { in: slugs, mode: 'insensitive' } } } },
        },
        select: { id: true },
      }),
    ]);
    const excluded = new Set(dbRows.map((r) => r.id));
    return ids.filter(
      (id) => !excluded.has(id) && !(payloadGenreIds[id] ?? []).some((g) => tmdbIds.includes(g)),
    );
  }

  /**
   * Country where-fragment. SHOWS use known-mismatch semantics (originCountries coverage
   * is ~100%, unknowns kept); MOVIES use STRICT matching (known country must equal) —
   * keeping the 60k+ NULL-country rows would make the filter a no-op; coverage grows via
   * the repairMovieCountries backfill. Legacy full-name values normalize to ISO.
   */
  private static readonly COUNTRY_NAME_VARIANTS: Record<string, string[]> = {
    US: ['United States of America', 'United States'],
    GB: ['Great Britain', 'United Kingdom'],
    JP: ['Japan'],
    FR: ['France'],
    IT: ['Italy'],
    IN: ['India'],
    ES: ['Spain'],
    DE: ['Germany'],
    CA: ['Canada'],
    BR: ['Brazil'],
    TR: ['Turkey'],
    AR: ['Argentina'],
    CN: ['China'],
    KR: ['South Korea'],
    AU: ['Australia'],
  };

  /** Strict movie-country match (equals or full-name variant) for a media id window. */
  private async strictMovieCountryIds(ids: string[], country: string): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const variants = DiscoveryService.COUNTRY_NAME_VARIANTS[country] ?? [];
    const rows = await this.prisma.movie.findMany({
      where: {
        mediaId: { in: ids },
        OR: [
          { country: { equals: country, mode: 'insensitive' } },
          ...(variants.length ? [{ country: { in: variants, mode: 'insensitive' as const } }] : []),
        ],
      },
      select: { mediaId: true },
    });
    return new Set(rows.map((r) => r.mediaId));
  }

  private countryWhere(country: string, type?: string): Prisma.MediaItemWhereInput {
    const variants = DiscoveryService.COUNTRY_NAME_VARIANTS[country] ?? [];
    const movieMatch: Prisma.MediaItemWhereInput = {
      movie: {
        is: {
          OR: [
            { country: { equals: country, mode: 'insensitive' } },
            ...(variants.length
              ? [{ country: { in: variants, mode: 'insensitive' as const } }]
              : []),
          ],
        },
      },
    };
    const showMatch: Prisma.MediaItemWhereInput = {
      show: {
        is: {
          OR: [{ originCountries: { has: country } }, { originCountries: { isEmpty: true } }],
        },
      },
    };
    if (type === 'MOVIE') return movieMatch;
    if (type === 'SHOW') return showMatch;
    return { OR: [movieMatch, showMatch] };
  }

  /**
   * Country filter over an id window (provider search path): shows match on
   * originCountries, movies on the production country — both with known-mismatch
   * semantics (unknown origin stays in the window).
   */
  private async filterIdsByCountry(ids: string[], country: string): Promise<string[]> {
    if (ids.length === 0) return ids;
    const rows = await this.prisma.mediaItem.findMany({
      where: {
        id: { in: ids },
        AND: [this.countryWhere(country)],
      },
      select: { id: true },
    });
    const keep = new Set(rows.map((r) => r.id));
    return ids.filter((id) => keep.has(id));
  }

  /**
   * Exclusion + country filters on trending entries, straight from the cached
   * payload signals (genre ids + origin countries) — zero extra provider calls.
   */
  private async filterEntriesExcluding(
    entries: TrendingEntry[],
    excludeSlugs: string[],
    country?: string,
    kind?: 'show' | 'movie',
  ): Promise<TrendingEntry[]> {
    let out = entries;
    if (excludeSlugs.length) {
      const tmdbIds = await this.tmdbIdsForSlugs(excludeSlugs);
      out = out.filter((e) => !e.g.some((g) => tmdbIds.includes(g)));
    }
    if (country) {
      if (kind === 'movie') {
        // STRICT for movies: trending payloads almost never carry origin data, so the
        // production country comes from the DB (coverage grows via repairMovieCountries).
        const keep = await this.strictMovieCountryIds(
          out.map((e) => e.id),
          country,
        );
        out = out.filter((e) => keep.has(e.id));
      } else {
        // Shows: payload origin_country has near-full coverage — known-mismatch is fine.
        out = out.filter((e) => {
          const oc = e.oc ?? [];
          return oc.length === 0 || oc.includes(country);
        });
      }
    }
    return out;
  }

  /** Genres present in the catalog, most-used first — filter chip lists. */
  async listGenres(): Promise<GenreFilterDto[]> {
    const rows = await this.prisma.genre.findMany({
      where: { media: { some: {} } },
      include: { _count: { select: { media: true } } },
      orderBy: { media: { _count: 'desc' } },
    });
    return rows.map((g) => ({
      id: g.id,
      name: localized(g, 'names', 'name') ?? g.name,
      slug: g.slug,
    }));
  }

  async discoverSections(userId?: string, genre?: string, filters?: ExploreFiltersDto) {
    const g = genre?.trim() || undefined;
    // Personalization is intentionally NOT part of this request. It has its own
    // show/movie endpoints, so an expensive cold affinity rebuild cannot hold the
    // catalog rails hostage. Explore cards also use the compact poster DTO.
    const [trendingShows, trendingMovies, topRatedShows, topRatedMovies, nowPlaying] =
      await Promise.all([
        this.trendingShows(userId, 1, 20, g, filters, true),
        this.trendingMovies(userId, 1, 20, g, filters, true),
        this.topRatedShows(userId, 1, 20, g, filters, true),
        this.topRatedMovies(userId, 1, 20, g, filters, true),
        this.nowPlayingMovies(userId, 1, 20, g, filters, true),
      ]);
    return {
      trendingShows: trendingShows.items,
      trendingMovies: trendingMovies.items,
      topRatedShows: topRatedShows.items,
      topRatedMovies: topRatedMovies.items,
      nowPlayingMovies: nowPlaying.items,
    };
  }

  /**
   * Paginated personalized shows. The cached value contains ids only, so it is
   * locale-independent and can be warmed outside a request language context.
   */
  async forYou(
    userId: string | undefined,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
  ) {
    return this.personalizedForYou(MediaType.SHOW, userId, page, pageSize, genre, filters);
  }

  /** Paginated personalized movies; taste signals still come from both media types. */
  async moviesForYou(
    userId: string | undefined,
    page = 1,
    pageSize = 20,
    genre?: string,
    filters?: ExploreFiltersDto,
  ) {
    return this.personalizedForYou(MediaType.MOVIE, userId, page, pageSize, genre, filters);
  }

  private async personalizedForYou(
    type: MediaType,
    userId: string | undefined,
    page: number,
    pageSize: number,
    genre?: string,
    filters?: ExploreFiltersDto,
  ) {
    if (!userId) {
      return type === MediaType.SHOW
        ? this.trendingShows(undefined, page, pageSize, genre, filters, true)
        : this.trendingMovies(undefined, page, pageSize, genre, filters, true);
    }
    let ids = await this.personalizedIds(type, userId, genre, filters);
    // releaseDate sort: re-order the ranked window newest-first (the cached ranking
    // is sort-agnostic — the affinity order is just the default view).
    if (filters?.sort === 'releaseDate') ids = await this.sortIdsByReleaseDesc(ids);
    const items = await this.fetchCardDtos(
      ids.slice((page - 1) * pageSize, page * pageSize),
      userId,
      pageSize,
    );
    return { items, page, hasMore: ids.length > page * pageSize };
  }

  private forYouKey(
    type: MediaType,
    userId: string,
    genre: string | undefined,
    hideAnime: boolean,
    filters?: ExploreFiltersDto,
  ) {
    const fp = `${this.parseSlugList(filters?.excludeGenres).join(',') || '-'}:${filters?.country?.trim().toUpperCase() || '-'}`;
    return `foryou:v3:${userId}:${type.toLowerCase()}:${genre?.trim().toLowerCase() || 'all'}:${hideAnime ? 'noanime' : 'all'}:${fp}`;
  }

  private async personalizedIds(
    type: MediaType,
    userId: string,
    genre?: string,
    filters?: ExploreFiltersDto,
    force = false,
    resolvedHideAnime?: boolean,
  ): Promise<string[]> {
    const hideAnime =
      resolvedHideAnime ?? ((filters?.hideAnime ?? false) || (await this.resolveHideAnime(userId)));
    const normalizedGenre = genre?.trim() || undefined;
    const key = this.forYouKey(type, userId, normalizedGenre, hideAnime, filters);
    let ids = force ? null : await this.redis.get<string[]>(key);
    if (!ids) {
      const ranking = await this.rankForYouIds(userId, normalizedGenre, hideAnime, filters, type);
      ids = ranking.ids;
      // Empty rankings are NOT cached: a brand-new user's first open would
      // otherwise poison the section after their first library changes.
      // Cold-start fallbacks are also left uncached: search-created light media
      // can gain genres/keywords shortly afterward, and the next read should use
      // that richer signal instead of a five-minute generic ranking.
      if (ids.length && ranking.cacheable) await this.redis.set(key, ids, 300);
    }
    return ids;
  }

  /** Rebuild both default personalized rails after a user's library changes. */
  async warmPersonalizedRecommendations(userId: string): Promise<void> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      select: { hideAnimeInExplore: true, exploreDefaultFilters: true },
    });
    const saved =
      profile?.exploreDefaultFilters &&
      typeof profile.exploreDefaultFilters === 'object' &&
      !Array.isArray(profile.exploreDefaultFilters)
        ? (profile.exploreDefaultFilters as Record<string, unknown>)
        : undefined;
    const excludeGenres = Array.isArray(saved?.excludeGenres)
      ? saved.excludeGenres.filter((value): value is string => typeof value === 'string').join(',')
      : undefined;
    const filters: ExploreFiltersDto = {
      excludeGenres,
      country: typeof saved?.country === 'string' ? saved.country : undefined,
      sort: saved?.order === 'releaseDate' ? 'releaseDate' : undefined,
      hideAnime: saved?.hideAnime === true,
    };
    const genre = typeof saved?.genre === 'string' ? saved.genre : undefined;
    const hideAnime = filters.hideAnime || (profile?.hideAnimeInExplore ?? false);
    await Promise.all([
      this.personalizedIds(MediaType.SHOW, userId, genre, filters, true, hideAnime),
      this.personalizedIds(MediaType.MOVIE, userId, genre, filters, true, hideAnime),
    ]);
  }

  /**
   * Personalized ranking. Affinity comes from the user's genres
   * (history ×2, favorites/watchlist ×1) AND the TMDB keywords of their library;
   * candidates are then ranked by affinity + community rating + recency, so
   * fresh well-rated matches beat old catalog filler. Anything the user already
   * watched, watchlisted, or favorited is excluded. With a genre filter active the
   * pool is that genre's whole catalog (affinity still drives the ranking), so a
   * filter never starves the section. Returns the ranked ids (cap 300).
   */
  private async rankForYouIds(
    userId: string,
    genre?: string,
    hideAnime = false,
    filters?: ExploreFiltersDto,
    type: MediaType = MediaType.SHOW,
  ): Promise<{ ids: string[]; cacheable: boolean }> {
    const exclude = this.parseSlugList(filters?.excludeGenres);
    const country = filters?.country?.trim().toUpperCase();
    // Score genres: watch history counts double; favorites and watchlist +1 each.
    // Aggregates in SQL — the old findMany pulled every mediaGenre row for the
    // user's entire library (thousands of rows) on every Discover open.
    // EXISTS keeps the old semantics: each mediaGenre row counts once per media,
    // regardless of how many history rows that media has.
    const [histGenres, favGenres, watchlistGenres] = await Promise.all([
      this.prisma.$queryRaw<{ name: string; c: number }[]>`
        SELECT g.name, COUNT(*)::int AS c
        FROM media_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE EXISTS (SELECT 1 FROM watch_history wh WHERE wh.media_id = mg.media_id AND wh.user_id = ${userId})
        GROUP BY g.name
      `,
      this.prisma.$queryRaw<{ name: string; c: number }[]>`
        SELECT g.name, COUNT(*)::int AS c
        FROM media_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = mg.media_id AND f.user_id = ${userId})
        GROUP BY g.name
      `,
      this.prisma.$queryRaw<{ name: string; c: number }[]>`
        SELECT g.name, COUNT(*)::int AS c
        FROM media_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE EXISTS (SELECT 1 FROM watchlist_items wi WHERE wi.media_id = mg.media_id AND wi.user_id = ${userId})
        GROUP BY g.name
      `,
    ]);
    const scores = new Map<string, number>();
    for (const r of histGenres) scores.set(r.name, (scores.get(r.name) ?? 0) + 2 * r.c);
    for (const r of favGenres) scores.set(r.name, (scores.get(r.name) ?? 0) + r.c);
    for (const r of watchlistGenres) scores.set(r.name, (scores.get(r.name) ?? 0) + r.c);
    const topGenres = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const genreNames = topGenres.map(([name]) => name);
    // Keyword affinity: frequency of TMDB keywords over the user's watched,
    // favorited, and watchlisted titles (persisted at hydration) — catches signals
    // genres are too coarse for (e.g. "isekai", "true crime", "sitcom").
    // Load exclusions alongside keywords. Besides saving a sequential DB round trip,
    // the exclusions tell us whether a metadata-light user has any library at all.
    const [topKeywords, excludedRows] = await Promise.all([
      this.prisma.$queryRaw<{ kw: string; c: number }[]>`
        WITH taste_media AS MATERIALIZED (
          SELECT media_id FROM watch_history WHERE user_id = ${userId}
          UNION
          SELECT media_id FROM favorites WHERE user_id = ${userId}
          UNION
          SELECT media_id FROM watchlist_items WHERE user_id = ${userId}
        )
        SELECT kw, COUNT(*)::int AS c FROM (
          SELECT jsonb_array_elements_text(s.keywords::jsonb) AS kw
          FROM taste_media t
          JOIN shows s ON s.media_id = t.media_id
          WHERE jsonb_typeof(s.keywords::jsonb) = 'array'
          UNION ALL
          SELECT jsonb_array_elements_text(m.keywords::jsonb) AS kw
          FROM taste_media t
          JOIN movies m ON m.media_id = t.media_id
          WHERE jsonb_typeof(m.keywords::jsonb) = 'array'
        ) kws
        GROUP BY kw
        ORDER BY c DESC
        LIMIT 12
      `,
      this.prisma.$queryRaw<{ media_id: string }[]>`
        SELECT media_id FROM watch_history WHERE user_id = ${userId}
        UNION SELECT media_id FROM watchlist_items WHERE user_id = ${userId}
        UNION SELECT media_id FROM favorites WHERE user_id = ${userId}
      `,
    ]);
    const keywordWeight = new Map(topKeywords.map((r, i) => [r.kw.toLowerCase(), 12 - i]));

    // Novelty: never recommend what the user already tracks.
    const excludedIds = excludedRows.map((r) => r.media_id);
    // A truly empty account has no basis for a "For You" rail. A user with library
    // items but no persisted genres/keywords yet gets an immediate quality-ranked
    // fallback; this is common while a search-created light row is being hydrated.
    if (excludedIds.length === 0 && !genre) return { ids: [], cacheable: false };
    const hasAffinity = genreNames.length > 0 || topKeywords.length > 0 || !!genre;

    const candidates = await this.prisma.mediaItem.findMany({
      where: {
        type,
        posterUrl: { not: null },
        // User opted out of anime: ANIME-classified rows leave the candidate pool.
        ...(hideAnime ? { contentClassification: { not: 'ANIME' } } : {}),
        // Genre filter active: the pool is that genre's catalog (affinity only ranks).
        // Otherwise: the pool is the user's affinity genres. Excluded slugs leave the
        // pool either way (some + none combine on the genres relation).
        ...(genre || genreNames.length > 0 || exclude.length > 0
          ? {
              genres: {
                ...(genre
                  ? {
                      some: {
                        genre: { slug: { equals: genre, mode: 'insensitive' as const } },
                      },
                    }
                  : genreNames.length > 0
                    ? { some: { genre: { name: { in: genreNames } } } }
                    : {}),
                ...(exclude.length
                  ? {
                      none: {
                        genre: { slug: { in: exclude, mode: 'insensitive' as const } },
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(country ? this.countryWhere(country, type) : {}),
        id: { notIn: excludedIds },
      },
      include: {
        genres: { include: { genre: true } },
        show: { select: { keywords: true, yearStart: true } },
        movie: { select: { keywords: true, releaseYear: true } },
      },
      orderBy: { popularity: 'desc' },
      take: 600,
    });

    // Rank: genre affinity (rank-weighted) + keyword affinity (capped) +
    // community rating + recency boost (old catalogs sink, fresh shows float).
    const genreRank = new Map(topGenres.map(([name], idx) => [name, idx]));
    const thisYear = new Date().getFullYear();
    const scored = candidates.map((m) => {
      let score = 0;
      for (const mg of m.genres) {
        const rank = genreRank.get(mg.genre.name);
        if (rank !== undefined) score += 12 - rank * 2;
      }
      const rawKeywords = type === MediaType.SHOW ? m.show?.keywords : m.movie?.keywords;
      const kws = Array.isArray(rawKeywords) ? (rawKeywords as string[]) : [];
      let kwScore = 0;
      for (const k of kws) kwScore += keywordWeight.get(k.toLowerCase()) ?? 0;
      score += Math.min(kwScore, 18);
      score += m.rating ?? 0;
      const year =
        type === MediaType.SHOW ? (m.show?.yearStart ?? null) : (m.movie?.releaseYear ?? null);
      if (year) {
        const age = thisYear - year;
        if (age <= 3) score += 10;
        else if (age <= 7) score += 6;
        else if (age <= 12) score += 3;
        else if (age > 25) score -= 6;
      }
      return { id: m.id, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // Cap the cached ranking at 300 — plenty of scroll depth, bounded Redis payload.
    return { ids: scored.slice(0, 300).map((s) => s.id), cacheable: hasAffinity };
  }

  private async discoverViaDb(type: MediaType, q: DiscoverQueryDto, userId?: string) {
    return this.topDb(type, q.pageSize || 20, userId, q);
  }

  private async topDb(
    type: MediaType,
    limit: number,
    userId?: string,
    q?: ExploreFilterInput,
    compact = false,
  ) {
    const hideAnime = (q?.hideAnime ?? false) || (await this.resolveHideAnime(userId));
    const exclude = this.parseSlugList(q?.excludeGenres);
    const country = q?.country?.trim().toUpperCase();
    const genreSome = q?.genre?.trim()
      ? { some: { genre: { slug: { equals: q.genre.trim(), mode: 'insensitive' as const } } } }
      : undefined;
    const where: Prisma.MediaItemWhereInput = {
      type,
      ...(hideAnime ? { contentClassification: { not: 'ANIME' as const } } : {}),
      // some + none combine on the genres relation: inclusion chip AND multi-exclusion.
      ...(genreSome || exclude.length
        ? {
            genres: {
              ...(genreSome ?? {}),
              ...(exclude.length
                ? { none: { genre: { slug: { in: exclude, mode: 'insensitive' as const } } } }
                : {}),
            },
          }
        : {}),
      ...(q?.minRating ? { rating: { gte: q.minRating } } : {}),
      // Country: known-mismatch semantics via countryWhere (unknown origin is kept).
      ...(country ? this.countryWhere(country, type) : {}),
    };
    // releaseDate sort is year-granular for shows (yearStart — shows store no full
    // release date); default popularity is unchanged.
    const orderBy: Prisma.MediaItemOrderByWithRelationInput =
      q?.sort === 'releaseDate'
        ? type === MediaType.MOVIE
          ? { movie: { releaseDate: 'desc' } }
          : { show: { yearStart: 'desc' } }
        : { popularity: 'desc' };
    const rows = await this.prisma.mediaItem.findMany({
      where,
      orderBy,
      take: limit,
    });
    const ids = rows.map((r) => r.id);
    return compact ? this.fetchCardDtos(ids, userId, limit) : this.fetchListDtos(ids, userId);
  }

  /**
   * Lightweight cards for LARGE user lists (watchlist/favorites, bounded pages).
   * Uses already-persisted locale maps plus the base-language fallback and skips the
   * cast/genres/provider/externalId includes and full DTO mapping — those turned
   * large watchlist responses into multi-second, multi-MB payloads for rows
   * that only ever render poster + title + progress. This read path must never
   * synchronously hydrate missing locales from TMDB: one page could otherwise
   * wait on dozens of provider requests before returning.
   */
  async fetchCardDtos(ids: string[], userId?: string, limit = 20): Promise<MediaCardLiteDto[]> {
    if (ids.length === 0) return [];
    const limitedIds = ids.slice(0, limit);
    const media = await this.prisma.mediaItem.findMany({
      where: { id: { in: limitedIds } },
      include: {
        show: { select: { episodesCount: true, yearStart: true } },
        movie: { select: { releaseYear: true } },
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              showStatuses: {
                where: { userId },
                select: { id: true, watchedCount: true, totalCount: true },
              },
              movieStatuses: { where: { userId }, select: { id: true, watched: true } },
            }
          : {}),
      },
    });
    const byId = new Map(media.map((m) => [m.id, m]));

    // Batch-query accurate aired episode counts for shows (excludes future + null air dates)
    const showMediaIds = media.filter((m) => m.type === MediaType.SHOW).map((m) => m.id);
    const airedCounts =
      showMediaIds.length > 0
        ? await this.prisma.$queryRaw<{ mediaId: string; airedCount: number }[]>`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "airedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
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
              showStatuses: {
                where: { userId },
                select: { id: true, watchedCount: true, totalCount: true },
              },
              movieStatuses: {
                where: { userId },
                select: { id: true, watched: true, watchedAt: true },
              },
            }
          : {}),
      },
    });
    const byId = new Map(media.map((m) => [m.id, m]));

    // Batch-query accurate aired episode counts for shows (excludes future + null air dates)
    const showMediaIds = media.filter((m) => m.type === MediaType.SHOW).map((m) => m.id);
    const airedCounts =
      showMediaIds.length > 0
        ? await this.prisma.$queryRaw<{ mediaId: string; airedCount: number }[]>`
          SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "airedCount"
          FROM shows sh
          JOIN seasons s ON s.show_id = sh.id
          JOIN episodes e ON e.season_id = s.id
          WHERE sh.media_id IN (${Prisma.join(showMediaIds)})
            AND s.is_special = false
            AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
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
