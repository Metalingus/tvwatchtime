import { MediaType, MediaStatus } from './enums';
import { ImageSet, PaginationQuery } from './common';
import type { ShowDto, MovieDto } from './media';

export interface DiscoverQuery extends PaginationQuery {
  type?: MediaType;
  genre?: string;
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
 * Lightweight card for LARGE user lists (watchlist/favorites, fetched up to 500 at
 * once). Only the fields PosterCard-style consumers render; full ShowDto|MovieDto
 * (with cast/genres/providers) stays for search/discover/trending/detail contexts.
 */
export interface MediaCardLiteDto {
  id: string;
  type: MediaType;
  title: string;
  images: ImageSet;
  inWatchlist?: boolean;
  favorite?: boolean;
  /** Shows only: 0..1 watched fraction of AIRED episodes. */
  userProgress?: number;
  /** Movies only. */
  watched?: boolean;
}

export interface DiscoverSectionsDto {
  topForYou: MediaCardDto[];
  trendingShows: MediaCardDto[];
  trendingMovies: MediaCardDto[];
}
