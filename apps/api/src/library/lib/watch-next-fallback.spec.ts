import { WatchNextBucket } from '@tvwatch/shared';
import { mostRecentlyWatchedFirst, promoteWatchNextFallback } from './watch-next-fallback';

const card = (id: number, lastWatchedAt: string) => ({
  id,
  lastWatchedAt: new Date(lastWatchedAt),
  bucket: WatchNextBucket.NOT_RECENTLY,
});

describe('promoteWatchNextFallback', () => {
  it('orders shows strictly by the most recent watch, with missing dates last', () => {
    const items = [
      card(1, '2026-01-01'),
      { ...card(2, '2026-02-01'), lastWatchedAt: null },
      card(3, '2026-03-01'),
    ];

    expect(items.sort(mostRecentlyWatchedFirst).map((item) => item.id)).toEqual([3, 1, 2]);
  });

  it('promotes the five most recently watched eligible shows when Watch Next is empty', () => {
    const stale = [
      card(1, '2026-01-01'),
      card(6, '2026-06-01'),
      card(3, '2026-03-01'),
      card(5, '2026-05-01'),
      card(2, '2026-02-01'),
      card(4, '2026-04-01'),
    ];

    const result = promoteWatchNextFallback([], stale);

    expect(result.watchNext.map((item) => item.id)).toEqual([6, 5, 4, 3, 2]);
    expect(result.watchNext.every((item) => item.bucket === WatchNextBucket.WATCH_NEXT)).toBe(true);
    expect(result.notRecently.map((item) => item.id)).toEqual([1]);
  });

  it('does not promote stale shows while the primary Watch Next bucket has content', () => {
    const current = { ...card(9, '2026-08-01'), bucket: WatchNextBucket.WATCH_NEXT };
    const stale = [card(1, '2026-01-01')];

    const result = promoteWatchNextFallback([current], stale);

    expect(result).toEqual({ watchNext: [current], notRecently: stale });
  });
});
