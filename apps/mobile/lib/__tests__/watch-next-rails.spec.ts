import { watchNextRailHasMore } from '../watch-next-rails';

describe('watchNextRailHasMore', () => {
  it('hides See more when the server total fits in the first slice', () => {
    // 5 cards from the server, one deduped/optimistically removed client-side: the server
    // still has nothing past offset 20, so the footer must not render.
    expect(
      watchNextRailHasMore({ rail: 'WATCH_NEXT', total: 5, pagesFetched: 0, hasNextPage: false }),
    ).toBe(false);
    expect(
      watchNextRailHasMore({ rail: 'WATCH_NEXT', total: 20, pagesFetched: 0, hasNextPage: false }),
    ).toBe(false);
    expect(
      watchNextRailHasMore({ rail: 'NOT_RECENTLY', total: 10, pagesFetched: 0, hasNextPage: false }),
    ).toBe(false);
  });

  it('shows See more when the server total exceeds the first slice', () => {
    expect(
      watchNextRailHasMore({ rail: 'WATCH_NEXT', total: 21, pagesFetched: 0, hasNextPage: false }),
    ).toBe(true);
    expect(
      watchNextRailHasMore({
        rail: 'START_WATCHING',
        total: 11,
        pagesFetched: 0,
        hasNextPage: false,
      }),
    ).toBe(true);
  });

  it('defers to the pager once a page has been fetched', () => {
    expect(
      watchNextRailHasMore({ rail: 'WATCH_NEXT', total: 50, pagesFetched: 1, hasNextPage: false }),
    ).toBe(false);
    expect(
      watchNextRailHasMore({ rail: 'WATCH_NEXT', total: 50, pagesFetched: 1, hasNextPage: true }),
    ).toBe(true);
  });
});
