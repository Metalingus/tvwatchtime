import { UpcomingPastBucket } from '@tvwatch/shared';
import { pastBucket } from './past-buckets';

// Fixed reference: Wednesday 2026-07-22 (ISO week started Monday 2026-07-20).
const NOW = new Date('2026-07-22T14:30:00');
const d = (iso: string) => new Date(`${iso}T09:00:00`);

describe('pastBucket', () => {
  it('returns null for today and future dates', () => {
    expect(pastBucket(d('2026-07-22'), NOW)).toBeNull();
    expect(pastBucket(d('2026-07-23'), NOW)).toBeNull();
  });

  it('buckets yesterday', () => {
    expect(pastBucket(d('2026-07-21'), NOW)).toEqual({
      key: UpcomingPastBucket.YESTERDAY,
      label: 'Yesterday',
    });
  });

  it('buckets earlier this week (same ISO week, before yesterday)', () => {
    expect(pastBucket(d('2026-07-20'), NOW)!.key).toBe(UpcomingPastBucket.EARLIER_THIS_WEEK);
  });

  it('buckets last week (previous ISO week)', () => {
    for (const day of ['2026-07-19', '2026-07-16', '2026-07-13']) {
      expect(pastBucket(d(day), NOW)!.key).toBe(UpcomingPastBucket.LAST_WEEK);
    }
  });

  it('buckets last month', () => {
    expect(pastBucket(d('2026-06-30'), NOW)!.key).toBe(UpcomingPastBucket.LAST_MONTH);
    expect(pastBucket(d('2026-06-01'), NOW)!.key).toBe(UpcomingPastBucket.LAST_MONTH);
  });

  it('buckets N months ago for 2..11 months', () => {
    expect(pastBucket(d('2026-05-15'), NOW)).toMatchObject({
      key: UpcomingPastBucket.MONTHS_AGO,
      params: { count: 2 },
      label: '2 months ago',
    });
    expect(pastBucket(d('2025-08-15'), NOW)).toMatchObject({
      key: UpcomingPastBucket.MONTHS_AGO,
      params: { count: 11 },
      label: '11 months ago',
    });
  });

  it('buckets whole years', () => {
    expect(pastBucket(d('2025-07-15'), NOW)).toMatchObject({
      key: UpcomingPastBucket.YEARS_AGO,
      params: { count: 1, years: 1 },
      label: '1 year ago',
    });
    expect(pastBucket(d('2024-07-15'), NOW)).toMatchObject({
      key: UpcomingPastBucket.YEARS_AGO,
      params: { count: 2, years: 2 },
      label: '2 years ago',
    });
  });

  it('buckets years and months', () => {
    expect(pastBucket(d('2025-06-15'), NOW)).toMatchObject({
      key: UpcomingPastBucket.YEARS_MONTHS_AGO,
      params: { years: 1, months: 1, count: 1 },
      label: '1 year and 1 month ago',
    });
    expect(pastBucket(d('2024-05-15'), NOW)).toMatchObject({
      key: UpcomingPastBucket.YEARS_MONTHS_AGO,
      params: { years: 2, months: 2, count: 2 },
      label: '2 years and 2 months ago',
    });
  });

  it('is insensitive to time-of-day on both inputs', () => {
    const lateNow = new Date('2026-07-22T23:59:59Z');
    expect(pastBucket(new Date('2026-07-21T00:00:01Z'), lateNow)!.key).toBe(
      UpcomingPastBucket.YESTERDAY,
    );
  });
});
