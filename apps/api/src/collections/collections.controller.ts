import { Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LIBRARY_SORTS, MediaType, type LibrarySort } from '@tvwatch/shared';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CollectionsService } from './collections.service';

class WatchlistQueryDto {
  @IsOptional()
  @IsEnum(MediaType)
  type?: MediaType;

  /** Comma-separated genre slugs; every selected genre must match. */
  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20;

  /** Movie-library optimization: omit already-watched movies at the database boundary. */
  @IsOptional()
  @IsString()
  unwatchedOnly?: string;

  @IsOptional()
  @IsString()
  excludeGenres?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  tags?: string;

  @IsOptional()
  @IsIn(LIBRARY_SORTS)
  sort?: LibrarySort;
}

class FavoritesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20;

  @IsOptional()
  @IsString()
  genre?: string;

  @IsOptional()
  @IsString()
  excludeGenres?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  tags?: string;

  @IsOptional()
  @IsIn(LIBRARY_SORTS)
  sort?: LibrarySort;
}

@ApiTags('collections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get('watchlist')
  watchlist(@CurrentUser('id') userId: string, @Query() q: WatchlistQueryDto) {
    return this.collections.watchlist(
      userId,
      q.type,
      q.page,
      q.pageSize,
      q.genre,
      q.unwatchedOnly === 'true' || q.unwatchedOnly === '1',
      {
        excludeGenres: q.excludeGenres,
        country: q.country,
        tags: q.tags,
        sort: q.sort,
      },
    );
  }

  @Get('favorites/shows')
  favoriteShows(@CurrentUser('id') userId: string, @Query() q: FavoritesQueryDto) {
    return this.collections.favorites(userId, MediaType.SHOW, q.page, q.pageSize, q.genre, q);
  }

  @Get('favorites/movies')
  favoriteMovies(@CurrentUser('id') userId: string, @Query() q: FavoritesQueryDto) {
    return this.collections.favorites(userId, MediaType.MOVIE, q.page, q.pageSize, q.genre, q);
  }
}
