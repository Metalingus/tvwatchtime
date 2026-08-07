import { compatibleAirtimeSeasons } from './airtime-structure';

const episodes = (season: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    season: { number: season },
  }));

describe('compatibleAirtimeSeasons', () => {
  it('accepts an exact season/episode coordinate set', () => {
    expect(compatibleAirtimeSeasons(['1-1', '1-2'], episodes(1, 2))).toEqual(new Set([1]));
  });

  it('rejects a split provider season before airtimes can overwrite canonical dates', () => {
    expect(
      compatibleAirtimeSeasons(
        Array.from({ length: 32 }, (_, index) => `1-${index + 1}`),
        episodes(1, 16),
      ),
    ).toEqual(new Set());
  });

  it('rejects equal-sized seasons whose episode coordinates differ', () => {
    expect(compatibleAirtimeSeasons(['1-1', '1-3'], episodes(1, 2))).toEqual(new Set());
  });

  it('allows compatible seasons while independently rejecting incompatible ones', () => {
    expect(
      compatibleAirtimeSeasons(
        ['1-1', '1-2', '2-1', '2-2'],
        [...episodes(1, 2), ...episodes(2, 1)],
      ),
    ).toEqual(new Set([1]));
  });
});
