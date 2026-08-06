import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MoviesService } from './movies.service';
import { TrackingService } from '../tracking/tracking.service';
import { CollectionsService } from '../collections/collections.service';
import { MarkWatchedDto } from '../tracking/dto/tracking.dto';

@ApiTags('movies')
@Controller()
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MoviesController {
  constructor(
    private readonly movies: MoviesService,
    private readonly tracking: TrackingService,
    private readonly collections: CollectionsService,
  ) {}

  @Get('movies/:id')
  detail(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.movies.getMovie(id, userId);
  }

  @Post('movies/:id/watched')
  markWatched(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: MarkWatchedDto,
  ) {
    return this.tracking.markMovieWatched(userId, id, dto);
  }

  @Delete('movies/:id/watched')
  unmarkWatched(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.tracking.unmarkMovieWatched(userId, id);
  }

  @Post('movies/:id/rewatch')
  rewatchMovie(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.tracking.rewatchMovie(userId, id);
  }

  @Post('movies/:id/reassign')
  reassign(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: { targetMediaId?: string },
  ) {
    if (!dto?.targetMediaId || dto.targetMediaId === id) {
      throw new BadRequestException('targetMediaId is required and must differ from the source');
    }
    return this.movies.reassignUserMovie(userId, id, dto.targetMediaId);
  }

  @Put('movies/:id/vote/rating')
  voteRating(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { value: number },
  ) {
    return this.movies.voteRating(userId, id, body.value);
  }

  @Put('movies/:id/vote/reaction')
  voteReaction(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { value: string },
  ) {
    return this.movies.voteReaction(userId, id, body.value);
  }

  @Put('movies/:id/vote/character')
  voteCharacter(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() body: { value: string | null },
  ) {
    if (body?.value !== null && typeof body?.value !== 'string') {
      throw new BadRequestException('value must be a cast id or null');
    }
    return this.movies.voteCharacter(userId, id, body.value);
  }

  @Post('movies/:id/watchlist')
  addWatchlist(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.addWatchlist(userId, id);
  }

  @Delete('movies/:id/watchlist')
  removeWatchlist(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.removeWatchlist(userId, id);
  }

  @Post('movies/:id/drop')
  drop(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.dropMedia(userId, id);
  }

  @Post('movies/:id/favorite')
  addFavorite(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.addFavorite(userId, id);
  }

  @Delete('movies/:id/favorite')
  removeFavorite(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.collections.removeFavorite(userId, id);
  }
}
