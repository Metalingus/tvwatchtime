export interface RatingChartEpisode {
  number: number;
  rating: number;
  votes: number;
}

export interface RatingChartSeason {
  seasonNumber: number;
  episodes: RatingChartEpisode[];
}

export function normalizeRatingChartSeasons(input: unknown): RatingChartSeason[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (season): season is RatingChartSeason =>
        !!season && Number.isFinite(season.seasonNumber) && Array.isArray(season.episodes),
    )
    .map((season) => ({
      ...season,
      episodes: season.episodes.filter(
        (episode) =>
          !!episode && Number.isFinite(episode.number) && Number.isFinite(episode.rating),
      ),
    }))
    .filter((season) => season.episodes.length > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber);
}

export function safeRatingSeasonIndex(index: unknown, seasonCount: number): number {
  if (seasonCount <= 0) return 0;
  const finiteIndex = typeof index === 'number' && Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(seasonCount - 1, Math.max(0, finiteIndex));
}
