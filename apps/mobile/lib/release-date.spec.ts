import { formatAirDate, formatBroadcastTime } from './format';
import { isEpisodeBulkWatchEligible } from './episode-progress';

describe('release date display', () => {
  it('preserves the provider calendar day for date-only values', () => {
    expect(formatAirDate('2026-09-17T00:00:00Z', 'en-US')).toBe('September 17, 2026');
  });
  it('formats precise dates and times in the device timezone', () => {
    const iso = '2026-09-18T02:00:00Z';
    expect(formatAirDate(iso, 'en-US', true)).toBe(
      new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    );
    expect(formatBroadcastTime(iso)).toBe(
      new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    );
    expect(isEpisodeBulkWatchEligible(iso, Date.parse('2026-09-18T01:59:59Z'), '22:00')).toBe(
      false,
    );
    expect(isEpisodeBulkWatchEligible(iso, Date.parse(iso), '22:00')).toBe(true);
  });
});
