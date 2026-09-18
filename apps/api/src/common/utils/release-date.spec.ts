import { calendarDay, hasReleased, releaseDay, validTimeZone } from '@tvwatch/shared';
import { runInTimeZone, releaseCacheScope } from '../timezone.context';
import {
  episodeAiredSql,
  episodeAiredWhere,
  isEpisodeBulkWatchEligible,
} from './episode-progress.util';
import { zonedDayRange } from './timezone.util';

describe('release dates', () => {
  it('does not expose tomorrow at UTC midnight to a US viewer', () => {
    const now = new Date('2026-09-17T00:30:00Z');
    expect(hasReleased('2026-09-17', now, 'America/Los_Angeles')).toBe(false);
    expect(hasReleased('2026-09-17', new Date('2026-09-17T07:00:00Z'), 'America/Los_Angeles')).toBe(
      true,
    );
  });
  it('uses the exact broadcast instant across viewer timezones', () => {
    const air = '2026-09-18T02:00:00Z';
    for (const zone of ['America/Los_Angeles', 'Europe/Paris', 'Pacific/Auckland']) {
      expect(hasReleased(air, new Date('2026-09-18T01:59:59Z'), zone, true)).toBe(false);
      expect(hasReleased(air, new Date(air), zone, true)).toBe(true);
    }
    expect(releaseDay(air, true, 'America/Los_Angeles').toISOString()).toContain('2026-09-17');
    expect(releaseDay('2026-09-18', false, 'America/Los_Angeles').toISOString()).toContain(
      '2026-09-18',
    );
  });
  it('handles eastern zones, year boundaries and invalid/unknown dates', () => {
    expect(hasReleased('2027-01-01', new Date('2026-12-31T12:00:00Z'), 'Pacific/Kiritimati')).toBe(
      true,
    );
    expect(hasReleased(null)).toBe(false);
    expect(hasReleased('bad')).toBe(false);
    expect(validTimeZone(['UTC'])).toBe('UTC');
    expect(validTimeZone('not/a-zone')).toBe('UTC');
  });
  it('uses the same timezone boundaries in SQL, Prisma and JS', () =>
    runInTimeZone('America/Los_Angeles', () => {
      const now = new Date('2026-09-17T00:30:00Z');
      expect(isEpisodeBulkWatchEligible(new Date('2026-09-17'), now)).toBe(false);
      const sql = episodeAiredSql(now);
      expect(sql.values).toEqual([new Date('2026-09-17'), now]);
      expect(JSON.stringify(episodeAiredWhere(now))).toContain('2026-09-17T00:00:00.000Z');
      expect(sql.strings.join('?')).toContain('e.air_time');
    }));
  it('isolates concurrent request timezones and date-scoped caches', async () => {
    const now = new Date('2026-09-17T00:30:00Z');
    const zones = ['America/Los_Angeles', 'Pacific/Auckland'];
    const scopes = await Promise.all(
      zones.map((zone) =>
        runInTimeZone(zone, async () => {
          await Promise.resolve();
          return releaseCacheScope(now);
        }),
      ),
    );
    expect(scopes[0]).toContain('2026-09-16');
    expect(scopes[1]).toContain('2026-09-17');
    expect(calendarDay(now, zones[0]).toISOString()).toContain('2026-09-16');
  });
  it.each([
    ['2026-03-08T12:00:00Z', 23],
    ['2026-11-01T12:00:00Z', 25],
  ])('uses DST-safe local day bounds at %s', (date, hours) => {
    const { start, end } = zonedDayRange('America/New_York', new Date(date));
    expect((end.getTime() - start.getTime()) / 3600000).toBe(hours);
  });
});
