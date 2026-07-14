// Pure selection logic for the daily watchlist reminder, extracted so it can be
// unit tested without a database. Picks one show per user, rotating so the same
// show isn't repeated until its cooldown elapses.

export interface ReminderCandidate {
  mediaId: string;
  lastWatchedAt: Date | null;
}

/**
 * @param candidates     stale shows with unaired-watched episodes (per user)
 * @param lastReminded   mediaId → most recent WATCHLIST_REMINDER timestamp
 * @param cooldownMs     how long before a show can be reminded again
 * @param now            reference time
 * @returns the chosen candidate, or null if there are none
 *
 * Preference order:
 *  1. Shows NOT reminded within the cooldown window (eligible). When some are
 *     eligible we only pick from those, so a different show surfaces each day.
 *  2. When every show is still on cooldown, fall back to ALL candidates so a
 *     daily reminder still goes out — picking the least-recently-reminded one
 *     (round-robins through the pool instead of repeating the same show).
 *  3. Tie-break by oldest lastWatchedAt (most overdue).
 */
export function pickReminderShow(
  candidates: ReminderCandidate[],
  lastReminded: Map<string, Date>,
  cooldownMs: number,
  now: Date,
): ReminderCandidate | null {
  if (candidates.length === 0) return null;
  const cutoff = now.getTime() - cooldownMs;

  const score = (c: ReminderCandidate): [number, number] => {
    const lr = lastReminded.get(c.mediaId);
    // Never reminded → 0 (highest priority); otherwise the reminder timestamp.
    const remindedAt = lr ? lr.getTime() : 0;
    const watchedAt = c.lastWatchedAt ? c.lastWatchedAt.getTime() : 0;
    return [remindedAt, watchedAt];
  };

  const eligible = candidates.filter((c) => {
    const lr = lastReminded.get(c.mediaId);
    return !lr || lr.getTime() < cutoff;
  });
  const pool = eligible.length > 0 ? eligible : candidates;

  return pool.slice().sort((a, b) => {
    const [ra, wa] = score(a);
    const [rb, wb] = score(b);
    if (ra !== rb) return ra - rb; // older/never-reminded first
    return wa - wb; // oldest-watched first
  })[0];
}
