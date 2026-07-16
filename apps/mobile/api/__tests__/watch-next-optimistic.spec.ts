import { EpisodeLabel, WatchNextBucket } from '@tvwatch/shared';
import type { EpisodeDto, WatchNextItemDto } from '@tvwatch/shared';
import { applyWatchStateToItems } from '../watch-next-optimistic';

// Pure-logic tests (no React Native imports) so this runs under the mobile Jest config.
// Mirrors the optimistic transform wired into useMarkEpisodeWatched.

const PAST = new Date(Date.now() - 7 * 86400000).toISOString(); // a week ago → AIRED

function ep(id: string, extra: Partial<EpisodeDto> = {}): EpisodeDto {
  return {
    id,
    seasonId: 'season-1',
    seasonNumber: 1,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `Ep ${id}`,
    watched: false,
    // Default to an aired episode (mirrors the backend: watch-next eps are always aired).
    airDate: PAST,
    ...extra,
  };
}

function item(partial: Partial<WatchNextItemDto> & { showId: string }): WatchNextItemDto {
  return {
    showTitle: partial.showTitle ?? 'Show',
    episode: partial.episode ?? ep('e1'),
    remainingUnwatched: partial.remainingUnwatched ?? 1,
    bucket: partial.bucket ?? WatchNextBucket.WATCH_NEXT,
    progress: partial.progress ?? 0,
    ...partial,
  } as WatchNextItemDto;
}

describe('applyWatchStateToItems', () => {
  describe('mark watched (on: true)', () => {
    it('swaps the Watch-Next card to nextEpisode, decrements +N, and moves the episode to History', () => {
      const items = [
        item({
          showId: 's1',
          episode: ep('e1'),
          nextEpisode: ep('e2'),
          remainingUnwatched: 3,
          bucket: WatchNextBucket.WATCH_NEXT,
          progress: 0.5,
        }),
      ];
      const out = applyWatchStateToItems(items, 'e1', true);

      // One history row (the just-watched episode) + the swapped watch-next card.
      expect(out).toHaveLength(2);
      const [hist, card] = out;

      expect(hist.bucket).toBe(WatchNextBucket.HISTORY);
      expect(hist.episode.id).toBe('e1');
      expect(hist.episode.watched).toBe(true);
      expect(hist.episode.watchCount).toBe(1);
      expect(hist.remainingUnwatched).toBe(0);
      expect(hist.lastWatchedAt).toBeTruthy();
      // History rows are always AIRED (mirrors the backend's recentlyWatchedEpisodes()).
      expect(hist.label).toBe(EpisodeLabel.AIRED);

      expect(card.bucket).toBe(WatchNextBucket.WATCH_NEXT);
      expect(card.episode.id).toBe('e2');
      expect(card.episode.watched).toBe(false);
      expect(card.remainingUnwatched).toBe(2);
      expect(card.nextEpisode).toBeNull();
      // nextEpisode is aired → AIRED optimistically (matches the server reconcile).
      expect(card.label).toBe(EpisodeLabel.AIRED);
    });

    it('shows the FINALE label on the swapped card when nextEpisode is a finale', () => {
      const items = [
        item({
          showId: 's1',
          episode: ep('e25'),
          nextEpisode: ep('e26', { finale: true }),
          remainingUnwatched: 2,
          bucket: WatchNextBucket.WATCH_NEXT,
        }),
      ];
      const out = applyWatchStateToItems(items, 'e25', true);
      const card = out.find((i) => i.bucket !== WatchNextBucket.HISTORY)!;
      expect(card.episode.id).toBe('e26');
      expect(card.label).toBe(EpisodeLabel.FINALE);
    });

    it('keeps no label when the swapped episode airs today with no known time', () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const items = [
        item({
          showId: 's1',
          episode: ep('e1'),
          nextEpisode: ep('e2', { airDate: today.toISOString() }), // no airTime → not AIRED today
          remainingUnwatched: 3,
          bucket: WatchNextBucket.WATCH_NEXT,
        }),
      ];
      const out = applyWatchStateToItems(items, 'e1', true);
      const card = out.find((i) => i.bucket !== WatchNextBucket.HISTORY)!;
      expect(card.label).toBeUndefined();
    });

    it('marks the history row AIRED even when the watched episode was a finale', () => {
      const items = [
        item({
          showId: 's1',
          episode: ep('e26', { finale: true }),
          nextEpisode: null,
          remainingUnwatched: 1,
          bucket: WatchNextBucket.WATCH_NEXT,
        }),
      ];
      const out = applyWatchStateToItems(items, 'e26', true);
      expect(out).toHaveLength(1);
      expect(out[0].bucket).toBe(WatchNextBucket.HISTORY);
      expect(out[0].label).toBe(EpisodeLabel.AIRED);
    });

    it('places the newly-watched episode at the front of History (latest-first → bottom after view reverse)', () => {
      const items = [
        item({ showId: 's1', episode: ep('h1'), bucket: WatchNextBucket.HISTORY }),
        item({
          showId: 's2',
          episode: ep('e1'),
          nextEpisode: ep('e2'),
          remainingUnwatched: 2,
          bucket: WatchNextBucket.WATCH_NEXT,
        }),
      ];
      const out = applyWatchStateToItems(items, 'e1', true);
      const historyRows = out.filter((i) => i.bucket === WatchNextBucket.HISTORY);
      expect(historyRows.map((i) => i.episode.id)).toEqual(['e1', 'h1']);
    });

    it('leaves the array unchanged when the episode is not in the watch-next cache', () => {
      const items = [
        item({ showId: 's1', episode: ep('e1'), nextEpisode: ep('e2'), remainingUnwatched: 2 }),
      ];
      expect(applyWatchStateToItems(items, 'missing', true)).toBe(items);
    });
  });

  describe('unwatch (on: false)', () => {
    it('returns the episode to the show card (keeping its bucket), increments +N, and never duplicates', () => {
      const items = [
        item({ showId: 's1', episode: ep('e1', { watched: true }), bucket: WatchNextBucket.HISTORY, remainingUnwatched: 0 }),
        item({ showId: 's1', episode: ep('e2'), bucket: WatchNextBucket.WATCH_NEXT, remainingUnwatched: 3 }),
      ];
      const out = applyWatchStateToItems(items, 'e1', false);

      // No duplicate card for the show, history entry removed.
      expect(out).toHaveLength(1);
      expect(out.filter((i) => i.bucket === WatchNextBucket.HISTORY)).toHaveLength(0);

      const card = out[0];
      expect(card.bucket).toBe(WatchNextBucket.WATCH_NEXT);
      expect(card.episode.id).toBe('e1');
      expect(card.episode.watched).toBe(false);
      expect(card.remainingUnwatched).toBe(4);
      // Returned episode was watched → aired → AIRED (matches the server).
      expect(card.label).toBe(EpisodeLabel.AIRED);
    });

    it('shows the FINALE label when the unwatched episode is a finale', () => {
      const items = [
        item({ showId: 's1', episode: ep('e26', { finale: true, watched: true }), bucket: WatchNextBucket.HISTORY, remainingUnwatched: 0 }),
        item({ showId: 's1', episode: ep('e27'), bucket: WatchNextBucket.WATCH_NEXT, remainingUnwatched: 2 }),
      ];
      const out = applyWatchStateToItems(items, 'e26', false);
      expect(out).toHaveLength(1);
      expect(out[0].episode.id).toBe('e26');
      expect(out[0].label).toBe(EpisodeLabel.FINALE);
    });

    it('keeps the original bucket (e.g. NOT_RECENTLY) when returning the episode', () => {
      const items = [
        item({ showId: 's1', episode: ep('e1', { watched: true }), bucket: WatchNextBucket.HISTORY, remainingUnwatched: 0 }),
        item({ showId: 's1', episode: ep('e2'), bucket: WatchNextBucket.NOT_RECENTLY, remainingUnwatched: 2 }),
      ];
      const out = applyWatchStateToItems(items, 'e1', false);
      expect(out).toHaveLength(1);
      expect(out[0].bucket).toBe(WatchNextBucket.NOT_RECENTLY);
      expect(out[0].episode.id).toBe('e1');
      expect(out[0].remainingUnwatched).toBe(3);
    });

    it('creates a new WATCH_NEXT card (FINALE label for a finale) when the show had no watch-next card', () => {
      const items = [
        item({ showId: 's1', episode: ep('e26', { finale: true, watched: true }), bucket: WatchNextBucket.HISTORY, remainingUnwatched: 0 }),
      ];
      const out = applyWatchStateToItems(items, 'e26', false);
      expect(out).toHaveLength(1);
      expect(out[0].bucket).toBe(WatchNextBucket.WATCH_NEXT);
      expect(out[0].episode.id).toBe('e26');
      expect(out[0].episode.watched).toBe(false);
      expect(out[0].remainingUnwatched).toBe(1);
      expect(out[0].label).toBe(EpisodeLabel.FINALE);
    });

    it('leaves the array unchanged when the episode is not in History', () => {
      const items = [item({ showId: 's1', episode: ep('e1'), bucket: WatchNextBucket.WATCH_NEXT })];
      expect(applyWatchStateToItems(items, 'e1', false)).toBe(items);
    });
  });
});
