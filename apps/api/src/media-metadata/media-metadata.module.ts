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
import { MetadataBackfillService } from './metadata-backfill.service';
import { StructureRemapService } from './structure-remap.service';
import { CastDedupService } from './cast-dedup.service';
import { ExternalReviewsService } from './external-reviews.service';
import { StructureAuthorityService } from './structure-authority.service';
import { PersonalizationWarmProcessor } from './personalization-warm.processor';
import { MediaCanonicalizationService } from './media-canonicalization.service';
import { CharacterArtworkService } from './character-artwork.service';
import { ArtworkGalleryService } from './artwork-gallery.service';
import { MovieIdentityService } from './movie-identity.service';
import { IdentityRepairService } from './identity-repair.service';
import { IdentityHealthAuditService } from './identity-health-audit.service';
import { IdentityBacklogService } from './identity-backlog.service';
import { StructureBackfillService } from './structure-backfill.service';
import { IdentityRepairSweepService } from './identity-repair-sweep.service';
import { IdentityMaintenanceService } from './identity-maintenance.service';
import { WatchForgeClient } from './providers/watchforge.client';
import { WatchForgeBudget } from './providers/watchforge-budget.service';
import { WatchForgeLedger } from './providers/watchforge-ledger.service';
import { MotnClient } from './providers/motn.client';
import { StreamingChartsService } from './streaming-charts/streaming-charts.service';

@Module({
  controllers: [MediaController],
  providers: [
    ProviderConfigService,
    ProviderRateLimiter,
    ProviderHttp,
    WatchForgeBudget,
    WatchForgeLedger,
    WatchForgeClient,
    IdentityRepairService,
    IdentityHealthAuditService,
    IdentityBacklogService,
    StructureBackfillService,
    IdentityRepairSweepService,
    IdentityMaintenanceService,
    CandidateDetectorService,
    ClassifierService,
    KitsuProvider,
    JikanProvider,
    AnimeMatchService,
    MediaReconciler,
    MediaPromotionService,
    HydrationQueue,
    HydrationProcessor,
    MetadataBackfillService,
    StructureRemapService,
    StructureAuthorityService,
    CastDedupService,
    TmdbClient,
    TmdbProvider,
    TvdbClient,
    TvdbProvider,
    TvmazeProvider,
    MovieIdentityService,
    MediaMetadataService,
    DiscoveryService,
    PersonalizationWarmProcessor,
    MediaCanonicalizationService,
    ExternalReviewsService,
    CharacterArtworkService,
    ArtworkGalleryService,
    MotnClient,
    StreamingChartsService,
  ],
  exports: [
    WatchForgeClient,
    IdentityRepairService,
    IdentityHealthAuditService,
    IdentityBacklogService,
    StructureBackfillService,
    IdentityRepairSweepService,
    IdentityMaintenanceService,
    MovieIdentityService,
    MediaMetadataService,
    DiscoveryService,
    ExternalReviewsService,
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
    MetadataBackfillService,
    StructureRemapService,
    StructureAuthorityService,
    CastDedupService,
    MediaCanonicalizationService,
    CharacterArtworkService,
    ArtworkGalleryService,
    MotnClient,
    StreamingChartsService,
  ],
})
export class MediaMetadataModule {}
