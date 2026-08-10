import { ApiPropertyOptional } from '@nestjs/swagger';
import { MediaType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

/** Explore sort options shared by search/trending/sections/for-you (default popularity). */
export const EXPLORE_SORTS = ['popularity', 'releaseDate'] as const;
export type ExploreSort = (typeof EXPLORE_SORTS)[number];

/** Explore filter fields shared by the search, trending, sections and for-you endpoints. */
export class ExploreFiltersDto {
  /** Comma-separated curated tag slugs; multiple values use OR semantics. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tags?: string;

  /** Comma-separated genre slugs to EXCLUDE (multi-select exclusion). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  excludeGenres?: string;

  @ApiPropertyOptional({ enum: EXPLORE_SORTS })
  @IsOptional()
  @IsIn(EXPLORE_SORTS)
  sort?: ExploreSort;

  /** ISO 3166-1 country filter (shows: originCountries, movies: production country). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  /** Explicit UI toggle — OR-ed with the profile hideAnimeInExplore flag (either hides). */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  hideAnime?: boolean;
}

export class SearchQueryDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsString()
  q!: string;

  @ApiPropertyOptional({ enum: MediaType })
  @IsOptional()
  @IsEnum(MediaType)
  type?: MediaType;

  /** Genre slug filter (matched against hydrated genres + TMDB payload genre ids). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  genre?: string;

  /** Comma-separated curated tag slugs; multiple values use OR semantics. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tags?: string;

  /** Comma-separated genre slugs to EXCLUDE (multi-select exclusion). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  excludeGenres?: string;

  @ApiPropertyOptional({ enum: EXPLORE_SORTS })
  @IsOptional()
  @IsIn(EXPLORE_SORTS)
  sort?: ExploreSort;

  /** ISO 3166-1 country filter (shows: originCountries, movies: production country). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  /** Explicit UI toggle — OR-ed with the profile hideAnimeInExplore flag (either hides). */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  hideAnime?: boolean;
}

/** Trending / sections / for-you endpoints: one genre chip + the shared explore filters. */
export class TrendingQueryDto extends ExploreFiltersDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Pins infinite pagination to one completed hydration snapshot. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  snapshot?: string;

  /** Genre slug filter (same semantics as SearchQueryDto.genre). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  genre?: string;
}

export class DiscoverQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: MediaType })
  @IsOptional()
  @IsEnum(MediaType)
  type?: MediaType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  genre?: string;

  /** Comma-separated curated tag slugs; multiple values use OR semantics. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tags?: string;

  /** Comma-separated genre slugs to EXCLUDE (wired to TMDB without_genres / DB none). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  excludeGenres?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  network?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1900)
  yearFrom?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  yearTo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minRuntime?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  maxRuntime?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minRating?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  provider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sort?: string;
}
