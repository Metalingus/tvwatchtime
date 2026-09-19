import { MediaType, MediaStatus } from './enums';
import { ImageSet, PaginationQuery } from './common';
import type { ShowDto, MovieDto } from './media';

/** Stable, provider-independent catalog facets shown by the Explore tag filter. */
export const MEDIA_TAG_SLUGS = [
  'k-drama',
  'j-drama',
  'c-drama',
  'isekai',
  'true-crime',
  'sitcom',
] as const;
export type MediaTagSlug = (typeof MEDIA_TAG_SLUGS)[number];

export interface DiscoverQuery extends PaginationQuery {
  type?: MediaType;
  /** Comma-separated genre ids or slugs; every selected genre must match. */
  genre?: string;
  /** Comma-separated curated tag slugs; multiple values use OR semantics. */
  tags?: string;
  network?: string;
  yearFrom?: number;
  yearTo?: number;
  status?: MediaStatus;
  minRuntime?: number;
  maxRuntime?: number;
  country?: string;
  language?: string;
  minRating?: number;
  provider?: string;
  sort?: 'TRENDING' | 'POPULAR' | 'RATING' | 'RECENT' | 'MATCH';
}

/**
 * A card in a discovery/list response. The list endpoints (search/discover/trending/
 * watchlist/favorites) return full ShowDto | MovieDto rows (via fetchListDtos), so
 * consumers can read `type`, `title`, `images.poster`, etc. directly.
 */
export type MediaCardDto = ShowDto | MovieDto;

/**
 * Lightweight card for poster-only surfaces (Explore rails and large user lists).
 * Full ShowDto|MovieDto rows stay available to detail-rich discovery contexts.
 */
export interface MediaCardLiteDto {
  id: string;
  type: MediaType;
  title: string;
  images: ImageSet;
  /** TMDB vote average (1..10) — null until the row carries a rating. */
  rating?: number | null;
  /** Release/start year (show.yearStart / movie.releaseYear). */
  year?: number | null;
  inWatchlist?: boolean;
  favorite?: boolean;
  /** Shows only: 0..1 watched fraction of AIRED episodes. */
  userProgress?: number;
  /** Movies only. */
  watched?: boolean;
}

/** Genre row for filter UIs (explore/search/see-all chips), most-used first. */
export interface GenreFilterDto {
  id: string;
  name: string;
  slug: string;
}

export interface DiscoverSectionsDto {
  trendingShows: MediaCardLiteDto[];
  trendingMovies: MediaCardLiteDto[];
  topRatedShows: MediaCardLiteDto[];
  topRatedMovies: MediaCardLiteDto[];
  nowPlayingMovies: MediaCardLiteDto[];
  upcomingMovies?: MediaCardLiteDto[];
}

/** Default Explore order. New/unknown saved layouts are normalized against these IDs. */
export const EXPLORE_SECTION_IDS = [
  'topShowsForYou',
  'topMoviesForYou',
  'trendingShows',
  'trendingMovies',
  'nowPlayingMovies',
  'upcomingMovies',
  'topRatedShows',
  'topRatedMovies',
] as const;
export type ExploreSectionId = (typeof EXPLORE_SECTION_IDS)[number];
export interface ExploreSectionPreferences {
  order: ExploreSectionId[];
  hidden: ExploreSectionId[];
}
export function normalizeExploreSections(value: unknown): ExploreSectionPreferences {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const valid = (items: unknown): ExploreSectionId[] =>
    Array.isArray(items)
      ? [
          ...new Set(
            items.filter(
              (id): id is ExploreSectionId =>
                typeof id === 'string' && (EXPLORE_SECTION_IDS as readonly string[]).includes(id),
            ),
          ),
        ]
      : [];
  const order = valid(data.order);
  return {
    order: [...order, ...EXPLORE_SECTION_IDS.filter((id) => !order.includes(id))],
    hidden: valid(data.hidden),
  };
}

/** Mondays at 03:00; the default scheduled row uses UTC. */
export const DEFAULT_UPCOMING_MOVIES_SCHEDULE = '0 3 * * 1';
