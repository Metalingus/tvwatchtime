import {
  EXPLORE_SECTION_IDS,
  isStreamingTopSectionId,
  normalizeExploreSections,
  STREAMING_TOP_SECTION_IDS,
} from '@tvwatch/shared';
import type { TFunction } from 'i18next';
import {
  availableSectionPreferences,
  EXPLORE_SECTION_META,
  exploreSectionTitle,
  moveExploreSection,
  visibleExploreSections,
} from './explore-sections';

const withoutStreaming = (id: string) => !isStreamingTopSectionId(id);

it('places Upcoming Movies directly under Playing Now in the default layout', () => {
  const layout = normalizeExploreSections(null);
  expect(layout.order[layout.order.indexOf('nowPlayingMovies') + 1]).toBe('upcomingMovies');
  expect(layout.hidden).toEqual([]);
});

it('restores saved order and visibility after serializing and reopening', () => {
  let layout = normalizeExploreSections(null);
  layout = moveExploreSection(layout, 'upcomingMovies', -1);
  layout.hidden = ['trendingMovies'];
  const restored = normalizeExploreSections(JSON.parse(JSON.stringify(layout)));
  expect(restored).toEqual(layout);
  expect(visibleExploreSections(restored, 'movies', withoutStreaming)).toEqual([
    'topMoviesForYou',
    'upcomingMovies',
    'nowPlayingMovies',
    'topRatedMovies',
  ]);
});

it('handles corrupt, duplicate, missing, and obsolete section IDs without losing current sections', () => {
  const layout = normalizeExploreSections({
    order: ['upcomingMovies', 'removed', 'upcomingMovies'],
    hidden: ['removed', 'topRatedMovies', 'topRatedMovies'],
  });
  expect(layout.order[0]).toBe('upcomingMovies');
  expect(new Set(layout.order)).toEqual(new Set(EXPLORE_SECTION_IDS));
  expect(layout.hidden).toEqual(['topRatedMovies']);
  expect(normalizeExploreSections('bad')).toEqual(normalizeExploreSections(null));
});

it('allows all sections to be disabled and reset to the full default layout', () => {
  const layout = { order: [...EXPLORE_SECTION_IDS], hidden: [...EXPLORE_SECTION_IDS] };
  expect(visibleExploreSections(layout, 'both')).toEqual([]);
  expect(visibleExploreSections(normalizeExploreSections(null), 'both')).toHaveLength(18);
  expect(
    visibleExploreSections(normalizeExploreSections(null), 'both', withoutStreaming),
  ).toHaveLength(8);
});

it('does not move rows past either end or mutate the saved settings while editing', () => {
  const layout = normalizeExploreSections(null);
  expect(moveExploreSection(layout, layout.order[0], -1)).toBe(layout);
  expect(moveExploreSection(layout, layout.order.at(-1)!, 1)).toBe(layout);
  const moved = moveExploreSection(layout, 'upcomingMovies', 1);
  expect(layout.order).toEqual(EXPLORE_SECTION_IDS);
  expect(moved.order).not.toEqual(layout.order);
});

it('adds the streaming charts after the existing sections and filters them by media type', () => {
  const layout = normalizeExploreSections(null);
  expect(layout.order.slice(-10)).toEqual([...STREAMING_TOP_SECTION_IDS]);
  expect(STREAMING_TOP_SECTION_IDS.every((id) => !EXPLORE_SECTION_META[id].route)).toBe(true);
  const shows = visibleExploreSections(layout, 'shows').filter(isStreamingTopSectionId);
  expect(shows).toEqual([
    'netflixTopShows',
    'primeTopShows',
    'disneyTopShows',
    'appleTopShows',
    'hboTopShows',
  ]);
});

it('keeps unavailable sections out of the editor without changing the rest of the layout', () => {
  const saved = {
    order: ['netflixTopShows', ...EXPLORE_SECTION_IDS.filter((id) => id !== 'netflixTopShows')],
    hidden: ['hboTopMovies', 'trendingShows'],
  };
  const editable = availableSectionPreferences(saved, withoutStreaming);
  expect(editable.order).toEqual(EXPLORE_SECTION_IDS.filter(withoutStreaming));
  expect(editable.hidden).toEqual(['trendingShows']);
  expect(availableSectionPreferences(saved, () => true)).toEqual(normalizeExploreSections(saved));
});

it('titles streaming charts with the untranslated service name', () => {
  const t = jest.fn((key: string, options?: { service?: string }) =>
    options?.service ? `${key}:${options.service}` : key,
  ) as unknown as TFunction;
  expect(exploreSectionTitle(t, 'disneyTopMovies')).toBe('explore:streamingTop.movies:Disney+');
  expect(exploreSectionTitle(t, 'primeTopShows')).toBe('explore:streamingTop.shows:Prime Video');
  expect(exploreSectionTitle(t, 'trendingShows')).toBe('explore:trendingShows');
});
