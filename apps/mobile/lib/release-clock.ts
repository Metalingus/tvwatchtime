/** Find an upcoming real broadcast/cache boundary in a JSON API payload. */
export function nextReleaseBoundary(data: unknown, now: number): number | null {
  let next = Infinity;
  const seen = new Set<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const row = value as Record<string, unknown>;
    for (const stamp of [row.refreshAt, row.airTime ? row.airDate : null]) {
      if (typeof stamp !== 'string') continue;
      const time = Date.parse(stamp);
      if (Number.isFinite(time) && time > now) next = Math.min(next, time);
    }
    for (const child of Object.values(row)) visit(child);
  };
  visit(data);
  return Number.isFinite(next) ? next : null;
}
