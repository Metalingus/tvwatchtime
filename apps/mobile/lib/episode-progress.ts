export interface EpisodeProgressItem {
  id: string;
  number: number;
  watched?: boolean;
  airDate?: string | Date | null;
}

export interface SeasonProgressItem {
  number: number;
  isSpecial?: boolean;
  episodes?: EpisodeProgressItem[];
}

/**
 * TVDB official episodes often have no air date. They still belong to the canonical
 * structure, so progress excludes only episodes with a valid date in the future.
 */
export function isEpisodeProgressEligible(
  airDate: string | Date | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!airDate) return true;
  const timestamp = airDate instanceof Date ? airDate.getTime() : new Date(airDate).getTime();
  return !Number.isFinite(timestamp) || timestamp <= now;
}

/** Count earlier progress-eligible, non-special episodes that are not yet watched. */
export function countUnwatchedPreviousEpisodes(
  seasons: SeasonProgressItem[] | undefined,
  seasonNumber: number,
  episodeNumber: number,
  now = new Date(),
): number {
  if (!seasons || seasonNumber === 0) return 0;

  return seasons.reduce((count, season) => {
    if (season.isSpecial || season.number === 0 || season.number > seasonNumber) return count;
    return (
      count +
      (season.episodes ?? []).filter((episode) => {
        const earlier =
          season.number < seasonNumber ||
          (season.number === seasonNumber && episode.number < episodeNumber);
        return (
          earlier && !episode.watched && isEpisodeProgressEligible(episode.airDate, now.getTime())
        );
      }).length
    );
  }, 0);
}
