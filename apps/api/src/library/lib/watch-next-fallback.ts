import { WatchNextBucket } from '@tvwatch/shared';

type FallbackCard = {
  lastWatchedAt: Date | null;
  bucket: WatchNextBucket;
};

export function mostRecentlyWatchedFirst<T extends Pick<FallbackCard, 'lastWatchedAt'>>(
  a: T,
  b: T,
): number {
  return (
    (b.lastWatchedAt?.getTime() ?? Number.NEGATIVE_INFINITY) -
    (a.lastWatchedAt?.getTime() ?? Number.NEGATIVE_INFINITY)
  );
}

/**
 * Keep the primary rail useful when normal recency rules leave it empty. Recently
 * watched shows have first priority; recently added shows fill any remaining slots.
 * Promoted cards are removed from their source rail so sections never duplicate.
 */
export function promoteWatchNextFallback<T extends FallbackCard>(
  watchNext: readonly T[],
  notRecently: readonly T[],
  recentlyAdded: readonly T[],
  compareRecentlyAdded: (a: T, b: T) => number,
  limit = 5,
): { watchNext: T[]; notRecently: T[]; recentlyAdded: T[] } {
  if (
    watchNext.length > 0 ||
    (notRecently.length === 0 && recentlyAdded.length === 0) ||
    limit <= 0
  ) {
    return {
      watchNext: [...watchNext],
      notRecently: [...notRecently],
      recentlyAdded: [...recentlyAdded],
    };
  }

  const watchedPromoted = notRecently
    .filter((card) => card.lastWatchedAt != null)
    .sort(mostRecentlyWatchedFirst)
    .slice(0, limit);
  const promotedCards = new Set(watchedPromoted);
  const addedPromoted: T[] = [];
  const fillCandidates = [...notRecently, ...recentlyAdded]
    .filter((card) => !promotedCards.has(card))
    .sort(compareRecentlyAdded);
  for (const card of fillCandidates) {
    if (watchedPromoted.length + addedPromoted.length >= limit) break;
    promotedCards.add(card);
    addedPromoted.push(card);
  }
  const promoted = [...watchedPromoted, ...addedPromoted];

  return {
    watchNext: promoted.map((card) => ({ ...card, bucket: WatchNextBucket.WATCH_NEXT })),
    notRecently: notRecently.filter((card) => !promotedCards.has(card)),
    recentlyAdded: recentlyAdded.filter((card) => !promotedCards.has(card)),
  };
}
