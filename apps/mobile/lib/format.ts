/** "2h12" / "45m" / "2h" — compact runtime display for media detail screens. */
export function formatRuntime(minutes?: number | null): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}`;
}

/** Localized "Month D, YYYY" for air dates. Date-only ISO strings are parsed as a LOCAL
 *  date (not UTC midnight), so the displayed day never shifts with the timezone. */
export function formatAirDate(iso: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  return d.toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' });
}

/** Localized "H:MM" for a raw 24h air time, matching the watched-time format. */
export function formatAirTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  return new Date(2000, 0, 1, Number(m[1]), Number(m[2])).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}
