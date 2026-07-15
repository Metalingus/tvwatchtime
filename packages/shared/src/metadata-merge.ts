import { ExternalProvider } from './enums';

export interface FieldSource<T> {
  provider: ExternalProvider;
  value: T | null | undefined;
}

export interface MergeResult<T> {
  value: T | null;
  changed: boolean;
  source: ExternalProvider | null;
}

/** A field-specific priority list, highest-precedence provider first. */
export type Priority = ExternalProvider[];

export const PRIORITY = {
  /** Confirmed or probable anime adaptation metadata. */
  anime: <Priority>[ExternalProvider.KITSU, ExternalProvider.MYANIME_LIST, ExternalProvider.THE_TVDB, ExternalProvider.TMDB],
  /** General shows/movies where TMDB exists. */
  general: <Priority>[ExternalProvider.TMDB, ExternalProvider.THE_TVDB],
  /** TVDB-only media (no TMDB) — TVDB is canonical general source. */
  tvdbOnly: <Priority>[ExternalProvider.THE_TVDB, ExternalProvider.TMDB],
  /** Actual manga publication metadata only (title/synopsis/chapters/volumes/serialization…). */
  mangaPublication: <Priority>[ExternalProvider.KITSU, ExternalProvider.MYANIME_LIST],
} as const;

export type ClassificationKind = 'general' | 'anime' | 'manga' | 'tvdbOnly';

/** Priority for canonical metadata fields, by content classification + whether TMDB exists. */
export function priorityFor(opts: { classification: ClassificationKind; hasTmdb?: boolean }): Priority {
  switch (opts.classification) {
    case 'anime':
      return PRIORITY.anime;
    case 'manga':
      return PRIORITY.mangaPublication;
    case 'tvdbOnly':
      return PRIORITY.tvdbOnly;
    case 'general':
    default:
      // General media: TMDB is canonical when present; otherwise TVDB is the general source.
      return opts.hasTmdb ? PRIORITY.general : PRIORITY.tvdbOnly;
  }
}

function isEmpty<T>(v: T | null | undefined): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/**
 * Field-level merge. Walks the priority list highest-first; the first provider that
 * supplies a non-empty value wins. Rules:
 *   - higher-priority non-empty replaces lower (when current is not manual);
 *   - null/empty never erases an existing useful value;
 *   - a manual/locally-curated current value is never overwritten (opts.isManual).
 *
 * This is applied PER FIELD — never as a whole-record replacement. Locale isolation is
 * the caller's responsibility (merge each locale independently).
 */
export function mergeField<T>(
  current: T | null | undefined,
  sources: FieldSource<T>[],
  priority: Priority,
  opts: { isManual?: boolean } = {},
): MergeResult<T> {
  if (opts.isManual && !isEmpty(current)) {
    return { value: current as T, changed: false, source: null };
  }

  const byProvider = new Map<ExternalProvider, T>();
  for (const s of sources) {
    if (!isEmpty(s.value) && !byProvider.has(s.provider)) byProvider.set(s.provider, s.value as T);
  }

  for (const p of priority) {
    const v = byProvider.get(p);
    if (!isEmpty(v)) {
      const changed = v !== (current ?? null);
      return { value: v as T, changed, source: p };
    }
  }

  // No provider supplied a value: keep whatever we already had.
  return { value: (current ?? null) as T, changed: false, source: null };
}

/**
 * Convenience: merge many fields sharing one priority. Returns merged values + per-field
 * provenance map (field → { provider, at }).
 */
export function mergeFields<T extends Record<string, unknown>>(
  current: T,
  providers: Partial<Record<ExternalProvider, Partial<T>>>,
  fields: (keyof T)[],
  priority: Priority,
  manualFields: Set<keyof T> = new Set(),
): { merged: T; provenance: Record<string, { provider: ExternalProvider } | null> } {
  const merged = { ...(current as object) } as T;
  const provenance: Record<string, { provider: ExternalProvider } | null> = {};
  for (const f of fields) {
    const sources: FieldSource<T[keyof T]>[] = (Object.keys(providers) as ExternalProvider[]).map((p) => ({
      provider: p,
      value: providers[p]?.[f] as T[keyof T] | undefined,
    }));
    const res = mergeField<T[keyof T]>(
      current[f],
      sources,
      priority,
      { isManual: manualFields.has(f) },
    );
    if (res.value !== null && res.value !== undefined) (merged as Record<string, unknown>)[f as string] = res.value;
    provenance[f as string] = res.source ? { provider: res.source } : null;
  }
  return { merged, provenance };
}
