import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { DiscoveryService } from './discovery.service';
import { MediaMetadataService } from './media-metadata.service';
import { TmdbClient } from './providers/tmdb.client';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbClient } from './providers/tvdb.client';
import { TvdbProvider } from './providers/tvdb.provider';
import { TvmazeProvider } from './providers/tvmaze.provider';

@Module({
  controllers: [MediaController],
  providers: [TmdbClient, TmdbProvider, TvdbClient, TvdbProvider, TvmazeProvider, MediaMetadataService, DiscoveryService],
  exports: [MediaMetadataService, DiscoveryService, TmdbProvider, TmdbClient, TvdbProvider, TvdbClient, TvmazeProvider],
})
export class MediaMetadataModule {}
