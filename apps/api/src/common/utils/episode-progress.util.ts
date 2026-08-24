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

/**
 * Positive bulk watch actions require a provider-confirmed air date. Undated
 * official episodes remain part of normal progress, but are never marked or
 * rewatched implicitly.
 */
export function isEpisodeBulkWatchEligible(
  airDate: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return !!airDate && airDate <= now;
}

/** Prisma fragment matching {@link isEpisodeProgressEligible}. */
export function episodeProgressEligibilityWhere(now: Date = new Date()): Prisma.EpisodeWhereInput {
  return {
    OR: [{ airDate: null }, { airDate: { lte: now } }],
  };
}
