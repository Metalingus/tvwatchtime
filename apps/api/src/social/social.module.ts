import { Module } from '@nestjs/common';
import { SocialController } from './social.controller';
import { CommentsService } from './comments.service';
import { SocialService } from './social.service';
import { ModerationService } from './moderation.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommentImageModule } from '../comment-images/comment-image.module';

@Module({
  imports: [NotificationsModule, CommentImageModule],
  controllers: [SocialController],
  providers: [CommentsService, SocialService, ModerationService],
  exports: [ModerationService],
})
export class SocialModule {}
