import { Module } from '@nestjs/common';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [MediaMetadataModule, CollectionsModule],
  controllers: [MoviesController],
  providers: [MoviesService],
})
export class MoviesModule {}
