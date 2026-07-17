// Trakt watched history normalization.
//
// `watched-history-*.json` pages carry one row per play:
//   { id, watched_at, action: "watch", type: "episode"|"movie",
//     episode: { ids, title, number, season }, show: { ids, year, title, … } }
// movie plays carry `movie: { ids, year, title }` instead of episode+show.
//
// Plays are deduped by entry `id` across pages, then collapsed per episode/movie:
// watchCount = number of plays, watchedAt = EARLIEST valid watched_at (invalid
// dates → null but the play still counts). Specials (S0/E0) are kept — the
// processor decides their fate.
//
// FALLBACK: only when NO history arrays were provided at all (`history: []`), the
// watched-movies aggregate yields movie candidates (plays → watchCount) and each
// watched-shows aggregate row is counted into skippedNoEpisodeData — episode rows
// are never fabricated. When history exists the aggregates are fully ignored.

import { normTitle, parseDate } from '../inference';
import {
  parseTraktIds,
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

/** Group identity: show trakt id → tvdb → tmdb → normalized title. */
const showKey = (ids: TraktIds, title: string): string =>
  ids.trakt != null
    ? `trakt:${ids.trakt}`
    : ids.tvdb != null
      ? `tvdb:${ids.tvdb}`
      : ids.tmdb != null
        ? `tmdb:${ids.tmdb}`
        : `title:${normTitle(title)}`;

/** Group identity: movie trakt id → tmdb → imdb → normalized title. */
const movieKey = (ids: TraktIds, title: string): string =>
  ids.trakt != null
    ? `trakt:${ids.trakt}`
    : ids.tmdb != null
      ? `tmdb:${ids.tmdb}`
      : ids.imdb != null
        ? `imdb:${ids.imdb}`
        : `title:${normTitle(title)}`;

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
    watchedAt: Date | null,
  ): void => {
    const key = movieKey(ids, title);
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
      if (playId != null) {
        if (seenPlayIds.has(playId)) continue; // duplicate play across pages
        seenPlayIds.add(playId);
      }
      const watchedAt = dateOrNull(e.watched_at);
      if (e.type === 'episode') {
        const ep = asObj(e.episode);
        const show = asObj(e.show);
        const season = numOrNull(ep?.season);
        const number = numOrNull(ep?.number);
        const showTitle = strOrNull(show?.title);
        if (season == null || number == null || !showTitle) {
          invalid++;
          continue;
        }
        const showIds = parseTraktIds(show?.ids);
        const key = `${showKey(showIds, showTitle)}|s${season}|e${number}`;
        const g = episodeGroups.get(key);
        if (g) {
          g.watchCount += 1;
          g.watchedAt = earliest(g.watchedAt, watchedAt);
        } else {
          episodeGroups.set(key, {
            showTitle,
            year: numOrNull(show?.year),
            season,
            episode: number,
            showIds,
            episodeIds: parseTraktIds(ep?.ids),
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
        addMovie(
          title,
          numOrNull(movie?.year),
          parseTraktIds(movie?.ids),
          numOrNull(r.plays) ?? 1,
          dateOrNull(r.last_watched_at),
        );
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
