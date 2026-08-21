import { averageEpisodeUserRating, resolveEpisodeRating } from './episode-rating.util';

describe('episode rating fallback', () => {
  it('prefers the provider score and normalizes it for both surfaces', () => {
    expect(resolveEpisodeRating(8.3, 4.9)).toEqual({
      ratingFive: 4.2,
      ratingTen: 8.3,
      source: 'PROVIDER',
    });
  });

  it('falls back to the average user score when the provider has none', () => {
    expect(resolveEpisodeRating(null, 4.25)).toEqual({
      ratingFive: 4.3,
      ratingTen: 8.5,
      source: 'COMMUNITY',
    });
  });

  it('returns no rating when neither source has a real score', () => {
    expect(resolveEpisodeRating(0, null)).toBeNull();
  });

  it('computes a weighted average from rating-section counts', () => {
    expect(
      averageEpisodeUserRating([
        { value: '3', count: 1 },
        { value: '5', count: 3 },
      ]),
    ).toBe(4.5);
  });
});
