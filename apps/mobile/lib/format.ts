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
export function formatAirDate(iso: string, locale?: string, precise = false): string {
  return formatReleaseDate(
    iso,
    { month: 'long', day: 'numeric', year: 'numeric' },
    locale,
    precise,
  );
}

/** Date-only fields preserve their calendar day; broadcast instants use the device timezone. */
export function formatReleaseDate(
  iso: string,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
  precise = false,
): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleDateString(locale, { ...options, ...(!precise ? { timeZone: 'UTC' } : {}) });
}

export function formatBroadcastTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
