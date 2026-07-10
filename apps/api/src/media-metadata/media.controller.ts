import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt.guard';
import { DiscoveryService } from './discovery.service';
import { DiscoverQueryDto, SearchQueryDto } from './dto/discover.dto';

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
  trendingShows(@Query('page') page = '1', @CurrentUser('id') userId?: string) {
    return this.discovery.trendingShows(userId, parseInt(page));
  }

  @Get('trending/movies')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  trendingMovies(@Query('page') page = '1', @CurrentUser('id') userId?: string) {
    return this.discovery.trendingMovies(userId, parseInt(page));
  }

  @Get('discover/sections')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  sections(@CurrentUser('id') userId?: string) {
    return this.discovery.discoverSections(userId);
  }
}
