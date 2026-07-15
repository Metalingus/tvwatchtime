import { Injectable, Logger } from '@nestjs/common';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { MediaMetadataService } from '../media-metadata.service';
import { TmdbProvider } from '../providers/tmdb.provider';
import { TvdbProvider } from '../providers/tvdb.provider';
import { MediaReconciler, type IdentityRef } from './media-reconciler.service';

/**
 * The single promotion path from a provisional/identity-only candidate to a permanent local
 * MediaItem. Every action requiring a stable local entity (select, watchlist, list, rate,
 * comment, favorite, import-required, reconcile) routes through here.
 *
 * Reuses the provider light-upserts (already idempotent by external id) inside the
 * reconciler's deterministic lock, so concurrent selectors for the SAME identity collapse to
 * one record and one subsequent hydration workflow.
 */
@Injectable()
export class MediaPromotionService {
  private readonly logger = new Logger(MediaPromotionService.name);

  constructor(
    private readonly reconciler: MediaReconciler,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  /**
   * Resolve (or create) the permanent local record for a namespace-aware provider identity.
   * Returns the local media id. The provider data is fetched only when no local mapping exists.
   */
  async promote(identity: IdentityRef): Promise<string | null> {
    return this.reconciler.getOrCreateByIdentity(identity, () => this.createFor(identity));
  }

  private async createFor(identity: IdentityRef): Promise<string> {
    const isSeries = identity.providerEntityKind === ProviderEntityKind.SERIES;
    const isMovie = identity.providerEntityKind === ProviderEntityKind.MOVIE;
    const numId = Number(identity.value);

    if (identity.provider === ExternalProvider.THE_TVDB) {
      if (isSeries || !isMovie) {
        const s = await this.tvdb.getShow(numId);
        return this.meta.lightUpsertShowTvdb({
          tvdbId: numId,
          title: s.title,
          overview: s.overview ?? null,
          posterUrl: s.posterUrl ?? null,
          backdropUrl: s.backdropUrl ?? null,
          popularity: s.popularity ?? 0,
          year: s.yearStart ?? null,
        });
      }
      const mv = await this.tvdb.getMovie(numId);
      return this.meta.lightUpsertMovieTvdb({
        tvdbId: numId,
        title: mv.title,
        overview: mv.overview ?? null,
        posterUrl: mv.posterUrl ?? null,
        backdropUrl: mv.backdropUrl ?? null,
        popularity: mv.popularity ?? 0,
        year: mv.releaseYear ?? null,
      });
    }

    if (identity.provider === ExternalProvider.TMDB) {
      if (isSeries || !isMovie) {
        const s = await this.tmdb.getShow(numId);
        return this.meta.lightUpsertShow({
          tmdbId: numId,
          title: s.title,
          overview: s.overview ?? null,
          posterUrl: s.posterUrl ?? null,
          backdropUrl: s.backdropUrl ?? null,
          rating: s.rating ?? null,
          popularity: s.popularity ?? 0,
          year: s.yearStart ?? null,
        });
      }
      const mv = await this.tmdb.getMovie(numId);
      return this.meta.lightUpsertMovie({
        tmdbId: numId,
        title: mv.title,
        overview: mv.overview ?? null,
        posterUrl: mv.posterUrl ?? null,
        backdropUrl: mv.backdropUrl ?? null,
        rating: mv.rating ?? null,
        popularity: mv.popularity ?? 0,
        year: mv.releaseYear ?? null,
      });
    }

    throw new Error(`promotion not supported for provider ${identity.provider}`);
  }
}
