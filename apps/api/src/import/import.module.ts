import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { ImportProcessor } from './import.processor';
import { ImportStorage } from './lib/storage';
import { ImportMatcher } from './lib/matcher';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { CommentImageModule } from '../comment-images/comment-image.module';

@Module({
  imports: [ConfigModule, MediaMetadataModule, CommentImageModule],
  controllers: [ImportController],
  providers: [ImportService, ImportProcessor, ImportStorage, ImportMatcher],
})
export class ImportModule {}
