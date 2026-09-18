/** Metadata refreshes must not roll back watch actions, votes, counts or scroll identity. */
const METADATA_FIELDS = [
  'title',
  'name',
  'overview',
  'stillUrl',
  'posterUrl',
  'backdropUrl',
  'runtimeMinutes',
  'trailerUrl',
  'airDate',
  'airTime',
  'images',
  'showTitle',
  'showImages',
  'network',
  'providers',
  'watchProviders',
  'character',
  'characterImageUrl',
  'profileUrl',
  'imageUrl',
  'gallery',
  'galleryPending',
  'characterArtworkPending',
  'metadataPending',
  'metadataVersion',
] as const;

export function mergeRefreshedMetadata<T>(current: T | undefined, fresh: T): T | undefined {
  if (!current || !fresh) return current;
  if (Array.isArray(current) && Array.isArray(fresh)) {
    const byId = new Map(current.map((row) => [row.id, row]));
    return fresh.map((row) =>
      byId.has(row.id) ? mergeRefreshedMetadata(byId.get(row.id), row) : row,
    ) as T;
  }
  if (typeof current !== 'object' || typeof fresh !== 'object') return current;
  const previous = current as Record<string, unknown>;
  const incoming = fresh as Record<string, unknown>;
  if (previous.id && incoming.id && previous.id !== incoming.id) return current;
  const result = { ...previous };
  for (const field of METADATA_FIELDS) {
    if (incoming[field] !== undefined) result[field] = incoming[field];
  }
  if ('metadataPending' in previous) result.metadataPending = !!incoming.metadataPending;
  for (const field of ['episodes', 'seasons', 'seasonsWithSpecials', 'cast']) {
    if (Array.isArray(incoming[field])) {
      result[field] = previous[field]
        ? mergeRefreshedMetadata(previous[field], incoming[field])
        : incoming[field];
    }
  }
  return result as T;
}

export function hasPendingMetadata(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const row = data as { metadataPending?: boolean; pages?: unknown[] };
  return row.metadataPending === true || !!row.pages?.some(hasPendingMetadata);
}
