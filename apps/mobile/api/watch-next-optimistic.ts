import { WatchNextBucket } from '@tvwatch/shared';
import type { EpisodeDto, WatchNextItemDto } from '@tvwatch/shared';

/**
 * Optimistically apply a watched-state change to the cached `/me/watch-next`
 * items array so the Shows-tab watchlist reacts instantly and the ~1s server
 * reconcile is invisible (no disappear / reappear / duplicate cards).
 *
 * Pure + side-effect free so it can be unit-tested.
 *
 * `on === true` (mark watched):
 *  - the matched item moves to History (latest entry → bottom of the History section),
 *  - its Watch-Next card is swapped in place to `nextEpisode` with `remainingUnwatched - 1`,
 *  - if there is no `nextEpisode` (last unwatched episode) the Watch-Next card is removed.
 *
 * `on === false` (unwatch):
 *  - the matched History item is removed,
 *  - the show's existing non-History card (any bucket) has its episode replaced with the
 *    unwatched one (keeping its bucket → returns to the section it was in) and
 *    `remainingUnwatched + 1`,
 *  - if the show has no Watch-Next card, a new `WATCH_NEXT` card is created with `+1`.
 */
export function applyWatchStateToItems(
  items: WatchNextItemDto[],
  episodeId: string,
  on: boolean,
): WatchNextItemDto[] {
  return on ? applyMarkWatched(items, episodeId) : applyUnwatch(items, episodeId);
}

function applyMarkWatched(items: WatchNextItemDto[], episodeId: string): WatchNextItemDto[] {
  const idx = items.findIndex((it) => it.episode?.id === episodeId);
  if (idx === -1) return items;
  const it = items[idx];
  const now = new Date().toISOString();

  const historyItem: WatchNextItemDto = {
    ...it,
    bucket: WatchNextBucket.HISTORY,
    episode: {
      ...it.episode,
      watched: true,
      watchedAt: now,
      watchCount: 1,
    },
    remainingUnwatched: 0,
    progress: 1,
    lastWatchedAt: now,
    nextEpisode: null,
  };

  let withoutIt: WatchNextItemDto[];
  if (it.nextEpisode) {
    // Swap the card in place to the following episode. Label/nextEpisode are cleared and
    // reconciled by the server refetch (~1s).
    const replacement: WatchNextItemDto = {
      ...it,
      episode: { ...it.nextEpisode, watched: false },
      nextEpisode: null,
      remainingUnwatched: Math.max(0, (it.remainingUnwatched ?? 1) - 1),
      label: undefined,
    };
    withoutIt = items.slice();
    withoutIt[idx] = replacement;
  } else {
    // Last unwatched episode → the show is finished; drop the Watch-Next card.
    withoutIt = items.filter((x) => x.episode?.id !== episodeId);
  }

  // History items are returned latest-first by the server and the view reverses them, so
  // prepending keeps the newly-watched episode at the bottom of the History section.
  const isHistory = (x: WatchNextItemDto) => x.bucket === WatchNextBucket.HISTORY;
  const firstHistoryIdx = withoutIt.findIndex(isHistory);
  if (firstHistoryIdx === -1) {
    // No history yet (or all non-history) — place it at the very front.
    return [historyItem, ...withoutIt];
  }
  return [...withoutIt.slice(0, firstHistoryIdx), historyItem, ...withoutIt.slice(firstHistoryIdx)];
}

function applyUnwatch(items: WatchNextItemDto[], episodeId: string): WatchNextItemDto[] {
  const histIdx = items.findIndex((it) => it.bucket === WatchNextBucket.HISTORY && it.episode?.id === episodeId);
  if (histIdx === -1) return items; // not in history cache — nothing to optimistically undo
  const hist = items[histIdx];
  const unwatched = hist.episode;

  const withoutHistory = items.filter((_, i) => i !== histIdx);

  // The show's existing non-History card (WATCH_NEXT / NOT_RECENTLY / START_WATCHING), if any.
  const cardIdx = withoutHistory.findIndex(
    (it) => it.bucket !== WatchNextBucket.HISTORY && it.showId === hist.showId,
  );

  if (cardIdx !== -1) {
    // Replace its episode in place (keeps the bucket → returns to the section it was in).
    const card = withoutHistory[cardIdx];
    const next: WatchNextItemDto = {
      ...card,
      episode: { ...unwatched, watched: false, watchedAt: null, watchCount: 0 },
      remainingUnwatched: (card.remainingUnwatched ?? 0) + 1,
      label: undefined,
    };
    const out = withoutHistory.slice();
    out[cardIdx] = next;
    return out;
  }

  // No Watch-Next card exists (show was finished) — create one in WATCH_NEXT with +1.
  const created: WatchNextItemDto = {
    showId: hist.showId,
    showTitle: hist.showTitle,
    posterUrl: hist.posterUrl,
    backdropUrl: hist.backdropUrl,
    network: hist.network,
    episode: { ...unwatched, watched: false, watchedAt: null, watchCount: 0 },
    nextEpisode: null,
    remainingUnwatched: 1,
    label: undefined,
    lastWatchedAt: hist.lastWatchedAt,
    bucket: WatchNextBucket.WATCH_NEXT,
    progress: 0,
  };

  // Insert into the WATCH_NEXT group (preserve existing order).
  const firstWatchNextIdx = withoutHistory.findIndex((it) => it.bucket === WatchNextBucket.WATCH_NEXT);
  if (firstWatchNextIdx === -1) return [...withoutHistory, created];
  return [
    ...withoutHistory.slice(0, firstWatchNextIdx),
    created,
    ...withoutHistory.slice(firstWatchNextIdx),
  ];
}

/** Type narrowing helper kept for callers that only need the episode shape. */
export type { EpisodeDto };
