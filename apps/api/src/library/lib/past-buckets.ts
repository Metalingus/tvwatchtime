// Past-time bucketing for the upcoming screen's scroll-up history.
//
// Granular, calendar-based buckets (UTC-encoded calendar-day boundaries, Monday-start
// weeks — same convention as the future-side buckets in LibraryService):
//   Yesterday → Earlier this week → Last week → Last month →
//   N months ago (2..11) → N years ago → N years and M months ago.
// Labels are English fallbacks; clients localize via key + params.
//
// Pure functions: no I/O, no logging.

import { UpcomingPastBucket } from '@tvwatch/shared';

export interface PastBucket {
  key: UpcomingPastBucket;
  /** count = months for MONTHS_AGO/YEARS_MONTHS_AGO, years for YEARS_AGO. */
  params?: { count?: number; years?: number; months?: number };
  label: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const atMidnight = (d: Date): Date => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

/** Monday 00:00 of the week containing d (ISO week start). */
const mondayOf = (d: Date): Date => {
  const x = atMidnight(d);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
};

/**
 * Bucket an aired (past) air date. Returns null for today/future dates — those
 * belong to the future-side UpcomingBucket buckets.
 */
export function pastBucket(date: Date, now: Date = new Date()): PastBucket | null {
  const d = atMidnight(date);
  const today = atMidnight(now);
  const diffDays = Math.round((d.getTime() - today.getTime()) / DAY_MS);
  if (diffDays >= 0) return null;
  if (diffDays === -1) return { key: UpcomingPastBucket.YESTERDAY, label: 'Yesterday' };

  if (d.getTime() >= mondayOf(today).getTime()) {
    return { key: UpcomingPastBucket.EARLIER_THIS_WEEK, label: 'Earlier this week' };
  }
  const lastMonday = mondayOf(today);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  if (d.getTime() >= lastMonday.getTime()) {
    return { key: UpcomingPastBucket.LAST_WEEK, label: 'Last week' };
  }

  const monthsAgo =
    today.getUTCFullYear() * 12 + today.getUTCMonth() - (d.getUTCFullYear() * 12 + d.getUTCMonth());
  if (monthsAgo <= 1) return { key: UpcomingPastBucket.LAST_MONTH, label: 'Last month' };
  if (monthsAgo < 12) {
    return {
      key: UpcomingPastBucket.MONTHS_AGO,
      params: { count: monthsAgo },
      label: `${monthsAgo} months ago`,
    };
  }
  const years = Math.floor(monthsAgo / 12);
  const months = monthsAgo % 12;
  if (months === 0) {
    return {
      key: UpcomingPastBucket.YEARS_AGO,
      params: { count: years, years },
      label: years === 1 ? '1 year ago' : `${years} years ago`,
    };
  }
  return {
    key: UpcomingPastBucket.YEARS_MONTHS_AGO,
    params: { years, months, count: months },
    label: `${years} year${years > 1 ? 's' : ''} and ${months} month${months > 1 ? 's' : ''} ago`,
  };
}
