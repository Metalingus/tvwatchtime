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
}
