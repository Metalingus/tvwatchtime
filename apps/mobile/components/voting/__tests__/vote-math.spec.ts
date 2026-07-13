import { computePercentages, applyVoteChange } from '@tvwatch/shared';

// Client-side mirror of the rounding/optimistic-update logic used by the voting
// sections. Pure logic only (no React Native imports) so it runs under the same
// Jest config as lib/dialog/__tests__/dialog.spec.ts.

describe('client vote-math', () => {
  it('hides nothing but yields all-zero percentages before anyone votes (total 0)', () => {
    const out = computePercentages(
      [
        { value: 'PHONE', count: 0 },
        { value: 'TV', count: 0 },
      ],
      0,
    );
    expect(out.every((o) => o.percent === 0)).toBe(true);
  });

  it('reveals 100% for the selected option on a first-and-only vote', () => {
    const out = computePercentages(
      [
        { value: 'PHONE', count: 1 },
        { value: 'TV', count: 0 },
      ],
      1,
    );
    const map = new Map(out.map((o) => [o.value, o.percent]));
    expect(map.get('PHONE')).toBe(100);
    expect(map.get('TV')).toBe(0);
  });

  it('keeps percentages summing to 100 across 5 rating buckets', () => {
    const out = computePercentages(
      [3, 1, 4, 2, 5].map((c, i) => ({ value: String(i + 1), count: c })),
      15,
    );
    expect(out.reduce((a, o) => a + o.percent, 0)).toBe(100);
  });

  it('optimistic first vote increments total + chosen option', () => {
    const res = applyVoteChange([{ value: 'TV', count: 2 }], 2, null, 'TV');
    expect(res.total).toBe(3);
    expect(res.options).toEqual([{ value: 'TV', count: 3 }]);
  });

  it('optimistic change moves the vote without changing total', () => {
    const res = applyVoteChange(
      [
        { value: 'TV', count: 2 },
        { value: 'PHONE', count: 1 },
      ],
      3,
      'TV',
      'PHONE',
    );
    expect(res.total).toBe(3);
    expect(res.options).toEqual([
      { value: 'TV', count: 1 },
      { value: 'PHONE', count: 2 },
    ]);
  });
});
