import { watchNextAiredEpisodeSql } from './watch-next-eligibility';

describe('watchNextAiredEpisodeSql', () => {
  it('requires a real non-future air date', () => {
    const now = new Date('2026-08-09T18:00:00.000Z');
    const sql = watchNextAiredEpisodeSql(now);

    expect(sql.strings.join('?').replace(/\s+/g, ' ')).toBe(
      'e.air_date IS NOT NULL AND e.air_date <= ?',
    );
    expect(sql.values).toEqual([now]);
  });
});
