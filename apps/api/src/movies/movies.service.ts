import { Injectable, NotFoundException } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { MediaMetadataService } from '../media-metadata/media-metadata.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../media-metadata/providers/tvdb.provider';

@Injectable()
export class MoviesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  async getMovie(id: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({ where: { id }, include: { externalIds: true } });
    if (!media) {
      if (this.tmdb.enabled && /^\d+$/.test(id)) {
        const fullId = await this.meta.ensureMovieFull(Number(id));
        return this.meta.getMovieDetail(fullId, userId);
      }
    } else {
      const lang = currentLanguage();
      // Re-hydrate when metadata is stale OR the request locale's title override
      // is missing (so already-hydrated movies still get localized on first view).
      const localeMissing = lang !== 'en' && !((media.titles as any)?.[lang]);
      const needsHydration =
        !media.metadataRefreshedAt ||
        Date.now() - media.metadataRefreshedAt.getTime() > 1000 * 60 * 60 * 24 ||
        localeMissing;
      const tmdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
      const tvdbExt = media.externalIds.find((e) => e.provider === ExternalProvider.THE_TVDB);
      if (needsHydration && this.tmdb.enabled && tmdbExt) {
        await this.meta.ensureMovieFull(Number(tmdbExt.value));
      } else if (needsHydration && this.tvdb.enabled && tvdbExt && !tmdbExt) {
        // TVDB-only movie (backup provider): hydrate fully so poster/cast/genres are present.
        await this.meta.ensureMovieFullTvdb(Number(tvdbExt.value));
      }
      return this.meta.getMovieDetail(id, userId);
    }
    return this.meta.getMovieDetail(id, userId);
  }

  async upcomingMovies(userId: string) {
    const watchlist = await this.prisma.watchlistItem.findMany({
      where: { userId, media: { type: 'MOVIE' as const, movie: { releaseDate: { gte: new Date() } } } },
      include: { media: { include: { movie: true } } },
    });
    return watchlist
      .map((w) => w.media)
      .sort((a, b) => (a.movie?.releaseDate?.getTime() || 0) - (b.movie?.releaseDate?.getTime() || 0));
  }
}
