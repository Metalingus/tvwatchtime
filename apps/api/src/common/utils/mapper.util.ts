import type {
  CastMemberDto,
  CurrentUserDto,
  EpisodeDto,
  ExternalIdDto,
  GenreDto,
  ImageSet,
  LanguagePreference,
  MediaCardLiteDto,
  MovieDto,
  NotificationItemDto,
  PublicUserDto,
  ShowDto,
  SeasonSummaryDto,
  ThemePreference,
  WatchProviderDto,
} from '@tvwatch/shared';
import { MediaType } from '@tvwatch/shared';
import { localized } from './localization.util';

type AnyRecord = Record<string, any>;

/**
 * Defensive: strip a duplicated TVDB artwork base. Some stored image URLs were
 * double-prefixed (host + already-absolute URL) before artwork() became idempotent.
 * This heals them in-flight so no DB migration is required.
 */
function normalizeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const dup = 'https://artworks.thetvdb.com/banners/https://';
  if (url.startsWith(dup)) return 'https://' + url.slice(dup.length);
  const dupHttp = 'https://artworks.thetvdb.com/banners/http://';
  if (url.startsWith(dupHttp)) return 'http://' + url.slice(dupHttp.length);
  return url;
}

function imagesOf(media: AnyRecord): ImageSet {
  return {
    poster: normalizeImageUrl(localized(media, 'posterUrls', 'posterUrl')),
    backdrop: normalizeImageUrl(localized(media, 'backdropUrls', 'backdropUrl')),
    still: normalizeImageUrl(localized(media, 'stillUrls', 'stillUrl')),
    logo: normalizeImageUrl(media.logoUrl),
  };
}

function genresOf(media: AnyRecord): GenreDto[] {
  return (media.genres ?? []).map((mg: AnyRecord) => ({
    id: mg.genre?.id ?? mg.genreId,
    name: localized(mg.genre ?? {}, 'names', 'name') ?? '',
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
      character: localized(mc, 'characters', 'character') ?? null,
      profileUrl: normalizeImageUrl(mc.castMember?.profileUrl),
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
    title: localized(media, 'titles', 'title') ?? media.title,
    overview: localized(media, 'overviews', 'overview') ?? null,
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
    title: localized(media, 'titles', 'title') ?? media.title,
    overview: localized(media, 'overviews', 'overview') ?? null,
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
    watchCount: userStatus?.watchCount ?? 0,
    trailerUrl: media.trailerUrl ?? null,
  };
}

/**
 * Lightweight card for large user lists (watchlist/favorites, up to 500 items per
 * page). Only what PosterCard-style consumers render — the heavy cast/genres/
 * providers/externalIds includes are skipped at the query level, so this mapper
 * only touches base media columns + user-scoped relations. Show progress is
 * overridden with the aired-episode count at the callsite (same as fetchListDtos).
 */
export function mapMediaCardLite(media: AnyRecord, userId?: string): MediaCardLiteDto {
  const userShow = userId ? (media.showStatuses ?? [])[0] : undefined;
  const userMovie = userId ? (media.movieStatuses ?? [])[0] : undefined;
  const total = media.show?.episodesCount ?? userShow?.totalCount ?? 0;
  return {
    id: media.id,
    type: media.type,
    title: localized(media, 'titles', 'title') ?? media.title,
    images: imagesOf(media),
    inWatchlist: !!(media.watchlist?.length || media._inWatchlist),
    favorite: !!(media.favorites?.length || media._favorite),
    ...(media.type === MediaType.SHOW
      ? { userProgress: total > 0 ? Math.min(1, (userShow?.watchedCount ?? 0) / total) : 0 }
      : { watched: userMovie?.watched ?? (media._watched ?? false) }),
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
    title: localized(ep, 'titles', 'title') ?? ep.title,
    overview: localized(ep, 'overviews', 'overview') ?? null,
    stillUrl: normalizeImageUrl(localized(ep, 'stillUrls', 'stillUrl')),
    runtimeMinutes: ep.runtimeMinutes ?? null,
    airDate: ep.airDate ? new Date(ep.airDate).toISOString() : null,
    airTime: ep.airTime ?? null,
    rating: ep.rating ?? null,
    watched: userStatus?.watched ?? false,
    watchedAt: userStatus?.watchedAt ? new Date(userStatus.watchedAt).toISOString() : null,
    watchCount: userStatus?.watchCount ?? 0,
    userRating: undefined,
    finale: ep.isFinale ?? false,
  };
}

export function mapSeason(season: AnyRecord, userId?: string): SeasonSummaryDto {
  const watched = userId ? season._watchedCount ?? 0 : 0;
  return {
    id: season.id,
    number: season.number,
    title: localized(season, 'titles', 'title') ?? season.title,
    posterUrl: localized(season, 'posterUrls', 'posterUrl') ?? null,
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
    themePreference: dbThemeToDto(user.profile?.themePreference),
    languagePreference: dbLangToDto(user.profile?.languagePreference),
  };
}

/** Prisma enum (SYSTEM/LIGHT/DARK) → shared ThemePreference ('system'|'light'|'dark'). */
export function dbThemeToDto(v: string | null | undefined): ThemePreference {
  const s = String(v ?? 'SYSTEM').toLowerCase();
  return (s === 'light' || s === 'dark' ? s : 'system') as ThemePreference;
}
/** Prisma enum (…/PT_BR/ZH_CN) → shared LanguagePreference (…/pt-BR/zh-CN). */
export function dbLangToDto(v: string | null | undefined): LanguagePreference {
  const s = String(v ?? 'SYSTEM');
  if (s === 'SYSTEM') return 'system';
  if (s === 'PT_BR') return 'pt-BR';
  if (s === 'ZH_CN') return 'zh-CN';
  return s.toLowerCase() as LanguagePreference;
}
/** Shared ThemePreference → Prisma enum. */
export function dtoThemeToDb(v: string | null | undefined) {
  const s = String(v ?? 'system').toUpperCase();
  return s === 'LIGHT' || s === 'DARK' ? s : 'SYSTEM';
}
/** Shared LanguagePreference → Prisma enum. */
export function dtoLangToDb(v: string | null | undefined) {
  if (!v || v === 'system') return 'SYSTEM';
  if (v === 'pt-BR') return 'PT_BR';
  if (v === 'zh-CN') return 'ZH_CN';
  return v.toUpperCase();
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
