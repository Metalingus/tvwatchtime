// TV Time JSON GDPR export normalization: shared types + defensive parsing.
//
// The export is a zip mixing JSON files (shows.json, movies.json, favorites.json,
// lists.json) with flattened CSV duplicates of the same data (favorites.csv,
// list_*.csv) plus one flat activity_history.csv. The JSON files are authoritative
// for watched data and ratings; activity_history.csv is used ONLY for its show
// `is_watchlisted` flag, which exists nowhere in the JSON.
//
// Media identity: `id: { tvdb: number, imdb: string }` — imdb is the string "-1"
// when absent (shows always have "-1"). We reuse TraktIds ({ tvdb, imdb }) so the
// matcher's external-id pipeline works unchanged.
//
// Everything here is a pure function: no I/O, no logging, never throws on garbage.

import { parseDate } from '../inference';
import type { NormalizedImportedRating } from '../ratings';
import type { TraktIds } from '../trakt/types';

export interface TvTimeWatchedEpisodeCandidate {
  showTitle: string;
  year: number | null;
  season: number;
  episode: number;
  special: boolean;
  showIds: TraktIds;
  episodeIds: TraktIds;
  watchedAt: Date | null;
}

/** Non-special season/episode footprint of one show — feeds the structural guard. */
export interface TvTimeShowFootprint {
  key: string;
  showTitle: string;
  year: number | null;
  showIds: TraktIds;
  maxSeason: number | null;
  seasonEpisodes: { season: number; maxEpisode: number }[];
}

export interface TvTimeShowsResult {
  episodes: TvTimeWatchedEpisodeCandidate[];
  footprints: Map<string, TvTimeShowFootprint>;
  invalid: number;
}

export interface TvTimeWatchedMovieCandidate {
  movieTitle: string;
  year: number | null;
  movieIds: TraktIds;
  watchedAt: Date | null;
}

export interface TvTimeWatchlistCandidate {
  type: 'show' | 'movie';
  title: string;
  year: number | null;
  ids: TraktIds;
  listedAt: Date | null;
}

export interface TvTimeMoviesResult {
  watched: TvTimeWatchedMovieCandidate[];
  watchlist: TvTimeWatchlistCandidate[];
  invalid: number;
}

export interface TvTimeFavoritesResult {
  candidates: TvTimeWatchlistCandidate[];
  skipped: number;
}

export interface TvTimeListItemCandidate {
  mediaType: 'show' | 'movie';
  title: string;
  year: number | null;
  ids: TraktIds;
  order: number;
  createdAt: Date | null;
}

export interface TvTimeListCandidate {
  sourceKey: string;
  title: string;
  description: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  createdAt: Date | null;
  items: TvTimeListItemCandidate[];
  skippedItems: number;
}

export interface TvTimeListsResult {
  lists: TvTimeListCandidate[];
  skippedLists: number;
}

export interface TvTimeRatingCandidate {
  rating: NormalizedImportedRating;
  showIds?: TraktIds;
  movieIds?: TraktIds;
  episodeIds?: TraktIds;
}

export interface TvTimeRatingsResult {
  candidates: TvTimeRatingCandidate[];
  detected: number;
  unsupported: number;
}

export interface TvTimeWatchlistCsvResult {
  candidates: TvTimeWatchlistCandidate[];
  skipped: number;
}

export const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const strOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

export const dateOrNull = (v: unknown): Date | null => (typeof v === 'string' ? parseDate(v) : null);

export const boolOrFalse = (v: unknown): boolean => v === true || v === 'true';

/**
 * Coerce a TV Time `id` blob into TraktIds. tvdb is numeric; imdb is a string with
 * the sentinel "-1" (also "-1"/-1 as number) meaning "no id" → null.
 */
export function parseTvTimeIds(raw: unknown): TraktIds {
  const out: TraktIds = {};
  const o = asObj(raw);
  if (!o) return out;
  out.tvdb = numOrNull(o.tvdb);
  const imdb = strOrNull(o.imdb) ?? (typeof o.imdb === 'number' ? String(o.imdb) : null);
  out.imdb = imdb && imdb !== '-1' ? imdb : null;
  return out;
}

/** Group identity for a show/movie: tvdb id → imdb → normalized title. */
export const mediaKey = (ids: TraktIds, norm: string): string =>
  ids.tvdb != null ? `tvdb:${ids.tvdb}` : ids.imdb ? `imdb:${ids.imdb}` : `title:${norm}`;

/** TV Time rates 1..10 (even steps); map to 1..5 like the Trakt path. */
export const mapRating = (value: number): number => Math.min(5, Math.max(1, Math.round(value / 2)));
