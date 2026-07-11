import { parseListObjects, type ParsedListObject } from './list-objects';

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

export interface ListParseError {
  row: number;
  sourceKey: string;
  reason: string;
}

const METADATA_KEYS = new Set(['collection', 'count']);

function isListRow(row: Record<string, string>): boolean {
  const type = String(row['type'] ?? '').trim().toLowerCase();
  const key = String(row['s_key'] ?? '').trim();
  return type === 'list' && !!key && !METADATA_KEYS.has(key);
}

function fallbackTitle(sourceKey: string, name: string | undefined): string {
  if (name && name.trim()) return name.trim();
  if (sourceKey === 'favorite-movies') return 'Favorite Movies';
  if (sourceKey === 'favorite-series') return 'Favorite Shows';
  // humanize an arbitrary s_key
  return sourceKey.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Imported list';
}

function parseVisibility(v: string | undefined): ListVisibility {
  const s = String(v ?? '').trim().toLowerCase();
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
  errors: ListParseError[];
}

/** Turn the lists-prod-lists.csv rows into normalized lists + per-object items. */
export function normalizeLists(rows: Record<string, string>[]): NormalizeListsResult {
  const lists: NormalizedList[] = [];
  const errors: ListParseError[] = [];
  rows.forEach((row, idx) => {
    if (!isListRow(row)) return; // collection/count/metadata rows are skipped
    const sourceKey = String(row['s_key']).trim();
    try {
      const objects = parseListObjects(row['objects']);
      const items: NormalizedListItem[] = objects.objects
        .map((o: ParsedListObject, i: number) => ({
          type: o.type || 'series',
          seriesId: o.type === 'series' ? o.id : null,
          uuid: o.uuid,
          order: i,
          createdAt: o.createdAt,
        }));
      objects.errors.forEach((e) => errors.push({ row: idx + 1, sourceKey, reason: `object #${e.index}: ${e.reason}` }));
      lists.push({
        sourceKey,
        title: fallbackTitle(sourceKey, row['name']),
        description: row['description'] && row['description'] !== '<nil>' ? row['description'].trim() || null : null,
        visibility: parseVisibility(row['is_public']),
        createdAt: parseListDate(row['created_at']),
        items,
      });
    } catch (e) {
      errors.push({ row: idx + 1, sourceKey, reason: (e as Error).message });
    }
  });
  return { lists, errors };
}

/** Build a { tvTime/Tvdb series id -> show name } map from the shows-data files. */
export function buildSeriesIdNameMap(files: { filename: string; rows: Record<string, string>[] }[]): Map<number, string> {
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
    const isShowData = name.includes('user_tv_show_data') || name.includes('followed_tv_show') || name.includes('tracking-prod-records');
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
