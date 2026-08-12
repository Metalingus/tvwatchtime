/**
 * IANA timezone helpers built on Intl (no library). Used to schedule per-user
 * notifications in the USER's timezone: "today" and wall-clock spread times must be
 * computed against the device's tz, not the server's.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of instant `at` in timezone `tz`. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24, // some environments render midnight as "24"
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (ms) of timezone `tz` at instant `at`: wall-clock-as-UTC minus real UTC. */
export function tzOffsetMs(tz: string, at: Date): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - at.getTime();
}

/** The UTC instant of a local wall time (y-m-d h:m) in timezone `tz`. */
export function utcFromZoned(tz: string, y: number, m: number, d: number, h = 0, min = 0): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  return new Date(guess.getTime() - tzOffsetMs(tz, guess));
}

/** The user's local day containing `at` as a UTC [start, end) range. */
export function zonedDayRange(tz: string, at: Date): { start: Date; end: Date } {
  const p = zonedParts(at, tz);
  const start = utcFromZoned(tz, p.year, p.month, p.day, 0, 0);
  // Date.UTC rolls d+1 into the next month correctly; 00:00 exists on every day.
  const end = utcFromZoned(tz, p.year, p.month, p.day + 1, 0, 0);
  return { start, end };
}

/**
 * TMDB/TVDB episode air dates are provider calendar dates, stored as UTC midnight
 * because PostgreSQL/Prisma use a DateTime column. They are not midnight broadcast
 * instants: compare their UTC Y-M-D to the user's current local Y-M-D so users west
 * of UTC are not notified one day early.
 */
export function dateOnlyMatchesLocalDay(dateOnly: Date, at: Date, tz?: string | null): boolean {
  const local = tz
    ? zonedParts(at, tz)
    : {
        year: at.getFullYear(),
        month: at.getMonth() + 1,
        day: at.getDate(),
      };
  return (
    dateOnly.getUTCFullYear() === local.year &&
    dateOnly.getUTCMonth() + 1 === local.month &&
    dateOnly.getUTCDate() === local.day
  );
}

/** True when `tz` is a valid IANA timezone name. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Late-slot catch-up policy for scheduled notifications. A slot that already passed
 * fires ~10min from now when the user's local evening hasn't started (< 21:00);
 * at/after 21:00 local it DEFERS to `nextSlot` (the caller's next-day first spread
 * slot) — notifications are NEVER skipped, they just never land as midnight
 * "airs today" pings.
 */
export function catchUpPushAt(pushAt: Date, now: Date, localHour: number, nextSlot: Date): Date {
  if (pushAt > now) return pushAt;
  if (localHour >= 21) return nextSlot;
  return new Date(now.getTime() + 10 * 60 * 1000);
}
