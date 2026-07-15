import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { DiscoveryService } from './discovery.service';
import { MediaMetadataService } from './media-metadata.service';
import { TmdbClient } from './providers/tmdb.client';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbClient } from './providers/tvdb.client';
import { TvdbProvider } from './providers/tvdb.provider';
import { TvmazeProvider } from './providers/tvmaze.provider';
import { ProviderConfigService } from './providers/shared/provider-config.service';
import { ProviderRateLimiter } from './providers/shared/rate-limiter';
import { ProviderHttp } from './providers/shared/provider-http';
import { CandidateDetectorService } from './classification/candidate-detector.service';
import { ClassifierService } from './classification/classifier.service';
import { KitsuProvider } from './providers/kitsu.provider';
import { JikanProvider } from './providers/jikan.provider';
import { AnimeMatchService } from './matching/anime-match.service';
import { MediaReconciler } from './reconcile/media-reconciler.service';
import { MediaPromotionService } from './reconcile/media-promotion.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { HydrationProcessor } from './hydration/hydration.processor';

@Module({
  controllers: [MediaController],
  providers: [
    ProviderConfigService,
    ProviderRateLimiter,
    ProviderHttp,
    CandidateDetectorService,
    ClassifierService,
    KitsuProvider,
    JikanProvider,
    AnimeMatchService,
    MediaReconciler,
    MediaPromotionService,
    HydrationQueue,
    HydrationProcessor,
    TmdbClient,
    TmdbProvider,
    TvdbClient,
    TvdbProvider,
    TvmazeProvider,
    MediaMetadataService,
    DiscoveryService,
  ],
  exports: [
    MediaMetadataService,
    DiscoveryService,
    TmdbProvider,
    TmdbClient,
    TvdbProvider,
    TvdbClient,
    TvmazeProvider,
    ProviderHttp,
    ProviderConfigService,
    CandidateDetectorService,
    ClassifierService,
    KitsuProvider,
    JikanProvider,
    AnimeMatchService,
    MediaReconciler,
    MediaPromotionService,
    HydrationQueue,
  ],
})
export class MediaMetadataModule {}
