import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ExternalProvider, MediaStatus, MediaType } from '@tvwatch/shared';
import {
  NormalizedCast,
  NormalizedEpisode,
  NormalizedGenre,
  NormalizedMovie,
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
  year?: string | number;
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

/** TVDB `/episodes/{id}/extended` shape (includes parent-series linkage + absolute numbering). */
interface TvdbEpisodeExtended extends TvdbEpisode {
  absoluteNumber?: number;
  seriesId?: number;
  seasons?: { id?: number; number?: number; type?: { type?: string } }[];
}

/** TVDB translations response (`/series|movies/{id}/translations/{lang}`). */
interface TvdbTranslation {
  name?: string;
  overview?: string;
  language?: string;
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

interface TvdbGenre {
  id?: number;
  name?: string;
}

interface TvdbMovieExtended {
  id: number;
  name?: string;
  overview?: string;
  runtime?: number;
  released?: string;
  imdbId?: string;
  artworks?: TvdbArtwork[];
  characters?: TvdbCharacter[];
  genres?: TvdbGenre[];
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
        year: this.yearOf(h),
        rating: null,
        popularity: 0,
      })),
    };
  }

  /** Search TVDB for movies (backup provider when TMDB has no/weak results). */
  async searchMovies(query: string, page = 1): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const limit = 50;
    const res = await this.client.get<{ data: TvdbSearchHit[] }>('/search', {
      query,
      type: 'movie',
      limit,
    });
    const hits = (res.data || []).filter((h) => h.type === 'movie' || !h.type);
    return {
      total: hits.length,
      items: hits.map((h) => ({
        tmdbId: 0,
        tvdbId: h.tvdb_id,
        type: MediaType.MOVIE,
        title: h.name || 'Untitled',
        posterUrl: this.client.artwork(h.image_url),
        backdropUrl: null,
        overview: h.overview || null,
        year: this.yearOf(h),
        rating: null,
        popularity: 0,
      })),
    };
  }

  private yearOf(h: TvdbSearchHit): number | null {
    const raw = h.first_air_time ?? h.year;
    if (raw == null || raw === '') return null;
    const y = Number(String(raw).slice(0, 4));
    return Number.isFinite(y) ? y : null;
  }

  async getShow(tvdbId: number, language?: string): Promise<NormalizedShow> {
    const res = await this.client.get<{ data: TvdbSeriesExtended }>(`/series/${tvdbId}/extended`, {}, language);
    const s = res.data;

    const poster = s.artworks?.find((a) => a.type === 1);
    const backdrop = s.artworks?.find((a) => a.type === 2);

    // TVDB `/series/{id}/extended` does NOT embed episodes per season. Fetch the series'
    // full episode list (aired/default order) and group by seasonNumber. This is best-effort
    // + rate-limit-resilient: a TVDB failure/rate-limit returns whatever we have so far
    // rather than throwing (so a TVDB hiccup never breaks a show's detail page or an import).
    const episodesBySeason = await this.fetchSeriesEpisodes(tvdbId, language);
    // Season numbers: union of the extended seasons list and any season that has episodes.
    const seasonNums = new Set<number>();
    for (const se of s.seasons || []) if (se.number != null) seasonNums.add(se.number);
    for (const sn of episodesBySeason.keys()) seasonNums.add(sn);

    const seasons: NormalizedSeason[] = [...seasonNums]
      .sort((a, b) => a - b)
      .map((num) => {
        const eps = episodesBySeason.get(num) ?? [];
        const se = (s.seasons || []).find((x) => x.number === num);
        return {
          tmdbId: se?.id ?? 0,
          number: num,
          title: `Season ${num}`,
          overview: null,
          posterUrl: null,
          episodeCount: eps.length,
          isSpecial: num === 0,
          episodes: eps.map((e) => this.normalizeEpisode(e)),
        };
      });

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

  /**
   * Fetch ALL episodes for a series, grouped by seasonNumber. Paginates TVDB's
   * `/series/{id}/episodes/{page}` (aired/default order). Best-effort: on a rate-limit or
   * failure it returns what it has gathered so far instead of throwing, so a TVDB hiccup
   * never breaks hydration of a show or an import. Capped at 12 pages (~1200 episodes).
   */
  private async fetchSeriesEpisodes(
    tvdbId: number,
    language?: string,
  ): Promise<Map<number, TvdbEpisode[]>> {
    const bySeason = new Map<number, TvdbEpisode[]>();
    // TVDB v4 `/series/{id}/episodes/default/{page}` returns { data: { episodes: [...], ...series }, links }.
    for (let page = 0; page < 12; page++) {
      try {
        const res = await this.client.get<{
          data: { episodes?: TvdbEpisode[] } | TvdbEpisode[];
          links?: { next?: string | null };
        }>(`/series/${tvdbId}/episodes/default/${page}`, {}, language);
        const raw = res.data as any;
        const eps: TvdbEpisode[] = Array.isArray(raw) ? raw : Array.isArray(raw?.episodes) ? raw.episodes : [];
        if (eps.length === 0) break;
        for (const e of eps) {
          const sn = e.seasonNumber ?? 0;
          if (!bySeason.has(sn)) bySeason.set(sn, []);
          bySeason.get(sn)!.push(e);
        }
        if (!res.links?.next) break;
      } catch {
        // Rate-limited or failed — return what we have so far (best-effort, never throw).
        break;
      }
    }
    return bySeason;
  }

  // ---- Episode-by-ID + parent-series + translations (Phase 2) ----

  /**
   * Resolve a single TVDB episode by its episode ID, including parent-series linkage
   * and absolute numbering. Used by conditional TVDB recovery in imports and by
   * reconciliation. TVDB episode identity is stored under providerEntityKind EPISODE.
   */
  async getEpisode(
    tvdbEpisodeId: number,
    language?: string,
  ): Promise<{
    episode: NormalizedEpisode;
    tvdbEpisodeId: number;
    seriesId: number | null;
    seasonNumber: number | null;
    absoluteNumber: number | null;
  }> {
    const res = await this.client.get<{ data: TvdbEpisodeExtended }>(
      `/episodes/${tvdbEpisodeId}/extended`,
      {},
      language,
    );
    const e = res.data;
    return {
      tvdbEpisodeId,
      episode: this.normalizeEpisode(e),
      seriesId: e.seriesId ?? null,
      seasonNumber: e.seasonNumber ?? null,
      absoluteNumber: e.absoluteNumber ?? null,
    };
  }

  /** Localized title + overview for a series in the requested language. */
  async getSeriesTranslations(
    tvdbId: number,
    lang: string,
  ): Promise<{ title: string | null; overview: string | null; locale: string }> {
    const res = await this.client.get<{ data: TvdbTranslation }>(
      `/series/${tvdbId}/translations/${lang}`,
    );
    const t = res.data;
    return { title: t?.name ?? null, overview: t?.overview ?? null, locale: lang };
  }

  /** Localized title + overview for a movie in the requested language. */
  async getMovieTranslations(
    tvdbId: number,
    lang: string,
  ): Promise<{ title: string | null; overview: string | null; locale: string }> {
    const res = await this.client.get<{ data: TvdbTranslation }>(
      `/movies/${tvdbId}/translations/${lang}`,
    );
    const t = res.data;
    return { title: t?.name ?? null, overview: t?.overview ?? null, locale: lang };
  }

  private normalizeEpisode(e: TvdbEpisode): NormalizedEpisode {    return {
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

  /** Fully hydrate a movie from TVDB (backup provider): artworks, cast, genres, runtime. */
  async getMovie(tvdbId: number, language?: string): Promise<NormalizedMovie> {
    const res = await this.client.get<{ data: TvdbMovieExtended }>(`/movies/${tvdbId}/extended`, {}, language);
    const m = res.data;

    // TVDB artwork types: 1=poster, 2=background/banner, 14=movie poster (varies). Be lenient.
    const poster = m.artworks?.find((a) => a.type === 1 || a.type === 14);
    const backdrop = m.artworks?.find((a) => a.type === 2 || a.type === 15);

    const cast: NormalizedCast[] = (m.characters || [])
      .slice(0, 15)
      .map((c, i) => ({
        tmdbPersonId: 0,
        name: c.people?.[0]?.name ?? 'Unknown',
        character: c.name ?? null,
        profileUrl: null,
        order: i,
      }));

    const genres: NormalizedGenre[] = (m.genres || [])
      .map((g) => ({ tmdbId: g.id ?? 0, name: g.name || '' }))
      .filter((g) => g.name);

    return {
      type: MediaType.MOVIE,
      tmdbId: 0,
      title: m.name || 'Untitled',
      overview: m.overview || null,
      posterUrl: this.client.artwork(poster?.image),
      backdropUrl: this.client.artwork(backdrop?.image),
      releaseDate: m.released || null,
      releaseYear: m.released ? Number(String(m.released).slice(0, 4)) : null,
      runtimeMinutes: m.runtime ?? null,
      rating: null,
      popularity: 0,
      trailerUrl: null,
      country: null,
      language: null,
      genres,
      externals: [
        { provider: ExternalProvider.THE_TVDB, value: String(tvdbId) },
        ...(m.imdbId ? [{ provider: ExternalProvider.IMDB, value: m.imdbId }] : []),
      ],
      cast,
      providers: [] as NormalizedProvider[],
    };
  }
}
