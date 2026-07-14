import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ShowsService } from './shows.service';
import { TrackingService } from '../tracking/tracking.service';
import { CollectionsService } from '../collections/collections.service';
import { MarkWatchedDto } from '../tracking/dto/tracking.dto';

@ApiTags('shows')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ShowsController {
  constructor(
    private readonly shows: ShowsService,
    private readonly tracking: TrackingService,
    private readonly collections: CollectionsService,
  ) {}

  @Get('shows/:id')
  detail(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.shows.getShow(id, userId);
  }

  @Get('shows/:id/episodes')
  episodes(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.shows.getSeasons(id, userId);
  }

  @Get('shows/:id/seasons')
  seasons(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.shows.getSeasons(id, userId);
  }

  @Get('episodes/:id')
  episode(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.shows.getEpisodeDetail(id, userId);
  }

  @Post('episodes/:id/watched')
  markEpisode(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() dto: MarkWatchedDto) {
    return this.tracking.markEpisodeWatched(userId, id, dto);
  }

  @Delete('episodes/:id/watched')
  unmarkEpisode(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.tracking.unmarkEpisodeWatched(userId, id);
  }

  @Post('episodes/:id/rewatch')
  rewatchEpisode(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.tracking.rewatchEpisode(userId, id);
  }

  // ----- Episode voting (icon-based interaction sections) -----
  // Each upserts the single active vote for a category and returns the recomputed
  // section (counts + total) so the client can reconcile + render percentages.
  @Put('episodes/:id/vote/device')
  voteDevice(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() body: { value: string }) {
    return this.shows.voteDevice(userId, id, body.value);
  }

  @Put('episodes/:id/vote/rating')
  voteRating(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() body: { value: number }) {
    return this.shows.voteRating(userId, id, body.value);
  }

  @Put('episodes/:id/vote/reaction')
  voteReaction(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() body: { value: string }) {
    return this.shows.voteReaction(userId, id, body.value);
  }

  @Put('episodes/:id/vote/character')
  voteCharacter(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() body: { value: string | null }) {
    return this.shows.voteFavoriteCharacter(userId, id, body.value ?? null);
  }

  @Patch('episodes/:id/feedback')
  updateFeedback(@Param('id') id: string, @CurrentUser('id') userId: string, @Body() body: { rating?: number; reaction?: string; device?: string }) {
    return this.tracking.updateEpisodeFeedback(userId, id, body);
  }

  @Post('seasons/:id/watched')
  markSeason(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.tracking.markSeasonWatched(userId, id);
  }

  @Delete('seasons/:id/watched')
  unmarkSeason(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.tracking.unmarkSeasonWatched(userId, id);
  }

  @Post('shows/:id/watchlist')
  addWatchlist(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.addWatchlist(userId, id);
  }

  @Delete('shows/:id/watchlist')
  removeWatchlist(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.removeWatchlist(userId, id);
  }

  @Post('shows/:id/favorite')
  addFavorite(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.addFavorite(userId, id);
  }

  @Delete('shows/:id/favorite')
  removeFavorite(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.removeFavorite(userId, id);
  }
}
