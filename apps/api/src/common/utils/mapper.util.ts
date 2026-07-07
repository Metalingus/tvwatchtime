import type {
  CastMemberDto,
  CurrentUserDto,
  EpisodeDto,
  ExternalIdDto,
  GenreDto,
  ImageSet,
  MovieDto,
  NotificationItemDto,
  PublicUserDto,
  ShowDto,
  SeasonSummaryDto,
  WatchProviderDto,
} from '@tvwatch/shared';
import { MediaType } from '@tvwatch/shared';

type AnyRecord = Record<string, any>;

function imagesOf(media: AnyRecord): ImageSet {
  return {
    poster: media.posterUrl ?? null,
    backdrop: media.backdropUrl ?? null,
    still: media.stillUrl ?? null,
    logo: media.logoUrl ?? null,
  };
}

function genresOf(media: AnyRecord): GenreDto[] {
  return (media.genres ?? []).map((mg: AnyRecord) => ({
    id: mg.genre?.id ?? mg.genreId,
    name: mg.genre?.name ?? '',
  }));
}

function providersOf(media: AnyRecord): WatchProviderDto[] {
  return (media.providers ?? []).map((mp: AnyRecord) => ({
    id: mp.provider?.id ?? mp.providerId,
    name: mp.provider?.name ?? '',
    logoUrl: mp.provider?.logoUrl ?? null,
  }));
}

function castOf(media: AnyRecord): CastMemberDto[] {
  return (media.cast ?? [])
    .slice()
    .sort((a: AnyRecord, b: AnyRecord) => a.sortOrder - b.sortOrder)
    .map((mc: AnyRecord) => ({
      id: mc.castMember?.id ?? mc.castMemberId,
      name: mc.castMember?.name ?? '',
      character: mc.character ?? null,
      profileUrl: mc.castMember?.profileUrl ?? null,
      order: mc.sortOrder,
    }));
}

function externalsOf(media: AnyRecord): ExternalIdDto[] {
  return (media.externalIds ?? []).map((e: AnyRecord) => ({
    provider: e.provider,
    id: e.value,
  }));
}

export function mapShow(media: AnyRecord, userId?: string): ShowDto {
  const show = media.show ?? {};
  const status = (media.status ?? 'RETURNING') as any;
  // include is already filtered by userId, so the first row (if any) is this user's
  const userStatus = userId ? (media.showStatuses ?? [])[0] : undefined;
  const watched = userStatus?.watchedCount ?? 0;
  const total = show.episodesCount ?? userStatus?.totalCount ?? 0;
  return {
    id: media.id,
    type: MediaType.SHOW,
    title: media.title,
    overview: media.overview ?? null,
    images: imagesOf(media),
    yearStart: show.yearStart ?? null,
    yearEnd: show.yearEnd ?? null,
    status,
    seasonsCount: show.seasonsCount ?? 0,
    episodesCount: show.episodesCount ?? 0,
    runtimeMinutes: show.runtimeMinutes ?? null,
    rating: media.rating ?? null,
    network: show.network ?? null,
    genres: genresOf(media),
    providers: providersOf(media),
    cast: castOf(media),
    externalIds: externalsOf(media),
    nextAirDate: show.nextAirDate ? new Date(show.nextAirDate).toISOString() : null,
    addedCount: media.addedCount ?? 0,
    inWatchlist: !!(media.watchlist?.length || media._inWatchlist),
    favorite: !!(media.favorites?.length || media._favorite),
    userProgress: total > 0 ? Math.min(1, watched / total) : 0,
    trailerUrl: media.trailerUrl ?? null,
  };
}

export function mapMovie(media: AnyRecord, userId?: string): MovieDto {
  const movie = media.movie ?? {};
  // include is already filtered by userId, so the first row (if any) is this user's
  const userStatus = userId ? (media.movieStatuses ?? [])[0] : undefined;
  return {
    id: media.id,
    type: MediaType.MOVIE,
    title: media.title,
    overview: media.overview ?? null,
    images: imagesOf(media),
    releaseDate: movie.releaseDate ? new Date(movie.releaseDate).toISOString() : null,
    releaseYear: movie.releaseYear ?? null,
    runtimeMinutes: movie.runtimeMinutes ?? null,
    rating: media.rating ?? null,
    genres: genresOf(media),
    providers: providersOf(media),
    cast: castOf(media),
    externalIds: externalsOf(media),
    addedCount: media.addedCount ?? 0,
    inWatchlist: !!(media.watchlist?.length || media._inWatchlist),
    favorite: !!(media.favorites?.length || media._favorite),
    watched: userStatus?.watched ?? (media._watched ?? false),
    watchedAt: userStatus?.watchedAt ? new Date(userStatus.watchedAt).toISOString() : null,
    trailerUrl: media.trailerUrl ?? null,
  };
}

export function mapEpisode(
  ep: AnyRecord,
  userStatus?: AnyRecord,
): EpisodeDto {
  return {
    id: ep.id,
    seasonId: ep.seasonId,
    seasonNumber: ep.season?.number ?? ep.seasonNumber,
    number: ep.number,
    title: ep.title,
    overview: ep.overview ?? null,
    stillUrl: ep.stillUrl ?? null,
    runtimeMinutes: ep.runtimeMinutes ?? null,
    airDate: ep.airDate ? new Date(ep.airDate).toISOString() : null,
    airTime: ep.airTime ?? null,
    rating: ep.rating ?? null,
    watched: userStatus?.watched ?? false,
    watchedAt: userStatus?.watchedAt ? new Date(userStatus.watchedAt).toISOString() : null,
    userRating: undefined,
    finale: ep.isFinale ?? false,
  };
}

export function mapSeason(season: AnyRecord, userId?: string): SeasonSummaryDto {
  const watched = userId ? season._watchedCount ?? 0 : 0;
  return {
    id: season.id,
    number: season.number,
    title: season.title,
    posterUrl: season.posterUrl ?? null,
    episodeCount: season.episodeCount ?? (season.episodes?.length ?? 0),
    watchedCount: watched,
    airedCount: season.airedCount ?? 0,
  };
}

export function mapPublicUser(user: AnyRecord): PublicUserDto {
  const profile = user.profile ?? {};
  return {
    id: user.id,
    username: user.username,
    displayName: profile.displayName ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    coverUrl: profile.coverUrl ?? null,
    bio: profile.bio ?? null,
    followingCount: user._followingCount ?? 0,
    followersCount: user._followersCount ?? 0,
    commentsCount: user._commentsCount ?? 0,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

export function mapCurrentUser(user: AnyRecord): CurrentUserDto {
  return {
    ...mapPublicUser(user),
    email: user.email,
    authProviders: (user.authProviders ?? []).map((a: AnyRecord) => a.provider),
    isPrivate: user.profile?.isPrivate ?? false,
    role: user.role,
    mustChangePassword: user.mustChangePassword ?? false,
  };
}

export function mapNotification(n: AnyRecord): NotificationItemDto {
  return {
    id: n.id,
    category: n.category,
    title: n.title,
    body: n.body ?? null,
    imageUrl: n.imageUrl ?? null,
    iconUrl: n.iconUrl ?? null,
    actorAvatarUrl: n.actorAvatarUrl ?? null,
    link: n.link ?? null,
    read: n.read,
    createdAt: new Date(n.createdAt).toISOString(),
  };
}
