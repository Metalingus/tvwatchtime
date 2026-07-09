import { Injectable } from '@nestjs/common';
import { ExternalProvider, MediaStatus, MediaType } from '@tvwatch/shared';
import { TmdbClient } from './tmdb.client';

export interface NormalizedExternal {
  provider: ExternalProvider;
  value: string;
  url?: string | null;
}
export interface NormalizedGenre {
  tmdbId: number;
  name: string;
}
export interface NormalizedCast {
  tmdbPersonId: number;
  name: string;
  character?: string | null;
  profileUrl?: string | null;
  order: number;
}
export interface NormalizedProvider {
  name: string;
  logoUrl?: string | null;
}
export interface NormalizedSeason {
  tmdbId: number;
  number: number;
  title: string;
  overview?: string | null;
  posterUrl?: string | null;
  episodeCount: number;
  isSpecial: boolean;
  episodes: NormalizedEpisode[];
}
export interface NormalizedEpisode {
  tmdbId: number;
  number: number;
  title: string;
  overview?: string | null;
  stillUrl?: string | null;
  runtimeMinutes?: number | null;
  airDate?: string | null;
  rating?: number | null;
  isFinale: boolean;
}
export interface NormalizedShow {
  type: MediaType.SHOW;
  tmdbId: number;
  tvdbId?: number;
  title: string;
  overview?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  status: MediaStatus;
  yearStart?: number | null;
  yearEnd?: number | null;
  network?: string | null;
  runtimeMinutes?: number | null;
  rating?: number | null;
  popularity?: number | null;
  trailerUrl?: string | null;
  seasonsCount: number;
  episodesCount: number;
  inProduction: boolean;
  genres: NormalizedGenre[];
  externals: NormalizedExternal[];
  cast: NormalizedCast[];
  providers: NormalizedProvider[];
  seasons: NormalizedSeason[];
  nextAirDate?: string | null;
}
export interface NormalizedMovie {
  type: MediaType.MOVIE;
  tmdbId: number;
  title: string;
  overview?: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  releaseDate?: string | null;
  releaseYear?: number | null;
  runtimeMinutes?: number | null;
  rating?: number | null;
  popularity?: number | null;
  trailerUrl?: string | null;
  country?: string | null;
  language?: string | null;
  genres: NormalizedGenre[];
  externals: NormalizedExternal[];
  cast: NormalizedCast[];
  providers: NormalizedProvider[];
}
export interface NormalizedSearchItem {
  tmdbId: number;
  tvdbId?: number;
  type: MediaType;
  title: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string | null;
  year?: number | null;
  rating?: number | null;
  popularity?: number | null;
}

interface TmdbShow {
  id: number;
  name?: string;
  title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
  status?: string;
  in_production?: boolean;
  first_air_date?: string;
  last_air_date?: string;
  number_of_seasons?: number;
  number_of_episodes?: number;
  episode_run_time?: number[];
  networks?: { name: string }[];
  genres?: { id: number; name: string }[];
  external_ids?: { imdb_id?: string; tvdb_id?: number };
  credits?: { cast?: TmdbCast[] };
  aggregate_credits?: { cast?: TmdbCast[] };
  'watch/providers'?: { results?: Record<string, any> };
  videos?: { results?: { site: string; type: string; key: string }[] };
  seasons?: TmdbSeason[];
  next_episode_to_air?: { air_date?: string } | null;
}
interface TmdbMovie {
  id: number;
  title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  runtime?: number;
  vote_average?: number;
  popularity?: number;
  status?: string;
  genres?: { id: number; name: string }[];
  external_ids?: { imdb_id?: string };
  credits?: { cast?: TmdbCast[] };
  'watch/providers'?: { results?: Record<string, any> };
  videos?: { results?: { site: string; type: string; key: string }[] };
  production_countries?: { iso_3166_1: string }[];
  original_language?: string;
}
interface TmdbCast {
  id: number;
  name: string;
  character?: string;
  profile_path?: string | null;
  order?: number;
}
interface TmdbSeason {
  id: number;
  season_number: number;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  episode_count?: number;
  episodes?: TmdbEpisode[];
}
interface TmdbEpisode {
  id: number;
  episode_number: number;
  name?: string;
  overview?: string;
  still_path?: string | null;
  runtime?: number;
  air_date?: string;
  vote_average?: number;
  episode_type?: string;
}

const statusMap = (s?: string): MediaStatus => {
  switch ((s || '').toLowerCase()) {
    case 'ended':
    case 'canceled':
      return MediaStatus.ENDED;
    case 'returning series':
    case 'in production':
      return MediaStatus.RETURNING;
    case 'planned':
    case 'rumored':
      return MediaStatus.UPCOMING;
    default:
      return MediaStatus.RETURNING;
  }
};

@Injectable()
export class TmdbProvider {
  constructor(private readonly tmdb: TmdbClient) {}

  get enabled() {
    return this.tmdb.enabled;
  }

  private trailer(videos?: { results?: { site: string; type: string; key: string }[] }): string | null {
    const t = (videos?.results || []).find((v) => v.site === 'YouTube' && /trailer|teaser/i.test(v.type));
    return t ? `https://www.youtube.com/watch?v=${t.key}` : null;
  }

  private castOf(credits?: { cast?: TmdbCast[] }): NormalizedCast[] {
    return (credits?.cast || []).slice(0, 15).map((c) => ({
      tmdbPersonId: c.id,
      name: c.name,
      character: c.character ?? null,
      profileUrl: this.tmdb.img(c.profile_path, 'w185'),
      order: c.order ?? 0,
    }));
  }

  private providersOf(watch?: { results?: Record<string, any> }): NormalizedProvider[] {
    const us = watch?.results?.US;
    const list = (us?.flatrate || us?.rent || us?.buy || []) as { provider_name: string; logo_path?: string }[];
    const seen = new Set<string>();
    return list
      .filter((p) => p.provider_name && !seen.has(p.provider_name) && seen.add(p.provider_name))
      .slice(0, 8)
      .map((p) => ({
        name: p.provider_name,
        logoUrl: this.tmdb.img(p.logo_path, 'w92'),
      }));
  }

  async searchShows(query: string, page = 1): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const res = await this.tmdb.get<{ results: TmdbShow[]; total_results: number }>(
      '/search/tv',
      { query, page, include_adult: false },
    );
    return {
      total: res.total_results || 0,
      items: (res.results || []).map((s) => ({
        tmdbId: s.id,
        type: MediaType.SHOW,
        title: s.name || 'Untitled',
        posterUrl: this.tmdb.img(s.poster_path, 'w342'),
        backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
        overview: s.overview || null,
        rating: s.vote_average ?? null,
        popularity: s.popularity ?? null,
      })),
    };
  }

  async searchMovies(query: string, page = 1): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const res = await this.tmdb.get<{ results: TmdbMovie[]; total_results: number }>(
      '/search/movie',
      { query, page, include_adult: false },
    );
    return {
      total: res.total_results || 0,
      items: (res.results || []).map((m) => ({
        tmdbId: m.id,
        type: MediaType.MOVIE,
        title: m.title || 'Untitled',
        posterUrl: this.tmdb.img(m.poster_path, 'w342'),
        backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
        overview: m.overview || null,
        year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
        rating: m.vote_average ?? null,
        popularity: m.popularity ?? null,
      })),
    };
  }

  async getShow(id: number): Promise<NormalizedShow> {
    const s = await this.tmdb.get<TmdbShow>(
      `/tv/${id}`,
      { append_to_response: 'external_ids,credits,watch/providers,videos' },
    );
    const seasons = (s.seasons || [])
      .filter((se) => se.season_number >= 0)
      .map((se) => this.normalizeSeason(se));
    for (const se of seasons) {
      if (se.episodes.length === 0) {
        const detail = await this.tmdb.get<TmdbSeason>(`/tv/${id}/season/${se.number}`);
        se.episodes = (detail.episodes || []).map((e) => this.normalizeEpisode(e));
      }
    }
    const network = s.networks?.[0]?.name ?? null;
    return {
      type: MediaType.SHOW,
      tmdbId: s.id,
      title: s.name || 'Untitled',
      overview: s.overview || null,
      posterUrl: this.tmdb.img(s.poster_path, 'w500'),
      backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      status: statusMap(s.status),
      yearStart: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null,
      yearEnd: s.last_air_date ? Number(s.last_air_date.slice(0, 4)) : null,
      network,
      runtimeMinutes: (s.episode_run_time || [])[0] ?? null,
      rating: s.vote_average ?? null,
      popularity: s.popularity ?? null,
      trailerUrl: this.trailer(s.videos),
      seasonsCount: s.number_of_seasons ?? seasons.length,
      episodesCount: s.number_of_episodes ?? seasons.reduce((a, b) => a + b.episodes.length, 0),
      inProduction: !!s.in_production,
      genres: (s.genres || []).map((g) => ({ tmdbId: g.id, name: g.name })),
      externals: [
        { provider: ExternalProvider.TMDB, value: String(s.id) },
        ...(s.external_ids?.imdb_id ? [{ provider: ExternalProvider.IMDB, value: s.external_ids.imdb_id }] : []),
        ...(s.external_ids?.tvdb_id ? [{ provider: ExternalProvider.THE_TVDB, value: String(s.external_ids.tvdb_id) }] : []),
      ],
      cast: this.castOf(s.credits),
      providers: this.providersOf(s['watch/providers']),
      seasons,
      nextAirDate: s.next_episode_to_air?.air_date ?? null,
    };
  }

  async getMovie(id: number): Promise<NormalizedMovie> {
    const m = await this.tmdb.get<TmdbMovie>(
      `/movie/${id}`,
      { append_to_response: 'external_ids,credits,watch/providers,videos' },
    );
    return {
      type: MediaType.MOVIE,
      tmdbId: m.id,
      title: m.title || 'Untitled',
      overview: m.overview || null,
      posterUrl: this.tmdb.img(m.poster_path, 'w500'),
      backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      releaseDate: m.release_date || null,
      releaseYear: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      runtimeMinutes: m.runtime ?? null,
      rating: m.vote_average ?? null,
      popularity: m.popularity ?? null,
      trailerUrl: this.trailer(m.videos),
      country: m.production_countries?.[0]?.iso_3166_1 ?? null,
      language: m.original_language ?? null,
      genres: (m.genres || []).map((g) => ({ tmdbId: g.id, name: g.name })),
      externals: [
        { provider: ExternalProvider.TMDB, value: String(m.id) },
        ...(m.external_ids?.imdb_id ? [{ provider: ExternalProvider.IMDB, value: m.external_ids.imdb_id }] : []),
      ],
      cast: this.castOf(m.credits),
      providers: this.providersOf(m['watch/providers']),
    };
  }

  async trendingShows(window: 'day' | 'week' = 'week', page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>(`/trending/tv/${window}`, { page });
    return (res.results || []).map((s) => ({
      tmdbId: s.id,
      type: MediaType.SHOW,
      title: s.name || 'Untitled',
      posterUrl: this.tmdb.img(s.poster_path, 'w342'),
      backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      overview: s.overview || null,
      rating: s.vote_average ?? null,
      popularity: s.popularity ?? null,
    }));
  }

  async trendingMovies(window: 'day' | 'week' = 'week', page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>(`/trending/movie/${window}`, { page });
    return (res.results || []).map((m) => ({
      tmdbId: m.id,
      type: MediaType.MOVIE,
      title: m.title || 'Untitled',
      posterUrl: this.tmdb.img(m.poster_path, 'w342'),
      backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      overview: m.overview || null,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      rating: m.vote_average ?? null,
      popularity: m.popularity ?? null,
    }));
  }

  async discoverShows(params: {
    genre?: number;
    year?: number;
    network?: number;
    sort?: string;
    page?: number;
  }): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const res = await this.tmdb.get<{ results: TmdbShow[]; total_results: number }>(
      '/discover/tv',
      {
        with_genres: params.genre,
        first_air_date_year: params.year,
        with_networks: params.network,
        sort_by: params.sort || 'popularity.desc',
        page: params.page || 1,
        'vote_count.gte': 50,
      },
    );
    return {
      total: res.total_results || 0,
      items: (res.results || []).map((s) => ({
        tmdbId: s.id,
        type: MediaType.SHOW,
        title: s.name || 'Untitled',
        posterUrl: this.tmdb.img(s.poster_path, 'w342'),
        backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
        overview: s.overview || null,
        year: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null,
        rating: s.vote_average ?? null,
        popularity: s.popularity ?? null,
      })),
    };
  }

  async discoverMovies(params: {
    genre?: number;
    year?: number;
    sort?: string;
    page?: number;
    voteCountGte?: number;
    withWatchProviders?: number;
    watchRegion?: string;
  }): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const res = await this.tmdb.get<{ results: TmdbMovie[]; total_results: number }>(
      '/discover/movie',
      {
        with_genres: params.genre,
        primary_release_year: params.year,
        sort_by: params.sort || 'popularity.desc',
        page: params.page || 1,
        'vote_count.gte': params.voteCountGte ?? 50,
        with_watch_providers: params.withWatchProviders,
        watch_region: params.watchRegion,
      },
    );
    return {
      total: res.total_results || 0,
      items: (res.results || []).map((m) => ({
        tmdbId: m.id,
        type: MediaType.MOVIE,
        title: m.title || 'Untitled',
        posterUrl: this.tmdb.img(m.poster_path, 'w342'),
        backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
        overview: m.overview || null,
        year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
        rating: m.vote_average ?? null,
        popularity: m.popularity ?? null,
      })),
    };
  }

  // ---- Additional TMDb endpoints for admin hydration ----

  /** Top rated movies: /movie/top_rated */
  async topRatedMovies(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>('/movie/top_rated', { page });
    return (res.results || []).map((m) => ({
      tmdbId: m.id, type: MediaType.MOVIE, title: m.title || 'Untitled',
      posterUrl: this.tmdb.img(m.poster_path, 'w342'), backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      overview: m.overview || null, year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      rating: m.vote_average ?? null, popularity: m.popularity ?? null,
    }));
  }

  /** Now playing movies: /movie/now_playing */
  async nowPlayingMovies(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>('/movie/now_playing', { page });
    return (res.results || []).map((m) => ({
      tmdbId: m.id, type: MediaType.MOVIE, title: m.title || 'Untitled',
      posterUrl: this.tmdb.img(m.poster_path, 'w342'), backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      overview: m.overview || null, year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      rating: m.vote_average ?? null, popularity: m.popularity ?? null,
    }));
  }

  /** Upcoming movies: /movie/upcoming */
  async upcomingMovies(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>('/movie/upcoming', { page });
    return (res.results || []).map((m) => ({
      tmdbId: m.id, type: MediaType.MOVIE, title: m.title || 'Untitled',
      posterUrl: this.tmdb.img(m.poster_path, 'w342'), backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      overview: m.overview || null, year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      rating: m.vote_average ?? null, popularity: m.popularity ?? null,
    }));
  }

  /** Popular movies: /movie/popular */
  async popularMovies(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>('/movie/popular', { page });
    return (res.results || []).map((m) => ({
      tmdbId: m.id, type: MediaType.MOVIE, title: m.title || 'Untitled',
      posterUrl: this.tmdb.img(m.poster_path, 'w342'), backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      overview: m.overview || null, year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      rating: m.vote_average ?? null, popularity: m.popularity ?? null,
    }));
  }

  /** Popular shows: /tv/popular */
  async popularShows(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/popular', { page });
    return (res.results || []).map((s) => ({
      tmdbId: s.id, type: MediaType.SHOW, title: s.name || 'Untitled',
      posterUrl: this.tmdb.img(s.poster_path, 'w342'), backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      overview: s.overview || null, rating: s.vote_average ?? null, popularity: s.popularity ?? null,
    }));
  }

  /** Top rated shows: /tv/top_rated */
  async topRatedShows(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/top_rated', { page });
    return (res.results || []).map((s) => ({
      tmdbId: s.id, type: MediaType.SHOW, title: s.name || 'Untitled',
      posterUrl: this.tmdb.img(s.poster_path, 'w342'), backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      overview: s.overview || null, rating: s.vote_average ?? null, popularity: s.popularity ?? null,
    }));
  }

  /** Airing today: /tv/airing_today */
  async airingToday(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/airing_today', { page });
    return (res.results || []).map((s) => ({
      tmdbId: s.id, type: MediaType.SHOW, title: s.name || 'Untitled',
      posterUrl: this.tmdb.img(s.poster_path, 'w342'), backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      overview: s.overview || null, rating: s.vote_average ?? null, popularity: s.popularity ?? null,
    }));
  }

  /** On the air: /tv/on_the_air */
  async onTheAir(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/on_the_air', { page });
    return (res.results || []).map((s) => ({
      tmdbId: s.id, type: MediaType.SHOW, title: s.name || 'Untitled',
      posterUrl: this.tmdb.img(s.poster_path, 'w342'), backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      overview: s.overview || null, rating: s.vote_average ?? null, popularity: s.popularity ?? null,
    }));
  }

  async genres(type: 'tv' | 'movie'): Promise<{ id: number; name: string }[]> {
    const res = await this.tmdb.get<{ genres: { id: number; name: string }[] }>(`/genre/${type}/list`);
    return res.genres || [];
  }

  private normalizeSeason(se: TmdbSeason): NormalizedSeason {
    return {
      tmdbId: se.id,
      number: se.season_number,
      title: se.name || `Season ${se.season_number}`,
      overview: se.overview || null,
      posterUrl: this.tmdb.img(se.poster_path, 'w342'),
      episodeCount: se.episode_count ?? (se.episodes?.length ?? 0),
      isSpecial: se.season_number === 0,
      episodes: (se.episodes || []).map((e) => this.normalizeEpisode(e)),
    };
  }

  private normalizeEpisode(e: TmdbEpisode): NormalizedEpisode {
    return {
      tmdbId: e.id,
      number: e.episode_number,
      title: e.name || `Episode ${e.episode_number}`,
      overview: e.overview || null,
      stillUrl: this.tmdb.img(e.still_path, 'w300'),
      runtimeMinutes: e.runtime ?? null,
      airDate: e.air_date || null,
      rating: e.vote_average ?? null,
      isFinale: e.episode_type === 'finale',
    };
  }
}
