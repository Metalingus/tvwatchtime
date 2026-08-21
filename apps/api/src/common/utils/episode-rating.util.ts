export interface EpisodeRatingResolution {
  /** Rating normalized to the chart's 0-5 scale. */
  ratingFive: number;
  /** Rating normalized to the episode detail's provider-compatible 0-10 scale. */
  ratingTen: number;
  source: 'PROVIDER' | 'COMMUNITY';
}

const finitePositive = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) && value > 0 ? value : null;

const roundOne = (value: number): number => Math.round(value * 10) / 10;

/** Provider rating wins; the app-user average fills only a missing provider score. */
export function resolveEpisodeRating(
  providerRatingTen: number | null | undefined,
  communityAverageFive: number | null | undefined,
): EpisodeRatingResolution | null {
  const provider = finitePositive(providerRatingTen);
  if (provider != null) {
    const ratingTen = Math.min(10, provider);
    return {
      ratingFive: roundOne(ratingTen / 2),
      ratingTen: roundOne(ratingTen),
      source: 'PROVIDER',
    };
  }

  const community = finitePositive(communityAverageFive);
  if (community == null) return null;
  const ratingFive = Math.min(5, community);
  return {
    ratingFive: roundOne(ratingFive),
    ratingTen: roundOne(ratingFive * 2),
    source: 'COMMUNITY',
  };
}

export function averageEpisodeUserRating(
  options: Array<{ value: string | number; count: number }> | null | undefined,
): number | null {
  let votes = 0;
  let weighted = 0;
  for (const option of options ?? []) {
    const value = Number(option.value);
    const count = Number(option.count);
    if (
      !Number.isFinite(value) ||
      value < 1 ||
      value > 5 ||
      !Number.isFinite(count) ||
      count <= 0
    ) {
      continue;
    }
    votes += count;
    weighted += value * count;
  }
  return votes > 0 ? weighted / votes : null;
}
