export interface ScrollToIndexTarget {
  scrollToIndex(options: { index: number; animated: boolean }): void;
}

export function shouldWaitForAuthoritativeWatchNext(options: {
  isLoading: boolean;
  isFetchedAfterMount: boolean;
  hasWatchNext: boolean;
}): boolean {
  return options.isLoading || (!options.hasWatchNext && !options.isFetchedAfterMount);
}

/**
 * Try the one-time Watch Next landing only when both data and the rendered list are ready.
 * Returning false deliberately leaves the caller's landed latch open for an on-layout retry.
 */
export function attemptInitialWatchNextLanding(
  list: ScrollToIndexTarget | null,
  options: { isLoading: boolean; alreadyLanded: boolean; landingIndex: number },
): boolean {
  if (options.isLoading || options.alreadyLanded || options.landingIndex <= 0 || !list) {
    return false;
  }
  list.scrollToIndex({ index: options.landingIndex, animated: false });
  return true;
}
