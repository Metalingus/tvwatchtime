import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MediaType } from '@tvwatch/shared';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { LibraryService } from './library.service';

class HistoryQueryDto {
  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @IsOptional()
  from?: string;

  @IsOptional()
  to?: string;

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
}

@ApiTags('library')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get('watch-next')
  watchNext(@CurrentUser('id') userId: string) {
    return this.library.watchNext(userId);
  }

  @Get('upcoming')
  upcoming(@CurrentUser('id') userId: string) {
    return this.library.upcoming(userId);
  }

  @Get('history')
  history(@CurrentUser('id') userId: string, @Query() q: HistoryQueryDto) {
    return this.library.history(userId, q);
  }

  @Get('shows/progress')
  showsByStatus(@CurrentUser('id') userId: string) {
    return this.library.showsByStatus(userId);
  }
}
