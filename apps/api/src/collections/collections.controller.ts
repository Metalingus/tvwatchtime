import { Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MediaType } from '@tvwatch/shared';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
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
    );
  }

  @Get('favorites/shows')
  favoriteShows(
    @CurrentUser('id') userId: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('genre') genre?: string,
  ) {
    return this.collections.favorites(
      userId,
      MediaType.SHOW,
      Number(page),
      Number(pageSize),
      genre,
    );
  }

  @Get('favorites/movies')
  favoriteMovies(
    @CurrentUser('id') userId: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('genre') genre?: string,
  ) {
    return this.collections.favorites(
      userId,
      MediaType.MOVIE,
      Number(page),
      Number(pageSize),
      genre,
    );
  }
}
