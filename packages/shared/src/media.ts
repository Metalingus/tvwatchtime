import { ExternalProvider, MediaStatus, MediaType } from './enums';
import { ImageSet, IdName, MatchScore } from './common';

export interface ExternalIdDto {
  provider: ExternalProvider;
  id: string;
}

export interface GenreDto extends IdName {}

export interface WatchProviderDto extends IdName {
  logoUrl?: string | null;
}

/** Per-country watch offers (JustWatch-sourced via TMDB watch/providers).
 *  `stream` merges flatrate/free/ads; `rent`/`buy` are purchase offers.
 *  The legacy flat `providers` array on media DTOs mirrors `stream`. */
export interface WatchProvidersBlockDto {
  /** ISO 3166-1 country the offers were resolved for (request locale region, US fallback). */
  country: string;
  /** TMDB watch-page link for that country (carries JustWatch attribution). */
  link?: string | null;
  stream: WatchProviderDto[];
  rent: WatchProviderDto[];
  buy: WatchProviderDto[];
}

export interface CastMemberDto {
  id: string;
  name: string;
  character?: string | null;
  profileUrl?: string | null;
  order: number;
}

export interface VotableCastMemberDto extends CastMemberDto {
  /** Stable per-title credit identifier (MediaCast id) used for favorite voting. */
  creditId: string;
  /** Raw vote count for this cast member (percentages derived client-side). */
  votes: number;
}

/** Backward-compatible episode name for the shared votable cast shape. */
export type EpisodeCastMemberDto = VotableCastMemberDto;

/** One selectable option with its raw community vote count. */
export interface VoteOptionDto {
  /** Stable value/identifier (device enum, rating as string, reaction type, or castId). */
  value: string;
  count: number;
}

/** A single-select voting category. Percentages are derived client-side from counts. */
export interface VoteSectionDto<TValue = string> {
  /** The authenticated user's current selection, or null when they have not voted. */
  userVote: TValue | null;
  /** Total number of voters in this section. */
  total: number;
  /** One entry per selectable option (option order is meaningful). */
  options: VoteOptionDto[];
}

export interface CharacterVoteOptionDto {
  castId: string;
  count: number;
}

export interface CharacterVoteSectionDto {
  userVote: string | null;
  total: number;
  options: CharacterVoteOptionDto[];
}

/**
 * Multi-select reaction section. A user may select several reactions; each
 * option's percent is computed independently (counts need not sum to 100).
 * `total` is the number of distinct users who picked at least one reaction.
 */
export interface ReactionVoteSectionDto {
  /** The user's selected reactions (empty => not voted => percentages hidden). */
  userVotes: string[];
  total: number;
  options: VoteOptionDto[];
}

/** All four episode interaction voting categories. */
export interface EpisodeInteractionsDto {
  device: VoteSectionDto;
  rating: VoteSectionDto;
  reaction: ReactionVoteSectionDto;
  /** null when the episode has no eligible cast to vote on. */
  character: CharacterVoteSectionDto | null;
}

/** Whole movie interaction voting categories. */
export interface MovieInteractionsDto {
  rating: VoteSectionDto;
  reaction: ReactionVoteSectionDto;
  /** Optional during staggered API/mobile rollout; null when the movie has no eligible cast. */
  character?: CharacterVoteSectionDto | null;
}

/** Whole show interaction voting categories. */
export interface ShowInteractionsDto {
  rating: VoteSectionDto;
}

export interface SeasonSummaryDto {
  id: string;
  number: number;
  title: string;
  posterUrl?: string | null;
  episodeCount: number;
  watchedCount: number;
  airedCount: number;
}

export interface EpisodeDto {
  id: string;
  seasonId: string;
  seasonNumber: number;
  number: number;
  title: string;
  overview?: string | null;
  stillUrl?: string | null;
  runtimeMinutes?: number | null;
  airDate?: string | null;
  airTime?: string | null;
  rating?: number | null;
  watched: boolean;
  watchedAt?: string | null;
  watchCount?: number;
  userRating?: number | null;
  finale?: boolean;
}

export interface ShowDto {
  id: string;
  type: MediaType.SHOW;
  title: string;
  /** Original-language title — only populated for anime when it differs from the
   *  displayed (user-locale) title and the user isn't in that original language. */
  originalTitle?: string | null;
  overview?: string | null;
  images: ImageSet;
  yearStart?: number | null;
  yearEnd?: number | null;
  status: MediaStatus;
  seasonsCount: number;
  episodesCount: number;
  runtimeMinutes?: number | null;
  rating?: number | null;
  network?: string | null;
  /** ISO 3166-1 origin country codes (e.g. ["US","JP"]). */
  originCountries?: string[];
  /** ISO 639 original language code (e.g. "en", "ja"). */
  originalLanguage?: string | null;
  genres: GenreDto[];
  providers: WatchProviderDto[];
  /** Per-country stream/rent/buy offers. Null until the media rehydrates with the
   *  watchProviders blob; `providers` then mirrors `watchProviders.stream`. */
  watchProviders?: WatchProvidersBlockDto | null;
  cast: CastMemberDto[];
  externalIds: ExternalIdDto[];
  nextAirDate?: string | null;
  addedCount: number;
  match?: MatchScore;
  inWatchlist?: boolean;
  favorite?: boolean;
  /** True when the user explicitly dropped the show. Watch history is preserved. */
  dropped?: boolean;
  /** True when the user paused tracking — hidden from watch-next/upcoming and no
   *  episode notifications until resumed. Only set on user-scoped show payloads. */
  trackingPaused?: boolean;
  /** ISO timestamp of when tracking was paused (null when not paused). */
  trackingPausedAt?: string | null;
  userProgress?: number; // 0..1
  trailerUrl?: string | null;
}

export interface MovieDto {
  id: string;
  type: MediaType.MOVIE;
  title: string;
  overview?: string | null;
  images: ImageSet;
  releaseDate?: string | null;
  releaseYear?: number | null;
  runtimeMinutes?: number | null;
  rating?: number | null;
  /** ISO 3166-1 origin country code (e.g. "US"). */
  country?: string | null;
  /** ISO 639 original language code (e.g. "en"). */
  language?: string | null;
  genres: GenreDto[];
  providers: WatchProviderDto[];
  /** Per-country stream/rent/buy offers (see ShowDto.watchProviders). */
  watchProviders?: WatchProvidersBlockDto | null;
  cast: CastMemberDto[];
  externalIds: ExternalIdDto[];
  addedCount: number;
  match?: MatchScore;
  inWatchlist?: boolean;
  favorite?: boolean;
  watched?: boolean;
  watchedAt?: string | null;
  watchCount?: number;
  trailerUrl?: string | null;
}

export interface RecommendationDto {
  /** TMDB id of the recommended media (NOT our internal media id). */
  tmdbId: number;
  type: 'SHOW' | 'MOVIE';
  title: string;
  posterUrl?: string | null;
  year?: number | null;
  rating?: number | null;
}

export interface ShowDetailDto extends ShowDto {
  seasons: SeasonSummaryDto[];
  seasonsWithSpecials?: SeasonSummaryDto[];
  communityRatings?: { season: number; rating: number; votes: number }[];
  interactions: ShowInteractionsDto;
  /** TMDB /recommendations snapshot (tmdbId-keyed, not internal ids). */
  recommendations?: RecommendationDto[];
}

export interface EpisodeDetailDto extends EpisodeDto {
  showId: string;
  showTitle: string;
  showImages: ImageSet;
  /** Show network(s) — may hold up to MAX_NETWORKS_PER_SHOW joined by NETWORK_SEPARATOR. */
  network?: string | null;
  providers: WatchProviderDto[];
  /** Per-country stream/rent/buy offers (see ShowDto.watchProviders). */
  watchProviders?: WatchProvidersBlockDto | null;
  cast?: EpisodeCastMemberDto[];
  interactions: EpisodeInteractionsDto;
  commentsCount: number;
}

export interface MovieDetailDto extends MovieDto {
  cast: VotableCastMemberDto[];
  /** Dead field — never populated; kept for compatibility. `recommendations` supersedes it. */
  similar: MovieDto[];
  interactions: MovieInteractionsDto;
  /** Whether this user has activity that can be transferred to a corrected movie match. */
  canReassign: boolean;
  /** TMDB /recommendations snapshot (tmdbId-keyed, not internal ids). */
  recommendations?: RecommendationDto[];
}

// ---------------- Networks ----------------
/**
 * Multi-network shows are stored in the single `network` string column, joined by this
 * separator (e.g. "TV Tokyo · AT-X"). Episode details render the full string; compact
 * surfaces (watch-next/upcoming cards, home-screen widgets) show `firstNetwork(...)` only.
 */
export const NETWORK_SEPARATOR = ' · ';

/** Cap on stored networks per show — keeps the joined string short for compact surfaces. */
export const MAX_NETWORKS_PER_SHOW = 2;

/** Join network names for storage: trims, dedupes, caps at MAX_NETWORKS_PER_SHOW. */
export function formatNetworks(names: (string | null | undefined)[]): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_NETWORKS_PER_SHOW) break;
  }
  return out.length ? out.join(NETWORK_SEPARATOR) : null;
}

/** First network of a stored (possibly joined) network string — for compact surfaces. */
export function firstNetwork(network?: string | null): string | null {
  if (!network) return null;
  const first = network.split(NETWORK_SEPARATOR)[0]?.trim();
  return first || null;
}

export type LeaderboardType = 'shows' | 'movies' | 'combined';

export interface LeaderboardEntryDto {
  userId: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  totalMinutes: number;
  /** Global rank (1-based). */
  position: number;
}

export interface LeaderboardPageDto {
  /** Current page of ranked entries (length <= pageSize). */
  entries: LeaderboardEntryDto[];
  /** Current user's global entry; null when they're already in `entries`. */
  me: LeaderboardEntryDto | null;
  /** Total ranked users (public, active, >0 min). */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  type: LeaderboardType;
  /** True when entries came from the previous snapshot while a rebuild is running. */
  stale?: boolean;
}
