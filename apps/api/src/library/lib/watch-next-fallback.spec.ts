import { WatchNextBucket } from '@tvwatch/shared';
import { mostRecentlyWatchedFirst, promoteWatchNextFallback } from './watch-next-fallback';

const card = (id: number, lastWatchedAt: string | null) => ({
  id,
  lastWatchedAt: lastWatchedAt ? new Date(lastWatchedAt) : null,
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

    const result = promoteWatchNextFallback([], stale, [], () => 0);

    expect(result.watchNext.map((item) => item.id)).toEqual([6, 5, 4, 3, 2]);
    expect(result.watchNext.every((item) => item.bucket === WatchNextBucket.WATCH_NEXT)).toBe(true);
    expect(result.notRecently.map((item) => item.id)).toEqual([1]);
    expect(result.recentlyAdded).toEqual([]);
  });

  it('fills fewer than five watched candidates from the most recently added pool', () => {
    const stale = [card(1, '2026-01-01'), card(3, '2026-03-01'), card(2, '2026-02-01')];
    const added = [4, 5, 6].map((id) => ({
      ...card(id, '2026-01-01'),
      lastWatchedAt: null,
      bucket: WatchNextBucket.START_WATCHING,
    }));
    const addedAt = new Map([
      [4, new Date('2026-07-01')],
      [5, new Date('2026-07-02')],
      [6, new Date('2026-07-03')],
    ]);
    const result = promoteWatchNextFallback(
      [],
      stale,
      added,
      (a, b) => addedAt.get(b.id)!.getTime() - addedAt.get(a.id)!.getTime(),
    );

    expect(result.watchNext.map((item) => item.id)).toEqual([3, 2, 1, 6, 5]);
    expect(result.notRecently).toEqual([]);
    expect(result.recentlyAdded.map((item) => item.id)).toEqual([4]);
  });

  it('does not promote stale shows while the primary Watch Next bucket has content', () => {
    const current = { ...card(9, '2026-08-01'), bucket: WatchNextBucket.WATCH_NEXT };
    const stale = [card(1, '2026-01-01')];

    const added = [{ ...card(2, '2026-02-01'), bucket: WatchNextBucket.START_WATCHING }];
    const result = promoteWatchNextFallback([current], stale, added, () => 0);

    expect(result).toEqual({ watchNext: [current], notRecently: stale, recentlyAdded: added });
  });
});
