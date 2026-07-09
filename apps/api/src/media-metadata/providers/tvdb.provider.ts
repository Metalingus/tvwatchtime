import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ExternalProvider, MediaStatus, MediaType } from '@tvwatch/shared';
import {
  NormalizedCast,
  NormalizedEpisode,
  NormalizedProvider,
  NormalizedSeason,
  NormalizedSearchItem,
  NormalizedShow,
} from './tmdb.provider';
import { TvdbClient } from './tvdb.client';

interface TvdbSearchHit {
  tvdb_id: number;
  name?: string;
  overview?: string;
  image_url?: string;
  type?: string;
  first_air_time?: string;
}

interface TvdbEpisode {
  id: number;
  name?: string;
  aired?: string;
  runtime?: number;
  seasonNumber?: number;
  number?: number;
  overview?: string;
  finaleType?: string | null;
  image_url?: string;
}

interface TvdbSeason {
  id: number;
  number?: number;
  type?: { id?: number; type?: string; name?: string };
  episodes?: TvdbEpisode[];
}

interface TvdbArtwork {
  type: number;
  image: string;
}

interface TvdbCharacter {
  name?: string;
  people?: { id: number; name?: string }[];
}

interface TvdbSeriesExtended {
  id: number;
  name?: string;
  overview?: string;
  status?: { id?: number; name?: string };
  firstAired?: string;
  lastAired?: string;
  nextAired?: string;
  runtime?: number;
  originalNetwork?: { name?: string };
  imdbId?: string;
  seasons?: TvdbSeason[];
  artworks?: TvdbArtwork[];
  characters?: TvdbCharacter[];
}

const tvdbStatusMap = (s?: string): MediaStatus => {
  switch ((s || '').toLowerCase()) {
    case 'ended':
      return MediaStatus.ENDED;
    case 'upcoming':
      return MediaStatus.UPCOMING;
    default:
      return MediaStatus.RETURNING;
  }
};

@Injectable()
export class TvdbProvider {
  private readonly logger = new Logger(TvdbProvider.name);

  constructor(private readonly client: TvdbClient) {}

  get enabled(): boolean {
    return this.client.enabled;
  }

  async searchShows(query: string, page = 1): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const limit = 50;
    const res = await this.client.get<{ data: TvdbSearchHit[] }>('/search', {
      query,
      type: 'series',
      limit,
    });
    const hits = (res.data || []).filter((h) => h.type === 'series' || !h.type);
    return {
      total: hits.length,
      items: hits.map((h) => ({
        tmdbId: 0,
        tvdbId: h.tvdb_id,
        type: MediaType.SHOW,
        title: h.name || 'Untitled',
        posterUrl: this.client.artwork(h.image_url),
        backdropUrl: null,
        overview: h.overview || null,
        year: h.first_air_time ? Number(h.first_air_time.slice(0, 4)) : null,
        rating: null,
        popularity: 0,
      })),
    };
  }

  async getShow(tvdbId: number): Promise<NormalizedShow> {
    const res = await this.client.get<{ data: TvdbSeriesExtended }>(`/series/${tvdbId}/extended`);
    const s = res.data;

    const poster = s.artworks?.find((a) => a.type === 1);
    const backdrop = s.artworks?.find((a) => a.type === 2);

    const seasons: NormalizedSeason[] = (s.seasons || [])
      .filter((se) => !se.type?.name || /air|default/i.test(se.type.name))
      .map((se) => ({
        tmdbId: se.id,
        number: se.number ?? 0,
        title: `Season ${se.number ?? 0}`,
        overview: null,
        posterUrl: null,
        episodeCount: se.episodes?.length ?? 0,
        isSpecial: (se.number ?? 0) === 0,
        episodes: (se.episodes || []).map((e) => this.normalizeEpisode(e)),
      }));

    const cast: NormalizedCast[] = (s.characters || [])
      .slice(0, 15)
      .map((c, i) => ({
        tmdbPersonId: 0,
        name: c.people?.[0]?.name ?? 'Unknown',
        character: c.name ?? null,
        profileUrl: null,
        order: i,
      }));

    return {
      type: MediaType.SHOW,
      tmdbId: 0,
      tvdbId,
      title: s.name || 'Untitled',
      overview: s.overview || null,
      posterUrl: this.client.artwork(poster?.image),
      backdropUrl: this.client.artwork(backdrop?.image),
      status: tvdbStatusMap(s.status?.name),
      yearStart: s.firstAired ? Number(s.firstAired.slice(0, 4)) : null,
      yearEnd: s.lastAired ? Number(s.lastAired.slice(0, 4)) : null,
      network: s.originalNetwork?.name ?? null,
      runtimeMinutes: s.runtime ?? null,
      rating: null,
      popularity: 0,
      trailerUrl: null,
      seasonsCount: seasons.length,
      episodesCount: seasons.reduce((a, b) => a + b.episodes.length, 0),
      inProduction: (s.status?.name || '').toLowerCase() === 'continuing',
      genres: [],
      externals: [
        { provider: ExternalProvider.THE_TVDB, value: String(tvdbId) },
        ...(s.imdbId ? [{ provider: ExternalProvider.IMDB, value: s.imdbId }] : []),
      ],
      cast,
      providers: [] as NormalizedProvider[],
      seasons,
      nextAirDate: s.nextAired ?? null,
    };
  }

  private normalizeEpisode(e: TvdbEpisode): NormalizedEpisode {
    return {
      tmdbId: e.id,
      number: e.number ?? 0,
      title: e.name || `Episode ${e.number}`,
      overview: e.overview || null,
      stillUrl: this.client.artwork(e.image_url),
      runtimeMinutes: e.runtime ?? null,
      airDate: e.aired || null,
      rating: null,
      isFinale: e.finaleType === 'season' || e.finaleType === 'series',
    };
  }
}
