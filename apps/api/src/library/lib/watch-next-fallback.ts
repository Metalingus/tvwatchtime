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
 * Keep the primary rail useful when every eligible started show is stale. Promoted
 * cards are removed from NOT_RECENTLY so one show never appears in both sections.
 */
export function promoteWatchNextFallback<T extends FallbackCard>(
  watchNext: readonly T[],
  notRecently: readonly T[],
  limit = 5,
): { watchNext: T[]; notRecently: T[] } {
  if (watchNext.length > 0 || notRecently.length === 0 || limit <= 0) {
    return { watchNext: [...watchNext], notRecently: [...notRecently] };
  }

  const promoted = [...notRecently].sort(mostRecentlyWatchedFirst).slice(0, limit);
  const promotedCards = new Set(promoted);

  return {
    watchNext: promoted.map((card) => ({ ...card, bucket: WatchNextBucket.WATCH_NEXT })),
    notRecently: notRecently.filter((card) => !promotedCards.has(card)),
  };
}
