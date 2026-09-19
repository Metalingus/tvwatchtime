import { upcomingMovieWindow, upcomingMovieDateFilter } from './upcoming-movie-window';

it.each([
  ['2026-09-18T14:00:00Z', '2026-09-15', '2026-11-18'],
  ['2026-12-31T23:59:59Z', '2026-12-28', '2027-02-28'],
  ['2027-12-31T12:00:00Z', '2027-12-28', '2028-02-29'],
  ['2026-07-31T12:00:00Z', '2026-07-28', '2026-09-30'],
  ['2026-01-01T00:00:00Z', '2025-12-29', '2026-03-01'],
])('uses a clamped two-calendar-month window for %s', (now, start, end) => {
  expect(upcomingMovieWindow(new Date(now))).toEqual({ start, end });
});

it('includes all of the final calendar day in DB snapshot and fallback filters', () => {
  expect(upcomingMovieDateFilter({ start: '2026-09-15', end: '2026-11-18' })).toEqual({
    gte: new Date('2026-09-15T00:00:00Z'),
    lt: new Date('2026-11-19T00:00:00Z'),
  });
});
