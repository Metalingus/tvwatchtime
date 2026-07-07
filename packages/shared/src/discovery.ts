import { MediaType, MediaStatus } from './enums';
import { PaginationQuery } from './common';

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

export interface FeedCardDto {
  id: string;
  mediaType: MediaType;
  title: string;
  overview: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  runtimeMinutes?: number | null;
  genres: string[];
  rating?: number | null;
  match?: number;
  trailerUrl?: string | null;
}

export interface DiscoverSectionsDto {
  topForYou: FeedCardDto[];
  trendingShows: FeedCardDto[];
  trendingMovies: FeedCardDto[];
}
