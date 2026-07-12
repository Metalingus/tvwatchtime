import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Header, IconButton } from '../../components/Header';
import { EpisodeCard, UpcomingCard } from '../../components/cards';
import { Chip, EmptyState, Screen, SectionHeader, Spinner } from '../../components/primitives';
import { InfoBanner } from '../../components/InfoBanner';
import { useMarkEpisodeWatched, useUpcoming, useWatchNext } from '../../api/hooks';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useDismissableFlag } from '../../hooks/useDismissableFlag';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { colors, spacing } from '../../theme/theme';
import { WatchNextBucket } from '@tvwatch/shared';

export default function ShowsScreen() {
  const [tab, setTab] = useState<'watchlist' | 'upcoming'>('watchlist');
  const [resetKey, setResetKey] = useState(0);
  const { visible: showReimportBanner, dismiss: dismissReimportBanner } = useDismissableFlag('banner:lists_import_v1');
  const { t } = useTranslation(['shows', 'navigation', 'common']);
  const { tokens } = useAppearance();
  useTabPressReset(() => {
    setTab('watchlist');
    setResetKey((k) => k + 1);
  });
  return (
    <Screen>
      <Header
        title={t('shows:title')}
        right={
          <IconButton icon="notifications-outline" onPress={() => router.push('/notifications')} />
        }
      />
      <View style={styles.tabs}>
        <Chip label={t('shows:watchList')} active={tab === 'watchlist'} onPress={() => setTab('watchlist')} />
        <Chip label={t('shows:upcoming')} active={tab === 'upcoming'} onPress={() => setTab('upcoming')} />
      </View>
      {tab === 'watchlist' && showReimportBanner === true ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          <InfoBanner
            icon="download-outline"
            title="Missing anything from your import?"
            message="TV Time imports now include your lists. Re-import your export to pick up lists — and any watched episodes or shows that didn't come through last time. Your existing data won't be duplicated."
            actionLabel="Re-import data"
            onAction={() => router.push('/import')}
            onClose={dismissReimportBanner}
          />
        </View>
      ) : null}
      {tab === 'watchlist' ? <WatchList key={resetKey} /> : <Upcoming />}
    </Screen>
  );
}

function WatchList() {
  const { data, isLoading, refetch, isRefetching } = useWatchNext();
  const { t } = useTranslation(['shows', 'common']);
  const BUCKET_LABELS: Record<string, string> = {
    [WatchNextBucket.WATCH_NEXT]: t('shows:watchNext'),
    [WatchNextBucket.NOT_RECENTLY]: t('shows:notRecently'),
    [WatchNextBucket.HISTORY]: t('shows:history'),
    [WatchNextBucket.START_WATCHING]: t('shows:startWatching'),
  };
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const mark = useMarkEpisodeWatched();
  const items = data?.items ?? [];
  // History is always visible (scroll up to see it), auto-scroll lands on Watch Next
  const buckets = [WatchNextBucket.HISTORY, WatchNextBucket.WATCH_NEXT, WatchNextBucket.START_WATCHING, WatchNextBucket.NOT_RECENTLY];

  const scrollRef = useRef<ScrollView>(null);
  const watchNextY = useRef<number | null>(null);
  const didScroll = useRef(false);

  const scrollToWatchNext = (y: number) => {
    watchNextY.current = y;
    if (didScroll.current) return;
    didScroll.current = true;
    setTimeout(() => scrollRef.current?.scrollTo({ y, animated: false }), 80);
  };

  if (isLoading) return <Spinner />;
  if (items.length === 0)
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
    <ScrollView ref={scrollRef} contentContainerStyle={{ padding: spacing.lg }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}>
      {buckets.map((bucket) => {
        const group = items.filter((i) => i.bucket === bucket);
        if (group.length === 0) return null;
        // History: oldest on top, latest at the bottom (right above Watch Next).
        const ordered = bucket === WatchNextBucket.HISTORY ? [...group].reverse() : group;
        return (
          <View
            key={bucket}
            style={{ marginBottom: spacing.lg }}
            onLayout={bucket === WatchNextBucket.WATCH_NEXT ? (e) => scrollToWatchNext(e.nativeEvent.layout.y) : undefined}
          >
            <SectionHeader title={BUCKET_LABELS[bucket]} />
            {ordered.map((it) => (
              <EpisodeCard
                key={it.episode.id}
                item={it}
                onToggleWatched={() => mark.mutate({ id: it.episode.id, on: !it.episode.watched })}
              />
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

function Upcoming() {
  const { data, isLoading, refetch } = useUpcoming();
  const { t } = useTranslation(['shows', 'common']);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const groups = data?.groups ?? [];
  const scrollRef = useRef<ScrollView>(null);
  const todayY = useRef<number | null>(null);
  const didScroll = useRef(false);

  const landOnToday = (y: number) => {
    todayY.current = y;
    if (didScroll.current) return;
    didScroll.current = true;
    setTimeout(() => scrollRef.current?.scrollTo({ y, animated: false }), 80);
  };

  if (isLoading) return <Spinner />;
  if (groups.length === 0)
    return <EmptyState title={t('shows:empty.upcomingTitle')} subtitle={t('shows:empty.upcomingSubtitle')} cta={t('shows:empty.browseAll')} onCta={() => router.push('/(tabs)/explore')} icon="calendar-outline" />;

  const landingKey = ['TODAY', 'TOMORROW', 'THIS_WEEK'].find((k) => groups.some((g: any) => g.key === k));
  return (
    <ScrollView ref={scrollRef} contentContainerStyle={{ padding: spacing.lg }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}>
      {groups.map((g: any) => (
        <View
          key={g.key}
          style={{ marginBottom: spacing.lg }}
          onLayout={g.key === landingKey ? (e) => landOnToday(e.nativeEvent.layout.y) : undefined}
        >
          <SectionHeader title={g.label} />
          {g.items.map((it: any) => (
            <UpcomingCard key={it.id} item={it} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
});
