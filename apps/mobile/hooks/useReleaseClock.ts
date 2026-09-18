import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import type { QueryClient } from '@tanstack/react-query';
import { calendarDay, deviceTimeZone } from '@tvwatch/shared';
import { nextReleaseBoundary } from '../lib/release-clock';

const ROOTS = new Set([
  'watchNext',
  'upcoming',
  'show',
  'showEpisodes',
  'episode',
  'episodeSiblings',
  'showsByStatus',
  'watchlist',
  'movie',
  'movies',
]);

/** Refresh at date/broadcast transitions and after travel, without a polling loop. */
export function useReleaseClock(client: QueryClient): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let due = Infinity;
    let disposed = false;
    const scope = () => deviceTimeZone() + calendarDay(new Date(), deviceTimeZone()).toISOString();
    let lastScope = scope();
    const relevant = (query: { queryKey: readonly unknown[] }) =>
      ROOTS.has(String(query.queryKey[0]));
    const refresh = () => {
      lastScope = scope();
      void client.invalidateQueries({ predicate: relevant });
    };
    const schedule = () => {
      if (disposed) return;
      clearTimeout(timer);
      const now = Date.now();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      due = midnight.getTime();
      for (const query of client.getQueryCache().getAll()) {
        if (!relevant(query)) continue;
        const boundary = nextReleaseBoundary(query.state.data, now);
        if (boundary !== null) due = Math.min(due, boundary);
      }
      timer = setTimeout(
        () => {
          refresh();
          schedule();
        },
        Math.max(1, due - now + 25),
      );
    };
    const resume = () => {
      if (scope() !== lastScope || Date.now() >= due) refresh();
      schedule();
    };
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'success' && relevant(event.query))
        schedule();
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
    });
    // React Native defines window = globalThis, without browser focus events.
    // Native foreground transitions are already handled by AppState above.
    const browserWindow =
      Platform.OS === 'web' &&
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function' &&
      typeof window.removeEventListener === 'function'
        ? window
        : null;
    browserWindow?.addEventListener('focus', resume);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      appState.remove();
      browserWindow?.removeEventListener('focus', resume);
    };
  }, [client]);
}
