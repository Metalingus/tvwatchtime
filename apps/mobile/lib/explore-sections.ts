import type { TFunction } from 'i18next';
import {
  EXPLORE_SECTION_IDS,
  normalizeExploreSections,
  streamingTopSection,
  STREAMING_TOP_SERVICE_NAMES,
  withoutExploreSections,
  type ExploreSectionId,
  type ExploreSectionPreferences,
  type StreamingTopService,
} from '@tvwatch/shared';

/** Sections without a `route` are short ranked lists with no "see all" screen. */
export const EXPLORE_SECTION_META: Record<
  ExploreSectionId,
  { kind: 'shows' | 'movies'; route?: string; service?: StreamingTopService }
> = {
  topShowsForYou: { kind: 'shows', route: 'top-for-you' },
  topMoviesForYou: { kind: 'movies', route: 'top-movies-for-you' },
  trendingShows: { kind: 'shows', route: 'trending-shows' },
  trendingMovies: { kind: 'movies', route: 'trending-movies' },
  nowPlayingMovies: { kind: 'movies', route: 'now-playing-movies' },
  upcomingMovies: { kind: 'movies', route: 'upcoming-movies' },
  topRatedShows: { kind: 'shows', route: 'top-rated-shows' },
  topRatedMovies: { kind: 'movies', route: 'top-rated-movies' },
  netflixTopShows: { kind: 'shows', service: 'netflix' },
  netflixTopMovies: { kind: 'movies', service: 'netflix' },
  primeTopShows: { kind: 'shows', service: 'prime' },
  primeTopMovies: { kind: 'movies', service: 'prime' },
  disneyTopShows: { kind: 'shows', service: 'disney' },
  disneyTopMovies: { kind: 'movies', service: 'disney' },
  appleTopShows: { kind: 'shows', service: 'apple' },
  appleTopMovies: { kind: 'movies', service: 'apple' },
  hboTopShows: { kind: 'shows', service: 'hbo' },
  hboTopMovies: { kind: 'movies', service: 'hbo' },
};

export function visibleExploreSections(
  preferences: ExploreSectionPreferences,
  mediaType: 'both' | 'shows' | 'movies',
  isAvailable: (id: ExploreSectionId) => boolean = () => true,
): ExploreSectionId[] {
  return preferences.order.filter(
    (id) =>
      !preferences.hidden.includes(id) &&
      isAvailable(id) &&
      (mediaType === 'both' || EXPLORE_SECTION_META[id].kind === mediaType),
  );
}

/** Streaming chart titles interpolate the (untranslated) service brand name. */
export function exploreSectionTitle(t: TFunction, id: ExploreSectionId): string {
  const streaming = streamingTopSection(id);
  if (streaming) {
    return t(`explore:streamingTop.${streaming.kind}`, {
      service: STREAMING_TOP_SERVICE_NAMES[streaming.service],
    });
  }
  return t('explore:' + id);
}

/** The layout limited to sections the connected API offers (used by the editor). */
export function availableSectionPreferences(
  value: unknown,
  isAvailable: (id: ExploreSectionId) => boolean,
): ExploreSectionPreferences {
  return withoutExploreSections(
    normalizeExploreSections(value),
    EXPLORE_SECTION_IDS.filter((id) => !isAvailable(id)),
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
