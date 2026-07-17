// Trakt GDPR export: file classification + archive-level detection/language resolution.
//
// Files inside a Trakt zip may sit in subfolders, so classification always works on
// the lowercase basename with the `.json` extension stripped. Matching is prefix-based
// to tolerate numbered pages (`watched-history-27`) — but only for the exact prefixes
// below; every other Trakt file (collection-*, hidden-*, likes-*, network-*, notes-*,
// user-profile, user-stats, watched-playback, …) is `unsupported`.

import { safeLangPref, type SupportedLocale } from '@tvwatch/shared';

export type TraktFileKind =
  | 'watched_history'
  | 'watched_shows'
  | 'watched_movies'
  | 'ratings_show'
  | 'ratings_episode'
  | 'ratings_movie'
  | 'ratings_season'
  | 'watchlist'
  | 'favorites'
  | 'lists'
  | 'comments_episode'
  | 'comments_movie'
  | 'comments_show'
  | 'comments_season'
  | 'comments_list'
  | 'user_settings'
  | 'unsupported';

/** Lowercase basename without directories and without the `.json` extension. */
const stem = (filename: string): string => {
  const base = (filename.replace(/\\/g, '/').split('/').pop() ?? filename).toLowerCase();
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
};

/** Classify one file of a Trakt export by name. Unknown/unsupported → 'unsupported'. */
export function classifyTraktFile(filename: string): TraktFileKind {
  const f = stem(filename);
  if (f.startsWith('watched-history')) return 'watched_history';
  if (f.startsWith('watched-shows')) return 'watched_shows';
  if (f.startsWith('watched-movies')) return 'watched_movies';
  if (f.startsWith('ratings-episodes')) return 'ratings_episode';
  if (f.startsWith('ratings-shows')) return 'ratings_show';
  if (f.startsWith('ratings-movies')) return 'ratings_movie';
  if (f.startsWith('ratings-seasons')) return 'ratings_season';
  if (f.startsWith('lists-watchlist')) return 'watchlist';
  if (f.startsWith('lists-favorites')) return 'favorites';
  if (f.startsWith('lists-lists')) return 'lists';
  if (f.startsWith('comments-episodes')) return 'comments_episode';
  if (f.startsWith('comments-movies')) return 'comments_movie';
  if (f.startsWith('comments-shows')) return 'comments_show';
  if (f.startsWith('comments-seasons')) return 'comments_season';
  if (f.startsWith('comments-lists')) return 'comments_list';
  if (f.startsWith('user-settings')) return 'user_settings';
  return 'unsupported';
}

const TRAKT_ARCHIVE_PREFIXES = [
  'watched-history',
  'watched-shows',
  'watched-movies',
  'ratings-',
  'lists-watchlist',
  'lists-favorites',
  'lists-lists',
  'comments-',
  'user-settings',
  'user-profile',
];

/**
 * Heuristic: does this file list look like a Trakt GDPR export? True when ANY
 * `.json` basename starts with a known Trakt prefix. Used to pick the Trakt
 * pipeline over the TV Time CSV one.
 */
export function isTraktArchive(filenames: string[]): boolean {
  return filenames.some((name) => {
    const base = (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
    if (!base.endsWith('.json')) return false;
    return TRAKT_ARCHIVE_PREFIXES.some((p) => base.startsWith(p));
  });
}

/**
 * Resolve the archive's Trakt account language from the parsed user-settings.json
 * (`browsing.locale`, e.g. "en" or "fr-fr"). Tries the exact value, then the base
 * language code. Returns a SupportedLocale or null when nothing maps.
 */
export function resolveTraktArchiveLanguage(userSettings: unknown): SupportedLocale | null {
  if (!userSettings || typeof userSettings !== 'object') return null;
  const browsing = (userSettings as Record<string, unknown>).browsing;
  if (!browsing || typeof browsing !== 'object') return null;
  const raw = (browsing as Record<string, unknown>).locale;
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase();
  if (!norm) return null;
  const pref = safeLangPref(norm);
  if (pref !== 'system') return pref;
  const baseCode = norm.split(/[-_]/)[0];
  const pref2 = safeLangPref(baseCode);
  if (pref2 !== 'system') return pref2;
  return null;
}
