import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { DiscoveryService } from './discovery.service';
import { MediaMetadataService } from './media-metadata.service';
import { TmdbClient } from './providers/tmdb.client';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvmazeProvider } from './providers/tvmaze.provider';

@Module({
  controllers: [MediaController],
  providers: [TmdbClient, TmdbProvider, TvmazeProvider, MediaMetadataService, DiscoveryService],
  exports: [MediaMetadataService, DiscoveryService, TmdbProvider, TmdbClient, TvmazeProvider],
})
export class MediaMetadataModule {}
