import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  InteractionManager,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { MediaType, type LibraryFilters } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { PosterCard } from '../../components/cards';
import { LibraryEmptyState } from '../../components/LibraryEmptyState';
import { EmptyState, Screen, Spinner, T } from '../../components/primitives';
import { useFavoritePages, useWatchedMoviePages, useWatchlistPages } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing } from '../../theme/theme';
import { useContentWidth } from '../../hooks/useContentWidth';
import { LibraryFilterBar } from '../../components/LibraryFilterBar';

interface MovieItem {
  id: string;
  title: string;
  posterUrl?: string | null;
  progress?: number;
  watched?: boolean;
  rating?: number | null;
  year?: number | null;
}
type SectionKey = 'watchlist' | 'watched' | 'favorites';

interface FlatRow {
  type: 'header' | 'empty' | 'cards' | 'more';
  key: string;
  title?: string;
  count?: number;
  section?: SectionKey;
  message?: string;
  cards?: MovieItem[];
  /** First cards row of a section — gets breathing room under the header separator. */
  underHeader?: boolean;
  loading?: boolean;
  failed?: boolean;
}

/** Hoisted so the memoized PosterCard sees a stable style reference. */
const GRID_CARD_STYLE = { marginRight: 0 } as const;
const MOVIE_PAGE_SIZE = 24;

export default function MoviesScreen() {
  const width = useContentWidth();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['movies', 'common']);
  const [filters, setFilters] = useState<LibraryFilters>({ sort: 'addedDate' });
  // First pages load in parallel; additional pages are fetched only when the user
  // expands a section and taps See more.
  const watchlist = useWatchlistPages(MediaType.MOVIE, null, true, true, MOVIE_PAGE_SIZE, filters);
  const watched = useWatchedMoviePages(true, MOVIE_PAGE_SIZE, filters);
  const favorites = useFavoritePages(MediaType.MOVIE, null, true, MOVIE_PAGE_SIZE, filters);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([watchlist.refetch(), watched.refetch(), favorites.refetch()]);
    setRefreshing(false);
  }, [watchlist, watched, favorites]);
  // Expanded defaults are data-driven (set once the collections finish loading):
  // sections with fewer than 9 items start open, larger ones start collapsed.
  // User toggles win afterwards.
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean> | null>(null);

  const containerW = width - 32;
  const gap = 8;
  const cols = Math.max(3, Math.floor((containerW + gap) / (110 + gap))); // same density as My Shows see-all
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);

  const watchedItems: MovieItem[] = useMemo(() => {
    return watched.items.map((movie) => ({ ...movie }));
  }, [watched.items]);

  const watchlistItems: MovieItem[] = useMemo(
    () =>
      watchlist.items.map((m: any) => ({
        id: m.id,
        title: m.title,
        posterUrl: m.images?.poster ?? m.posterUrl,
        rating: m.rating ?? null,
        year: m.year ?? null,
      })),
    [watchlist.items],
  );

  const favoriteItems: MovieItem[] = useMemo(
    () =>
      favorites.items.map((m: any) => {
        const isWatched = !!m.watched;
        return {
          id: m.id,
          title: m.title,
          posterUrl: m.images?.poster ?? m.posterUrl,
          watched: isWatched,
          progress: isWatched ? 1 : undefined,
          rating: m.rating ?? null,
          year: m.year ?? null,
        };
      }),
    [favorites.items],
  );

  const sections = useMemo(
    () => [
      {
        key: 'watchlist' as SectionKey,
        title: t('movies:watchlist'),
        empty: t('movies:watchlistEmpty'),
        items: watchlistItems,
        total: watchlist.total,
        hasNextPage: !!watchlist.hasNextPage,
        loading: watchlist.isFetchingNextPage,
        failed: watchlist.isFetchNextPageError,
      },
      {
        key: 'watched' as SectionKey,
        title: t('movies:watched'),
        empty: t('movies:watchedEmpty'),
        items: watchedItems,
        total: watched.total,
        hasNextPage: !!watched.hasNextPage,
        loading: watched.isFetchingNextPage,
        failed: watched.isFetchNextPageError,
      },
      {
        key: 'favorites' as SectionKey,
        title: t('movies:favorites'),
        empty: t('movies:favoritesEmpty'),
        items: favoriteItems,
        total: favorites.total,
        hasNextPage: !!favorites.hasNextPage,
        loading: favorites.isFetchingNextPage,
        failed: favorites.isFetchNextPageError,
      },
    ],
    [
      t,
      watchlistItems,
      watchlist.total,
      watchlist.hasNextPage,
      watchlist.isFetchingNextPage,
      watchlist.isFetchNextPageError,
      watchedItems,
      watched.total,
      watched.hasNextPage,
      watched.isFetchingNextPage,
      watched.isFetchNextPageError,
      favoriteItems,
      favorites.total,
      favorites.hasNextPage,
      favorites.isFetchingNextPage,
      favorites.isFetchNextPageError,
    ],
  );

  const collectionsLoaded = !!watchlist.data && !!watched.data && !!favorites.data;
  useEffect(() => {
    if (expanded || !collectionsLoaded) return;
    setExpanded({
      // The first section always starts open; the rest follow the <9 rule.
      watchlist: true,
      watched: watched.total < 9,
      favorites: favorites.total < 9,
    });
    // The three item lists derive from the same fully-loaded queries — read at set time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, collectionsLoaded]);

  const { rows, stickyIndices } = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const s of sections) {
      rows.push({
        type: 'header',
        key: `h_${s.key}`,
        title: s.title,
        count: s.total,
        section: s.key,
      });
      if (expanded?.[s.key]) {
        if (s.items.length === 0) {
          rows.push({ type: 'empty', key: `e_${s.key}`, message: s.empty });
        } else {
          for (let i = 0; i < s.items.length; i += cols) {
            const slice = s.items.slice(i, i + cols);
            rows.push({
              type: 'cards',
              key: `r_${s.key}_${slice[0]?.id ?? i}_${i}`,
              cards: slice,
              underHeader: i === 0,
            });
          }
          if (s.hasNextPage) {
            rows.push({
              type: 'more',
              // A newly appended page gets a new footer instance. Reusing the
              // same key while moving it dozens of rows confused VirtualizedList.
              key: `m_${s.key}_${s.items.length}`,
              section: s.key,
              loading: s.loading,
              failed: s.failed,
            });
          }
        }
      }
    }
    const stickyIndices: number[] = [];
    rows.forEach((r, i) => {
      if (r.type === 'header') stickyIndices.push(i);
    });
    return { rows, stickyIndices };
  }, [sections, expanded, cols]);

  // Warm the disk cache for posters just below the viewport as pages append —
  // otherwise each newly mounted row triggers a network fetch +
  // decode on first scroll-past (the visible freeze/pop-in).
  // Deferred + capped: on a cold start with restored cache this fired for EVERY
  // library poster on the same frames the visible images were loading, starving
  // them behind hundreds of prefetch jobs (the multi-second blank posters).
  const posterUrls = useMemo(
    () =>
      [watchlistItems, watchedItems, favoriteItems]
        .flat()
        .map((m) => m.posterUrl)
        .filter((u): u is string => !!u),
    [watchlistItems, watchedItems, favoriteItems],
  );
  const prefetchedPosters = useRef(new Set<string>());
  useEffect(() => {
    const urls = posterUrls
      .filter((url) => !prefetchedPosters.current.has(url))
      .slice(0, MOVIE_PAGE_SIZE);
    if (!urls.length) return;
    urls.forEach((url) => prefetchedPosters.current.add(url));
    const task = InteractionManager.runAfterInteractions(() => {
      Image.prefetch(urls).catch(() => undefined);
    });
    return () => task.cancel();
  }, [posterUrls]);

  const noData =
    watchlist.items.length === 0 && watched.items.length === 0 && favorites.items.length === 0;
  const initialLoading =
    noData && (watchlist.isPending || watched.isPending || favorites.isPending);
  const filtersActive =
    (filters.genres?.length ?? 0) > 0 ||
    (filters.excludeGenres?.length ?? 0) > 0 ||
    (filters.tags?.length ?? 0) > 0 ||
    !!filters.country ||
    (filters.sort ?? 'addedDate') !== 'addedDate';
  const libraryEmpty = collectionsLoaded && noData && !filtersActive;

  const listRef = useRef<FlatList<FlatRow>>(null);
  const scrollOffset = useRef(0);
  const fetchGate = useRef<Partial<Record<SectionKey, boolean>>>({});
  const pendingAppend = useRef<{
    section: SectionKey;
    itemCount: number;
    offset: number;
    userMoved: boolean;
  } | null>(null);
  const watchlistFetchNextPage = watchlist.fetchNextPage;
  const watchedFetchNextPage = watched.fetchNextPage;
  const favoritesFetchNextPage = favorites.fetchNextPage;

  const loadMore = useCallback(
    (section: SectionKey) => {
      const isFetching =
        section === 'watchlist'
          ? watchlist.isFetchingNextPage
          : section === 'watched'
            ? watched.isFetchingNextPage
            : favorites.isFetchingNextPage;
      const hasNextPage =
        section === 'watchlist'
          ? watchlist.hasNextPage
          : section === 'watched'
            ? watched.hasNextPage
            : favorites.hasNextPage;
      if (fetchGate.current[section] || isFetching || !hasNextPage) return;

      fetchGate.current[section] = true;
      pendingAppend.current = {
        section,
        itemCount:
          section === 'watchlist'
            ? watchlistItems.length
            : section === 'watched'
              ? watchedItems.length
              : favoriteItems.length,
        offset: scrollOffset.current,
        userMoved: false,
      };
      const fetchNextPage =
        section === 'watchlist'
          ? watchlistFetchNextPage
          : section === 'watched'
            ? watchedFetchNextPage
            : favoritesFetchNextPage;
      void fetchNextPage({ cancelRefetch: false }).finally(() => {
        fetchGate.current[section] = false;
      });
    },
    [
      watchlist.isFetchingNextPage,
      watchlist.hasNextPage,
      watched.isFetchingNextPage,
      watched.hasNextPage,
      favorites.isFetchingNextPage,
      favorites.hasNextPage,
      watchlistFetchNextPage,
      watchedFetchNextPage,
      favoritesFetchNextPage,
      watchlistItems.length,
      watchedItems.length,
      favoriteItems.length,
    ],
  );

  // react-native-web does not implement maintainVisibleContentPosition. Restore
  // the exact anchor after an append unless the user deliberately scrolled while
  // the request was running.
  useEffect(() => {
    const pending = pendingAppend.current;
    if (!pending) return;
    const nextCount =
      pending.section === 'watchlist'
        ? watchlistItems.length
        : pending.section === 'watched'
          ? watchedItems.length
          : favoriteItems.length;
    if (nextCount <= pending.itemCount) return;
    pendingAppend.current = null;
    if (Platform.OS !== 'web' || pending.userMoved) return;
    requestAnimationFrame(() => {
      scrollOffset.current = pending.offset;
      listRef.current?.scrollToOffset({ offset: pending.offset, animated: false });
    });
  }, [watchlistItems.length, watchedItems.length, favoriteItems.length]);

  const onScroll = useCallback((event: any) => {
    const next = event.nativeEvent.contentOffset.y;
    const pending = pendingAppend.current;
    if (pending && Math.abs(next - pending.offset) > 32) pending.userMoved = true;
    scrollOffset.current = next;
  }, []);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: any[] }) => {
    for (const token of viewableItems) {
      const row = token.item as FlatRow | undefined;
      if (token.isViewable && row?.type === 'more' && row.section && !row.failed) {
        loadMoreRef.current(row.section);
      }
    }
  }).current;
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 10,
    minimumViewTime: 150,
  }).current;

  const renderItem = useCallback(
    ({ item }: { item: FlatRow }) => {
      if (item.type === 'header') {
        const sec = item.section!;
        const open = expanded?.[sec] ?? false;
        return (
          <Pressable
            style={[
              styles.header,
              { backgroundColor: tokens.background, borderBottomColor: tokens.divider },
            ]}
            onPress={() => setExpanded((e) => (e ? { ...e, [sec]: !e[sec] } : e))}
          >
            <View style={{ flex: 1 }}>
              <View style={styles.headerLeft}>
                <T variant="h1">{item.title}</T>
                <View style={[styles.pill, { backgroundColor: tokens.chip }]}>
                  <T variant="micro" style={{ color: tokens.primary }}>
                    {item.count}
                  </T>
                </View>
              </View>
            </View>
            <Ionicons
              name={open ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={tokens.textMuted}
            />
          </Pressable>
        );
      }
      if (item.type === 'empty') {
        return (
          <View style={styles.emptyWrap}>
            <EmptyState title={item.message!} icon="film-outline" />
          </View>
        );
      }
      if (item.type === 'more') {
        if (item.failed) {
          return (
            <Pressable
              onPress={() => loadMore(item.section!)}
              style={styles.more}
              accessibilityRole="button"
              hitSlop={8}
            >
              <T variant="caption" style={{ color: tokens.primary }}>
                {t('common:retry')}
              </T>
            </Pressable>
          );
        }
        return (
          <View style={styles.more} accessibilityRole="progressbar">
            <View style={styles.moreContent}>
              <ActivityIndicator size="small" color={tokens.primary} />
              <T variant="caption" style={{ color: tokens.primary }}>
                {t('common:loading')}
              </T>
            </View>
          </View>
        );
      }
      const cards = item.cards!;
      const fillCount = cols - cards.length;
      return (
        <View style={[styles.cardRow, item.underHeader ? { marginTop: gap } : null]}>
          {cards.map((it) => (
            <View key={it.id} style={{ width: cellW, marginBottom: gap }}>
              <PosterCard
                id={it.id}
                kind="movies"
                title={it.title}
                poster={it.posterUrl}
                progress={it.progress}
                rating={it.rating}
                year={it.year}
                width={cellW}
                style={GRID_CARD_STYLE}
              />
            </View>
          ))}
          {Array.from({ length: fillCount }).map((_, i) => (
            <View key={'pad_' + i} style={{ width: cellW }} />
          ))}
        </View>
      );
    },
    [expanded, tokens, cols, cellW, loadMore, t],
  );

  if (initialLoading) {
    return (
      <Screen>
        <Header title={t('movies:title')} />
        <Spinner />
      </Screen>
    );
  }

  if (libraryEmpty) {
    return (
      <Screen>
        <Header title={t('movies:title')} />
        <LibraryEmptyState kind="movies" refreshing={refreshing} onRefresh={onRefresh} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={t('movies:title')} />
      <LibraryFilterBar value={filters} onChange={setFilters} />
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(item) => item.key}
        stickyHeaderIndices={stickyIndices}
        // Android: clipped subviews make sticky headers vanish mid-scroll and come
        // back without their touch target — keep them mounted.
        removeClippedSubviews={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        renderItem={renderItem}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        }
        windowSize={10}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    // Negative top margin + equal extra padding: content position is unchanged, but
    // the opaque background extends 8px above the cell. When the header sticks, that
    // overhang covers the 1-2px sub-pixel seam between the stuck header and the page
    // Header, where scrolling cards otherwise peek through (Android). The 8px overlap
    // only ever lands on the card rows' empty marginBottom gap, never on cards.
    marginTop: -8,
    paddingTop: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between' },
  emptyWrap: { paddingVertical: 20 },
  more: { alignItems: 'center', paddingVertical: spacing.md },
  moreContent: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
