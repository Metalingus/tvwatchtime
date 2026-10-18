// TV Watch Time native export (`tvwatchtime-export.json`, format `tvwatchtime-library`).
//
// The export is produced by `users/export.service.ts`. Every media/episode row carries the
// exporting server's own id plus portable provider ids, so a restore on the same server can
// match exactly by id while a restore elsewhere falls back to the external-id matcher.
//
// Everything here is a pure function: no I/O, no logging, never throws on garbage input.

import { parseTraktIds, type TraktIds } from '../trakt/types';

export const TVWATCHTIME_EXPORT_FILE = 'tvwatchtime-export.json';
export const TVWATCHTIME_EXPORT_FORMAT = 'tvwatchtime-library';
/** Staged comment identity; the exported comment id is this server's comment id. */
export const TVWATCHTIME_COMMENT_KEY_PREFIX = 'tvwatchtime:comment:';
/** Oldest export version whose shape this parser understands. */
const MIN_VERSION = 4;

const REACTIONS = new Set([
  'SHOCKED',
  'FRUSTRATED',
  'SAD',
  'REFLECTIVE',
  'TOUCHED',
  'AMUSED',
  'SCARED',
  'BORED',
  'UNDERSTANDING',
  'THRILLED',
  'CONFUSED',
  'TENSE',
]);
const DEVICES = new Set(['PHONE', 'TABLET', 'COMPUTER', 'TV', 'OTHER']);
const THEMES = new Set(['SYSTEM', 'LIGHT', 'DARK']);
const TIMINGS = new Set(['AT_RELEASE', 'M15_BEFORE', 'H1_BEFORE', 'D1_BEFORE', 'WEEKLY_DIGEST']);
const OFFER_TYPES = new Set(['STREAM', 'RENT', 'BUY']);
const LANGUAGES = new Set([
  'SYSTEM',
  'EN',
  'FR',
  'ES',
  'PT_BR',
  'DE',
  'IT',
  'AR',
  'TR',
  'HI',
  'ID',
  'JA',
  'KO',
  'ZH_CN',
]);
const MAX_DATES_PER_VIEW = 1000;
const MAX_TEXT = 20_000;

export interface TvwViews {
  count: number;
  /** Ascending, de-duplicated. May be empty when only a count was recorded. */
  dates: Date[];
  device: string | null;
}

export interface TvwRating {
  value: number;
  ratedAt: Date | null;
}

export interface TvwEmotion {
  value: string;
  at: Date | null;
}

export interface TvwComment {
  exportId: string;
  parentId: string | null;
  text: string;
  spoiler: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface TvwCharacterVote {
  /** TVDB character/role id; the import apply resolves cast rows through it. */
  tvdbCharacterId: number | null;
  votedAt: Date | null;
}

interface TvwLibraryFields {
  watchlisted: { addedAt: Date | null; priority: number } | null;
  favorite: { addedAt: Date | null } | null;
  rating: TvwRating | null;
  emotions: TvwEmotion[];
  comments: TvwComment[];
}

export interface TvwShow extends TvwLibraryFields {
  exportId: string;
  title: string;
  year: number | null;
  ids: TraktIds;
  tracking: {
    dropped: boolean;
    pausedAt: Date | null;
    rewatchStartedAt: Date | null;
  } | null;
}

export interface TvwMovie extends TvwLibraryFields {
  exportId: string;
  title: string;
  year: number | null;
  ids: TraktIds;
  views: TvwViews | null;
  characterVote: TvwCharacterVote | null;
}

export interface TvwEpisode {
  /** Exporting server's episode id; null for legacy history rows that had no episode row. */
  exportId: string | null;
  showExportId: string;
  season: number;
  number: number;
  ids: TraktIds;
  views: TvwViews | null;
  rating: TvwRating | null;
  emotions: TvwEmotion[];
  comments: TvwComment[];
  characterVote: TvwCharacterVote | null;
}

export interface TvwList {
  sourceKey: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  createdAt: Date | null;
  items: { mediaExportId: string; addedAt: Date | null; order: number }[];
}

export interface TvwProfile {
  displayName: string | null;
  bio: string | null;
  location: string | null;
  isPrivate: boolean | null;
  hideAnimeInExplore: boolean | null;
  exploreDefaultFilters: unknown;
  exploreSections: unknown;
  theme: string | null;
  language: string | null;
}

export interface TvwNotificationPreferences {
  categories: Record<string, unknown>;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
  timing: string | null;
}

export interface TvwProviderAlert {
  mediaExportId: string;
  offerType: string;
  country: string;
  providerIds: number[];
  active: boolean;
}

export interface TvwSocial {
  following: string[];
  blocked: string[];
  listSubscriptions: { listId: string; notifyOnAdd: boolean }[];
  likedLists: string[];
}

export interface TvwExport {
  version: number;
  restoreToken: string | null;
  profile: TvwProfile | null;
  notificationPreferences: TvwNotificationPreferences | null;
  shows: TvwShow[];
  movies: TvwMovie[];
  episodes: TvwEpisode[];
  lists: TvwList[];
  providerAlerts: TvwProviderAlert[];
  social: TvwSocial;
  /** Rows dropped because they were structurally unusable. */
  invalid: number;
}

const basename = (name: string) =>
  (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();

/** Zip entry names (or a standalone upload name) that identify a native export. */
export function isTvWatchTimeArchive(filenames: string[]): boolean {
  return filenames.some((name) => basename(name) === TVWATCHTIME_EXPORT_FILE);
}

/** Standalone JSON uploads: the canonical name or a renamed copy (`tvwatchtime-export (1).json`). */
export function isTvWatchTimeStandaloneFile(filename: string): boolean {
  const base = basename(filename);
  return base.startsWith('tvwatchtime-export') && base.endsWith('.json');
}

/** True when parsed JSON declares the native format (content sniff for renamed uploads). */
export function isTvWatchTimeExportData(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).format === TVWATCHTIME_EXPORT_FORMAT
  );
}

const obj = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;

const arr = (value: unknown): any[] => (Array.isArray(value) ? value : []);

const str = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

const id = (value: unknown): string | null => str(value, 128);

const date = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const int = (value: unknown, min: number, max: number): number | null => {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

const year = (value: unknown) => int(value, 1800, 3000);

function parseViews(raw: unknown): TvwViews | null {
  const views = obj(raw);
  if (!views) return null;
  const dates = [
    ...new Set(
      arr(views.dates)
        .slice(0, MAX_DATES_PER_VIEW)
        .map(date)
        .filter((value): value is Date => !!value)
        .map((value) => value.getTime()),
    ),
  ]
    .sort((left, right) => left - right)
    .map((time) => new Date(time));
  const count = Math.max(int(views.count, 0, 100_000) ?? 0, dates.length);
  if (!count) return null;
  const device =
    typeof views.device === 'string' && DEVICES.has(views.device) ? views.device : null;
  return { count, dates, device };
}

function parseRating(raw: unknown): TvwRating | null {
  const rating = obj(raw);
  const value = int(rating?.value, 1, 5);
  return value == null ? null : { value, ratedAt: date(rating?.ratedAt) };
}

function parseEmotions(raw: unknown): TvwEmotion[] {
  const seen = new Set<string>();
  const out: TvwEmotion[] = [];
  for (const row of arr(raw)) {
    const emotion = obj(row);
    const value = typeof emotion?.value === 'string' ? emotion.value : null;
    if (!value || !REACTIONS.has(value) || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, at: date(emotion?.at) });
  }
  return out;
}

function parseComments(raw: unknown): TvwComment[] {
  const out: TvwComment[] = [];
  for (const row of arr(raw)) {
    const comment = obj(row);
    const exportId = id(comment?.id);
    const text = typeof comment?.text === 'string' ? comment.text.slice(0, MAX_TEXT) : '';
    if (!exportId || !text.trim()) continue;
    out.push({
      exportId,
      parentId: id(comment?.parentId),
      text,
      spoiler: comment?.spoiler === true,
      createdAt: date(comment?.createdAt),
      updatedAt: date(comment?.updatedAt),
    });
  }
  return out;
}

function parseCharacterVote(raw: unknown): TvwCharacterVote | null {
  const vote = obj(raw);
  if (!vote) return null;
  return {
    tvdbCharacterId: int(obj(vote.characterIds)?.tvdb, 1, Number.MAX_SAFE_INTEGER),
    votedAt: date(vote.votedAt),
  };
}

function libraryFields(media: Record<string, any>): TvwLibraryFields {
  const watchlisted = obj(media.watchlisted);
  const favorite = obj(media.favorite);
  return {
    watchlisted: watchlisted
      ? {
          addedAt: date(watchlisted.addedAt),
          priority: int(watchlisted.priority, -1_000_000, 1_000_000) ?? 0,
        }
      : null,
    favorite: favorite ? { addedAt: date(favorite.addedAt) } : null,
    rating: parseRating(media.rating),
    emotions: parseEmotions(media.emotions),
    comments: parseComments(media.comments),
  };
}

function parseProfile(raw: unknown): TvwProfile | null {
  const profile = obj(raw);
  if (!profile) return null;
  const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
  const jsonOrNull = (value: unknown) =>
    value && typeof value === 'object' && JSON.stringify(value).length <= 20_000 ? value : null;
  return {
    displayName: str(profile.displayName, 100),
    bio: str(profile.bio, 2_000),
    location: str(profile.location, 100),
    isPrivate: bool(profile.isPrivate),
    hideAnimeInExplore: bool(profile.hideAnimeInExplore),
    exploreDefaultFilters: jsonOrNull(profile.exploreDefaultFilters),
    exploreSections: jsonOrNull(profile.exploreSections),
    theme: typeof profile.theme === 'string' && THEMES.has(profile.theme) ? profile.theme : null,
    language:
      typeof profile.language === 'string' && LANGUAGES.has(profile.language)
        ? profile.language
        : null,
  };
}

function parseNotificationPreferences(raw: unknown): TvwNotificationPreferences | null {
  const prefs = obj(raw);
  if (!prefs) return null;
  const categories = obj(prefs.categories) ?? {};
  const time = (value: unknown) =>
    typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null;
  return {
    categories: JSON.stringify(categories).length <= 20_000 ? categories : {},
    quietHoursEnabled: prefs.quietHoursEnabled === true,
    quietHoursStart: time(prefs.quietHoursStart),
    quietHoursEnd: time(prefs.quietHoursEnd),
    timezone: str(prefs.timezone, 64),
    timing: typeof prefs.timing === 'string' && TIMINGS.has(prefs.timing) ? prefs.timing : null,
  };
}

function parseSocial(raw: unknown): TvwSocial {
  const social = obj(raw);
  const usernames = (rows: unknown) => [
    ...new Set(
      arr(rows)
        .map((row) => str(obj(row)?.username, 64))
        .filter((value): value is string => !!value),
    ),
  ];
  const listSubscriptions = new Map<string, { listId: string; notifyOnAdd: boolean }>();
  for (const row of arr(social?.listSubscriptions)) {
    const listId = id(obj(row)?.listId);
    if (listId)
      listSubscriptions.set(listId, { listId, notifyOnAdd: obj(row)?.notifyOnAdd === true });
  }
  return {
    following: usernames(social?.following),
    blocked: usernames(social?.blocked),
    listSubscriptions: [...listSubscriptions.values()],
    likedLists: [
      ...new Set(
        arr(social?.likedLists)
          .map((row) => id(obj(row)?.listId))
          .filter((value): value is string => !!value),
      ),
    ],
  };
}

/**
 * Parse a native export. Returns null when the payload is not a supported
 * `tvwatchtime-library` document; otherwise every structurally unusable row is dropped and
 * counted in `invalid`.
 */
export function parseTvWatchTimeExport(raw: unknown): TvwExport | null {
  const root = obj(raw);
  if (!root || root.format !== TVWATCHTIME_EXPORT_FORMAT) return null;
  const version = int(root.version, MIN_VERSION, 1_000);
  if (version == null) return null;
  let invalid = 0;

  const shows: TvwShow[] = [];
  const showIds = new Set<string>();
  for (const row of arr(root.shows)) {
    const show = obj(row);
    const exportId = id(show?.id);
    const title = str(show?.title);
    if (!show || !exportId || !title || showIds.has(exportId)) {
      invalid++;
      continue;
    }
    showIds.add(exportId);
    const tracking = obj(show.tracking);
    shows.push({
      exportId,
      title,
      year: year(show.year),
      ids: parseTraktIds(show.ids),
      ...libraryFields(show),
      tracking: tracking
        ? {
            dropped: tracking.dropped === true,
            pausedAt: date(tracking.pausedAt),
            rewatchStartedAt: date(tracking.rewatchStartedAt),
          }
        : null,
    });
  }

  const movies: TvwMovie[] = [];
  const movieIds = new Set<string>();
  for (const row of arr(root.movies)) {
    const movie = obj(row);
    const exportId = id(movie?.id);
    const title = str(movie?.title);
    if (!movie || !exportId || !title || movieIds.has(exportId) || showIds.has(exportId)) {
      invalid++;
      continue;
    }
    movieIds.add(exportId);
    movies.push({
      exportId,
      title,
      year: year(movie.year),
      ids: parseTraktIds(movie.ids),
      ...libraryFields(movie),
      views: parseViews(movie.views),
      characterVote: parseCharacterVote(movie.characterVote),
    });
  }

  const episodes: TvwEpisode[] = [];
  const episodeKeys = new Set<string>();
  for (const row of arr(root.episodes)) {
    const episode = obj(row);
    const showExportId = id(episode?.showId);
    const season = int(episode?.season, 0, 10_000);
    const number = int(episode?.number, 0, 100_000);
    if (
      !episode ||
      !showExportId ||
      !showIds.has(showExportId) ||
      season == null ||
      number == null
    ) {
      invalid++;
      continue;
    }
    // Legacy history rows use a synthetic `<show>:sX:eY` id with no backing episode row.
    const rawId = id(episode.id);
    const exportId = rawId && !rawId.startsWith(`${showExportId}:s`) ? rawId : null;
    const key = exportId ?? `${showExportId}:s${season}:e${number}`;
    if (episodeKeys.has(key)) {
      invalid++;
      continue;
    }
    episodeKeys.add(key);
    episodes.push({
      exportId,
      showExportId,
      season,
      number,
      ids: parseTraktIds(episode.ids),
      views: parseViews(episode.views),
      rating: parseRating(episode.rating),
      emotions: parseEmotions(episode.emotions),
      comments: parseComments(episode.comments),
      characterVote: parseCharacterVote(episode.characterVote),
    });
  }

  const lists: TvwList[] = [];
  const listKeys = new Set<string>();
  arr(root.lists).forEach((row, index) => {
    const list = obj(row);
    const title = str(list?.title, 200);
    if (!list || !title) {
      invalid++;
      return;
    }
    // v5 carries the list id; older exports fall back to a positional + title identity.
    const listId = id(list.id);
    const sourceKey = listId
      ? `tvwatchtime:list:${listId}`
      : `tvwatchtime:list:${index}:${title.toLowerCase()}`;
    if (listKeys.has(sourceKey)) {
      invalid++;
      return;
    }
    listKeys.add(sourceKey);
    const items: TvwList['items'] = [];
    const seen = new Set<string>();
    arr(list.items).forEach((item, order) => {
      const mediaExportId = id(obj(item)?.mediaId);
      if (!mediaExportId || seen.has(mediaExportId)) return;
      seen.add(mediaExportId);
      items.push({ mediaExportId, addedAt: date(obj(item)?.addedAt), order });
    });
    lists.push({
      sourceKey,
      title,
      description: str(list.description, 5_000),
      coverUrl: str(list.coverUrl, 2_000),
      visibility: list.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
      createdAt: date(list.createdAt),
      items,
    });
  });

  const providerAlerts: TvwProviderAlert[] = [];
  for (const row of arr(root.providerAlerts)) {
    const alert = obj(row);
    const mediaExportId = id(alert?.mediaId);
    const offerType = typeof alert?.offerType === 'string' ? alert.offerType : '';
    const country = str(alert?.country, 8);
    if (!mediaExportId || !OFFER_TYPES.has(offerType) || !country) {
      invalid++;
      continue;
    }
    providerAlerts.push({
      mediaExportId,
      offerType,
      country,
      providerIds: arr(alert?.providerIds)
        .map((value) => int(value, 1, 2_147_483_647))
        .filter((value): value is number => value != null)
        .slice(0, 200),
      active: alert?.active !== false,
    });
  }

  const user = obj(root.user);
  return {
    version,
    restoreToken: typeof user?.restoreToken === 'string' ? user.restoreToken : null,
    profile: parseProfile(user?.profile),
    notificationPreferences: parseNotificationPreferences(user?.notificationPreferences),
    shows,
    movies,
    episodes,
    lists,
    providerAlerts,
    social: parseSocial(root.social),
    invalid,
  };
}
