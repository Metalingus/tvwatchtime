// TV Time movies.json normalization.
//
// movies.json rows: { id: { tvdb, imdb }, created_at, uuid, title, watched_at,
//   is_watched, rating }
//
// is_watched=true  → watched movie candidate (watchedAt)
// is_watched=false → watchlist movie candidate (listedAt = created_at) — verified
// equivalent to activity_history.csv's is_watchlisted flag for movies.

import { normTitle, splitTitleYear } from '../inference';
import {
  asObj,
  boolOrFalse,
  dateOrNull,
  parseTvTimeIds,
  strOrNull,
  type TvTimeMoviesResult,
} from './types';

export function normalizeTvTimeJsonMovies(data: unknown): TvTimeMoviesResult {
  const watched: TvTimeMoviesResult['watched'] = [];
  const watchlist: TvTimeMoviesResult['watchlist'] = [];
  const seen = new Set<string>();
  let invalid = 0;

  if (!Array.isArray(data)) return { watched, watchlist, invalid };

  for (const row of data) {
    const m = asObj(row);
    const rawTitle = strOrNull(m?.title);
    const ids = parseTvTimeIds(m?.id);
    if (!m || !rawTitle) {
      invalid++;
      continue;
    }
    const { title, year } = splitTitleYear(rawTitle);
    const key = ids.tvdb != null ? `tvdb:${ids.tvdb}` : ids.imdb ? `imdb:${ids.imdb}` : `title:${normTitle(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (boolOrFalse(m.is_watched)) {
      watched.push({ movieTitle: title, year, movieIds: ids, watchedAt: dateOrNull(m.watched_at) });
    } else {
      watchlist.push({ type: 'movie', title, year, ids, listedAt: dateOrNull(m.created_at) });
    }
  }

  return { watched, watchlist, invalid };
}
