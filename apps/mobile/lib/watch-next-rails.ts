export type WatchNextPagedRail = 'WATCH_NEXT' | 'START_WATCHING' | 'NOT_RECENTLY';

/**
 * Size of the first slice `/me/watch-next` ships per paged rail. Must match the API's
 * WATCH_NEXT_LIMIT / START_WATCHING_LIMIT / NOT_RECENTLY_LIMIT; "See more" pages start
 * at this offset.
 */
export const WATCH_NEXT_INITIAL_SLICE: Record<WatchNextPagedRail, number> = {
  WATCH_NEXT: 20,
  START_WATCHING: 10,
  NOT_RECENTLY: 10,
};

/**
 * Whether a rail's "See more" footer should render. Before any page is fetched the
 * server's uncapped total is compared with the slice the server sent — never with the
 * rendered card count, which client dedupe and optimistic mark-watched transforms can
 * shrink below the total even though the server has nothing beyond the first slice.
 */
export function watchNextRailHasMore(options: {
  rail: WatchNextPagedRail;
  total: number;
  pagesFetched: number;
  hasNextPage: boolean;
}): boolean {
  if (options.pagesFetched > 0) return options.hasNextPage;
  return options.total > WATCH_NEXT_INITIAL_SLICE[options.rail];
}
