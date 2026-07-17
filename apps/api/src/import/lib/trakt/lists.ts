// Trakt watchlist + favorites + custom list normalization.
//
// `lists-watchlist.json` / `lists-favorites.json` rows: { type: "movie"|"show"|…,
// movie?|show?, rank, id, listed_at, notes, my_rating }. Only movie/show rows become candidates.
//
// `lists-lists.json` rows (Trakt docs shape): { name, description, privacy,
// created_at, updated_at, item_count, ids: { trakt, slug }, items?: [...] }.
// Items are read defensively from the embedded `items` array when present; the
// file may legitimately be an empty array (no custom lists).

import { parseDate } from '../inference';
import {
  parseTraktIds,
  type TraktListCandidate,
  type TraktListItemCandidate,
  type TraktWatchlistCandidate,
} from './types';

export interface TraktWatchlistResult {
  candidates: TraktWatchlistCandidate[];
  skipped: number;
}

export interface TraktListsResult {
  lists: TraktListCandidate[];
  skippedLists: number;
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

/** Shared row parser for lists-watchlist.json and lists-favorites.json (identical shapes). */
function normalizeMediaListRows(data: unknown): TraktWatchlistResult {
  const candidates: TraktWatchlistCandidate[] = [];
  let skipped = 0;
  if (!Array.isArray(data)) return { candidates, skipped };
  for (const row of data) {
    const r = asObj(row);
    const type = r?.type;
    if (!r || (type !== 'movie' && type !== 'show')) {
      skipped++; // season/episode/person/anything else
      continue;
    }
    const media = asObj(type === 'movie' ? r.movie : r.show);
    const title = strOrNull(media?.title);
    if (!title) {
      skipped++;
      continue;
    }
    candidates.push({
      type,
      title,
      year: numOrNull(media?.year),
      ids: parseTraktIds(media?.ids),
      listedAt: dateOrNull(r.listed_at),
      rank: numOrNull(r.rank),
    });
  }
  return { candidates, skipped };
}

/** Normalize the Trakt watchlist (lists-watchlist.json). Only movie/show rows are kept. */
export function normalizeTraktWatchlist(data: unknown): TraktWatchlistResult {
  return normalizeMediaListRows(data);
}

/** Normalize the Trakt favorites (lists-favorites.json). Only movie/show rows are kept. */
export function normalizeTraktFavorites(data: unknown): TraktWatchlistResult {
  return normalizeMediaListRows(data);
}

/** Normalize custom lists (lists-lists.json). Missing/empty items arrays are tolerated. */
export function normalizeTraktLists(data: unknown): TraktListsResult {
  const lists: TraktListCandidate[] = [];
  let skippedLists = 0;
  if (!Array.isArray(data)) return { lists, skippedLists };

  data.forEach((raw, index) => {
    const l = asObj(raw);
    const title = strOrNull(l?.name);
    if (!l || !title) {
      skippedLists++;
      return;
    }
    const ids = parseTraktIds(l.ids);
    const items: TraktListItemCandidate[] = [];
    let skippedItems = 0;
    if (Array.isArray(l.items)) {
      l.items.forEach((rawItem, itemIdx) => {
        const it = asObj(rawItem);
        const type = it?.type;
        const media =
          type === 'movie' ? asObj(it?.movie) : type === 'show' ? asObj(it?.show) : null;
        const itemTitle = strOrNull(media?.title);
        if (!media || !itemTitle || (type !== 'movie' && type !== 'show')) {
          skippedItems++; // season/episode/person/malformed items
          return;
        }
        items.push({
          mediaType: type,
          title: itemTitle,
          year: numOrNull(media.year),
          ids: parseTraktIds(media.ids),
          order: itemIdx + 1,
          createdAt: dateOrNull(it?.listed_at),
        });
      });
    }
    lists.push({
      sourceKey: `trakt:list:${ids.trakt ?? ids.slug ?? index}`,
      title,
      description: strOrNull(l.description),
      visibility: l.privacy === 'public' ? 'PUBLIC' : 'PRIVATE',
      createdAt: dateOrNull(l.created_at),
      items,
      skippedItems,
    });
  });

  return { lists, skippedLists };
}
