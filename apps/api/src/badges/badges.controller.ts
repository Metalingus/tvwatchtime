import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BadgeService } from './badge.service';

@ApiTags('badges')
@Controller()
export class BadgesController {
  constructor(private readonly badges: BadgeService) {}

  @Public()
  @Get('badges')
  listAll() {
    return this.badges.listAll();
  }

  @Get('me/badges')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  listMine(@CurrentUser('id') userId: string) {
    return this.badges.listMine(userId);
  }

  @Get('me/badges/progress')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  progress(@CurrentUser('id') userId: string) {
    return this.badges.listMine(userId);
  }
}
