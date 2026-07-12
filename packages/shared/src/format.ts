// Locale-aware formatting helpers wrapping the platform `Intl` API. No manual string
// construction for dates/numbers/plurals. `locale` is a SupportedLocale (e.g. 'pt-BR').

import type { SupportedLocale } from './theme-locale';

const ISO = (l: SupportedLocale) => l.replace('-', '-'); // already BCP-47

export function formatDate(date: Date | string | null, locale: SupportedLocale): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(ISO(locale), { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

export function formatDateTime(date: Date | string | null, locale: SupportedLocale): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(ISO(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatRelativeTime(date: Date | string | null, locale: SupportedLocale): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(ISO(locale), { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return rtf.format(0, 'second');
}

export function formatNumber(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(ISO(locale)).format(value);
}

export function formatCompact(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(ISO(locale), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatPercent(fraction: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(ISO(locale), { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}

/** Minutes → "2h 30m" style watch-time; localized digits via Intl. */
export function formatWatchTime(totalMinutes: number, locale: SupportedLocale): string {
  if (!totalMinutes || totalMinutes < 1) return formatNumber(0, locale) + 'm';
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  const parts: string[] = [];
  if (h) parts.push(`${formatNumber(h, locale)}h`);
  if (m || !h) parts.push(`${formatNumber(m, locale)}m`);
  return parts.join(' ');
}
