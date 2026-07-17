// TV Time activity_history.csv — show watchlist extraction ONLY.
//
// The flat CSV duplicates everything the JSON files already carry (watched flags,
// ratings, timestamps) EXCEPT one signal: the show-level `is_watchlisted` flag
// (TV Time's "in my watchlist"), which exists nowhere in the JSON and cannot be
// reconstructed from shows.json's `status` field. Movie watchlist state needs no
// CSV (movies.json is_watched=false ⇔ watchlisted, verified equivalent).
//
// Rows are already parsed by lib/csv.ts (proper quoting — titles contain commas).
// Only rows with type=show AND is_watchlisted=true become candidates, deduped by
// TVDB series id. Everything else is ignored by design.

import { normTitle, splitTitleYear } from '../inference';
import { numOrNull, strOrNull, type TvTimeWatchlistCandidate, type TvTimeWatchlistCsvResult } from './types';

const truthy = (v: string | undefined): boolean => /^(1|true|yes|y)$/i.test(String(v ?? '').trim());

export function normalizeTvTimeWatchlistCsv(rows: Record<string, string>[]): TvTimeWatchlistCsvResult {
  const candidates: TvTimeWatchlistCandidate[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const row of rows) {
    const type = strOrNull(row['type'])?.toLowerCase();
    if (type !== 'show' || !truthy(row['is_watchlisted'])) continue;
    const rawTitle = strOrNull(row['title']);
    if (!rawTitle) {
      skipped++;
      continue;
    }
    const { title, year } = splitTitleYear(rawTitle);
    const tvdb = numOrNull(row['tvdb_id']);
    const imdbRaw = strOrNull(row['imdb_id']);
    const imdb = imdbRaw && imdbRaw !== '-1' ? imdbRaw : null;
    const key = tvdb != null ? `tvdb:${tvdb}` : imdb ? `imdb:${imdb}` : `title:${normTitle(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ type: 'show', title, year, ids: { tvdb, imdb }, listedAt: null });
  }

  return { candidates, skipped };
}
