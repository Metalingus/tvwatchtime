export enum MediaType {
  SHOW = 'SHOW',
  MOVIE = 'MOVIE',
}

export enum MediaStatus {
  RETURNING = 'RETURNING',
  ENDED = 'ENDED',
  UPCOMING = 'UPCOMING',
  CANCELED = 'CANCELED',
}

export enum ExternalProvider {
  TMDB = 'TMDB',
  TVMAZE = 'TVMAZE',
  IMDB = 'IMDB',
  TRAKT = 'TRAKT',
  THE_TVDB = 'THE_TVDB',
  KITSU = 'KITSU',
  MYANIME_LIST = 'MYANIME_LIST',
}

/**
 * Namespace within a provider's id space. A verified identity is the triple
 * (ExternalProvider, ProviderEntityKind, value). Prevents collisions such as
 * TMDB series vs movie, TVDB series vs movie vs episode, Kitsu/MAL anime vs manga.
 */
export enum ProviderEntityKind {
  SERIES = 'SERIES',
  MOVIE = 'MOVIE',
  EPISODE = 'EPISODE',
  SEASON = 'SEASON',
  ANIME = 'ANIME',
  MANGA = 'MANGA',
}

/** Content classification, independent of structural media type (SHOW/MOVIE). */
export enum ContentClassification {
  GENERAL = 'GENERAL',
  ANIME = 'ANIME',
  MANGA = 'MANGA',
  UNKNOWN = 'UNKNOWN',
}

/** Jikan is a *retrieval* provider for MyAnimeList; the stored identity is MYANIME_LIST. */
export const ANIME_RETRIEVAL_PROVIDER = 'JIKAN' as const;

export enum AuthProvider {
  GOOGLE = 'GOOGLE',
  APPLE = 'APPLE',
  FACEBOOK = 'FACEBOOK',
  EMAIL = 'EMAIL',
}

export enum WatchDevice {
  PHONE = 'PHONE',
  TABLET = 'TABLET',
  COMPUTER = 'COMPUTER',
  TV = 'TV',
  OTHER = 'OTHER',
}

export enum NotificationCategory {
  EPISODE_SOON = 'EPISODE_SOON',
  EPISODE_TODAY = 'EPISODE_TODAY',
  EPISODE_AIRED = 'EPISODE_AIRED',
  PREMIERE = 'PREMIERE',
  MOVIE_RELEASE = 'MOVIE_RELEASE',
  WATCHLIST_REMINDER = 'WATCHLIST_REMINDER',
  BADGE = 'BADGE',
  FOLLOW = 'FOLLOW',
  COMMENT_LIKE = 'COMMENT_LIKE',
  COMMENT_REPLY = 'COMMENT_REPLY',
  SYSTEM = 'SYSTEM',
  ANNOUNCEMENT = 'ANNOUNCEMENT',
  CONTACT = 'CONTACT',
}

export enum ContactReason {
  FEEDBACK = 'FEEDBACK',
  BUG_REPORT = 'BUG_REPORT',
  DATA = 'DATA',
  PERSONAL_INFO = 'PERSONAL_INFO',
  ACCOUNT = 'ACCOUNT',
  OTHER = 'OTHER',
}

export enum NotificationTiming {
  AT_RELEASE = 'AT_RELEASE',
  M15_BEFORE = 'M15_BEFORE',
  H1_BEFORE = 'H1_BEFORE',
  D1_BEFORE = 'D1_BEFORE',
  WEEKLY_DIGEST = 'WEEKLY_DIGEST',
}

export enum NotificationChannel {
  IN_APP = 'IN_APP',
  PUSH = 'PUSH',
  BOTH = 'BOTH',
}

export enum NotificationSort {
  MOST_RELEVANT = 'MOST_RELEVANT',
  LATEST = 'LATEST',
  MOST_LIKED = 'MOST_LIKED',
}

export enum ReactionType {
  SHOCKED = 'SHOCKED',
  FRUSTRATED = 'FRUSTRATED',
  SAD = 'SAD',
  REFLECTIVE = 'REFLECTIVE',
  TOUCHED = 'TOUCHED',
  AMUSED = 'AMUSED',
  SCARED = 'SCARED',
  BORED = 'BORED',
  UNDERSTANDING = 'UNDERSTANDING',
  THRILLED = 'THRILLED',
  CONFUSED = 'CONFUSED',
  TENSE = 'TENSE',
}

export enum BadgeCategory {
  WATCH = 'WATCH',
  MARATHON = 'MARATHON',
  APP_USAGE = 'APP_USAGE',
  RATING = 'RATING',
  COMMENT = 'COMMENT',
  FOLLOW = 'FOLLOW',
}

export enum ListVisibility {
  PRIVATE = 'PRIVATE',
  PUBLIC = 'PUBLIC',
}

export enum WatchNextBucket {
  WATCH_NEXT = 'WATCH_NEXT',
  HISTORY = 'HISTORY',
  NOT_RECENTLY = 'NOT_RECENTLY',
  START_WATCHING = 'START_WATCHING',
}

export enum UpcomingBucket {
  TODAY = 'TODAY',
  TOMORROW = 'TOMORROW',
  THIS_WEEK = 'THIS_WEEK',
  LATER = 'LATER',
}

export enum EpisodeLabel {
  NEW = 'NEW',
  PREMIERE = 'PREMIERE',
  LATEST = 'LATEST',
  AIRED = 'AIRED',
  FINALE = 'FINALE',
}
