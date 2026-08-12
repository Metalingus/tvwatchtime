import type {
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
  WatchProvidersBlockDto,
  VotableCastMemberDto,
} from '@tvwatch/shared';
import { MediaType } from '@tvwatch/shared';
import { localized } from './localization.util';
import { currentLanguage } from '../language.context';
import { isDeletedUserAccount } from '../../users/lib/deleted-user';

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

/** Default offer country per app language when the locale carries no region subtag. */
const LANG_DEFAULT_COUNTRY: Record<string, string> = {
  en: 'US',
  fr: 'FR',
  de: 'DE',
  es: 'ES',
  it: 'IT',
  pt: 'BR',
  ja: 'JP',
  ko: 'KR',
  zh: 'CN',
  hi: 'IN',
  ar: 'SA',
  tr: 'TR',
  id: 'ID',
};

/** ISO 3166-1 country for watch offers: locale region subtag → per-language default → US. */
export function requestOfferCountry(lang: string = currentLanguage()): string {
  const region = lang.split('-')[1]?.toUpperCase();
  if (region && /^[A-Z]{2}$/.test(region)) return region;
  return LANG_DEFAULT_COUNTRY[lang.split('-')[0]] ?? 'US';
}

function blobProviders(list: any): WatchProviderDto[] {
  if (!Array.isArray(list)) return [];
  // Blob entries carry the TMDB provider id (stringified for the DTO); the slugged
  // name is the fallback render key for blobs written before ids were stored.
  return list
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      id:
        p.id != null
          ? String(p.id)
          : String(p.name)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-'),
      name: p.name,
      logoUrl: p.logoUrl ?? null,
    }));
}

/** Resolve the stored per-country watch-offer blob for the request locale.
 *  Falls back to US offers, then to the legacy US-only relation rows. */
export function watchProvidersOf(
  media: AnyRecord,
  country: string = requestOfferCountry(),
): WatchProvidersBlockDto | null {
  const blob = media.watchProviders;
  if (blob && typeof blob === 'object') {
    const entry = blob[country] ?? blob.US ?? null;
    if (entry) {
      return {
        country: blob[country] ? country : 'US',
        link: entry.link ?? null,
        stream: blobProviders(entry.stream),
        rent: blobProviders(entry.rent),
        buy: blobProviders(entry.buy),
      };
    }
  }
  const legacy = providersOf(media);
  return legacy.length > 0
    ? { country: 'US', link: null, stream: legacy, rent: [], buy: [] }
    : null;
}

function castOf(media: AnyRecord): VotableCastMemberDto[] {
  return (media.cast ?? [])
    .slice()
    .sort((a: AnyRecord, b: AnyRecord) => a.sortOrder - b.sortOrder)
    .map((mc: AnyRecord) => ({
      id: mc.castMember?.id ?? mc.castMemberId,
      // MediaCast is the stable, title-scoped role identifier used for character voting.
      // Base card/show consumers safely ignore these two additive fields; MovieDetailDto
      // exposes them through VotableCastMemberDto.
      creditId: mc.id,
      votes: mc._count?.characterVotes ?? 0,
      name: mc.castMember?.name ?? '',
      character: localized(mc, 'characters', 'character') ?? null,
      characterImageUrl: normalizeImageUrl(mc.characterImageUrl),
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
  const watchProviders = watchProvidersOf(media);
  return {
    id: media.id,
    type: MediaType.SHOW,
    title: localized(media, 'titles', 'title') ?? media.title,
    originalTitle: show.originalTitle ?? null,
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
    originCountries: show.originCountries ?? [],
    originalLanguage: show.originalLanguage ?? null,
    genres: genresOf(media),
    providers: watchProviders?.stream ?? [],
    watchProviders,
    cast: castOf(media),
    externalIds: externalsOf(media),
    nextAirDate: show.nextAirDate ? new Date(show.nextAirDate).toISOString() : null,
    addedCount: media.addedCount ?? 0,
    inWatchlist: !!(media.watchlist?.length || media._inWatchlist),
    favorite: !!(media.favorites?.length || media._favorite),
    dropped: !!userStatus?.dropped,
    trackingPaused: !!userStatus?.pausedAt,
    trackingPausedAt: userStatus?.pausedAt ? new Date(userStatus.pausedAt).toISOString() : null,
    userProgress: total > 0 ? Math.min(1, watched / total) : 0,
    trailerUrl: media.trailerUrl ?? null,
  };
}

export function mapMovie(media: AnyRecord, userId?: string): MovieDto {
  const movie = media.movie ?? {};
  // include is already filtered by userId, so the first row (if any) is this user's
  const userStatus = userId ? (media.movieStatuses ?? [])[0] : undefined;
  const watchProviders = watchProvidersOf(media);
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
    country: movie.country ?? null,
    language: movie.language ?? null,
    genres: genresOf(media),
    providers: watchProviders?.stream ?? [],
    watchProviders,
    cast: castOf(media),
    externalIds: externalsOf(media),
    addedCount: media.addedCount ?? 0,
    inWatchlist: !!(media.watchlist?.length || media._inWatchlist),
    favorite: !!(media.favorites?.length || media._favorite),
    watched: userStatus?.watched ?? media._watched ?? false,
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
    rating: media.rating ?? null,
    year:
      media.type === MediaType.SHOW
        ? (media.show?.yearStart ?? null)
        : (media.movie?.releaseYear ?? null),
    inWatchlist: !!(media.watchlist?.length || media._inWatchlist),
    favorite: !!(media.favorites?.length || media._favorite),
    ...(media.type === MediaType.SHOW
      ? { userProgress: total > 0 ? Math.min(1, (userShow?.watchedCount ?? 0) / total) : 0 }
      : { watched: userMovie?.watched ?? media._watched ?? false }),
  };
}

export function mapEpisode(ep: AnyRecord, userStatus?: AnyRecord): EpisodeDto {
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
  const watched = userId ? (season._watchedCount ?? 0) : 0;
  return {
    id: season.id,
    number: season.number,
    title: localized(season, 'titles', 'title') ?? season.title,
    posterUrl: localized(season, 'posterUrls', 'posterUrl') ?? null,
    episodeCount: season.episodeCount ?? season.episodes?.length ?? 0,
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
    // System deleted-user account (comments of deleted accounts) — clients render a
    // localized "Deleted user" name and suppress profile links.
    isDeletedUser: isDeletedUserAccount(user),
  };
}

export function mapCurrentUser(user: AnyRecord): CurrentUserDto {
  return {
    ...mapPublicUser(user),
    email: user.email,
    authProviders: (user.authProviders ?? []).map((a: AnyRecord) => a.provider),
    isPrivate: user.profile?.isPrivate ?? false,
    hideAnimeInExplore: user.profile?.hideAnimeInExplore ?? false,
    exploreDefaultFilters: user.profile?.exploreDefaultFilters ?? null,
    role: user.role,
    mustChangePassword: user.mustChangePassword ?? false,
    onboardingStatus: user.onboardingStatus ?? 'NOT_STARTED',
    onboardingVersion: user.onboardingVersion ?? null,
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
