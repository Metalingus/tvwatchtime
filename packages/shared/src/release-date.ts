/** A provider calendar date is not a UTC-midnight broadcast instant. */
export const TIME_ZONE_HEADER = 'X-TVWatch-Timezone';

const zones = new Map<string, string>();
const formatters = new Map<string, Intl.DateTimeFormat>();

export function validTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100) return 'UTC';
  const cached = zones.get(value);
  if (cached) return cached;
  let zone = 'UTC';
  try {
    zone = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    /* An invalid client zone must not break a request. */
  }
  if (zones.size >= 128) zones.clear();
  zones.set(value, zone);
  return zone;
}

export function deviceTimeZone(): string {
  try {
    return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return 'UTC';
  }
}

/** Calendar day encoded as UTC midnight, for calendar arithmetic only. */
export function calendarDay(at: Date, timeZone: string): Date {
  const zone = validTimeZone(timeZone);
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (formatters.size >= 128) formatters.clear();
    formatters.set(zone, formatter);
  }
  const parts = formatter.formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
}

export function releaseDay(value: string | Date, precise: boolean, timeZone: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return new Date(NaN);
  return precise
    ? calendarDay(date, timeZone)
    : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Unknown times become eligible on the local release day when the time is unknown for the viewer. */
export function hasReleased(
  value: string | Date | null | undefined,
  now: Date = new Date(),
  timeZone = 'UTC',
  precise = false,
): boolean {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  return precise
    ? date.getTime() <= now.getTime()
    : releaseDay(date, false, timeZone).getTime() <= calendarDay(now, timeZone).getTime();
}
