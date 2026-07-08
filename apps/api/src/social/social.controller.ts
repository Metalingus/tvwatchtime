import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FeatureFlagService } from '../common/feature-flag.service';
import { CommentsService } from './comments.service';
import { SocialService } from './social.service';
import { ModerationService } from './moderation.service';
import { CommentQueryDto, CreateCommentDto, ReportCommentDto } from './dto/comment.dto';

@ApiTags('social')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class SocialController {
  constructor(
    private readonly comments: CommentsService,
    private readonly social: SocialService,
    private readonly moderation: ModerationService,
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
  reportComment(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: ReportCommentDto) {
    return this.moderation.report(userId, { targetType: 'COMMENT', targetId: id, reason: dto.reason });
  }

  // ---- Block / Unblock ----
  @Post('users/:id/block')
  block(@CurrentUser('id') userId: string, @Param('id') targetId: string) {
    return this.moderation.block(userId, targetId);
  }

  @Delete('users/:id/block')
  unblock(@CurrentUser('id') userId: string, @Param('id') targetId: string) {
    return this.moderation.unblock(userId, targetId);
  }

  @Get('me/blocked')
  blockedUsers(@CurrentUser('id') userId: string) {
    return this.moderation.getBlockedUsers(userId);
  }

  // ---- Report User ----
  @Post('users/:id/report')
  reportUser(@CurrentUser('id') userId: string, @Param('id') targetId: string, @Body() dto: ReportCommentDto) {
    return this.moderation.report(userId, { targetType: 'USER', targetId, reason: dto.reason });
  }

  @Post('images/:id/report')
  reportImage(@CurrentUser('id') userId: string, @Param('id') targetId: string, @Body() dto: ReportCommentDto) {
    return this.moderation.report(userId, { targetType: 'IMAGE', targetId, reason: dto.reason });
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
