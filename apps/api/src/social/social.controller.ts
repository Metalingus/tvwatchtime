import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FeatureFlagService } from '../common/feature-flag.service';
import { CommentsService } from './comments.service';
import { SocialService } from './social.service';
import { CommentQueryDto, CreateCommentDto, ReportCommentDto } from './dto/comment.dto';

@ApiTags('social')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SocialController {
  constructor(
    private readonly comments: CommentsService,
    private readonly social: SocialService,
    private readonly flags: FeatureFlagService,
  ) {}

  @Get('comments')
  listComments(@CurrentUser('id') userId: string, @Query() q: CommentQueryDto) {
    return this.comments.list(userId, q);
  }

  @Get('comments/participants')
  participants(@Query('threadType') threadType: string, @Query('threadId') threadId: string) {
    return this.comments.participants(threadType, threadId);
  }

  @Get('comments/:id/replies')
  replies(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.comments.replies(userId, id);
  }

  @Post('comments')
  async createComment(@CurrentUser('id') userId: string, @Body() dto: CreateCommentDto) {
    if (!(await this.flags.isEnabled('comments_enabled'))) throw new BadRequestException('Comments are temporarily disabled');
    return this.comments.create(userId, dto);
  }

  @Post('comments/:id/like')
  like(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.comments.like(userId, id);
  }

  @Delete('comments/:id/like')
  unlike(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.comments.unlike(userId, id);
  }

  @Post('comments/:id/report')
  report(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: ReportCommentDto) {
    return this.comments.report(userId, id, dto.reason);
  }

  @Post('users/:id/follow')
  follow(@CurrentUser('id') userId: string, @Param('id') targetId: string) {
    return this.social.follow(userId, targetId);
  }

  @Delete('users/:id/follow')
  unfollow(@CurrentUser('id') userId: string, @Param('id') targetId: string) {
    return this.social.unfollow(userId, targetId);
  }

  @Get('users/:id/activity')
  activity(@Param('id') id: string) {
    return this.social.activity(id);
  }
}
