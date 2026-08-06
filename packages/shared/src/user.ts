import { Paginated, PaginationQuery } from './common';
import { EpisodeDto } from './media';
import {
  EpisodeLabel,
  MediaType,
  UpcomingBucket,
  UpcomingPastBucket,
  WatchNextBucket,
} from './enums';

export interface WatchNextItemDto {
  showId: string;
  showTitle: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  network?: string | null;
  episode: EpisodeDto;
  /** The episode after `episode` (next-up once this one is watched). Absent/null on HISTORY
   *  items and when `episode` is the last unwatched episode. Used by the client to optimistically
   *  swap the Watch-Next card to the following episode on mark-watched. */
  nextEpisode?: EpisodeDto | null;
  /** watch_history row id — HISTORY items only. Powers the scroll-up history cursor
   *  (tiebreaker next to watchedAt, which collides on bulk imports). */
  historyId?: string;
  remainingUnwatched: number;
  label?: EpisodeLabel;
  lastWatchedAt?: string | null;
  bucket: WatchNextBucket;
  progress: number; // 0..1
}

export interface WatchNextResponseDto {
  items: WatchNextItemDto[];
  /** True when the user's watch history holds more episodes than the initial slice —
   *  gates the first scroll-up fetch (older pages chain off the returned cursor). */
  historyHasMore?: boolean;
  /** Uncapped primary-rail sizes — totals drive the per-section "See more" buttons
   *  (extra items page via GET /me/watch-next/bucket). */
  bucketTotals?: { watchNext: number; notRecently: number; startWatching: number };
}

/** One offset page of a capped watch-list rail (See more). */
export interface WatchNextBucketPageDto {
  items: WatchNextItemDto[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}

/** Cursor into the scroll-up watch history of the watch list. */
export interface WatchNextHistoryCursor {
  before: string; // ISO watchedAt of the oldest loaded history item
  beforeId: string; // watch_history row id tiebreaker
}

export interface WatchNextHistoryPageDto {
  items: WatchNextItemDto[];
  hasMore: boolean;
  cursor: WatchNextHistoryCursor | null;
}

export interface UpcomingItemDto {
  id: string;
  mediaType: MediaType;
  mediaId: string;
  title: string;
  posterUrl?: string | null;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  airDate: string;
  airTime?: string | null;
  network?: string | null;
  label?: EpisodeLabel;
  bucket: UpcomingBucket | UpcomingPastBucket | string;
  watched?: boolean;
}

export interface UpcomingGroupDto {
  key: UpcomingBucket | UpcomingPastBucket | string;
  label: string;
  /** Interpolation params for localized labels (MONTHS_AGO count, YEARS_MONTHS_AGO years+months). */
  params?: { count?: number; years?: number; months?: number };
  items: UpcomingItemDto[];
}

/** Cursor into the scroll-up past history of the upcoming screen. */
export interface UpcomingPastCursor {
  before: string; // ISO airDate of the oldest loaded past item
  beforeId: string; // episode id tiebreaker
}

export interface UpcomingPastPageDto {
  groups: UpcomingGroupDto[];
  hasMore: boolean;
  cursor: UpcomingPastCursor | null;
}

export type ShowProgressSection = 'watching' | 'notStarted' | 'finished' | 'paused' | 'dropped';

export interface ShowProgressItemDto {
  id: string;
  title: string;
  posterUrl?: string | null;
  progress: number;
  rating?: number | null;
  year?: number | null;
}

export interface ShowProgressSummaryDto {
  watching: number;
  notStarted: number;
  finished: number;
  paused: number;
  /** Optional during the additive API/mobile rollout. */
  dropped?: number;
}

export interface ShowProgressPageDto extends Paginated<ShowProgressItemDto> {}

export interface MovieLibraryItemDto {
  id: string;
  title: string;
  posterUrl?: string | null;
  rating?: number | null;
  year?: number | null;
  watched: true;
  progress: 1;
}

export interface MovieLibraryPageDto extends Paginated<MovieLibraryItemDto> {}

export interface HistoryItemDto {
  id: string;
  mediaType: MediaType;
  mediaId: string;
  title: string;
  posterUrl?: string | null;
  /** TMDB vote average (1..10) — null until the row carries a rating. */
  rating?: number | null;
  /** Release/start year (show.yearStart / movie.releaseYear). */
  year?: number | null;
  episodeId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  runtimeMinutes?: number | null;
  watchedAt: string;
}

export interface HistoryQuery extends PaginationQuery {
  mediaType?: MediaType;
  from?: string;
  to?: string;
}

export interface DurationDto {
  months: number;
  days: number;
  hours: number;
  totalMinutes: number;
}

export interface StatsSummaryDto {
  tvTime: DurationDto;
  episodesWatched: number;
  movieTime: DurationDto;
  moviesWatched: number;
  remainingEpisodes: number;
  remainingMovies: number;
  addedShows: number;
  addedMovies: number;
  /** True when the server is recomputing these stats in the background (SWR). The client polls
   *  while true and stops once fresh. Absent/undefined ⇒ treated as fresh. */
  stale?: boolean;
}

export interface ChartPointDto {
  label: string;
  value: number;
}

export interface ShowStatsDto {
  tvTime: DurationDto;
  tvTimeChart: ChartPointDto[];
  episodesWatched: number;
  episodesWatchedChart: ChartPointDto[];
  biggestMarathons: {
    showTitle: string;
    episodeCount: number;
    periodLabel: string;
  }[];
  addedShows: number;
  topGenres: { name: string; count: number }[];
  /** Genre counts represent distinct titles, never episodes or rewatches. */
  genreCountUnit?: 'titles';
  topNetworks: { name: string; count: number }[];
  votedRatings: { ratings: number; showsRated: number };
  mostVotedRatings: { showTitle: string; rating: number }[];
  characterVotes: { votes: number; shows: number };
  mostVotedCharacters: { showTitle: string; character: string }[];
  comments: { count: number; shows: number };
  earnedLikes: number;
  episodeCommentsChart: ChartPointDto[];
  remainingEpisodes: number;
  upcomingEpisodesChart: ChartPointDto[];
  catchUpSpeedEpisodesPerWeek: number;
  timeToWatch: DurationDto;
  futureWatchTimeChart: ChartPointDto[];
  catchUpPredictionDate?: string | null;
  /** See StatsSummaryDto.stale. */
  stale?: boolean;
}

export interface MovieStatsDto {
  movieTime: DurationDto;
  movieTimeChart: ChartPointDto[];
  moviesWatched: number;
  moviesWatchedChart: ChartPointDto[];
  addedMovies: number;
  topGenres: { name: string; count: number }[];
  /** Genre counts represent distinct titles, never rewatches. */
  genreCountUnit?: 'titles';
  votedRatings: { ratings: number; moviesRated: number };
  characterVotes: { votes: number; movies: number };
  comments: { count: number; movies: number };
  earnedLikes: number;
  movieCommentsChart: ChartPointDto[];
  remainingMovies: number;
  upcomingMoviesChart: ChartPointDto[];
  catchUpSpeedMoviesPerWeek: number;
  timeToWatch: DurationDto;
  futureWatchTimeChart: ChartPointDto[];
  catchUpPredictionDate?: string | null;
  /** See StatsSummaryDto.stale. */
  stale?: boolean;
}

export interface PaginatedHistory extends Paginated<HistoryItemDto> {}
