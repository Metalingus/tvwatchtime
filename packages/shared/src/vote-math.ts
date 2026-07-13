/**
 * Largest-remainder percentage rounding for vote distributions.
 *
 * Independently rounding each option's percentage can leave the displayed set
 * summing to 99% or 101%. This distributes the leftover whole points to the
 * options with the largest fractional remainder so the result always sums to
 * exactly 100% when there is at least one vote. Deterministic: ties are broken
 * by the original option order.
 */

export interface VoteOptionCount {
  /** Stable value/identifier for this option (device, rating as string, reaction type, castId). */
  value: string;
  count: number;
}

export interface VoteOptionPercent extends VoteOptionCount {
  /** Whole-number percentage 0..100. */
  percent: number;
}

/**
 * Compute whole-number percentages from counts. Returns an entry per input
 * option, preserving order. When `total <= 0`, every option gets 0.
 */
export function computePercentages<T extends VoteOptionCount>(
  options: T[],
  total: number,
): (T & VoteOptionPercent)[] {
  if (total <= 0) {
    return options.map((o) => ({ ...o, percent: 0 }));
  }

  const raw = options.map((o) => ({
    base: o,
    exact: (o.count * 100) / total,
    floor: Math.floor((o.count * 100) / total),
    remainder: (o.count * 100) / total - Math.floor((o.count * 100) / total),
  }));

  const sumFloors = raw.reduce((acc, r) => acc + r.floor, 0);
  let leftover = 100 - sumFloors;

  // Hand out leftover points to the largest remainders (stable by index).
  const order = raw
    .map((r, index) => ({ index, remainder: r.remainder }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const extra = new Map<number, number>();
  for (const { index } of order) {
    if (leftover <= 0) break;
    extra.set(index, (extra.get(index) ?? 0) + 1);
    leftover -= 1;
  }

  return raw.map((r, index) => ({
    ...r.base,
    percent: r.floor + (extra.get(index) ?? 0),
  }));
}

/**
 * Apply a single-user vote change to a count distribution immutably, returning
 * the new counts + total. Used for optimistic UI before the server reconciles.
 *
 * - `from == null`        -> first vote: total + 1, `to` option count + 1
 * - `from != null && from !== to` -> change: old option - 1, new option + 1, total unchanged
 * - `from === to`         -> no-op (returns a structural clone, same numbers)
 */
export function applyVoteChange<T extends VoteOptionCount>(
  options: T[],
  total: number,
  from: string | null,
  to: string | null,
): { options: T[]; total: number } {
  if (to == null) {
    // Clearing a vote (e.g. reaction unset): decrement the old option + total.
    if (from == null) return { options, total };
    let removed = false;
    const next = options.map((o) => {
      if (!removed && o.value === from) {
        removed = true;
        return { ...o, count: Math.max(0, o.count - 1) };
      }
      return o;
    });
    return { options: next, total: Math.max(0, total - 1) };
  }

  if (from === to) {
    return { options: options.map((o) => ({ ...o })), total };
  }

  let touchedTo = false;
  let touchedFrom = false;
  const next = options.map((o) => {
    let count = o.count;
    if (from != null && !touchedFrom && o.value === from) {
      touchedFrom = true;
      count = Math.max(0, count - 1);
    }
    if (!touchedTo && o.value === to) {
      touchedTo = true;
      count = count + 1;
    }
    return { ...o, count };
  });

  // If the target option did not exist in the distribution yet (e.g. a brand-new
  // cast member receiving their first vote), append it.
  const finalOptions = touchedTo ? next : [...next, { value: to, count: 1 } as T];

  const totalDelta = from == null ? 1 : 0;
  return { options: finalOptions, total: total + totalDelta };
}
