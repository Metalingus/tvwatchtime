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
import { Header } from '../components/Header';
import { PosterCard, cardYear } from '../components/cards';
import { LibraryEmptyState } from '../components/LibraryEmptyState';
import { EmptyState, Screen, Spinner, T } from '../components/primitives';
import { useShowProgressPages, useShowProgressSummary } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { useContentWidth } from '../hooks/useContentWidth';
import { useTranslation } from 'react-i18next';

interface StatusItem {
  id: string;
  title: string;
  posterUrl?: string | null;
  progress: number;
  rating?: number | null;
}
type SectionKey = 'watching' | 'notStarted' | 'finished' | 'paused' | 'dropped';

interface FlatRow {
  type: 'header' | 'empty' | 'loading' | 'cards' | 'more';
  key: string;
  title?: string;
  count?: number;
  section?: SectionKey;
  message?: string;
  cards?: StatusItem[];
  /** First cards row of a section — gets breathing room under the header separator. */
  underHeader?: boolean;
  loading?: boolean;
  failed?: boolean;
}

/** Hoisted so the memoized PosterCard sees a stable style reference. */
const GRID_CARD_STYLE = { marginRight: 0 } as const;

export default function MyShowsScreen() {
  const width = useContentWidth();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social', 'common']);
  const summary = useShowProgressSummary();
  const [refreshing, setRefreshing] = useState(false);
  // Expanded defaults are data-driven: sections with fewer than 9 items start
  // open, larger ones start collapsed. Set once — user toggles win afterwards.
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean> | null>(null);
  useEffect(() => {
    if (expanded || !summary.data) return;
    setExpanded({
      // The first section always starts open; the rest follow the <9 rule.
      watching: true,
      notStarted: summary.data.notStarted < 9,
      finished: summary.data.finished < 9,
      paused: summary.data.paused < 9,
      dropped: summary.data.dropped !== undefined && summary.data.dropped < 9,
    });
  }, [summary.data, expanded]);

  const watching = useShowProgressPages('watching', expanded?.watching === true);
  const notStarted = useShowProgressPages('notStarted', expanded?.notStarted === true);
  const finished = useShowProgressPages('finished', expanded?.finished === true);
  const paused = useShowProgressPages('paused', expanded?.paused === true);
  const dropped = useShowProgressPages(
    'dropped',
    summary.data?.dropped !== undefined && expanded?.dropped === true,
  );
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const requests: Promise<unknown>[] = [summary.refetch()];
    if (expanded?.watching) requests.push(watching.refetch());
    if (expanded?.notStarted) requests.push(notStarted.refetch());
    if (expanded?.finished) requests.push(finished.refetch());
    if (expanded?.paused) requests.push(paused.refetch());
    if (summary.data?.dropped !== undefined && expanded?.dropped) requests.push(dropped.refetch());
    await Promise.all(requests);
    setRefreshing(false);
  }, [expanded, summary, watching, notStarted, finished, paused, dropped]);

  const pageItems = useCallback((query: typeof watching): StatusItem[] => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flatMap((page) =>
      (page.items ?? []).filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }),
    );
  }, []);
  const watchingItems = useMemo(() => pageItems(watching), [pageItems, watching.data]);
  const notStartedItems = useMemo(() => pageItems(notStarted), [pageItems, notStarted.data]);
  const finishedItems = useMemo(() => pageItems(finished), [pageItems, finished.data]);
  const pausedItems = useMemo(() => pageItems(paused), [pageItems, paused.data]);
  const droppedItems = useMemo(() => pageItems(dropped), [pageItems, dropped.data]);

  const containerW = width - 32; // spacing.lg * 2
  const gap = 8;
  const cols = Math.max(3, Math.floor((containerW + gap) / (110 + gap))); // 3 per row, same as Movies tab
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);

  const defs = useMemo(
    () => [
      {
        key: 'watching' as SectionKey,
        title: t('social:myShows.toWatch'),
        empty: t('social:myShows.toWatchEmpty'),
        items: watchingItems,
        total: summary.data?.watching ?? 0,
        hasNextPage: !!watching.hasNextPage,
        loading: watching.isPending || watching.isFetchingNextPage,
        pageLoading: watching.isFetchingNextPage,
        failed: watching.isFetchNextPageError,
      },
      {
        key: 'notStarted' as SectionKey,
        title: t('social:myShows.notStarted'),
        empty: t('social:myShows.notStartedEmpty'),
        items: notStartedItems,
        total: summary.data?.notStarted ?? 0,
        hasNextPage: !!notStarted.hasNextPage,
        loading: notStarted.isPending || notStarted.isFetchingNextPage,
        pageLoading: notStarted.isFetchingNextPage,
        failed: notStarted.isFetchNextPageError,
      },
      {
        key: 'finished' as SectionKey,
        title: t('social:myShows.finished'),
        empty: t('social:myShows.finishedEmpty'),
        items: finishedItems,
        total: summary.data?.finished ?? 0,
        hasNextPage: !!finished.hasNextPage,
        loading: finished.isPending || finished.isFetchingNextPage,
        pageLoading: finished.isFetchingNextPage,
        failed: finished.isFetchNextPageError,
      },
      {
        key: 'paused' as SectionKey,
        title: t('social:myShows.paused'),
        empty: t('social:myShows.pausedEmpty'),
        items: pausedItems,
        total: summary.data?.paused ?? 0,
        hasNextPage: !!paused.hasNextPage,
        loading: paused.isPending || paused.isFetchingNextPage,
        pageLoading: paused.isFetchingNextPage,
        failed: paused.isFetchNextPageError,
      },
      ...(summary.data?.dropped === undefined
        ? []
        : [
            {
              key: 'dropped' as SectionKey,
              title: t('social:myShows.dropped'),
              empty: t('social:myShows.droppedEmpty'),
              items: droppedItems,
              total: summary.data.dropped,
              hasNextPage: !!dropped.hasNextPage,
              loading: dropped.isPending || dropped.isFetchingNextPage,
              pageLoading: dropped.isFetchingNextPage,
              failed: dropped.isFetchNextPageError,
            },
          ]),
    ],
    [
      t,
      summary.data,
      watchingItems,
      watching.hasNextPage,
      watching.isPending,
      watching.isFetchingNextPage,
      watching.isFetchNextPageError,
      notStartedItems,
      notStarted.hasNextPage,
      notStarted.isPending,
      notStarted.isFetchingNextPage,
      notStarted.isFetchNextPageError,
      finishedItems,
      finished.hasNextPage,
      finished.isPending,
      finished.isFetchingNextPage,
      finished.isFetchNextPageError,
      pausedItems,
      paused.hasNextPage,
      paused.isPending,
      paused.isFetchingNextPage,
      paused.isFetchNextPageError,
      droppedItems,
      dropped.hasNextPage,
      dropped.isPending,
      dropped.isFetchingNextPage,
      dropped.isFetchNextPageError,
    ],
  );

  const { rows, stickyIndices } = useMemo(() => {
    const rows: FlatRow[] = [];
    for (const s of defs) {
      rows.push({
        type: 'header',
        key: `h_${s.key}`,
        title: s.title,
        count: s.total,
        section: s.key,
      });
      if (expanded?.[s.key]) {
        if (s.loading && s.items.length === 0) {
          rows.push({ type: 'loading', key: `l_${s.key}` });
        } else if (s.items.length === 0) {
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
              key: `m_${s.key}_${s.items.length}`,
              section: s.key,
              loading: s.pageLoading,
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
  }, [defs, expanded, cols]);

  // Warm the disk cache for posters below the viewport (see movies.tsx note).
  // Deferred + capped: on a cold start with restored cache, prefetching EVERY
  // library poster on the first frames starved the visible images behind
  // hundreds of prefetch jobs (the multi-second blank posters).
  const posterUrls = useMemo(
    () =>
      [watchingItems, notStartedItems, finishedItems, pausedItems, droppedItems]
        .flat()
        .map((item) => item.posterUrl)
        .filter((url): url is string => !!url),
    [watchingItems, notStartedItems, finishedItems, pausedItems, droppedItems],
  );
  const prefetchedPosters = useRef(new Set<string>());
  useEffect(() => {
    const urls = posterUrls.filter((url) => !prefetchedPosters.current.has(url)).slice(0, 24);
    if (!urls.length) return;
    urls.forEach((url) => prefetchedPosters.current.add(url));
    const task = InteractionManager.runAfterInteractions(() => {
      Image.prefetch(urls).catch(() => undefined);
    });
    return () => task.cancel();
  }, [posterUrls]);

  const listRef = useRef<FlatList<FlatRow>>(null);
  const scrollOffset = useRef(0);
  const fetchGate = useRef<Partial<Record<SectionKey, boolean>>>({});
  const pendingAppend = useRef<{
    section: SectionKey;
    itemCount: number;
    offset: number;
    userMoved: boolean;
  } | null>(null);
  const watchingFetchNextPage = watching.fetchNextPage;
  const notStartedFetchNextPage = notStarted.fetchNextPage;
  const finishedFetchNextPage = finished.fetchNextPage;
  const pausedFetchNextPage = paused.fetchNextPage;
  const droppedFetchNextPage = dropped.fetchNextPage;

  const loadMore = useCallback(
    (section: SectionKey) => {
      const query =
        section === 'watching'
          ? watching
          : section === 'notStarted'
            ? notStarted
            : section === 'finished'
              ? finished
              : section === 'paused'
                ? paused
                : dropped;
      if (fetchGate.current[section] || query.isFetchingNextPage || !query.hasNextPage) return;

      fetchGate.current[section] = true;
      pendingAppend.current = {
        section,
        itemCount:
          section === 'watching'
            ? watchingItems.length
            : section === 'notStarted'
              ? notStartedItems.length
              : section === 'finished'
                ? finishedItems.length
                : section === 'paused'
                  ? pausedItems.length
                  : droppedItems.length,
        offset: scrollOffset.current,
        userMoved: false,
      };
      const fetchNextPage =
        section === 'watching'
          ? watchingFetchNextPage
          : section === 'notStarted'
            ? notStartedFetchNextPage
            : section === 'finished'
              ? finishedFetchNextPage
              : section === 'paused'
                ? pausedFetchNextPage
                : droppedFetchNextPage;
      void fetchNextPage({ cancelRefetch: false }).finally(() => {
        fetchGate.current[section] = false;
      });
    },
    [
      watching,
      notStarted,
      finished,
      paused,
      dropped,
      watchingFetchNextPage,
      notStartedFetchNextPage,
      finishedFetchNextPage,
      pausedFetchNextPage,
      droppedFetchNextPage,
      watchingItems.length,
      notStartedItems.length,
      finishedItems.length,
      pausedItems.length,
      droppedItems.length,
    ],
  );

  useEffect(() => {
    const pending = pendingAppend.current;
    if (!pending) return;
    const nextCount =
      pending.section === 'watching'
        ? watchingItems.length
        : pending.section === 'notStarted'
          ? notStartedItems.length
          : pending.section === 'finished'
            ? finishedItems.length
            : pending.section === 'paused'
              ? pausedItems.length
              : droppedItems.length;
    if (nextCount <= pending.itemCount) return;
    pendingAppend.current = null;
    if (Platform.OS !== 'web' || pending.userMoved) return;
    requestAnimationFrame(() => {
      scrollOffset.current = pending.offset;
      listRef.current?.scrollToOffset({ offset: pending.offset, animated: false });
    });
  }, [
    watchingItems.length,
    notStartedItems.length,
    finishedItems.length,
    pausedItems.length,
    droppedItems.length,
  ]);

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
            <EmptyState title={item.message!} icon="tv-outline" />
          </View>
        );
      }

      if (item.type === 'loading') {
        return (
          <View style={styles.inlineLoading}>
            <ActivityIndicator size="small" color={tokens.primary} />
          </View>
        );
      }

      if (item.type === 'more') {
        if (item.failed) {
          return (
            <Pressable onPress={() => loadMore(item.section!)} style={styles.more}>
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

      // cards row
      const cards = item.cards!;
      const fillCount = cols - cards.length;
      return (
        <View style={[styles.cardRow, item.underHeader ? { marginTop: gap } : null]}>
          {cards.map((it) => (
            <View key={it.id} style={{ width: cellW, marginBottom: gap }}>
              <PosterCard
                id={it.id}
                kind="shows"
                title={it.title}
                poster={it.posterUrl}
                progress={it.progress}
                rating={it.rating}
                year={cardYear(it)}
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

  if (summary.isLoading || !expanded)
    return (
      <Screen>
        <Header title={t('social:myShows.title')} showBack />
        <Spinner />
      </Screen>
    );

  const trackedShowCount =
    (summary.data?.watching ?? 0) +
    (summary.data?.notStarted ?? 0) +
    (summary.data?.finished ?? 0) +
    (summary.data?.paused ?? 0) +
    (summary.data?.dropped ?? 0);
  if (summary.isSuccess && trackedShowCount === 0) {
    return (
      <Screen>
        <Header title={t('social:myShows.title')} showBack />
        <LibraryEmptyState kind="shows" refreshing={refreshing} onRefresh={onRefresh} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={t('social:myShows.title')} showBack />
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
        windowSize={10}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    // See movies.tsx — the overhang covers the sticky-header seam where cards peek
    // through between the stuck header and the page Header.
    marginTop: -8,
    paddingTop: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  emptyWrap: {
    paddingVertical: 20,
  },
  inlineLoading: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  more: {
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  moreContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
