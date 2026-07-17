// TV Time JSON rating normalization.
//
// Ratings live INSIDE the watched-data files as a nullable 1..10 `rating` field:
//   - shows.json episodes
//   - movies.json movies
//   - episodes embedded in favorites.json / lists.json shows (a rating can exist
//     there even when the episode isn't in shows.json — verified in real exports)
//
// Episode ratings are deduped by TVDB episode id across ALL sources (first wins,
// shows.json is processed first). voteKey stays null — the apply stage falls back
// to stable `episode:<id>` / `media:<id>` identity keys, which keeps re-imports
// idempotent without inventing an id space. 1..10 → 1..5 via round(r/2) clamped.

import { normTitle, parseDate, splitTitleYear } from '../inference';
import type { NormalizedImportedRating } from '../ratings';
import {
  asObj,
  mapRating,
  numOrNull,
  parseTvTimeIds,
  strOrNull,
  type TvTimeRatingCandidate,
  type TvTimeRatingsResult,
} from './types';

const ratingValue = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n != null && n >= 1 && n <= 10 ? n : null;
};

export function normalizeTvTimeJsonRatings(input: {
  shows: unknown[];
  movies: unknown[];
  collections: unknown[]; // favorites.json object + lists.json rows
}): TvTimeRatingsResult {
  const candidates: TvTimeRatingCandidate[] = [];
  const seenEpisodes = new Set<string>();
  const seenMovies = new Set<string>();
  let detected = 0;
  let unsupported = 0;

  const base = (
    targetType: NormalizedImportedRating['targetType'],
    sourceFile: string,
    sourceRow: number,
    createdAt: Date | null,
  ): NormalizedImportedRating => ({
    targetType,
    sourceFile,
    sourceRow,
    sourceSet: 'tvtime',
    sourceRatingId: null,
    idFromExplicitCol: false,
    normalizedRating: null,
    supported: true,
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: null,
    voteKey: null,
  });

  const pushEpisode = (
    showTitle: string,
    seasonNumber: number | null,
    episodeNumber: number | null,
    epIds: ReturnType<typeof parseTvTimeIds>,
    showIds: ReturnType<typeof parseTvTimeIds>,
    value: number,
    createdAt: Date | null,
    sourceFile: string,
    sourceRow: number,
  ) => {
    const key = epIds.tvdb != null ? `tvdb:${epIds.tvdb}` : `${normTitle(showTitle)}|s${seasonNumber}|e${episodeNumber}`;
    if (seenEpisodes.has(key)) return;
    seenEpisodes.add(key);
    candidates.push({
      rating: {
        ...base('episode', sourceFile, sourceRow, createdAt),
        normalizedRating: mapRating(value),
        externalEpisodeId: epIds.tvdb ?? null,
        showTitle,
        seasonNumber,
        episodeNumber,
      },
      showIds,
      episodeIds: epIds,
    });
  };

  const pushMovie = (
    movieTitle: string,
    movieIds: ReturnType<typeof parseTvTimeIds>,
    value: number,
    createdAt: Date | null,
    sourceFile: string,
    sourceRow: number,
  ) => {
    const key = movieIds.tvdb != null ? `tvdb:${movieIds.tvdb}` : movieIds.imdb ? `imdb:${movieIds.imdb}` : `title:${normTitle(movieTitle)}`;
    if (seenMovies.has(key)) return;
    seenMovies.add(key);
    candidates.push({
      rating: { ...base('movie', sourceFile, sourceRow, createdAt), normalizedRating: mapRating(value), movieTitle },
      movieIds,
    });
  };

  // Harvest every rated episode of a show-shaped object ({ id, title, seasons }).
  const harvestShow = (show: Record<string, unknown>, sourceFile: string, rowBase: number) => {
    const rawTitle = strOrNull(show.title);
    if (!rawTitle) return;
    const { title } = splitTitleYear(rawTitle);
    const showIds = parseTvTimeIds(show.id);
    const seasons = Array.isArray(show.seasons) ? show.seasons : [];
    seasons.forEach((rawSeason) => {
      const s = asObj(rawSeason);
      const seasonNumber = numOrNull(s?.number);
      const eps = Array.isArray(s?.episodes) ? (s!.episodes as unknown[]) : [];
      eps.forEach((rawEp) => {
        const e = asObj(rawEp);
        const value = ratingValue(e?.rating);
        if (value == null) return;
        detected++;
        const episodeNumber = numOrNull(e?.number);
        if (seasonNumber == null || episodeNumber == null) {
          unsupported++;
          return;
        }
        pushEpisode(
          title,
          seasonNumber,
          episodeNumber,
          parseTvTimeIds(e?.id),
          showIds,
          value,
          typeof e?.watched_at === 'string' ? (parseDate(e.watched_at) ?? null) : null,
          sourceFile,
          rowBase,
        );
      });
    });
  };

  input.shows.forEach((data, fileIdx) => {
    if (!Array.isArray(data)) return;
    data.forEach((row, idx) => {
      const show = asObj(row);
      if (show) harvestShow(show, 'shows.json', fileIdx * 100000 + idx + 1);
    });
  });

  input.movies.forEach((data, fileIdx) => {
    if (!Array.isArray(data)) return;
    data.forEach((row, idx) => {
      const m = asObj(row);
      const value = ratingValue(m?.rating);
      if (!m || value == null) return;
      detected++;
      const rawTitle = strOrNull(m.title);
      if (!rawTitle) {
        unsupported++;
        return;
      }
      const { title } = splitTitleYear(rawTitle);
      const createdAt = typeof m.watched_at === 'string' ? parseDate(m.watched_at) : null;
      pushMovie(title, parseTvTimeIds(m.id), value, createdAt, 'movies.json', fileIdx * 100000 + idx + 1);
    });
  });

  // Embedded shows/movies inside favorites.json + lists.json (deduped by id above).
  input.collections.forEach((data, collIdx) => {
    const roots = Array.isArray(data) ? data : [data];
    roots.forEach((root, idx) => {
      const r = asObj(root);
      if (!r) return;
      const sourceFile = Array.isArray(data) ? 'lists.json' : 'favorites.json';
      const rowBase = 1000000 + collIdx * 100000 + idx + 1;
      if (Array.isArray(r.shows)) {
        for (const show of r.shows) {
          const s = asObj(show);
          if (s) harvestShow(s, sourceFile, rowBase);
        }
      }
      if (Array.isArray(r.movies)) {
        for (const rawMovie of r.movies) {
          const m = asObj(rawMovie);
          const value = ratingValue(m?.rating);
          if (!m || value == null) continue;
          detected++;
          const rawTitle = strOrNull(m.title);
          if (!rawTitle) {
            unsupported++;
            continue;
          }
          const { title } = splitTitleYear(rawTitle);
          pushMovie(title, parseTvTimeIds(m.id), value, null, sourceFile, rowBase);
        }
      }
    });
  });

  return { candidates, detected, unsupported };
}
