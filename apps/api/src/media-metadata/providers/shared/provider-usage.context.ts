import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-operation provider accounting (e.g. one import). ProviderHttp records every actual HTTP
 * attempt and every cache hit into the active context, so an import can report exactly how
 * many TMDB/TVDB/WatchForge calls it cost. Outside a context, recording is a no-op.
 */
export type ProviderUsage = Record<string, { requests: number; cacheHits: number }>;

const storage = new AsyncLocalStorage<ProviderUsage>();

export function runWithProviderUsage<T>(usage: ProviderUsage, fn: () => Promise<T>): Promise<T> {
  return storage.run(usage, fn);
}

export function recordProviderUsage(provider: string, field: 'requests' | 'cacheHits'): void {
  const usage = storage.getStore();
  if (!usage) return;
  (usage[provider] ??= { requests: 0, cacheHits: 0 })[field]++;
}
