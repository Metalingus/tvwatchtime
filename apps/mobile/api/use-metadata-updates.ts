import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { hasPendingMetadata } from './metadata-refresh';

const POLL_MS = 2000;
const MAX_POLL_MS = 90000;

/** Poll only our pending background task; retain cached content throughout. */
export function useMetadataUpdates<
  T extends {
    data: unknown;
    dataUpdatedAt: number;
    refetch: () => Promise<unknown>;
  },
>(query: T, key: string): T {
  const qc = useQueryClient();
  const previous = useRef({ key, pending: false });
  const window = useRef({ key, startedAt: 0 });
  if (window.current.key !== key) window.current = { key, startedAt: 0 };
  const pending = hasPendingMetadata(query.data);
  useEffect(() => {
    if (previous.current.key === key && previous.current.pending && !pending) {
      void qc.invalidateQueries({
        predicate: (entry) => ['upcoming', 'showsByStatus'].includes(String(entry.queryKey[0])),
      });
    }
    previous.current = { key, pending };
  }, [key, pending, qc]);

  useEffect(() => {
    if (!pending) {
      window.current.startedAt = 0;
      return;
    }
    if (!window.current.startedAt) window.current.startedAt = Date.now();
    if (Date.now() - window.current.startedAt >= MAX_POLL_MS) return;
    const timer = setTimeout(() => {
      if (AppState.currentState === 'background') return;
      void query.refetch().catch(() => undefined);
    }, POLL_MS);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - window.current.startedAt < MAX_POLL_MS) {
        void query.refetch().catch(() => undefined);
      }
    });
    return () => {
      clearTimeout(timer);
      listener.remove();
    };
  }, [key, pending, query.dataUpdatedAt, query.refetch]);
  return query;
}
