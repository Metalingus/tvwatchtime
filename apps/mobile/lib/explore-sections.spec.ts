import { EXPLORE_SECTION_IDS, normalizeExploreSections } from '@tvwatch/shared';
import { moveExploreSection, visibleExploreSections } from './explore-sections';

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
  expect(visibleExploreSections(restored, 'movies')).toEqual([
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
  expect(visibleExploreSections(normalizeExploreSections(null), 'both')).toHaveLength(8);
});

it('does not move rows past either end or mutate the saved settings while editing', () => {
  const layout = normalizeExploreSections(null);
  expect(moveExploreSection(layout, layout.order[0], -1)).toBe(layout);
  expect(moveExploreSection(layout, layout.order.at(-1)!, 1)).toBe(layout);
  const moved = moveExploreSection(layout, 'upcomingMovies', 1);
  expect(layout.order).toEqual(EXPLORE_SECTION_IDS);
  expect(moved.order).not.toEqual(layout.order);
});
