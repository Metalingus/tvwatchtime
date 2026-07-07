import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';

@Module({
  imports: [MediaMetadataModule],
  controllers: [LibraryController],
  providers: [LibraryService],
})
export class LibraryModule {}
