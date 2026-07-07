import { Module } from '@nestjs/common';
import { ShowsController } from './shows.controller';
import { ShowsService } from './shows.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [MediaMetadataModule, CollectionsModule],
  controllers: [ShowsController],
  providers: [ShowsService],
})
export class ShowsModule {}
