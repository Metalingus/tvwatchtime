import {
  tvdbBroadcastInstant,
  tvdbBroadcastSchedule,
  tvdbLegacyBroadcastDate,
} from './tvdb-airtime';

describe('TVDB airtime ingestion', () => {
  const eastern = tvdbBroadcastSchedule({
    airsTime: '03:00',
    originalCountry: 'usa',
    originalNetwork: { name: 'Netflix' },
  });
  it('converts the reported Bloodbath schedule to 3 AM Toronto / 07:00 UTC', () => {
    expect(eastern).toEqual({ airTime: '03:00', timeZone: 'America/New_York' });
    expect(tvdbBroadcastInstant('2026-09-17', eastern)).toBe('2026-09-17T07:00:00.000Z');
  });
  it('uses daylight-saving rules instead of a fixed Eastern offset', () => {
    expect(tvdbBroadcastInstant('2026-01-17', eastern)).toBe('2026-01-17T08:00:00.000Z');
    expect(tvdbBroadcastInstant('2026-03-08', eastern)).toBe('2026-03-08T07:00:00.000Z');
    expect(tvdbBroadcastInstant('2026-11-01', eastern)).toBe('2026-11-01T08:00:00.000Z');
  });
  it('uses the source country timezone, never the viewer timezone', () => {
    const schedule = tvdbBroadcastSchedule({ airsTime: '0:30', originalCountry: 'jpn' });
    expect(tvdbBroadcastInstant('2026-09-17', schedule)).toBe('2026-09-16T15:30:00.000Z');
  });
  it('uses Apple TV Eastern midnight for both Slow Horses episodes despite British production', () => {
    const schedule = tvdbBroadcastSchedule({
      airsTime: '00:00',
      originalCountry: 'gbr',
      originalNetwork: { name: 'Apple TV' },
    });
    expect(tvdbBroadcastInstant('2026-09-16', schedule)).toBe('2026-09-16T04:00:00.000Z');
    expect(tvdbBroadcastInstant('2026-09-23', schedule)).toBe('2026-09-23T04:00:00.000Z');
  });
  it('follows TVDB Prime official GMT dates without applying a second day shift', () => {
    const prime = tvdbBroadcastSchedule({
      airsTime: '20:00',
      originalCountry: 'usa',
      originalNetwork: { name: 'Amazon Prime Video' },
    });
    expect(tvdbBroadcastInstant('2026-09-17', prime)).toBe('2026-09-17T00:00:00.000Z');
  });
  it('does not invent times or normalize invalid calendar dates', () => {
    expect(tvdbBroadcastSchedule({ originalCountry: 'usa' })).toBeNull();
    expect(tvdbBroadcastSchedule({ airsTime: '03:00', originalCountry: 'unknown' })).toBeNull();
    expect(tvdbBroadcastSchedule({ airsTime: '25:00', originalCountry: 'usa' })).toBeNull();
    expect(tvdbBroadcastInstant('2026-02-30', eastern)).toBeNull();
    expect(tvdbBroadcastInstant(null, eastern)).toBeNull();
  });
  it('rejects missing and ambiguous daylight-saving wall times', () => {
    expect(
      tvdbBroadcastInstant('2026-03-08', { airTime: '02:30', timeZone: 'America/New_York' }),
    ).toBeNull();
    expect(
      tvdbBroadcastInstant('2026-11-01', { airTime: '01:30', timeZone: 'America/New_York' }),
    ).toBeNull();
  });
});

describe('streaming schedule corrections', () => {
  const apple = tvdbBroadcastSchedule({
    airsTime: '00:00',
    originalCountry: 'gbr',
    originalNetwork: { name: 'Apple TV', country: 'usa' },
  });
  it('recognizes only the exact old production-country conversion', () => {
    expect(tvdbLegacyBroadcastDate(new Date('2026-09-15T23:00:00Z'), '00:00', apple)).toBe(
      '2026-09-16',
    );
    expect(tvdbLegacyBroadcastDate(new Date('2026-09-16T04:00:00Z'), '00:00', apple)).toBeNull();
    expect(tvdbLegacyBroadcastDate(new Date('2026-09-16T01:00:00Z'), '00:00', apple)).toBeNull();
    expect(tvdbLegacyBroadcastDate(new Date('2026-09-15T23:00:00Z'), '21:00', apple)).toBeNull();
  });
  it('keeps Eastern midnight at 05:00 UTC in winter', () => {
    expect(tvdbBroadcastInstant('2026-12-16', apple)).toBe('2026-12-16T05:00:00.000Z');
  });
  it('uses the streaming convention for Netflix originals made outside the US too', () => {
    const netflix = tvdbBroadcastSchedule({
      airsTime: '03:00',
      originalCountry: 'kor',
      originalNetwork: { name: 'Netflix' },
    });
    expect(tvdbBroadcastInstant('2026-09-16', netflix)).toBe('2026-09-16T07:00:00.000Z');
  });
  it('retains the local source zone for a British television broadcaster', () => {
    const bbc = tvdbBroadcastSchedule({
      airsTime: '21:00',
      originalCountry: 'gbr',
      originalNetwork: { name: 'BBC One' },
    });
    expect(bbc).toEqual({ airTime: '21:00', timeZone: 'Europe/London' });
    expect(tvdbBroadcastInstant('2026-09-16', bbc)).toBe('2026-09-16T20:00:00.000Z');
  });
});
