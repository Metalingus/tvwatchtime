import { hasPendingMetadata, mergeRefreshedMetadata } from './metadata-refresh';

it('replaces placeholders without rolling back watched state or votes', () => {
  const current = {
    id: 'episode',
    title: 'Episode 1',
    stillUrl: null,
    watched: true,
    interactions: { rating: { userVote: '5' } },
    metadataPending: true,
  };
  const fresh = {
    id: 'episode',
    title: 'Bloodbath',
    stillUrl: 'https://example.test/still.jpg',
    watched: false,
    interactions: { rating: { userVote: null } },
    metadataPending: false,
  };
  const result = mergeRefreshedMetadata<any>(current, fresh);
  expect(result).toMatchObject({
    title: 'Bloodbath',
    stillUrl: fresh.stillUrl,
    watched: true,
    metadataPending: false,
  });
  expect(result.interactions).toBe(current.interactions);
});
it('updates mounted season/episode rows while preserving progress and stable ids', () => {
  const current = [
    {
      id: 'season',
      title: 'Season 4',
      watchedCount: 2,
      episodes: [{ id: 'episode', title: 'Episode 1', watched: true }],
    },
  ];
  const fresh = [
    {
      id: 'season',
      title: 'The Lizzie Borden Story',
      watchedCount: 0,
      episodes: [{ id: 'episode', title: 'Bloodbath', watched: false }],
    },
  ];
  expect(mergeRefreshedMetadata(current, fresh)).toEqual([
    {
      id: 'season',
      title: 'The Lizzie Borden Story',
      watchedCount: 2,
      episodes: [{ id: 'episode', title: 'Bloodbath', watched: true }],
    },
  ]);
});
it('does not resurrect a removed cache or replace a different episode', () => {
  expect(mergeRefreshedMetadata(undefined, { id: 'a' })).toBeUndefined();
  const current = { id: 'a', title: 'A' };
  expect(mergeRefreshedMetadata(current, { id: 'b', title: 'B' })).toBe(current);
});
it('checks pending work across paginated watch-next data', () => {
  expect(
    hasPendingMetadata({ pages: [{ metadataPending: false }, { metadataPending: true }] }),
  ).toBe(true);
  expect(hasPendingMetadata({ pages: [{ metadataPending: false }] })).toBe(false);
});

it('updates a date-only detail to the newly ingested airtime without changing watched state', () => {
  const current = {
    id: 'bloodbath',
    airDate: '2026-09-17T00:00:00Z',
    airTime: null,
    watched: true,
  };
  const fresh = {
    id: 'bloodbath',
    airDate: '2026-09-17T07:00:00Z',
    airTime: '03:00',
    watched: false,
  };
  expect(mergeRefreshedMetadata<any>(current, fresh)).toEqual({ ...fresh, watched: true });
});

it.each(['https://www.youtube.com/watch?v=f_bKjZeJBBI', null])(
  'adopts a corrected or removed trailer during background metadata refresh (%s)',
  (trailerUrl) => {
    const current = { id: 'show', watched: true, trailerUrl: 'old-promo' as string | null };
    expect(mergeRefreshedMetadata(current, { ...current, watched: false, trailerUrl })).toEqual({
      ...current,
      trailerUrl,
    });
  },
);
