import {
  episodeProgressEligibilityWhere,
  isEpisodeProgressEligible,
} from './episode-progress.util';

describe('episode progress eligibility', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');

  it('includes undated and already-aired episodes but excludes explicit future episodes', () => {
    expect(isEpisodeProgressEligible(null, now)).toBe(true);
    expect(isEpisodeProgressEligible(new Date('2026-08-07T12:00:00.000Z'), now)).toBe(true);
    expect(isEpisodeProgressEligible(new Date('2026-08-09T12:00:00.000Z'), now)).toBe(false);
  });

  it('builds the equivalent Prisma predicate', () => {
    expect(episodeProgressEligibilityWhere(now)).toEqual({
      OR: [{ airDate: null }, { airDate: { lte: now } }],
    });
  });
});
