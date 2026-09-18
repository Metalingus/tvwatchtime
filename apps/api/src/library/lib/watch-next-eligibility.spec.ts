import { watchNextAiredEpisodeSql } from './watch-next-eligibility';

describe('watchNextAiredEpisodeSql', () => {
  it('requires a real non-future air date', () => {
    const now = new Date('2026-08-09T18:00:00.000Z');
    const sql = watchNextAiredEpisodeSql(now);

    expect(sql.strings.join('?')).toContain('e.air_date IS NOT NULL');
    expect(sql.strings.join('?')).toContain('e.air_time');
    expect(sql.values).toEqual([new Date('2026-08-10T00:00:00Z'), now]);
  });
});
