// Trakt watched history normalization.
//
// `watched-history-*.json` pages carry one row per play:
//   { id, watched_at, action: "watch", type: "episode"|"movie",
//     episode: { ids, title, number, season }, show: { ids, year, title, … } }
// movie plays carry `movie: { ids, year, title }` instead of episode+show.
//
// Plays are deduped by entry `id` across pages, then collapsed per episode/movie:
// watchCount = number of valid plays, watchedAt = EARLIEST watched_at. Rows with
// invalid dates are rejected instead of being applied at import time. Specials
// (S0/E0) are kept — the processor decides their fate.
//
// FALLBACK: only when NO history arrays were provided at all (`history: []`), the
// watched-movies aggregate yields movie candidates (plays → watchCount) and each
// watched-shows aggregate row is counted into skippedNoEpisodeData — episode rows
// are never fabricated. When history exists the aggregates are fully ignored.

import { normTitle, parseDate } from '../inference';
import {
  parseTraktIds,
  traktIdsKey,
  type TraktIds,
  type TraktWatchedEpisodeCandidate,
  type TraktWatchedMovieCandidate,
} from './types';

export interface TraktWatchedResult {
  episodes: TraktWatchedEpisodeCandidate[];
  movies: TraktWatchedMovieCandidate[];
  invalid: number;
  skippedNoEpisodeData: number;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

const dateOrNull = (v: unknown): Date | null => (typeof v === 'string' ? parseDate(v) : null);

const earliest = (cur: Date | null, d: Date | null): Date | null =>
  d && (cur == null || d.getTime() < cur.getTime()) ? d : cur;

/** Group identity includes every exported id so contradictory rows cannot merge. */
const showKey = (ids: TraktIds, title: string, year: number | null): string =>
  traktIdsKey(ids) || `title:${normTitle(title)}:${year ?? ''}`;

/** Group identity includes every exported id so contradictory rows cannot merge. */
const movieKey = (ids: TraktIds, title: string, year: number | null): string =>
  traktIdsKey(ids) || `title:${normTitle(title)}:${year ?? ''}`;

const episodeKey = (
  showIds: TraktIds,
  episodeIds: TraktIds,
  title: string,
  year: number | null,
  season: number,
  episode: number,
): string => {
  const identity = traktIdsKey(episodeIds);
  return identity
    ? `episode:${identity}`
    : `${showKey(showIds, title, year)}|s${season}|e${episode}`;
};

export function normalizeTraktWatched(input: {
  history: unknown[];
  watchedMovies: unknown[];
  watchedShows: unknown[];
}): TraktWatchedResult {
  const episodeGroups = new Map<string, TraktWatchedEpisodeCandidate>();
  const movieGroups = new Map<string, TraktWatchedMovieCandidate>();
  const seenPlayIds = new Set<number>();
  let invalid = 0;
  let skippedNoEpisodeData = 0;

  const addMovie = (
    title: string,
    year: number | null,
    ids: TraktIds,
    count: number,
    watchedAt: Date,
  ): void => {
    const key = movieKey(ids, title, year);
    const g = movieGroups.get(key);
    if (g) {
      g.watchCount += count;
      g.watchedAt = earliest(g.watchedAt, watchedAt);
    } else {
      movieGroups.set(key, {
        movieTitle: title,
        year,
        movieIds: ids,
        watchCount: count,
        watchedAt,
      });
    }
  };

  // `history` is an array of per-file arrays; skip non-array elements defensively.
  for (const page of input.history) {
    if (!Array.isArray(page)) continue;
    for (const entry of page) {
      const e = asObj(entry);
      if (!e) {
        invalid++;
        continue;
      }
      const playId = numOrNull(e.id);
      if (playId == null || !Number.isSafeInteger(playId) || playId <= 0) {
        invalid++;
        continue;
      }
      if (seenPlayIds.has(playId)) continue; // duplicate play across pages
      seenPlayIds.add(playId);
      const watchedAt = dateOrNull(e.watched_at);
      if (!watchedAt) {
        invalid++;
        continue;
      }
      if (e.type === 'episode') {
        const ep = asObj(e.episode);
        const show = asObj(e.show);
        const season = numOrNull(ep?.season);
        const number = numOrNull(ep?.number);
        const showTitle = strOrNull(show?.title);
        if (
          season == null ||
          number == null ||
          !Number.isSafeInteger(season) ||
          !Number.isSafeInteger(number) ||
          season < 0 ||
          number < 0 ||
          !showTitle
        ) {
          invalid++;
          continue;
        }
        const showIds = parseTraktIds(show?.ids);
        const year = numOrNull(show?.year);
        const episodeIds = parseTraktIds(ep?.ids);
        const key = episodeKey(showIds, episodeIds, showTitle, year, season, number);
        const g = episodeGroups.get(key);
        if (g) {
          g.watchCount += 1;
          g.watchedAt = earliest(g.watchedAt, watchedAt);
        } else {
          episodeGroups.set(key, {
            showTitle,
            year,
            season,
            episode: number,
            showIds,
            episodeIds,
            watchCount: 1,
            watchedAt,
          });
        }
      } else if (e.type === 'movie') {
        const movie = asObj(e.movie);
        const title = strOrNull(movie?.title);
        if (!title) {
          invalid++;
          continue;
        }
        addMovie(title, numOrNull(movie?.year), parseTraktIds(movie?.ids), 1, watchedAt);
      } else {
        invalid++; // unknown type
      }
    }
  }

  // Aggregate fallback — only when no history arrays were provided at all.
  if (input.history.length === 0) {
    for (const page of input.watchedMovies) {
      if (!Array.isArray(page)) continue;
      for (const row of page) {
        const r = asObj(row);
        const movie = asObj(r?.movie);
        const title = strOrNull(movie?.title);
        if (!r || !title) {
          invalid++;
          continue;
        }
        const count = numOrNull(r.plays);
        const watchedAt = dateOrNull(r.last_watched_at);
        if (count == null || !Number.isSafeInteger(count) || count <= 0 || !watchedAt) {
          invalid++;
          continue;
        }
        addMovie(title, numOrNull(movie?.year), parseTraktIds(movie?.ids), count, watchedAt);
      }
    }
    // Show aggregates carry no per-episode data — counted, never fabricated.
    for (const page of input.watchedShows) {
      if (!Array.isArray(page)) continue;
      skippedNoEpisodeData += page.length;
    }
  }

  return {
    episodes: [...episodeGroups.values()],
    movies: [...movieGroups.values()],
    invalid,
    skippedNoEpisodeData,
  };
}
