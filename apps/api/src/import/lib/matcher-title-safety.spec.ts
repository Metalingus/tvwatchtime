import { pickBestTitleMatch } from './matcher';

describe('provider title/year safety', () => {
  const candidates = [
    { title: 'Dune', year: 1984, popularity: 90 },
    { title: 'Dune', year: 2021, popularity: 80 },
  ];

  it('selects only a candidate compatible with an explicit source year', () => {
    expect(pickBestTitleMatch(candidates, 1984)?.year).toBe(1984);
    expect(pickBestTitleMatch(candidates, 2021)?.year).toBe(2021);
  });

  it('rejects every exact-title remake when none fits the explicit year', () => {
    expect(pickBestTitleMatch(candidates, 2000)).toBeUndefined();
  });
});
