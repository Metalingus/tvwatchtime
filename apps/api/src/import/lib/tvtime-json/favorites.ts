// TV Time favorites.json normalization.
//
// favorites.json is a single object: { name, description, is_public,
//   movies: [...], shows: [{ id, title, uuid, seasons, added_at }] }
// Membership is the only signal imported (embedded seasons are ignored here but
// their episode ratings are harvested by ratings.ts). Movie entries are parsed
// defensively — the sample export has an empty movies array.

import { splitTitleYear } from '../inference';
import {
  asObj,
  dateOrNull,
  parseTvTimeIds,
  strOrNull,
  type TvTimeFavoritesResult,
  type TvTimeWatchlistCandidate,
} from './types';

export function normalizeTvTimeJsonFavorites(data: unknown): TvTimeFavoritesResult {
  const candidates: TvTimeWatchlistCandidate[] = [];
  let skipped = 0;

  const root = asObj(data);
  if (!root) return { candidates, skipped };

  const collect = (rows: unknown, type: 'show' | 'movie') => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const r = asObj(row);
      const rawTitle = strOrNull(r?.title);
      if (!r || !rawTitle) {
        skipped++;
        continue;
      }
      const { title, year } = splitTitleYear(rawTitle);
      candidates.push({ type, title, year, ids: parseTvTimeIds(r.id), listedAt: dateOrNull(r.added_at) });
    }
  };

  collect(root.shows, 'show');
  collect(root.movies, 'movie');

  return { candidates, skipped };
}
