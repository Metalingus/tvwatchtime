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
  votes: number;
  votePct: number;
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
  userRating?: number | null;
  userDevice?: string | null;
  userReaction?: string | null;
  favoriteCharacterId?: string | null;
  commentsCount: number;
}

export interface MovieDetailDto extends MovieDto {
  similar: MovieDto[];
}
