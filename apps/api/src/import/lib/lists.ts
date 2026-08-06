import { parseGoMaps, parseListObjects, type ParsedListObject } from './list-objects';

export type ListVisibility = 'PRIVATE' | 'PUBLIC';

export interface NormalizedListItem {
  type: string; // 'series' | 'movie'
  seriesId: number | null;
  uuid: string | null;
  order: number;
  createdAt: Date | null;
}

export interface NormalizedList {
  sourceKey: string;
  title: string;
  description: string | null;
  visibility: ListVisibility;
  createdAt: Date | null;
  items: NormalizedListItem[];
}

/** Favorites carried by the pseudo-list rows `favorite-series` / `favorite-movies`. */
export interface NormalizedFavorites {
  series: NormalizedListItem[];
  movies: NormalizedListItem[];
}

export interface ListParseError {
  row: number;
  sourceKey: string;
  reason: string;
}

const METADATA_KEYS = new Set(['collection', 'count']);

/**
 * The `favorite-series` / `favorite-movies` s_keys are NOT custom lists — they are the
 * user's favorites exported in list shape. They route to the favorites pipeline instead
 * of becoming CustomLists.
 */
const FAVORITE_S_KEYS = new Set(['favorite-series', 'favorite-movies']);

function isListRow(row: Record<string, string>): boolean {
  const type = String(row['type'] ?? '')
    .trim()
    .toLowerCase();
  const key = String(row['s_key'] ?? '').trim();
  return type === 'list' && !!key && !METADATA_KEYS.has(key);
}

function fallbackTitle(sourceKey: string, name: string | undefined): string {
  if (name && name.trim()) return name.trim();
  // humanize an arbitrary s_key
  return (
    sourceKey.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Imported list'
  );
}

function parseVisibility(v: string | undefined): ListVisibility {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (s === 'true' || s === '1' || s === 'public') return 'PUBLIC';
  return 'PRIVATE'; // <nil>, empty, false, missing, unknown → never expose as public by default
}

function parseListDate(v: string | undefined): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s === '<nil>' || s.startsWith('0001')) return null;
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

export interface NormalizeListsResult {
  lists: NormalizedList[];
  favorites: NormalizedFavorites;
  errors: ListParseError[];
}

/** Map parsed objects to normalized list items, preserving order. */
function toItems(objects: ParsedListObject[]): NormalizedListItem[] {
  return objects.map((o, i) => ({
    type: o.type || 'series',
    seriesId: o.type === 'series' ? o.id : null,
    uuid: o.uuid,
    order: i,
    createdAt: o.createdAt,
  }));
}

/**
 * Turn the lists-prod-lists.csv rows into normalized lists + favorites.
 *
 * Row anatomy (verified against real exports):
 * - `s_key=collection` (type empty): META row whose `lists` column is a Go-map dump of
 *   EVERY list the user owns, keyed by s_key — including each list's real `name`. List
 *   rows themselves often carry an empty `name`, so the collection blob is the naming
 *   source of truth.
 * - `s_key=count`: aggregate meta row, skipped.
 * - `s_key=favorite-series|favorite-movies` (type=list): the user's FAVORITES, not lists.
 *   Series entries carry a TVDB `id`; movie entries only a `uuid`.
 * - `s_key=<uuid>` (type=list): a real custom list; `name` may be empty (recover from the
 *   collection blob).
 */
export function normalizeLists(rows: Record<string, string>[]): NormalizeListsResult {
  const lists: NormalizedList[] = [];
  const favorites: NormalizedFavorites = { series: [], movies: [] };
  const errors: ListParseError[] = [];

  // Pass 1: the collection row's `lists` blob maps s_key → list metadata (real names).
  const nameByKey = new Map<string, string>();
  const collection = rows.find((r) => String(r['s_key'] ?? '').trim() === 'collection');
  if (collection) {
    for (const fields of parseGoMaps(collection['lists'])) {
      const key = fields.s_key?.trim();
      const name = fields.name && fields.name !== '<nil>' ? fields.name.trim() : '';
      if (key && name && !nameByKey.has(key)) nameByKey.set(key, name);
    }
  }

  // Pass 2: list rows → custom lists or favorites.
  rows.forEach((row, idx) => {
    if (!isListRow(row)) return; // collection/count/metadata rows are skipped
    const sourceKey = String(row['s_key']).trim();
    try {
      const objects = parseListObjects(row['objects']);
      const items = toItems(objects.objects);
      objects.errors.forEach((e) =>
        errors.push({ row: idx + 1, sourceKey, reason: `object #${e.index}: ${e.reason}` }),
      );
      if (FAVORITE_S_KEYS.has(sourceKey)) {
        // Not a list: the user's favorites in list shape → favorites pipeline.
        const target = sourceKey === 'favorite-series' ? favorites.series : favorites.movies;
        target.push(...items);
        return;
      }
      lists.push({
        sourceKey,
        title: fallbackTitle(sourceKey, row['name'] || nameByKey.get(sourceKey)),
        description:
          row['description'] && row['description'] !== '<nil>'
            ? row['description'].trim() || null
            : null,
        visibility: parseVisibility(row['is_public']),
        createdAt: parseListDate(row['created_at']),
        items,
      });
    } catch (e) {
      errors.push({ row: idx + 1, sourceKey, reason: (e as Error).message });
    }
  });
  return { lists, favorites, errors };
}

/** Build a { tvTime/Tvdb series id -> show name } map from the shows-data files. */
export function buildSeriesIdNameMap(
  files: { filename: string; rows: Record<string, string>[] }[],
): Map<number, string> {
  const map = new Map<number, string>();
  const put = (idRaw: string | undefined, name: string | undefined) => {
    if (!name) return;
    const s = String(name).trim();
    if (!s || s === '<nil>') return;
    const idStr = String(idRaw ?? '').trim();
    if (!idStr || idStr === '<nil>') return;
    const digits = idStr.replace(/[^\d-]/g, '');
    if (!digits) return; // non-numeric id (e.g. "abc") — don't coerce empty to 0
    const num = Number(digits);
    if (!Number.isFinite(num)) return;
    if (!map.has(num)) map.set(num, s);
  };
  for (const f of files) {
    const name = f.filename.toLowerCase();
    const isShowData =
      name.includes('user_tv_show_data') ||
      name.includes('followed_tv_show') ||
      name.includes('tracking-prod-records');
    if (!isShowData) continue;
    for (const r of f.rows) {
      // user_tv_show_data / followed_tv_show use tv_show_id + tv_show_name
      put(r['tv_show_id'], r['tv_show_name']);
      // tracking files use s_id/series_id + series_name
      put(r['s_id'], r['series_name']);
      put(r['series_id'], r['series_name']);
    }
  }
  return map;
}

export function isListsFile(filename: string): boolean {
  return filename.toLowerCase().includes('lists-prod-lists');
}

/**
 * Build a { movie uuid -> movie name } map from every file that carries both columns
 * (v1 `tracking-prod-records.csv`, `ratings-live-votes.csv`, `emotions-live-votes.csv`).
 * TV Time movie objects in lists/favorites carry ONLY a uuid — this is the only way to
 * recover their identity without a provider lookup. First non-empty name wins.
 */
export function buildMovieUuidNameMap(
  files: { filename: string; rows: Record<string, string>[] }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    for (const r of f.rows) {
      const entityType = String(r['entity_type'] ?? '')
        .trim()
        .toLowerCase();
      const uuid = String(
        entityType === 'movie' && r['entity_uuid'] ? r['entity_uuid'] : (r['uuid'] ?? ''),
      ).trim();
      const name = String(r['movie_name'] ?? '').trim();
      if (uuid && uuid !== '<nil>' && name && name !== '<nil>' && !map.has(uuid)) {
        map.set(uuid, name);
      }
    }
  }
  return map;
}
