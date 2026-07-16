import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
import { LeaderboardBustProcessor } from './leaderboard-bust.processor';

@Module({
  controllers: [StatsController],
  providers: [StatsService, LeaderboardBustProcessor],
  exports: [StatsService],
})
export class StatsModule {}
