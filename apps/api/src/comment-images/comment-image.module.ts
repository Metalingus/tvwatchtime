import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommentImageController } from './comment-image.controller';
import { CommentImageService } from './comment-image.service';
import { CommentImageProcessor } from './comment-image.processor';
import { CommentImageStorage } from './lib/storage';
import { ModerationService } from './lib/moderation';
import { ContentModerationModule } from '../common/moderation/content-moderation.module';

@Module({
  imports: [ConfigModule, ContentModerationModule],
  controllers: [CommentImageController],
  providers: [CommentImageService, CommentImageProcessor, CommentImageStorage, ModerationService],
  exports: [CommentImageService, CommentImageProcessor],
})
export class CommentImageModule {}
