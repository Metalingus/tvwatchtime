import { normalizeRatingChartSeasons, safeRatingSeasonIndex } from '../rating-chart';

describe('rating chart state', () => {
  it('filters malformed seasons and episodes before rendering', () => {
    expect(
      normalizeRatingChartSeasons([
        null,
        { seasonNumber: 2, episodes: [{ number: 1, rating: 4.2, votes: 3 }] },
        { seasonNumber: 1, episodes: [{ number: 1, rating: null, votes: 0 }] },
        { episodes: [] },
      ]),
    ).toEqual([
      {
        seasonNumber: 2,
        episodes: [{ number: 1, rating: 4.2, votes: 3 }],
      },
    ]);
  });

  it('clamps stale indexes when a ratings payload shrinks', () => {
    expect(safeRatingSeasonIndex(4, 2)).toBe(1);
    expect(safeRatingSeasonIndex(-1, 2)).toBe(0);
  });

  it('recovers from a non-finite page index instead of indexing undefined', () => {
    expect(safeRatingSeasonIndex(Number.NaN, 3)).toBe(0);
    expect(safeRatingSeasonIndex(undefined, 3)).toBe(0);
  });
});
