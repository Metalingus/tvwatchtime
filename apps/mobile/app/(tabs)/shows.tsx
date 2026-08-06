import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header, IconButton } from '../../components/Header';
import { EpisodeCard, UpcomingCard } from '../../components/cards';
import { LibraryEmptyState } from '../../components/LibraryEmptyState';
import { Chip, EmptyState, Screen, SectionHeader, Spinner, T } from '../../components/primitives';
import { InfoBanner } from '../../components/InfoBanner';
import {
  useMarkEpisodeWatched,
  usePausedWatchNext,
  useRewatchEpisode,
  useShowProgressSummary,
  useUnwatchEpisodeOnce,
  useUpcoming,
  useUpcomingPast,
  useWatchNext,
  useWatchNextBucket,
  useWatchNextHistory,
  useActiveAnnouncement,
  useUnreadNotificationCount,
} from '../../api/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useDismissableFlag } from '../../hooks/useDismissableFlag';
import { pickLocale, runAnnouncementAction } from '../../lib/announcement';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing } from '../../theme/theme';
import { UpcomingGroupDto, UpcomingPastBucket, WatchNextBucket } from '@tvwatch/shared';

const VALID_ICONS = new Set([
  'information-circle-outline',
  'megaphone-outline',
  'download-outline',
  'notifications-outline',
  'bulb-outline',
  'gift-outline',
  'star-outline',
  'trophy-outline',
  'flame-outline',
  'sparkles-outline',
  'calendar-outline',
  'pricetag-outline',
  'film-outline',
  'tv-outline',
  'list-outline',
  'people-outline',
  'chatbubble-outline',
  'warning-outline',
  'checkmark-circle-outline',
  'rocket-outline',
]);

// Exact row heights power getItemLayout → initialScrollIndex lands on Watch Next
// precisely on mount (even before rows lay out), with zero post-mount programmatic
// scrolling — so marking a show never yanks the viewport, and the tab-reset remount
// (key={resetKey}) re-lands exactly like a fresh open.
const CARD_H = 122; // EpisodeCard: header 20 + gap xs + still 74 + padding sm×2 + marginBottom sm
const UPCOMING_H = 108; // UpcomingCard: poster 84 + padding sm×2 + marginBottom sm
const HEADER_H = 44; // SectionHeader (h1 18px + paddingVertical sm×2, bottom-aligned)
const MORE_H = 44; // "See more" section-footer button (caption row + marginBottom sm)

type WatchRow =
  | { type: 'spacer'; key: string; h: number }
  | { type: 'header'; key: string; bucket: string; h: number }
  | { type: 'card'; key: string; item: any; h: number }
  | {
      type: 'more';
      key: string;
      bucket: 'WATCH_NEXT' | 'START_WATCHING' | 'NOT_RECENTLY';
      h: number;
    };

type UpcomingRow =
  | { type: 'spacer'; key: string; h: number }
  | { type: 'header'; key: string; groupKey: string; group: UpcomingGroupDto; h: number }
  | { type: 'card'; key: string; item: any; h: number };

export default function ShowsScreen() {
  const [tab, setTab] = useState<'watchlist' | 'upcoming'>('watchlist');
  const [resetKey, setResetKey] = useState(0);
  const { t, i18n } = useTranslation(['shows', 'navigation', 'common']);
  const { tokens } = useAppearance();
  const { data: announcement } = useActiveAnnouncement();
  const unreadNotifications = useUnreadNotificationCount();
  const librarySummary = useShowProgressSummary();
  const dismissKey = announcement
    ? `announcement:${announcement.id}:rev:${announcement.revision}`
    : null;
  const { visible: showAnnouncementBanner, dismiss: dismissAnnouncementBanner } =
    useDismissableFlag(dismissKey ?? '');
  useTabPressReset(() => {
    setTab('watchlist');
    setResetKey((k) => k + 1);
  });
  const showBanner = !!announcement && !!dismissKey && showAnnouncementBanner === true;
  const trackedShowCount = librarySummary.data
    ? librarySummary.data.watching +
      librarySummary.data.notStarted +
      librarySummary.data.finished +
      librarySummary.data.paused +
      (librarySummary.data.dropped ?? 0)
    : null;
  const libraryEmpty = trackedShowCount === 0;
  return (
    <Screen>
      <Header
        title={t('shows:title')}
        right={
          <IconButton
            icon="notifications-outline"
            badge={unreadNotifications.data}
            onPress={() => router.push('/notifications')}
          />
        }
      />
      {librarySummary.isPending ? (
        <Spinner />
      ) : libraryEmpty ? (
        <LibraryEmptyState
          kind="shows"
          refreshing={librarySummary.isRefetching}
          onRefresh={() => {
            void librarySummary.refetch();
          }}
        />
      ) : (
        <>
          <View style={styles.tabs}>
            <Chip
              label={t('shows:watchList')}
              active={tab === 'watchlist'}
              onPress={() => setTab('watchlist')}
            />
            <Chip
              label={t('shows:upcoming')}
              active={tab === 'upcoming'}
              onPress={() => setTab('upcoming')}
            />
          </View>
          {tab === 'watchlist' && showBanner && announcement ? (
            <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
              <InfoBanner
                icon={
                  (VALID_ICONS.has(announcement.icon)
                    ? announcement.icon
                    : 'information-circle-outline') as any
                }
                title={pickLocale(announcement.title, i18n.language)}
                message={pickLocale(announcement.message, i18n.language)}
                actionLabel={
                  announcement.actionLabel
                    ? pickLocale(announcement.actionLabel, i18n.language)
                    : undefined
                }
                onAction={
                  announcement.action?.type !== 'none'
                    ? () => runAnnouncementAction(announcement.action)
                    : undefined
                }
                onClose={dismissAnnouncementBanner}
              />
            </View>
          ) : null}
          {tab === 'watchlist' ? <WatchList key={resetKey} /> : <Upcoming />}
        </>
      )}
    </Screen>
  );
}

function WatchList() {
  const { tokens } = useAppearance();
  const { data, isLoading, refetch, isRefetching } = useWatchNext();
  const queryClient = useQueryClient();
  const { t } = useTranslation(['shows', 'common']);
  const BUCKET_LABELS: Record<string, string> = {
    [WatchNextBucket.WATCH_NEXT]: t('shows:watchNext'),
    [WatchNextBucket.NOT_RECENTLY]: t('shows:notRecently'),
    [WatchNextBucket.HISTORY]: t('shows:history'),
    [WatchNextBucket.START_WATCHING]: t('shows:startWatching'),
    [WatchNextBucket.PAUSED]: t('shows:paused'),
  };
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Reset fetched older-history pages — their cursors chain from the pre-refresh slice.
    queryClient.removeQueries({ queryKey: ['watchNext', 'history'] });
    // Reset the "See more" bucket pages — offsets chain from the pre-refresh slice.
    queryClient.removeQueries({ queryKey: ['watchNext', 'bucket'] });
    await refetch();
    setRefreshing(false);
  }, [refetch, queryClient]);
  const mark = useMarkEpisodeWatched();
  const rewatch = useRewatchEpisode();
  const unwatchOnce = useUnwatchEpisodeOnce();
  // "See more" pagers for server-capped rails.
  const watchNextQ = useWatchNextBucket('WATCH_NEXT');
  const notRecentlyQ = useWatchNextBucket('NOT_RECENTLY');
  const startWatchingQ = useWatchNextBucket('START_WATCHING');

  // Cursor for the scroll-up history pages: the OLDEST item of the initial slice
  // (data order is newest-first). historyId is the watch_history row id tiebreaker —
  // bulk imports stamp identical watchedAt values.
  const historyCursor = useMemo(() => {
    const hist = (data?.items ?? []).filter((i) => i.bucket === WatchNextBucket.HISTORY);
    const oldest = hist[hist.length - 1];
    const before = oldest?.lastWatchedAt ?? oldest?.episode?.watchedAt;
    if (!oldest?.historyId || !before) return null;
    return { before, beforeId: oldest.historyId };
  }, [data?.items]);
  const pastQuery = useWatchNextHistory(historyCursor);
  const pausedQuery = usePausedWatchNext();

  // Flat rows (header / card) so the list virtualizes — a plain ScrollView rendered
  // EVERY card (300+ for heavy users) with no windowing, and fully re-rendered on
  // every mutation.
  const rows = useMemo<WatchRow[]>(() => {
    // Dedupe by episode id: an episode should appear at most once in the watchlist.
    // (Imports / double-marks can produce duplicate watch_history rows for the same episode.)
    const seenEpisode = new Set<string>();
    const items = (data?.items ?? []).filter((it) => {
      const k = it.episode.id;
      if (seenEpisode.has(k)) return false;
      seenEpisode.add(k);
      return true;
    });
    // Older scroll-up pages: fetched newest→oldest (within and across pages), so the
    // flattened list is globally descending; main items win dedupe (they are newer).
    const older = (pastQuery.data?.pages ?? [])
      .flatMap((p) => p.items)
      .filter((it) => {
        const k = it.episode.id;
        if (seenEpisode.has(k)) return false;
        seenEpisode.add(k);
        return true;
      });
    // Paused shows: next episodes from tracking-paused shows, own rail at the
    // bottom (separate endpoint — watch-next excludes them).
    const pausedItems = (pausedQuery.data?.items ?? []).filter((it) => {
      const k = it.episode.id;
      if (seenEpisode.has(k)) return false;
      seenEpisode.add(k);
      return true;
    });
    // "See more" pages for the capped rails (deduped like the main slice).
    const extraByBucket: Record<string, any[]> = {
      [WatchNextBucket.WATCH_NEXT]: [],
      [WatchNextBucket.NOT_RECENTLY]: [],
      [WatchNextBucket.START_WATCHING]: [],
    };
    for (const [bucket, q] of [
      [WatchNextBucket.WATCH_NEXT, watchNextQ],
      [WatchNextBucket.NOT_RECENTLY, notRecentlyQ],
      [WatchNextBucket.START_WATCHING, startWatchingQ],
    ] as const) {
      extraByBucket[bucket] = (q.data?.pages ?? [])
        .flatMap((p) => p.items)
        .filter((it) => {
          const k = it.episode.id;
          if (seenEpisode.has(k)) return false;
          seenEpisode.add(k);
          return true;
        });
    }
    // History is always visible (scroll up to see it), auto-scroll lands on Watch Next
    const buckets = [
      WatchNextBucket.HISTORY,
      WatchNextBucket.WATCH_NEXT,
      // "Haven't watched for a while" renders before "Start watching".
      WatchNextBucket.NOT_RECENTLY,
      WatchNextBucket.START_WATCHING,
      WatchNextBucket.PAUSED,
    ];
    const out: WatchRow[] = [{ type: 'spacer', key: 'top', h: spacing.lg }];
    let isFirstSection = true;
    for (const bucket of buckets) {
      const group =
        bucket === WatchNextBucket.PAUSED ? pausedItems : items.filter((i) => i.bucket === bucket);
      const extra = extraByBucket[bucket] ?? [];
      if (group.length === 0 && !(bucket === WatchNextBucket.HISTORY && older.length > 0)) continue;
      // History: oldest on top, latest at the bottom (right above Watch Next). Older
      // pages are all older than the initial slice, so ascending order is older-pages
      // reversed, then the initial group reversed.
      const ordered =
        bucket === WatchNextBucket.HISTORY
          ? [...older].reverse().concat([...group].reverse())
          : group;
      out.push({
        type: 'header',
        key: `h_${bucket}`,
        bucket,
        h: HEADER_H + (isFirstSection ? 0 : spacing.lg),
      });
      isFirstSection = false;
      for (const it of [...ordered, ...extra]) {
        // Non-History cards are keyed by showId so an optimistic mark-watched swap
        // (episode E → nextEpisode) updates the same component in place instead of
        // remounting. History rows keep the episode key (a show can appear multiple
        // times in History → showId would collide).
        out.push({
          type: 'card',
          key: bucket === WatchNextBucket.HISTORY ? `c_${it.episode.id}` : `c_${it.showId}`,
          item: it,
          h: CARD_H,
        });
      }
      // "See more" footer: until a page is fetched, the server's uncapped rail total
      // decides; afterwards the pager's hasNextPage does.
      if (
        bucket === WatchNextBucket.WATCH_NEXT ||
        bucket === WatchNextBucket.NOT_RECENTLY ||
        bucket === WatchNextBucket.START_WATCHING
      ) {
        const q =
          bucket === WatchNextBucket.WATCH_NEXT
            ? watchNextQ
            : bucket === WatchNextBucket.NOT_RECENTLY
              ? notRecentlyQ
              : startWatchingQ;
        const total =
          bucket === WatchNextBucket.WATCH_NEXT
            ? (data?.bucketTotals?.watchNext ?? 0)
            : bucket === WatchNextBucket.NOT_RECENTLY
              ? (data?.bucketTotals?.notRecently ?? 0)
              : (data?.bucketTotals?.startWatching ?? 0);
        const hasMore = (q.data?.pages.length ?? 0) > 0 ? !!q.hasNextPage : total > group.length;
        if (hasMore) out.push({ type: 'more', key: `m_${bucket}`, bucket, h: MORE_H });
      }
    }
    return out;
  }, [
    data?.items,
    data?.bucketTotals,
    pastQuery.data?.pages,
    pausedQuery.data?.items,
    watchNextQ.data?.pages,
    watchNextQ.hasNextPage,
    notRecentlyQ.data?.pages,
    notRecentlyQ.hasNextPage,
    startWatchingQ.data?.pages,
    startWatchingQ.hasNextPage,
  ]);

  // Land on Watch Next; when it has no items, fall back to "Haven't watched for a
  // while", then "Start watching" (first rail that exists wins).
  const landingIndex = useMemo(() => {
    for (const b of [
      WatchNextBucket.WATCH_NEXT,
      WatchNextBucket.NOT_RECENTLY,
      WatchNextBucket.START_WATCHING,
    ]) {
      const i = rows.findIndex((r) => r.type === 'header' && r.bucket === b);
      if (i > 0) return i;
    }
    return -1;
  }, [rows]);

  const getItemLayout = useCallback(
    (_: any, index: number) => {
      let offset = 0;
      for (let i = 0; i < index; i++) offset += rows[i].h;
      return { length: rows[index].h, offset, index };
    },
    [rows],
  );

  // Land on the Watch Next header ONCE per mount. Exact getItemLayout makes
  // scrollToIndex compute the offset without any layout pass, so a single next-frame
  // call always lands. (initialScrollIndex was abandoned: rows above the index stay
  // blank on mount — with short lists the whole History section never rendered.)
  // The landed-ref means marking a show never re-scrolls; the tab-reset remount
  // (key={resetKey}) re-lands like a fresh open.
  const listRef = useRef<FlatList<WatchRow>>(null);
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || landingIndex <= 0) return;
    landed.current = true;
    const timer = setTimeout(
      () => listRef.current?.scrollToIndex({ index: landingIndex, animated: false }),
      0,
    );
    return () => clearTimeout(timer);
  }, [landingIndex]);

  // Infinite top scroll (older watch history). Mirrors the Upcoming tab's scroll-up:
  // level-triggered top detection (edge triggers are flaky on web) + cooldown +
  // manual anchor restore from exact row heights on web (react-native-web has no
  // maintainVisibleContentPosition; native anchors via that prop instead).
  const canFetchPast =
    (pastQuery.data?.pages.length ?? 0) > 0
      ? !!pastQuery.hasNextPage
      : (data?.historyHasMore ?? false) && !!historyCursor;
  const offsetRef = useRef(0);
  const rowsRef = useRef<WatchRow[]>([]);
  const pendingPrepend = useRef<{ height: number; offset: number } | null>(null);
  const pastFetchGate = useRef(0);
  const topArmed = useRef(true);
  const fetchStartedAtPageCount = useRef<number | null>(null);
  const maybeFetchPast = useCallback(() => {
    if (!canFetchPast || pastQuery.isFetchingNextPage) return false;
    const now = Date.now();
    if (now - pastFetchGate.current < 1200) return false;
    pastFetchGate.current = now;
    fetchStartedAtPageCount.current = pastQuery.data?.pages.length ?? 0;
    pendingPrepend.current = {
      height: rowsRef.current.reduce((sum, r) => sum + r.h, 0),
      offset: offsetRef.current,
    };
    void pastQuery.fetchNextPage();
    return true;
  }, [canFetchPast, pastQuery]);
  const onScroll = useCallback(
    (e: any) => {
      const offset = Math.max(0, e.nativeEvent.contentOffset.y);
      offsetRef.current = offset;
      if (offset >= 250) {
        topArmed.current = true;
        return;
      }
      // Start immediately on a real scroll event; the interval below remains the
      // fallback for programmatic/native anchor moves that emit no event.
      if (topArmed.current && maybeFetchPast()) topArmed.current = false;
    },
    [maybeFetchPast],
  );
  // Latched level-trigger: fire ONE fetch per arrival at the top, re-arming only
  // after the offset leaves the threshold. Without the latch, an offset pinned in
  // the zone (empty/fully-deduped page, failed fetch, or the spacer anchored at 0
  // via maintainVisibleContentPosition) refires fetchNextPage every cooldown tick
  // for as long as the user sits at the top.
  useEffect(() => {
    const id = setInterval(() => {
      if (offsetRef.current >= 250) {
        topArmed.current = true;
        return;
      }
      if (!topArmed.current) return;
      // Consume the top-arrival latch only after a request really starts. If a
      // fast scroll reaches the top during the cooldown or an in-flight request,
      // leave it armed so the interval retries without a down/up scroll gesture.
      if (maybeFetchPast()) topArmed.current = false;
    }, 500);
    return () => clearInterval(id);
  }, [maybeFetchPast]);
  // A successful page is forward progress even if every item was deduplicated or
  // native anchor restoration emitted no onScroll. Re-arm in that case so a user
  // who is still at the top can continue loading; failed/no-progress requests stay
  // latched until the user deliberately leaves and returns to the top.
  useEffect(() => {
    if (pastQuery.isFetchingNextPage) return;
    const startedAt = fetchStartedAtPageCount.current;
    if (startedAt === null) return;
    fetchStartedAtPageCount.current = null;
    if ((pastQuery.data?.pages.length ?? 0) > startedAt) topArmed.current = true;
  }, [pastQuery.isFetchingNextPage, pastQuery.data?.pages.length]);
  rowsRef.current = rows;

  useEffect(() => {
    const pending = pendingPrepend.current;
    if (!pending || pastQuery.isFetchingNextPage) return;
    pendingPrepend.current = null;
    const delta = rows.reduce((sum, r) => sum + r.h, 0) - pending.height;
    const next = pending.offset + Math.max(0, delta);
    // Native moves the viewport via maintainVisibleContentPosition, but that
    // programmatic anchor adjustment does not consistently emit onScroll. Mirror
    // the expected offset in our detector on every platform.
    offsetRef.current = next;
    if (Platform.OS !== 'web') return;
    if (next > 0) listRef.current?.scrollToOffset({ offset: next, animated: false });
  }, [rows, pastQuery.isFetchingNextPage]);

  const renderRow = useCallback(
    ({ item: row }: { item: WatchRow }) => {
      if (row.type === 'spacer') return <View style={{ height: row.h }} />;
      if (row.type === 'header') {
        return (
          <View style={{ height: row.h, justifyContent: 'flex-end' }}>
            <SectionHeader title={BUCKET_LABELS[row.bucket]} />
          </View>
        );
      }
      if (row.type === 'more') return <SeeMoreRow bucket={row.bucket} h={row.h} />;
      const it = row.item;
      return (
        <View style={{ height: CARD_H }}>
          <EpisodeCard
            item={it}
            onMarkWatched={() => mark.mutate({ id: it.episode.id, on: true })}
            onRewatch={() => rewatch.mutate(it.episode.id)}
            onUnwatchOnce={() => unwatchOnce.mutate(it.episode.id)}
            onUnwatch={() => mark.mutate({ id: it.episode.id, on: false })}
          />
        </View>
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [mark, rewatch, t],
  );

  if (isLoading) return <Spinner />;
  // rows always contains the top spacer; "empty" = nothing but the spacer.
  if (rows.length <= 1)
    return (
      <EmptyState
        title={t('shows:empty.watchlistTitle')}
        subtitle={t('shows:empty.watchlistSubtitle')}
        cta={t('shows:empty.browseShows')}
        onCta={() => router.push('/(tabs)/explore')}
        icon="tv-outline"
      />
    );

  return (
    <View style={{ flex: 1 }}>
      {pastQuery.isFetchingNextPage ? (
        <View style={styles.topLoader} pointerEvents="none">
          <Spinner />
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        }
        initialNumToRender={15}
        maxToRenderPerBatch={12}
        windowSize={9}
        getItemLayout={getItemLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        // Keep the viewport anchored when optimistic updates insert/remove History
        // rows above the visible area.
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
    </View>
  );
}

/** Feed-style "See more" section footer: loads the next 10 items of the rail
 *  until the server's uncapped total is exhausted. */
function SeeMoreRow({
  bucket,
  h,
}: {
  bucket: 'WATCH_NEXT' | 'START_WATCHING' | 'NOT_RECENTLY';
  h: number;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['shows']);
  const q = useWatchNextBucket(bucket);
  return (
    <View style={{ height: h, justifyContent: 'center' }}>
      <Pressable
        onPress={() => {
          if (!q.isFetchingNextPage) q.fetchNextPage();
        }}
        style={({ pressed }) => [
          styles.moreBtn,
          { backgroundColor: tokens.surface },
          pressed && { backgroundColor: tokens.surfaceAlt },
        ]}
        accessibilityRole="button"
      >
        {q.isFetchingNextPage ? (
          <Spinner />
        ) : (
          <>
            <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>
              {t('shows:seeMore')}
            </T>
            <Ionicons
              name="chevron-down"
              size={14}
              color={tokens.primary}
              style={{ marginLeft: 4 }}
            />
          </>
        )}
      </Pressable>
    </View>
  );
}

function Upcoming() {
  const { tokens } = useAppearance();
  const { data, isLoading, refetch } = useUpcoming();
  const queryClient = useQueryClient();
  const { t } = useTranslation(['shows', 'common']);
  const pastCursor = data?.past?.cursor ?? null;
  const pastHasMore = data?.past?.hasMore ?? false;
  const pastQuery = useUpcomingPast(pastCursor);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Reset fetched past pages — their cursors chain from the pre-refresh slice.
    queryClient.removeQueries({ queryKey: ['upcoming', 'past'] });
    await refetch();
    setRefreshing(false);
  }, [refetch, queryClient]);

  const UPCOMING_GROUP_KEYS: Record<string, string> = {
    TODAY: t('shows:today'),
    TOMORROW: t('shows:tomorrow'),
    THIS_WEEK: t('shows:thisWeek'),
    NEXT_WEEK: t('shows:nextWeek'),
    LATER: t('shows:later'),
  };

  // Localized group header: past buckets translate via key + params, future buckets
  // via the fixed map; server label is the fallback for unknown keys.
  const groupLabel = useCallback(
    (g: UpcomingGroupDto): string => {
      switch (g.key) {
        case UpcomingPastBucket.YESTERDAY:
          return t('shows:yesterday');
        case UpcomingPastBucket.EARLIER_THIS_WEEK:
          return t('shows:earlierThisWeek');
        case UpcomingPastBucket.LAST_WEEK:
          return t('shows:lastWeek');
        case UpcomingPastBucket.LAST_MONTH:
          return t('shows:lastMonth');
        case UpcomingPastBucket.MONTHS_AGO:
          return t('shows:pastMonthsAgo', { count: g.params?.count ?? 0 });
        case UpcomingPastBucket.YEARS_AGO:
          return t('shows:pastYearsAgo', { count: g.params?.years ?? g.params?.count ?? 1 });
        case UpcomingPastBucket.YEARS_MONTHS_AGO:
          return t('shows:pastYearsMonthsAgo', {
            years: g.params?.years ?? 1,
            count: g.params?.months ?? 1,
          });
        default:
          return UPCOMING_GROUP_KEYS[g.key] ?? g.label ?? g.key;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // Merge older infinite-scroll pages above the main slice. Pages are fetched
  // newest-older → oldest, so they prepend in reverse fetch order; groups with
  // the same identity (key + params) merge, items deduped by episode id.
  const groups = useMemo<UpcomingGroupDto[]>(() => {
    const mainGroups = data?.groups ?? [];
    const pages = pastQuery.data?.pages ?? [];
    if (pages.length === 0) return mainGroups;
    const merged: UpcomingGroupDto[] = [];
    const byIdentity = new Map<string, UpcomingGroupDto>();
    const seenIds = new Set<string>();
    const pushGroups = (gs: UpcomingGroupDto[]) => {
      for (const g of gs) {
        const identity = `${g.key}|${JSON.stringify(g.params ?? null)}`;
        let target = byIdentity.get(identity);
        if (!target) {
          target = { ...g, items: [] };
          byIdentity.set(identity, target);
          merged.push(target);
        }
        for (const it of g.items) {
          if (seenIds.has(it.id)) continue;
          seenIds.add(it.id);
          target.items.push(it);
        }
      }
    };
    for (const page of [...pages].reverse()) pushGroups(page.groups);
    pushGroups(mainGroups);
    return merged.filter((g) => g.items.length > 0);
  }, [data?.groups, pastQuery.data?.pages]);
  // Infinite top scroll: with no pages fetched yet, the main endpoint's
  // hasMore+cursor gates the first fetch; afterwards the last page's cursor gates.
  const canFetchPast =
    (pastQuery.data?.pages.length ?? 0) > 0 ? !!pastQuery.hasNextPage : pastHasMore && !!pastCursor;
  // Top detection via onScroll (react-native-web's onStartReached is unreliable)
  // + manual anchor restore computed from our exact row heights — RNW has no
  // maintainVisibleContentPosition, so without this the offset pinned at 0 after
  // a prepend and wheeling up emitted no scroll events: nothing could retrigger.
  // The 1.2s cooldown caps a refire burst at ~50 req/min.
  const listRef = useRef<FlatList<UpcomingRow>>(null);
  const offsetRef = useRef(0);
  const rowsRef = useRef<UpcomingRow[]>([]);
  const pendingPrepend = useRef<{ height: number; offset: number } | null>(null);
  const pastFetchGate = useRef(0);
  const topArmed = useRef(true);
  const fetchStartedAtPageCount = useRef<number | null>(null);
  const maybeFetchPast = useCallback(() => {
    if (!canFetchPast || pastQuery.isFetchingNextPage) return false;
    const now = Date.now();
    if (now - pastFetchGate.current < 1200) return false;
    pastFetchGate.current = now;
    fetchStartedAtPageCount.current = pastQuery.data?.pages.length ?? 0;
    pendingPrepend.current = {
      height: rowsRef.current.reduce((sum, r) => sum + r.h, 0),
      offset: offsetRef.current,
    };
    void pastQuery.fetchNextPage();
    return true;
  }, [canFetchPast, pastQuery]);
  const onScroll = useCallback(
    (e: any) => {
      const offset = Math.max(0, e.nativeEvent.contentOffset.y);
      offsetRef.current = offset;
      if (offset >= 250) {
        topArmed.current = true;
        return;
      }
      if (topArmed.current && maybeFetchPast()) topArmed.current = false;
    },
    [maybeFetchPast],
  );
  // Level-triggered top detection: edge-triggered approaches (onStartReached,
  // onScroll crossings) are flaky on web — after the anchor restore the offset can
  // sit inside the threshold with no further events, forcing a scroll-down-and-up
  // dance. A cheap interval just looks at the current position. It is latched
  // (topArmed): ONE fetch per arrival at the top, re-arming only once the offset
  // leaves the threshold — otherwise an offset pinned near 0 (empty/deduped page,
  // failed fetch, anchored spacer) refires forever while the user sits at the top.
  useEffect(() => {
    const id = setInterval(() => {
      if (offsetRef.current >= 250) {
        topArmed.current = true;
        return;
      }
      if (!topArmed.current) return;
      // Do not burn the latch when a fast top arrival overlaps a cooldown or the
      // previous fetch; keeping it armed lets this level-trigger retry in place.
      if (maybeFetchPast()) topArmed.current = false;
    }, 500);
    return () => clearInterval(id);
  }, [maybeFetchPast]);
  useEffect(() => {
    if (pastQuery.isFetchingNextPage) return;
    const startedAt = fetchStartedAtPageCount.current;
    if (startedAt === null) return;
    fetchStartedAtPageCount.current = null;
    if ((pastQuery.data?.pages.length ?? 0) > startedAt) topArmed.current = true;
  }, [pastQuery.isFetchingNextPage, pastQuery.data?.pages.length]);

  // Flat rows (header / card) so the list virtualizes (up to 200 cards server-side).
  const rows = useMemo<UpcomingRow[]>(() => {
    const out: UpcomingRow[] = [{ type: 'spacer', key: 'top', h: spacing.lg }];
    let isFirstSection = true;
    for (const g of groups) {
      if (!g.items?.length) continue;
      out.push({
        type: 'header',
        key: `h_${g.key}_${JSON.stringify(g.params ?? null)}`,
        groupKey: g.key,
        group: g,
        h: HEADER_H + (isFirstSection ? 0 : spacing.lg),
      });
      isFirstSection = false;
      for (const it of g.items)
        out.push({ type: 'card', key: `c_${it.id}`, item: it, h: UPCOMING_H });
    }
    return out;
  }, [groups]);
  rowsRef.current = rows;

  // Restore the visual anchor once a prepended page has rendered: the delta comes
  // from our exact row heights. Web only — react-native-web has no
  // maintainVisibleContentPosition; native anchors via that prop instead (applying
  // both would double-shift).
  useEffect(() => {
    const pending = pendingPrepend.current;
    if (!pending || pastQuery.isFetchingNextPage) return;
    pendingPrepend.current = null;
    const delta = rows.reduce((sum, r) => sum + r.h, 0) - pending.height;
    const next = pending.offset + Math.max(0, delta);
    offsetRef.current = next;
    if (Platform.OS !== 'web') return;
    if (next > 0) listRef.current?.scrollToOffset({ offset: next, animated: false });
  }, [rows, pastQuery.isFetchingNextPage]);

  const landingKey = ['TODAY', 'TOMORROW', 'THIS_WEEK'].find((k) =>
    groups.some((g: any) => g.key === k),
  );
  const landingIndex = useMemo(
    () => rows.findIndex((r) => r.type === 'header' && r.groupKey === landingKey),
    [rows, landingKey],
  );

  const getItemLayout = useCallback(
    (_: any, index: number) => {
      let offset = 0;
      for (let i = 0; i < index; i++) offset += rows[i].h;
      return { length: rows[index].h, offset, index };
    },
    [rows],
  );

  // Same landing strategy as WatchList: one exact next-frame scroll per mount
  // (no initialScrollIndex — rows above the index stayed blank on short lists).
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || landingIndex <= 0) return;
    landed.current = true;
    const timer = setTimeout(
      () => listRef.current?.scrollToIndex({ index: landingIndex, animated: false }),
      0,
    );
    return () => clearTimeout(timer);
  }, [landingIndex]);

  const renderRow = useCallback(
    ({ item: row }: { item: UpcomingRow }) => {
      if (row.type === 'spacer') return <View style={{ height: row.h }} />;
      if (row.type === 'header') {
        return (
          <View style={{ height: row.h, justifyContent: 'flex-end' }}>
            <SectionHeader title={groupLabel(row.group)} />
          </View>
        );
      }
      return (
        <View style={{ height: UPCOMING_H }}>
          <UpcomingCard item={row.item} />
        </View>
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [t, groupLabel],
  );

  if (isLoading) return <Spinner />;
  if (groups.length === 0)
    return (
      <EmptyState
        title={t('shows:empty.upcomingTitle')}
        subtitle={t('shows:empty.upcomingSubtitle')}
        cta={t('shows:empty.browseAll')}
        onCta={() => router.push('/(tabs)/explore')}
        icon="calendar-outline"
      />
    );

  return (
    <View style={{ flex: 1 }}>
      {pastQuery.isFetchingNextPage ? (
        <View style={styles.topLoader} pointerEvents="none">
          <Spinner />
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderRow}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        }
        initialNumToRender={15}
        maxToRenderPerBatch={12}
        windowSize={9}
        getItemLayout={getItemLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  // "See more" section footer (mirrors the Explore feed's per-user expand button).
  moreBtn: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minWidth: 120,
    minHeight: 30,
  },
  // Scroll-up page spinner: absolute overlay so it never shifts row layout (a layout
  // row at the top pushed the whole list down mid-fetch → visible flicker).
  topLoader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingVertical: spacing.xs,
    zIndex: 1,
  },
});
