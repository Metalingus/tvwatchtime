import { Module } from '@nestjs/common';
import { ContentModerationModule } from '../common/moderation/content-moderation.module';
import { SocialController } from './social.controller';
import { CommentsService } from './comments.service';
import { SocialService } from './social.service';
import { ModerationService } from './moderation.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommentImageModule } from '../comment-images/comment-image.module';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { TranslationService } from './translation.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [NotificationsModule, CommentImageModule, MediaMetadataModule, ContentModerationModule],
  controllers: [SocialController, ConversationsController],
  providers: [
    CommentsService,
    SocialService,
    ModerationService,
    TranslationService,
    ConversationsService,
  ],
  exports: [ModerationService],
})
export class SocialModule {}
