import { Prisma } from '@prisma/client';

/**
 * Progress includes official episodes with no known air date and excludes only episodes
 * that are explicitly scheduled in the future.
 */
export function isEpisodeProgressEligible(
  airDate: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return !airDate || airDate <= now;
}

/** Prisma fragment matching {@link isEpisodeProgressEligible}. */
export function episodeProgressEligibilityWhere(now: Date = new Date()): Prisma.EpisodeWhereInput {
  return {
    OR: [{ airDate: null }, { airDate: { lte: now } }],
  };
}
