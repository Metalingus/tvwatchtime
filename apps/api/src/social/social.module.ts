import { Module } from '@nestjs/common';
import { SocialController } from './social.controller';
import { CommentsService } from './comments.service';
import { SocialService } from './social.service';
import { ModerationService } from './moderation.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [SocialController],
  providers: [CommentsService, SocialService, ModerationService],
  exports: [ModerationService],
})
export class SocialModule {}
