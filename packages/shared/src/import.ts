import { Paginated, PaginationQuery } from './common';
import { MediaType } from './enums';

export interface ImportPreviewItemDto {
  index: number;
  raw: Record<string, unknown>;
  mediaType: MediaType;
  title: string;
  year?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  matchedMediaId?: string | null;
  matchedTitle?: string | null;
  matchScore: number; // 0..1
  status: 'MATCHED' | 'UNMATCHED' | 'CONFLICT' | 'DUPLICATE';
  conflicts?: string[];
}

export interface ImportPreviewDto {
  importId: string;
  total: number;
  matched: number;
  unmatched: number;
  conflicts: number;
  duplicates: number;
  items: ImportPreviewItemDto[];
}

export interface ImportResultDto {
  importId: string;
  status: 'PENDING' | 'PREVIEWING' | 'CONFIRMED' | 'APPLIED' | 'ROLLED_BACK' | 'FAILED';
  addedEpisodes: number;
  addedMovies: number;
  addedRatings: number;
  addedWatchlist: number;
  addedFavorites: number;
  errors: string[];
  createdAt: string;
}

export interface ImportListItemDto extends PaginationQuery {}
export interface PaginatedImports extends Paginated<ImportResultDto> {}
