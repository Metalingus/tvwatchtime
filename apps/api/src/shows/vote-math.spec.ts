import { computePercentages, applyVoteChange } from '@tvwatch/shared';

describe('vote-math', () => {
  describe('computePercentages', () => {
    it('returns all zeros when total is zero', () => {
      const out = computePercentages(
        [
          { value: 'A', count: 0 },
          { value: 'B', count: 0 },
        ],
        0,
      );
      expect(out.map((o) => o.percent)).toEqual([0, 0]);
    });

    it('gives the only voted option 100% on a first-and-only vote', () => {
      const out = computePercentages(
        [
          { value: 'A', count: 1 },
          { value: 'B', count: 0 },
        ],
        1,
      );
      expect(out.map((o) => o.percent)).toEqual([100, 0]);
    });

    it('always sums to exactly 100 when there is at least one vote', () => {
      const counts = [1, 1, 1, 1, 1, 1, 1]; // 7 voters over 7 options
      const total = counts.reduce((a, b) => a + b, 0);
      const out = computePercentages(
        counts.map((c, i) => ({ value: String(i), count: c })),
        total,
      );
      const sum = out.reduce((a, o) => a + o.percent, 0);
      expect(sum).toBe(100);
    });

    it('distributes leftover points via largest remainder (3 voters, 3 options)', () => {
      // 1/3 = 33.33 each -> floors 33+33+33=99 -> one leftover -> 34,33,33
      const out = computePercentages(
        [
          { value: 'A', count: 1 },
          { value: 'B', count: 1 },
          { value: 'C', count: 1 },
        ],
        3,
      );
      expect(out.map((o) => o.percent).sort((a, b) => a - b)).toEqual([33, 33, 34]);
      expect(out.reduce((a, o) => a + o.percent, 0)).toBe(100);
    });

    it('is deterministic on ties (preserves input order)', () => {
      const build = () =>
        computePercentages(
          [
            { value: 'A', count: 1 },
            { value: 'B', count: 1 },
            { value: 'C', count: 1 },
          ],
          3,
        ).map((o) => o.value);
      // Repeated calls yield identical ordering.
      expect(build()).toEqual(build());
    });

    it('preserves option order and carries through original fields', () => {
      const out = computePercentages(
        [
          { value: 'PHONE', count: 3, extra: true },
          { value: 'TV', count: 1 },
        ],
        4,
      );
      expect(out.map((o) => o.value)).toEqual(['PHONE', 'TV']);
      expect(out[0]).toMatchObject({ count: 3, extra: true });
      expect(out[0].percent).toBe(75);
      expect(out[1].percent).toBe(25);
    });
  });

  describe('applyVoteChange', () => {
    const opts = (counts: Record<string, number>) =>
      Object.entries(counts).map(([value, count]) => ({ value, count }));

    it('first vote increments total and the chosen option', () => {
      const res = applyVoteChange(opts({ A: 2, B: 1 }), 3, null, 'A');
      expect(res.total).toBe(4);
      expect(res.options).toEqual([
        { value: 'A', count: 3 },
        { value: 'B', count: 1 },
      ]);
    });

    it('changing a vote moves the count without changing total', () => {
      const res = applyVoteChange(opts({ A: 2, B: 1 }), 3, 'A', 'B');
      expect(res.total).toBe(3);
      expect(res.options).toEqual([
        { value: 'A', count: 1 },
        { value: 'B', count: 2 },
      ]);
    });

    it('re-selecting the same value is a no-op on totals/counts', () => {
      const res = applyVoteChange(opts({ A: 2, B: 1 }), 3, 'A', 'A');
      expect(res.total).toBe(3);
      expect(res.options).toEqual([
        { value: 'A', count: 2 },
        { value: 'B', count: 1 },
      ]);
    });

    it('appends a brand-new option receiving its first vote', () => {
      const res = applyVoteChange(opts({ A: 2 }), 2, null, 'B');
      expect(res.total).toBe(3);
      expect(res.options).toEqual([
        { value: 'A', count: 2 },
        { value: 'B', count: 1 },
      ]);
    });

    it('clearing a vote decrements the old option and the total', () => {
      const res = applyVoteChange(opts({ A: 2, B: 1 }), 3, 'A', null);
      expect(res.total).toBe(2);
      expect(res.options).toEqual([
        { value: 'A', count: 1 },
        { value: 'B', count: 1 },
      ]);
    });
  });
});
