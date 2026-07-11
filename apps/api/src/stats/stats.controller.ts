import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StatsService } from './stats.service';

@ApiTags('stats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('summary')
  summary(@CurrentUser('id') userId: string) {
    return this.stats.getSummary(userId);
  }

  @Get('shows')
  shows(@CurrentUser('id') userId: string) {
    return this.stats.getShowStats(userId);
  }

  @Get('movies')
  movies(@CurrentUser('id') userId: string) {
    return this.stats.getMovieStats(userId);
  }

  @Get('leaderboard')
  leaderboard(
    @CurrentUser('id') userId: string,
    @Query('type') type: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.stats.getLeaderboard(
      userId,
      (type as any) || 'combined',
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 10,
    );
  }
}
