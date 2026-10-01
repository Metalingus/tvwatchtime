/**
 * Insertion-ordered LRU with a per-entry TTL. A drop-in for the Map subset used by the
 * singleton ImportMatcher (get/set/has/delete), so process-lifetime caches stay bounded and
 * refusals cannot be pinned forever.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    /** Lifetime in ms, fixed or chosen per value (e.g. shorter for unresolved results). */
    private readonly ttlMs: number | ((value: V) => number) = Number.POSITIVE_INFINITY,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): this {
    const ttl = typeof this.ttlMs === 'function' ? this.ttlMs(value) : this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Live [key, value] pairs, snapshotted so callers may delete while iterating. */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    const now = this.now();
    for (const [key, entry] of [...this.entries]) {
      if (entry.expiresAt > now) yield [key, entry.value];
    }
  }
}
