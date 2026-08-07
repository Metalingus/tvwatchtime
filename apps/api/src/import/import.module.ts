import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { ImportProcessor } from './import.processor';
import { ImportStorage } from './lib/storage';
import { ImportMatcher } from './lib/matcher';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { CommentImageModule } from '../comment-images/comment-image.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [ConfigModule, MediaMetadataModule, CommentImageModule, NotificationsModule],
  controllers: [ImportController],
  providers: [ImportService, ImportProcessor, ImportStorage, ImportMatcher],
  exports: [ImportService],
})
export class ImportModule {}
