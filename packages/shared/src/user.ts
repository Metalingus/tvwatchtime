import { Paginated, PaginationQuery } from './common';
import { EpisodeDto } from './media';
import { EpisodeLabel, MediaType, UpcomingBucket, WatchNextBucket } from './enums';

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
  remainingUnwatched: number;
  label?: EpisodeLabel;
  lastWatchedAt?: string | null;
  bucket: WatchNextBucket;
  progress: number; // 0..1
}

export interface WatchNextResponseDto {
  items: WatchNextItemDto[];
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
  bucket: UpcomingBucket;
  watched?: boolean;
}

export interface UpcomingGroupDto {
  key: UpcomingBucket;
  label: string;
  items: UpcomingItemDto[];
}

export interface HistoryItemDto {
  id: string;
  mediaType: MediaType;
  mediaId: string;
  title: string;
  posterUrl?: string | null;
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
}

export interface MovieStatsDto {
  movieTime: DurationDto;
  movieTimeChart: ChartPointDto[];
  moviesWatched: number;
  moviesWatchedChart: ChartPointDto[];
  addedMovies: number;
  topGenres: { name: string; count: number }[];
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
}

export interface PaginatedHistory extends Paginated<HistoryItemDto> {}
