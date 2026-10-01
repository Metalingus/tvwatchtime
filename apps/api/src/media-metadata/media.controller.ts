import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt.guard';
import { DiscoveryService } from './discovery.service';
import { DiscoverQueryDto, SearchQueryDto, TrendingQueryDto } from './dto/discover.dto';

@ApiTags('discovery')
@Controller()
export class MediaController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('search')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  search(@Query() q: SearchQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.search(q, userId);
  }

  @Get('discover/shows')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  discoverShows(@Query() q: DiscoverQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.discoverShows(q, userId);
  }

  @Get('discover/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  discoverMovies(@Query() q: DiscoverQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.discoverMovies(q, userId);
  }

  @Get('trending/shows')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  trendingShows(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.trendingShows(userId, q.page ?? 1, 20, q.genre, q, false, q.snapshot);
  }

  @Get('trending/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  trendingMovies(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.trendingMovies(userId, q.page ?? 1, 20, q.genre, q, false, q.snapshot);
  }

  @Get('top-rated/shows')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  topRatedShows(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.topRatedShows(userId, q.page ?? 1, 20, q.genre, q, false, q.snapshot);
  }

  @Get('top-rated/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  topRatedMovies(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.topRatedMovies(userId, q.page ?? 1, 20, q.genre, q, false, q.snapshot);
  }

  @Get('now-playing/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  nowPlayingMovies(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.nowPlayingMovies(userId, q.page ?? 1, 20, q.genre, q, false, q.snapshot);
  }

  @Get('upcoming/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  upcomingMovies(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.upcomingMovies(userId, q.page ?? 1, 20, q.genre, q, false, q.snapshot);
  }

  @Get('discover/sections')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  sections(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.discoverSections(userId, q.genre, q);
  }

  /** Official streaming top charts (shows + movies per service) for the viewer's country. */
  @Get('discover/streaming-top')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  streamingTop(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.streamingTop(userId, q.genre, q);
  }

  /** Backward-compatible alias for paginated personalized shows. */
  @Get('discover/for-you')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  forYou(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.forYou(userId, q.page ?? 1, 20, q.genre, q);
  }

  @Get('discover/for-you/shows')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  forYouShows(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.forYou(userId, q.page ?? 1, 20, q.genre, q);
  }

  @Get('discover/for-you/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  forYouMovies(@Query() q: TrendingQueryDto, @CurrentUser('id') userId?: string) {
    return this.discovery.moviesForYou(userId, q.page ?? 1, 20, q.genre, q);
  }

  /** Catalog genres (most-used first) — filter chip lists in explore/search/see-all. */
  @Get('genres')
  genres() {
    return this.discovery.listGenres();
  }
}
