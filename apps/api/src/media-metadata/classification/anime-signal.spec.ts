import { isAnimeSignal } from './anime-signal';

describe('isAnimeSignal', () => {
  it('is true only for Animation (16) + JP origin', () => {
    expect(isAnimeSignal([16, 10759], ['JP'])).toBe(true);
    expect(isAnimeSignal([16], ['JP', 'US'])).toBe(true);
  });

  it('is false for Western animation (no JP origin)', () => {
    expect(isAnimeSignal([16, 35], ['US'])).toBe(false);
    expect(isAnimeSignal([16], [])).toBe(false);
  });

  it('is false for JP origin without the Animation genre', () => {
    expect(isAnimeSignal([18, 9648], ['JP'])).toBe(false);
  });

  it('is false for empty inputs', () => {
    expect(isAnimeSignal([], [])).toBe(false);
  });
});
