import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { ImportProcessor } from './import.processor';
import { ImportStorage } from './lib/storage';
import { ImportMatcher } from './lib/matcher';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';

@Module({
  imports: [ConfigModule, MediaMetadataModule],
  controllers: [ImportController],
  providers: [ImportService, ImportProcessor, ImportStorage, ImportMatcher],
})
export class ImportModule {}
