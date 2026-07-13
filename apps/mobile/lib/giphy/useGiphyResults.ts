import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GIPHY_DEBOUNCE_MS,
  GIPHY_PAGE_LIMIT,
  GiphyError,
  fetchSearch,
  fetchTrending,
  type GiphyGif,
} from './client';

export type GiphyStatus = 'idle' | 'loading' | 'loadingMore' | 'ready' | 'empty' | 'error';

export interface UseGiphyResults {
  items: GiphyGif[];
  status: GiphyStatus;
  errorKind: 'config' | 'invalid-key' | 'rate-limit' | 'network' | null;
  hasMore: boolean;
  /** Whether the current query is a search (vs trending). */
  isSearch: boolean;
  loadMore: () => void;
  reload: () => void;
}

/**
 * Drives the GIF picker data: trending when the query is empty, debounced
 * search otherwise. Stale responses cannot overwrite newer results, and
 * pagination appends results in the order GIPHY returns them.
 */
export function useGiphyResults(query: string, lang: string, enabled: boolean): UseGiphyResults {
  const [items, setItems] = useState<GiphyGif[]>([]);
  const [status, setStatus] = useState<GiphyStatus>('idle');
  const [errorKind, setErrorKind] = useState<UseGiphyResults['errorKind']>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isSearch, setIsSearch] = useState(false);

  const offsetRef = useRef(0);
  const totalRef = useRef(0);
  const reqToken = useRef(0);
  const loadingMoreRef = useRef(false);

  const trimmed = query.trim();
  const wantSearch = trimmed.length > 0;

  // Initial / query-change load (debounced for search, immediate for trending).
  useEffect(() => {
    if (!enabled) return;
    reqToken.current += 1;
    const token = reqToken.current;

    const run = async () => {
      setStatus('loading');
      setErrorKind(null);
      offsetRef.current = 0;
      totalRef.current = 0;
      try {
        const page = wantSearch
          ? await fetchSearch({ q: trimmed, offset: 0, lang })
          : await fetchTrending({ offset: 0, lang });
        // Ignore stale results if the query changed while in flight.
        if (token !== reqToken.current) return;
        setIsSearch(wantSearch);
        setItems(page.items);
        totalRef.current = page.totalCount;
        offsetRef.current = page.items.length;
        setHasMore(page.items.length > 0 && page.items.length < page.totalCount);
        setStatus(page.items.length === 0 ? 'empty' : 'ready');
      } catch (e) {
        if (token !== reqToken.current) return;
        setItems([]);
        setHasMore(false);
        setStatus('error');
        setErrorKind(e instanceof GiphyError ? e.kind : 'network');
      }
    };

    if (!wantSearch) {
      run();
      return;
    }
    // Debounce search input.
    const handle = setTimeout(run, GIPHY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, wantSearch, lang, enabled]);

  const loadMore = useCallback(() => {
    if (!enabled || loadingMoreRef.current) return;
    if (!hasMore) return;
    if (status !== 'ready' && status !== 'loadingMore') return;
    loadingMoreRef.current = true;
    const token = reqToken.current;
    const before = items;
    setStatus('loadingMore');
    (async () => {
      try {
        const page = wantSearch
          ? await fetchSearch({ q: trimmed, offset: offsetRef.current, lang })
          : await fetchTrending({ offset: offsetRef.current, lang });
        if (token !== reqToken.current) return;
        setItems([...before, ...page.items]);
        offsetRef.current += page.items.length;
        totalRef.current = page.totalCount;
        setHasMore(offsetRef.current < page.totalCount);
        setStatus(before.length + page.items.length === 0 ? 'empty' : 'ready');
      } catch (e) {
        if (token !== reqToken.current) return;
        setStatus('ready');
        setErrorKind(e instanceof GiphyError ? e.kind : 'network');
      } finally {
        loadingMoreRef.current = false;
      }
    })();
  }, [enabled, hasMore, status, items, wantSearch, trimmed, lang]);

  const reload = useCallback(() => {
    // Bump the token to invalidate any in-flight request and re-run the effect.
    reqToken.current += 1;
    setStatus('loading');
    setErrorKind(null);
    offsetRef.current = 0;
    totalRef.current = 0;
    const token = reqToken.current;
    (async () => {
      try {
        const page = wantSearch
          ? await fetchSearch({ q: trimmed, offset: 0, lang })
          : await fetchTrending({ offset: 0, lang });
        if (token !== reqToken.current) return;
        setIsSearch(wantSearch);
        setItems(page.items);
        totalRef.current = page.totalCount;
        offsetRef.current = page.items.length;
        setHasMore(page.items.length > 0 && page.items.length < page.totalCount);
        setStatus(page.items.length === 0 ? 'empty' : 'ready');
      } catch (e) {
        if (token !== reqToken.current) return;
        setItems([]);
        setHasMore(false);
        setStatus('error');
        setErrorKind(e instanceof GiphyError ? e.kind : 'network');
      }
    })();
  }, [wantSearch, trimmed, lang]);

  return { items, status, errorKind, hasMore, isSearch, loadMore, reload };
}
