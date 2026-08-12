import type { QueryClient, QueryKey } from '@tanstack/react-query';

export const MARK_SEASON_WATCHED_MUTATION_KEY = ['markSeasonWatched'] as const;

export type SeasonEpisodesSnapshot = [QueryKey, unknown][];

const mapItemsDeep = (data: any, fn: (item: any) => any) => {
  if (!data) return data;
  if (Array.isArray(data)) return data.map(fn);
  if (Array.isArray(data.items)) return { ...data, items: data.items.map(fn) };
  if (Array.isArray(data.pages)) {
    return {
      ...data,
      pages: data.pages.map((page: any) =>
        Array.isArray(page?.items) ? { ...page, items: page.items.map(fn) } : page,
      ),
    };
  }
  return data;
};

const findItemDeep = (data: any, predicate: (item: any) => boolean) => {
  if (!data) return undefined;
  if (Array.isArray(data)) return data.find(predicate);
  if (Array.isArray(data.items)) return data.items.find(predicate);
  if (Array.isArray(data.pages)) {
    for (const page of data.pages) {
      const found = Array.isArray(page?.items) ? page.items.find(predicate) : undefined;
      if (found) return found;
    }
  }
  return undefined;
};

/** Optimistic per-episode transform for one season inside the ['showEpisodes'] caches. */
export const patchSeasonEpisodes = (
  queryClient: QueryClient,
  seasonId: string,
  fn: (episode: any) => any,
): SeasonEpisodesSnapshot => {
  const previous = queryClient.getQueriesData({ queryKey: ['showEpisodes'] });
  previous.forEach(([queryKey, data]) => {
    if (data === undefined) return;
    queryClient.setQueryData(queryKey, (current: any) =>
      mapItemsDeep(current, (season: any) =>
        season?.id === seasonId
          ? { ...season, episodes: (season.episodes ?? []).map((episode: any) => fn(episode)) }
          : season,
      ),
    );
  });
  return previous;
};

/** Restore only the failed season, preserving optimistic changes made by concurrent mutations. */
export const restoreSeasonEpisodes = (
  queryClient: QueryClient,
  seasonId: string,
  previous: SeasonEpisodesSnapshot | undefined,
) => {
  previous?.forEach(([queryKey, previousData]) => {
    const previousSeason = findItemDeep(previousData, (season: any) => season?.id === seasonId);
    if (!previousSeason) return;

    queryClient.setQueryData(queryKey, (current: any) =>
      mapItemsDeep(current, (season: any) => (season?.id === seasonId ? previousSeason : season)),
    );
  });
};
