import type { ExploreSectionId, ExploreSectionPreferences } from '@tvwatch/shared';

export const EXPLORE_SECTION_META: Record<
  ExploreSectionId,
  { kind: 'shows' | 'movies'; route: string }
> = {
  topShowsForYou: { kind: 'shows', route: 'top-for-you' },
  topMoviesForYou: { kind: 'movies', route: 'top-movies-for-you' },
  trendingShows: { kind: 'shows', route: 'trending-shows' },
  trendingMovies: { kind: 'movies', route: 'trending-movies' },
  nowPlayingMovies: { kind: 'movies', route: 'now-playing-movies' },
  upcomingMovies: { kind: 'movies', route: 'upcoming-movies' },
  topRatedShows: { kind: 'shows', route: 'top-rated-shows' },
  topRatedMovies: { kind: 'movies', route: 'top-rated-movies' },
};

export function visibleExploreSections(
  preferences: ExploreSectionPreferences,
  mediaType: 'both' | 'shows' | 'movies',
): ExploreSectionId[] {
  return preferences.order.filter(
    (id) =>
      !preferences.hidden.includes(id) &&
      (mediaType === 'both' || EXPLORE_SECTION_META[id].kind === mediaType),
  );
}

export function moveExploreSection(
  preferences: ExploreSectionPreferences,
  id: ExploreSectionId,
  direction: -1 | 1,
): ExploreSectionPreferences {
  const index = preferences.order.indexOf(id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= preferences.order.length) return preferences;
  const order = [...preferences.order];
  [order[index], order[destination]] = [order[destination], order[index]];
  return { ...preferences, order };
}
