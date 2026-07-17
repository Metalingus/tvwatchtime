// TV Time JSON GDPR export: file classification + archive-level detection.
//
// The zip mixes JSON files (authoritative) with flattened CSV duplicates:
//   shows.json / movies.json / favorites.json / lists.json   → parsed
//   activity_history.csv                                     → parsed ONLY for show watchlist flags
//   favorites.csv / list_*.csv / any other .csv              → ignored (duplicates of the JSON)
//
// Classification works on the lowercase basename (files may sit in subfolders).

export type TvTimeJsonFileKind =
  | 'shows'
  | 'movies'
  | 'favorites'
  | 'lists'
  | 'activity_csv'
  | 'ignored_csv'
  | 'unsupported';

/** Lowercase basename without directories. */
const base = (filename: string): string =>
  (filename.replace(/\\/g, '/').split('/').pop() ?? filename).toLowerCase();

/** Classify one file of a TV Time JSON export by name. Unknown → 'unsupported'. */
export function classifyTvTimeJsonFile(filename: string): TvTimeJsonFileKind {
  const f = base(filename);
  if (f === 'shows.json') return 'shows';
  if (f === 'movies.json') return 'movies';
  if (f === 'favorites.json') return 'favorites';
  if (f === 'lists.json') return 'lists';
  if (f === 'activity_history.csv') return 'activity_csv';
  if (f.endsWith('.csv')) return 'ignored_csv'; // flattened duplicates (list_*.csv, favorites.csv, …)
  return 'unsupported';
}

const ARCHIVE_MARKERS = ['shows.json', 'movies.json', 'activity_history.csv'];

/**
 * Heuristic: does this file list look like a TV Time JSON GDPR export? True when ANY
 * entry basename is shows.json / movies.json / activity_history.csv. Checked AFTER the
 * Trakt detector (no name overlap). activity_history.csv alone is a marker too — its
 * headers would otherwise hit the legacy generic CSV profiles and import unwatched
 * rows as watched.
 */
export function isTvTimeJsonArchive(filenames: string[]): boolean {
  return filenames.some((name) => ARCHIVE_MARKERS.includes(base(name)));
}

/** Basenames accepted as a standalone single-file JSON upload (mirrors the Trakt path). */
const STANDALONE_JSON = ['shows.json', 'movies.json', 'favorites.json', 'lists.json'];

export function isTvTimeJsonStandaloneFile(filename: string): boolean {
  return STANDALONE_JSON.includes(base(filename));
}
