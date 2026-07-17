// Trakt GDPR JSON export normalization: shared types + defensive id parsing.
//
// A Trakt export is a zip of per-domain JSON files (watched-history-*.json,
// ratings-*.json, lists-watchlist.json, lists-lists.json, comments-*.json,
// user-settings.json, …). This module turns those files into neutral "candidate"
// objects consumed by the import pipeline — the same role lib/inference.ts plays
// for TV Time CSVs.
//
// Everything here is a pure function: no I/O, no logging, never throws on garbage.

import type { NormalizedImportedRating } from '../ratings';
import type { NormalizedImportedComment } from '../comments';

/** External ids attached to Trakt media objects. `plex` and unknown keys are ignored. */
export interface TraktIds {
  trakt?: number | null;
  slug?: string | null;
  tmdb?: number | null;
  tvdb?: number | null;
  imdb?: string | null;
}

export interface TraktWatchedEpisodeCandidate {
  showTitle: string;
  year: number | null;
  season: number;
  episode: number;
  showIds: TraktIds;
  episodeIds: TraktIds;
  watchCount: number;
  watchedAt: Date | null;
}

export interface TraktWatchedMovieCandidate {
  movieTitle: string;
  year: number | null;
  movieIds: TraktIds;
  watchCount: number;
  watchedAt: Date | null;
}

export interface TraktRatingCandidate {
  rating: NormalizedImportedRating;
  showIds?: TraktIds;
  movieIds?: TraktIds;
  episodeIds?: TraktIds;
}

export interface TraktCommentCandidate {
  comment: NormalizedImportedComment;
  showIds?: TraktIds;
  movieIds?: TraktIds;
  episodeIds?: TraktIds;
}

export interface TraktWatchlistCandidate {
  type: 'show' | 'movie';
  title: string;
  year: number | null;
  ids: TraktIds;
  listedAt: Date | null;
  rank: number | null;
}

export interface TraktListItemCandidate {
  mediaType: 'show' | 'movie';
  title: string;
  year: number | null;
  ids: TraktIds;
  order: number;
  createdAt: Date | null;
}

export interface TraktListCandidate {
  sourceKey: string;
  title: string;
  description: string | null;
  visibility: 'PRIVATE' | 'PUBLIC';
  createdAt: Date | null;
  items: TraktListItemCandidate[];
  skippedItems: number;
}

/**
 * Defensively coerce a raw `ids` blob into TraktIds. Numeric ids are coerced with
 * Number() (null/garbage → null), imdb/slug are stringified, `plex` and unknown
 * keys are ignored. Non-object input → {}.
 */
export function parseTraktIds(raw: unknown): TraktIds {
  const out: TraktIds = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
  };
  if ('trakt' in o) out.trakt = num(o.trakt);
  if ('slug' in o) out.slug = str(o.slug);
  if ('tmdb' in o) out.tmdb = num(o.tmdb);
  if ('tvdb' in o) out.tvdb = num(o.tvdb);
  if ('imdb' in o) out.imdb = str(o.imdb);
  return out;
}
