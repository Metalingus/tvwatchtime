import { MediaType, MediaStatus } from './enums';
import { PaginationQuery } from './common';
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

export interface DiscoverSectionsDto {
  topForYou: MediaCardDto[];
  trendingShows: MediaCardDto[];
  trendingMovies: MediaCardDto[];
}
