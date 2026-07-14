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

export interface CastMemberDto {
  id: string;
  name: string;
  character?: string | null;
  profileUrl?: string | null;
  order: number;
}

export interface EpisodeCastMemberDto extends CastMemberDto {
  /** Stable per-show credit identifier (MediaCast id) used for favorite voting. */
  creditId: string;
  /** Raw vote count for this cast member (percentages derived client-side). */
  votes: number;
}

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
  genres: GenreDto[];
  providers: WatchProviderDto[];
  cast: CastMemberDto[];
  externalIds: ExternalIdDto[];
  nextAirDate?: string | null;
  addedCount: number;
  match?: MatchScore;
  inWatchlist?: boolean;
  favorite?: boolean;
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
  genres: GenreDto[];
  providers: WatchProviderDto[];
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

export interface ShowDetailDto extends ShowDto {
  seasons: SeasonSummaryDto[];
  seasonsWithSpecials?: SeasonSummaryDto[];
  communityRatings?: { season: number; rating: number; votes: number }[];
}

export interface EpisodeDetailDto extends EpisodeDto {
  showId: string;
  showTitle: string;
  showImages: ImageSet;
  providers: WatchProviderDto[];
  cast?: EpisodeCastMemberDto[];
  interactions: EpisodeInteractionsDto;
  commentsCount: number;
}

export interface MovieDetailDto extends MovieDto {
  similar: MovieDto[];
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
}
