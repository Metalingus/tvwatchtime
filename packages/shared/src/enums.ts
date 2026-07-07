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
}

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
