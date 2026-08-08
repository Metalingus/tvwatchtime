import { Injectable } from '@nestjs/common';
import { ExternalProvider, MediaStatus, MediaType, formatNetworks } from '@tvwatch/shared';
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
  /** TVDB character id of the role (TVDB hydration only) — TVTime character-vote resolution. */
  characterExternalId?: number | null;
  /**
   * Provider-namespaced CastMember.externalId (e.g. "TMDB_123", "TVDB_456"). Always set
   * by providers; the TMDB_ prefix is reserved for real TMDB person ids and TVDB_ for
   * TVDB people ids — previously TVDB people ids were stored under the TMDB_ namespace,
   * which created duplicate cast members when a title was hydrated by both providers.
   */
  personExternalId?: string;
}
export interface NormalizedProvider {
  name: string;
  logoUrl?: string | null;
}
/** TMDB `/person/{id}?append_to_response=combined_credits,external_ids` payload. */
export interface TmdbPersonCredit {
  id: number;
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  character?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
}
export interface TmdbPersonPayload {
  id: number;
  name: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  profile_path?: string | null;
  external_ids?: { imdb_id?: string | null };
  combined_credits?: { cast?: TmdbPersonCredit[] };
}
/** Provider entry inside the per-country blob — carries the TMDB provider id so
 *  availability alerts can match offers against subscribed providers. */
export interface NormalizedBlobProvider extends NormalizedProvider {
  id: number;
}
/** Watch offers for one ISO 3166-1 country (JustWatch-sourced via TMDB watch/providers).
 *  `stream` merges flatrate/free/ads; `rent`/`buy` are purchase offers. */
export interface NormalizedCountryProviders {
  link?: string | null;
  stream: NormalizedBlobProvider[];
  rent: NormalizedBlobProvider[];
  buy: NormalizedBlobProvider[];
}
/** watch/providers `results` map, normalized per country (empty countries omitted). */
export type NormalizedProvidersByCountry = Record<string, NormalizedCountryProviders>;
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
  /**
   * Running episode number across the whole series (1..N, specials excluded). TVDB
   * supplies it directly; TMDB hydration computes it cumulatively. This is the key
   * that maps a flattened TMDB structure (S1 = 153 eps) onto a split TVDB structure
   * (TMDB S1E32 == TVDB S2E1 == absolute 32) during structure reconciliation.
   */
  absoluteNumber?: number | null;
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
  /** All-country watch offers (stream/rent/buy per ISO country). Undefined when the
   *  provider supplies no offer data (TVDB) — persist must never clobber stored data. */
  providersByCountry?: NormalizedProvidersByCountry;
  seasons: NormalizedSeason[];
  nextAirDate?: string | null;
  /** ISO 639-1 original language (TMDB shows only) — anime classification evidence. */
  originalLanguage?: string | null;
  /** Original-language title (TMDB original_name / TVDB series name). Shown in show details. */
  originalTitle?: string | null;
  /** ISO 3166-1 origin countries (TMDB shows only) — anime classification evidence ('JP'). */
  originCountries?: string[];
  /** TMDB keyword names (e.g. ["anime","isekai"]) — anime classification signal. */
  keywords?: string[];
  /** All locale translations from the appended TMDB translations payload. Key = ISO 639-1. */
  translations?: Record<string, { title?: string; overview?: string }>;
  /** TMDB user reviews (page 1) from the appended reviews payload. */
  reviews?: NormalizedReview[];
  /** TMDB /recommendations snapshot from the appended payload (cap 20). TMDB-only. */
  recommendations?: RecommendationItem[];
}

/** Identity/classification payload used before choosing a structural provider. It never
 * fetches season details and must never be persisted as an episode structure. */
export interface TmdbShowRoutingProfile {
  tmdbId: number;
  title: string;
  yearStart: number | null;
  genreIds: number[];
  keywords: string[];
  tvdbId: number | null;
  imdbId: string | null;
}
export interface TmdbMovieRoutingProfile {
  tmdbId: number;
  title: string;
  releaseYear: number | null;
  genreIds: number[];
  keywords: string[];
  imdbId: string | null;
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
  /** All-country watch offers (see NormalizedShow.providersByCountry). */
  providersByCountry?: NormalizedProvidersByCountry;
  /** TMDB keyword names (e.g. ["anime"]) — anime classification signal. */
  keywords?: string[];
  /** All locale translations from the provider (bulk-cached). Key = app locale code. */
  translations?: Record<string, { title?: string; overview?: string }>;
  /** TMDB user reviews (page 1) from the appended reviews payload. */
  reviews?: NormalizedReview[];
  /** TMDB /recommendations snapshot from the appended payload (cap 20). TMDB-only. */
  recommendations?: RecommendationItem[];
}

interface TmdbReview {
  author?: string;
  author_details?: {
    name?: string;
    username?: string;
    avatar_path?: string | null;
    rating?: number | null;
  };
  content?: string;
  created_at?: string;
  id?: string;
  updated_at?: string;
  url?: string;
}
export interface NormalizedReview {
  externalId: string;
  author: string;
  username: string | null;
  avatarUrl: string | null;
  /** TMDB 1..10 author rating (null when the review has none). */
  rating: number | null;
  content: string;
  /** Canonical TMDB review URL (badge link target). */
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Card-shaped TMDB /recommendations item (tmdbId, not our internal media id). */
export interface RecommendationItem {
  tmdbId: number;
  type: MediaType;
  title: string;
  posterUrl?: string | null;
  year?: number | null;
  rating?: number | null;
}

export interface NormalizedSearchItem {
  tmdbId: number;
  tvdbId?: number;
  type: MediaType;
  title: string;
  /** Original-language title (TMDB original_name/original_title) — language-aware name checks. */
  originalTitle?: string | null;
  /** Provider-supplied alternate titles (TVDB search aliases, when available). */
  aliases?: string[];
  posterUrl?: string | null;
  backdropUrl?: string | null;
  overview?: string | null;
  year?: number | null;
  rating?: number | null;
  popularity?: number | null;
  /** TMDB genre ids from list payloads (search/trending/discover) — genre filtering. */
  genreIds?: number[];
  /** Provider-native genre records when a backup provider exposes them in search. */
  providerGenres?: { id?: number; name?: string; slug?: string }[];
  /** Origin countries from list payloads when available (trending TV has origin_country;
   *  movies use original_language === 'ja' as the JP proxy) — anime signal. */
  originCountries?: string[];
}

interface TmdbShow {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
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
  original_language?: string;
  origin_country?: string[];
  genre_ids?: number[];
  keywords?: { results?: { name?: string }[] };
  translations?: { translations?: TmdbTranslation[] };
  recommendations?: { results?: TmdbRecommendationResult[] };
}
interface TmdbTranslation {
  iso_639_1?: string;
  data?: { name?: string; title?: string; overview?: string };
}
interface TmdbMovie {
  id: number;
  title?: string;
  original_title?: string;
  overview?: string;
  reviews?: { results?: TmdbReview[] };
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
  genre_ids?: number[];
  keywords?: { keywords?: { name?: string }[] };
  translations?: { translations?: TmdbTranslation[] };
  recommendations?: { results?: TmdbRecommendationResult[] };
}
/** TMDB recommendations list item — shaped like a search/trending item. */
interface TmdbRecommendationResult {
  id?: number;
  media_type?: string;
  name?: string;
  title?: string;
  poster_path?: string | null;
  first_air_date?: string;
  release_date?: string;
  vote_average?: number;
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

  /** Lightweight localized base (title/overview/poster/backdrop) — one TMDb call,
   *  no append_to_response. Used to populate list-item locale overrides cheaply. */
  async localizedShowBase(tmdbId: number, language?: string) {
    const s = await this.tmdb.get<any>(`/tv/${tmdbId}`, {}, language);
    return {
      title: s.name || s.title || '',
      overview: s.overview ?? null,
      posterUrl: this.tmdb.img(s.poster_path, 'w342'),
      backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      rating: s.vote_average ?? null,
    };
  }

  /** One lightweight routing call: identity + genres + keywords + external ids, with no
   * appended season payloads. StructureAuthorityService calls this before any full show
   * hydration so anime never temporarily writes a TMDB episode graph. */
  async getShowRoutingProfile(tmdbId: number): Promise<TmdbShowRoutingProfile> {
    const s = await this.tmdb.get<TmdbShow>(
      `/tv/${tmdbId}`,
      { append_to_response: 'external_ids,keywords' },
      'en-US',
    );
    return {
      tmdbId: s.id,
      title: s.name || 'Untitled',
      yearStart: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) || null : null,
      genreIds: (s.genres ?? []).map((g) => g.id),
      keywords: (s.keywords?.results ?? []).map((k) => k.name).filter((n): n is string => !!n),
      tvdbId: s.external_ids?.tvdb_id ?? null,
      imdbId: s.external_ids?.imdb_id ?? null,
    };
  }

  /** Movie counterpart used for strict content classification. Movies always retain
   * TMDB structural ownership, but anime classification still requires TMDB-authored
   * genre id 16 and the `anime` keyword. */
  async getMovieRoutingProfile(tmdbId: number): Promise<TmdbMovieRoutingProfile> {
    const m = await this.tmdb.get<TmdbMovie>(
      `/movie/${tmdbId}`,
      { append_to_response: 'external_ids,keywords' },
      'en-US',
    );
    return {
      tmdbId: m.id,
      title: m.title || 'Untitled',
      releaseYear: m.release_date ? Number(m.release_date.slice(0, 4)) || null : null,
      genreIds: (m.genres ?? []).map((g) => g.id),
      keywords: (m.keywords?.keywords ?? []).map((k) => k.name).filter((n): n is string => !!n),
      imdbId: m.external_ids?.imdb_id ?? null,
    };
  }

  /** Alternative titles are identity evidence, not display metadata. Import recovery uses this
   * only after a stale external id and a bounded provider search, so localized/romanized legacy
   * names can be verified without accepting a fuzzy search result. */
  async getAlternativeTitles(type: 'SHOW' | 'MOVIE', tmdbId: number): Promise<string[]> {
    const payload = await this.tmdb.get<{
      results?: Array<{ title?: string | null }>;
      titles?: Array<{ title?: string | null }>;
    }>(
      type === 'SHOW' ? `/tv/${tmdbId}/alternative_titles` : `/movie/${tmdbId}/alternative_titles`,
    );
    return [
      ...new Set(
        [...(payload.results ?? []), ...(payload.titles ?? [])]
          .map((entry) => entry.title?.trim())
          .filter((title): title is string => !!title),
      ),
    ];
  }

  async localizedMovieBase(tmdbId: number, language?: string) {
    const m = await this.tmdb.get<any>(`/movie/${tmdbId}`, {}, language);
    return {
      title: m.title || m.name || '',
      overview: m.overview ?? null,
      posterUrl: this.tmdb.img(m.poster_path, 'w342'),
      backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      rating: m.vote_average ?? null,
    };
  }

  /** Lightweight localized episode base (title/overview/still) — one TMDb call. */
  async localizedEpisodeBase(tmdbId: number, season: number, episode: number, language?: string) {
    const e = await this.tmdb.get<any>(
      `/tv/${tmdbId}/season/${season}/episode/${episode}`,
      {},
      language,
    );
    return {
      title: e.name || '',
      overview: (e.overview ?? null) as string | null,
      stillUrl: this.tmdb.img(e.still_path, 'w300') as string | null,
    };
  }

  /**
   * Person details + acting credits in ONE call (combined_credits + external_ids
   * appends; the language param localizes both biography and credit titles).
   * Raw payload — normalization lives in people/normalized-person.ts.
   */
  async getPerson(tmdbId: number, language?: string): Promise<TmdbPersonPayload> {
    return this.tmdb.get<TmdbPersonPayload>(
      `/person/${tmdbId}`,
      { append_to_response: 'combined_credits,external_ids' },
      language,
    );
  }

  private trailer(videos?: {
    results?: { site: string; type: string; key: string }[];
  }): string | null {
    const t = (videos?.results || []).find(
      (v) => v.site === 'YouTube' && /trailer|teaser/i.test(v.type),
    );
    return t ? `https://www.youtube.com/watch?v=${t.key}` : null;
  }

  private castOf(credits?: { cast?: TmdbCast[] }): NormalizedCast[] {
    return (credits?.cast || []).slice(0, 15).map((c) => ({
      tmdbPersonId: c.id,
      name: c.name,
      character: c.character ?? null,
      profileUrl: this.tmdb.img(c.profile_path, 'w185'),
      order: c.order ?? 0,
      personExternalId: `TMDB_${c.id}`,
    }));
  }

  private providersOf(watch?: { results?: Record<string, any> }): NormalizedProvider[] {
    const us = watch?.results?.US;
    const list = (us?.flatrate || us?.rent || us?.buy || []) as {
      provider_name: string;
      logo_path?: string;
    }[];
    const seen = new Set<string>();
    return list
      .filter((p) => p.provider_name && !seen.has(p.provider_name) && seen.add(p.provider_name))
      .slice(0, 8)
      .map((p) => ({
        name: p.provider_name,
        logoUrl: this.tmdb.img(p.logo_path, 'w92'),
      }));
  }

  /** Full per-country watch offers (stream = flatrate+free+ads, plus rent/buy),
   *  deduped by provider id, sorted by TMDB display priority, capped per list.
   *  Countries with no offers are omitted; undefined when the payload is absent. */
  private providersByCountryOf(watch?: {
    results?: Record<string, any>;
  }): NormalizedProvidersByCountry | undefined {
    const results = watch?.results;
    if (!results || typeof results !== 'object') return undefined;
    const CAP = 8;
    const mapList = (list: any[] | undefined): NormalizedBlobProvider[] => {
      const seen = new Set<number>();
      return (
        (list ?? []) as {
          provider_id: number;
          provider_name: string;
          logo_path?: string;
          display_priority?: number;
        }[]
      )
        .filter((p) => p.provider_name && !seen.has(p.provider_id) && seen.add(p.provider_id))
        .sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))
        .slice(0, CAP)
        .map((p) => ({
          id: p.provider_id,
          name: p.provider_name,
          logoUrl: this.tmdb.img(p.logo_path, 'w92'),
        }));
    };
    const out: NormalizedProvidersByCountry = {};
    for (const [country, offers] of Object.entries(results)) {
      if (!/^[A-Z]{2}$/.test(country) || !offers || typeof offers !== 'object') continue;
      // Stream = flatrate + free + ads combined (all "watch as part of access").
      const stream = mapList([
        ...(offers.flatrate ?? []),
        ...(offers.free ?? []),
        ...(offers.ads ?? []),
      ]);
      const rent = mapList(offers.rent);
      const buy = mapList(offers.buy);
      if (stream.length === 0 && rent.length === 0 && buy.length === 0) continue;
      out[country] = { link: offers.link ?? null, stream, rent, buy };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async searchShows(
    query: string,
    page = 1,
  ): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const res = await this.tmdb.get<{ results: TmdbShow[]; total_results: number }>('/search/tv', {
      query,
      page,
      include_adult: false,
    });
    return {
      total: res.total_results || 0,
      items: (res.results || []).map((s) => ({
        tmdbId: s.id,
        type: MediaType.SHOW,
        title: s.name || 'Untitled',
        originalTitle: s.original_name ?? null,
        posterUrl: this.tmdb.img(s.poster_path, 'w342'),
        backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
        overview: s.overview || null,
        year: s.first_air_date ? Number(s.first_air_date.slice(0, 4)) : null,
        rating: s.vote_average ?? null,
        popularity: s.popularity ?? null,
        genreIds: s.genre_ids ?? [],
        originCountries: s.origin_country ?? [],
      })),
    };
  }

  async searchMovies(
    query: string,
    page = 1,
  ): Promise<{ items: NormalizedSearchItem[]; total: number }> {
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
        originalTitle: m.original_title ?? null,
        posterUrl: this.tmdb.img(m.poster_path, 'w342'),
        backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
        overview: m.overview || null,
        year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
        rating: m.vote_average ?? null,
        popularity: m.popularity ?? null,
        genreIds: m.genre_ids ?? [],
        // Movie list payloads have no origin_country — original_language 'ja' is the JP proxy.
        originCountries: m.original_language === 'ja' ? ['JP'] : [],
      })),
    };
  }

  /** Light production-country lookup (ONE call, no appends) — movies.country backfill. */
  async getMovieCountry(tmdbId: number): Promise<string | null> {
    const m = await this.tmdb.get<TmdbMovie>(`/movie/${tmdbId}`);
    return m.production_countries?.[0]?.iso_3166_1 ?? null;
  }

  /** Lightweight keywords fetch (old rows predate keywords persistence). TV shape: `results`. */
  async getShowKeywords(tmdbId: number): Promise<string[] | null> {
    try {
      const res = await this.tmdb.get<{ results?: { name?: string }[] }>(`/tv/${tmdbId}/keywords`);
      return (res.results ?? []).map((k) => k.name).filter((n): n is string => !!n);
    } catch {
      return null;
    }
  }

  /** Lightweight keywords fetch (old rows predate keywords persistence). Movie shape: `keywords`. */
  async getMovieKeywords(tmdbId: number): Promise<string[] | null> {
    try {
      const res = await this.tmdb.get<{ keywords?: { name?: string }[] }>(
        `/movie/${tmdbId}/keywords`,
      );
      return (res.keywords ?? []).map((k) => k.name).filter((n): n is string => !!n);
    } catch {
      return null;
    }
  }

  /** Lightweight external-IDs check — returns the TVDB ID for a TMDB show, or null. */
  async getTvdbIdForShow(tmdbId: number): Promise<number | null> {
    try {
      const res = await this.tmdb.get<{ tvdb_id?: number | null }>(`/tv/${tmdbId}/external_ids`);
      return res.tvdb_id ?? null;
    } catch {
      return null;
    }
  }

  /** Lightweight external-IDs check — returns the TVDB ID for a TMDB movie, or null. */
  async getTvdbIdForMovie(tmdbId: number): Promise<number | null> {
    try {
      const res = await this.tmdb.get<{ tvdb_id?: number | null }>(`/movie/${tmdbId}/external_ids`);
      return res.tvdb_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Exact external-id → TMDB translation via `/find` (one call, no title search).
   * Used by the import matcher to resolve TVDB/IMDB ids (series, movies, episodes).
   * Returns null on any failure (provider disabled, upstream error, no results).
   */
  async findByExternalId(
    externalId: string | number,
    source: 'tvdb_id' | 'imdb_id',
  ): Promise<{
    movie: { tmdbId: number; genreIds: number[] } | null;
    show: { tmdbId: number; genreIds: number[]; originCountries: string[] } | null;
    episode: { tmdbEpisodeId: number; showId: number; season: number; episode: number } | null;
  } | null> {
    try {
      return await this.findByExternalIdStrict(externalId, source);
    } catch {
      return null;
    }
  }

  /** Same as findByExternalId, but provider errors/rate limits are allowed to bubble. */
  async findByExternalIdStrict(
    externalId: string | number,
    source: 'tvdb_id' | 'imdb_id',
  ): Promise<{
    movie: { tmdbId: number; genreIds: number[] } | null;
    show: { tmdbId: number; genreIds: number[]; originCountries: string[] } | null;
    episode: { tmdbEpisodeId: number; showId: number; season: number; episode: number } | null;
  } | null> {
    const res = await this.tmdb.get<{
      movie_results?: { id?: number; genre_ids?: number[] }[];
      tv_results?: { id?: number; genre_ids?: number[]; origin_country?: string[] }[];
      tv_episode_results?: {
        id?: number;
        show_id?: number;
        season_number?: number;
        episode_number?: number;
      }[];
    }>(`/find/${externalId}`, { external_source: source });
    const m = res.movie_results?.[0];
    const s = res.tv_results?.[0];
    const e = res.tv_episode_results?.[0];
    return {
      movie: m?.id ? { tmdbId: m.id, genreIds: m.genre_ids ?? [] } : null,
      show: s?.id
        ? { tmdbId: s.id, genreIds: s.genre_ids ?? [], originCountries: s.origin_country ?? [] }
        : null,
      episode:
        e?.id && e.show_id && e.season_number != null && e.episode_number != null
          ? {
              tmdbEpisodeId: e.id,
              showId: e.show_id,
              season: e.season_number,
              episode: e.episode_number,
            }
          : null,
    };
  }

  async getShow(
    id: number,
    language?: string,
    opts?: { skipSeasonDetail?: (seasonNumber: number, episodeCount: number) => boolean },
  ): Promise<NormalizedShow> {
    // ONE call: base + externals + credits + providers + videos + keywords + translations
    // + reviews + recommendations + up to 12 seasons appended (TMDB append_to_response
    // caps at 20 sub-requests). Seasons beyond the window (or an unappendable season)
    // fall back to the individual season endpoint below — same behavior as before, just
    // fewer calls. Callers re-hydrating an already-hydrated show can pass
    // skipSeasonDetail to skip that per-season call for seasons they already store
    // complete (left episode-less here; the caller filters them out before persisting).
    const seasonAppends = Array.from({ length: 12 }, (_, i) => `season/${i}`).join(',');
    const s = await this.tmdb.get<TmdbShow & Record<string, any>>(
      `/tv/${id}`,
      {
        append_to_response: `external_ids,credits,watch/providers,videos,keywords,translations,reviews,recommendations,${seasonAppends}`,
      },
      language,
    );
    const seasons = (s.seasons || [])
      .filter((se) => se.season_number >= 0)
      .map((se) => this.normalizeSeason(se));
    for (const se of seasons) {
      if (se.episodes.length === 0) {
        // Prefer the appended season payload (`season/{n}` key in the same response);
        // fall back to the individual endpoint for seasons outside the appended window.
        const appended = s[`season/${se.number}`] as TmdbSeason | undefined;
        if (
          !(appended && Array.isArray(appended.episodes) && appended.episodes.length > 0) &&
          opts?.skipSeasonDetail?.(se.number, se.episodeCount ?? 0)
        ) {
          continue; // caller already stores this season complete — see skipSeasonDetail
        }
        const detail =
          appended && Array.isArray(appended.episodes) && appended.episodes.length > 0
            ? appended
            : await this.tmdb.get<TmdbSeason>(`/tv/${id}/season/${se.number}`, {}, language);
        se.episodes = (detail.episodes || []).map((e) => this.normalizeEpisode(e));
      }
    }
    // Absolute numbering: TMDB has no absoluteNumber field — compute it cumulatively
    // across the ordered non-special seasons (TMDB S1E32 == TVDB S2E1 == absolute 32;
    // the structure reconciler matches on this). Skipped (episode-less) seasons use
    // their summary episodeCount so later seasons stay correctly offset.
    let absoluteCursor = 1;
    for (const se of [...seasons].sort((a, b) => a.number - b.number)) {
      if (se.isSpecial) continue;
      if (se.episodes.length > 0) {
        for (const ep of se.episodes) ep.absoluteNumber = absoluteCursor++;
      } else {
        absoluteCursor += se.episodeCount ?? 0;
      }
    }
    // Multi-network shows keep up to 2 names joined in the single string (e.g. "TV Tokyo · AT-X").
    const network = formatNetworks((s.networks ?? []).map((n) => n.name));
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
        ...(s.external_ids?.imdb_id
          ? [{ provider: ExternalProvider.IMDB, value: s.external_ids.imdb_id }]
          : []),
        ...(s.external_ids?.tvdb_id
          ? [{ provider: ExternalProvider.THE_TVDB, value: String(s.external_ids.tvdb_id) }]
          : []),
      ],
      cast: this.castOf(s.credits),
      providers: this.providersOf(s['watch/providers']),
      providersByCountry: this.providersByCountryOf(s['watch/providers']),
      seasons,
      nextAirDate: s.next_episode_to_air?.air_date ?? null,
      originalLanguage: s.original_language ?? null,
      originalTitle: s.original_name ?? null,
      originCountries: s.origin_country ?? [],
      keywords: (s.keywords?.results ?? []).map((k) => k.name).filter((n): n is string => !!n),
      translations: this.translationsOf(s.translations),
      reviews: this.reviewsOf(s.reviews),
      recommendations: this.recommendationsOf(s.recommendations, MediaType.SHOW),
    };
  }

  async getMovie(id: number, language?: string): Promise<NormalizedMovie> {
    const m = await this.tmdb.get<TmdbMovie>(
      `/movie/${id}`,
      {
        append_to_response:
          'external_ids,credits,watch/providers,videos,keywords,translations,reviews,recommendations',
      },
      language,
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
        ...(m.external_ids?.imdb_id
          ? [{ provider: ExternalProvider.IMDB, value: m.external_ids.imdb_id }]
          : []),
      ],
      cast: this.castOf(m.credits),
      providers: this.providersOf(m['watch/providers']),
      providersByCountry: this.providersByCountryOf(m['watch/providers']),
      // Movie keywords use a different payload shape than TV keywords (`keywords` vs `results`).
      keywords: (m.keywords?.keywords ?? []).map((k) => k.name).filter((n): n is string => !!n),
      translations: this.translationsOf(m.translations),
      reviews: this.reviewsOf(m.reviews),
      recommendations: this.recommendationsOf(m.recommendations, MediaType.MOVIE),
    };
  }

  /** Appended recommendations payload → card-shaped items (cap 20). TV and movies share
   *  the `{ results: [...] }` shape; items look like search/trending items. */
  private recommendationsOf(
    r?: { results?: TmdbRecommendationResult[] },
    fallbackType: MediaType = MediaType.SHOW,
  ): RecommendationItem[] {
    return (r?.results ?? [])
      .filter((it) => it.id)
      .slice(0, 20)
      .map((it) => {
        const date = it.first_air_date || it.release_date;
        return {
          tmdbId: it.id!,
          type: it.media_type === 'movie' ? MediaType.MOVIE : fallbackType,
          title: it.name || it.title || 'Untitled',
          posterUrl: this.tmdb.img(it.poster_path, 'w342'),
          year: date ? Number(date.slice(0, 4)) : null,
          rating: it.vote_average ?? null,
        };
      });
  }

  /** Appended reviews payload (page 1) → normalized provider reviews. */
  private reviewsOf(r?: { results?: TmdbReview[] }): NormalizedReview[] {
    return (r?.results ?? [])
      .filter((rev) => rev.id && rev.content)
      .map((rev) => ({
        externalId: rev.id!,
        author:
          rev.author || rev.author_details?.name || rev.author_details?.username || 'TMDB user',
        username: rev.author_details?.username || null,
        avatarUrl: this.avatarOf(rev.author_details?.avatar_path),
        rating: rev.author_details?.rating ?? null,
        content: rev.content!,
        url: rev.url || `https://www.themoviedb.org/review/${rev.id}`,
        createdAt: rev.created_at ?? null,
        updatedAt: rev.updated_at ?? null,
      }));
  }

  /** TMDB avatar paths are image paths, full URLs, or the '/https://…' gravatar quirk. */
  private avatarOf(path?: string | null): string | null {
    if (!path) return null;
    if (path.startsWith('/https://') || path.startsWith('/http://')) return path.slice(1);
    if (path.startsWith('http')) return path;
    return this.tmdb.img(path, 'w185');
  }

  /** Standalone reviews fetch (lazy sync for media hydrated before reviews existed). */
  async getShowReviews(id: number): Promise<NormalizedReview[]> {
    const res = await this.tmdb.get<{ results?: TmdbReview[] }>(`/tv/${id}/reviews`);
    return this.reviewsOf(res);
  }

  async getMovieReviews(id: number): Promise<NormalizedReview[]> {
    const res = await this.tmdb.get<{ results?: TmdbReview[] }>(`/movie/${id}/reviews`);
    return this.reviewsOf(res);
  }

  /** Standalone light recommendations fetch (no appends) — metadata-health repair path. */
  async getShowRecommendations(id: number): Promise<RecommendationItem[]> {
    const res = await this.tmdb.get<{ results?: TmdbRecommendationResult[] }>(
      `/tv/${id}/recommendations`,
    );
    return this.recommendationsOf(res, MediaType.SHOW);
  }

  async getMovieRecommendations(id: number): Promise<RecommendationItem[]> {
    const res = await this.tmdb.get<{ results?: TmdbRecommendationResult[] }>(
      `/movie/${id}/recommendations`,
    );
    return this.recommendationsOf(res, MediaType.MOVIE);
  }

  /** Episode reviews live on a per-episode endpoint (not appendable via the show call). */
  async getEpisodeReviews(
    id: number,
    season: number,
    episode: number,
  ): Promise<NormalizedReview[]> {
    const res = await this.tmdb.get<{ results?: TmdbReview[] }>(
      `/tv/${id}/season/${season}/episode/${episode}/reviews`,
    );
    return this.reviewsOf(res);
  }

  /** Appended TMDB translations payload → per-locale {title, overview} map (ISO 639-1 keys). */
  private translationsOf(t?: {
    translations?: TmdbTranslation[];
  }): Record<string, { title?: string; overview?: string }> | undefined {
    const list = t?.translations ?? [];
    const out: Record<string, { title?: string; overview?: string }> = {};
    for (const tr of list) {
      const loc = tr.iso_639_1;
      if (!loc) continue;
      const title = tr.data?.name || tr.data?.title || undefined;
      const overview = tr.data?.overview || undefined;
      if (title || overview) out[loc] = { title, overview };
    }
    return Object.keys(out).length > 0 ? out : undefined;
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
      genreIds: s.genre_ids ?? [],
      originCountries: s.origin_country ?? [],
    }));
  }

  async trendingMovies(window: 'day' | 'week' = 'week', page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>(`/trending/movie/${window}`, {
      page,
    });
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
      genreIds: m.genre_ids ?? [],
      // Movie list payloads have no origin_country — original_language 'ja' is the JP proxy.
      originCountries: m.original_language === 'ja' ? ['JP'] : [],
    }));
  }

  /**
   * App-level sort shortcuts → TMDB sort_by: 'popularity' → popularity.desc,
   * 'releaseDate' → the type's date field desc; anything else passes through
   * unchanged (raw TMDB sort strings like 'vote_average.desc' keep working).
   */
  private sortBy(sort: string | undefined, releaseDateSort: string): string {
    if (!sort || sort === 'popularity') return 'popularity.desc';
    if (sort === 'releaseDate') return releaseDateSort;
    return sort;
  }

  async discoverShows(params: {
    genre?: number;
    year?: number;
    network?: number;
    sort?: string;
    page?: number;
    excludeGenres?: number[];
    country?: string;
  }): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const res = await this.tmdb.get<{ results: TmdbShow[]; total_results: number }>(
      '/discover/tv',
      {
        with_genres: params.genre,
        first_air_date_year: params.year,
        with_networks: params.network,
        sort_by: this.sortBy(params.sort, 'first_air_date.desc'),
        page: params.page || 1,
        'vote_count.gte': 50,
        without_genres: params.excludeGenres?.length ? params.excludeGenres.join(',') : undefined,
        with_origin_country: params.country,
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
    excludeGenres?: number[];
    country?: string;
  }): Promise<{ items: NormalizedSearchItem[]; total: number }> {
    const res = await this.tmdb.get<{ results: TmdbMovie[]; total_results: number }>(
      '/discover/movie',
      {
        with_genres: params.genre,
        primary_release_year: params.year,
        sort_by: this.sortBy(params.sort, 'primary_release_date.desc'),
        page: params.page || 1,
        'vote_count.gte': params.voteCountGte ?? 50,
        with_watch_providers: params.withWatchProviders,
        watch_region: params.watchRegion,
        without_genres: params.excludeGenres?.length ? params.excludeGenres.join(',') : undefined,
        with_origin_country: params.country,
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
      tmdbId: m.id,
      type: MediaType.MOVIE,
      title: m.title || 'Untitled',
      posterUrl: this.tmdb.img(m.poster_path, 'w342'),
      backdropUrl: this.tmdb.img(m.backdrop_path, 'w780'),
      overview: m.overview || null,
      year: m.release_date ? Number(m.release_date.slice(0, 4)) : null,
      rating: m.vote_average ?? null,
      popularity: m.popularity ?? null,
      genreIds: m.genre_ids ?? [],
      originCountries: m.original_language === 'ja' ? ['JP'] : [],
    }));
  }

  /** Now playing movies: /movie/now_playing */
  async nowPlayingMovies(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>('/movie/now_playing', { page });
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
      genreIds: m.genre_ids ?? [],
      originCountries: m.original_language === 'ja' ? ['JP'] : [],
    }));
  }

  /** Upcoming movies: /movie/upcoming */
  async upcomingMovies(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>('/movie/upcoming', { page });
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
      genreIds: m.genre_ids ?? [],
      originCountries: m.original_language === 'ja' ? ['JP'] : [],
    }));
  }

  /** Popular movies: /movie/popular */
  async popularMovies(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbMovie[] }>('/movie/popular', { page });
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

  /** Popular shows: /tv/popular */
  async popularShows(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/popular', { page });
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

  /** Top rated shows: /tv/top_rated */
  async topRatedShows(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/top_rated', { page });
    return (res.results || []).map((s) => ({
      tmdbId: s.id,
      type: MediaType.SHOW,
      title: s.name || 'Untitled',
      posterUrl: this.tmdb.img(s.poster_path, 'w342'),
      backdropUrl: this.tmdb.img(s.backdrop_path, 'w780'),
      overview: s.overview || null,
      rating: s.vote_average ?? null,
      popularity: s.popularity ?? null,
      genreIds: s.genre_ids ?? [],
      originCountries: s.origin_country ?? [],
    }));
  }

  /** Airing today: /tv/airing_today */
  async airingToday(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/airing_today', { page });
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

  /** On the air: /tv/on_the_air */
  async onTheAir(page = 1): Promise<NormalizedSearchItem[]> {
    const res = await this.tmdb.get<{ results: TmdbShow[] }>('/tv/on_the_air', { page });
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

  async genres(type: 'tv' | 'movie'): Promise<{ id: number; name: string }[]> {
    const res = await this.tmdb.get<{ genres: { id: number; name: string }[] }>(
      `/genre/${type}/list`,
    );
    return res.genres || [];
  }

  private normalizeSeason(se: TmdbSeason): NormalizedSeason {
    return {
      tmdbId: se.id,
      number: se.season_number,
      title: se.name || `Season ${se.season_number}`,
      overview: se.overview || null,
      posterUrl: this.tmdb.img(se.poster_path, 'w342'),
      episodeCount: se.episode_count ?? se.episodes?.length ?? 0,
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
