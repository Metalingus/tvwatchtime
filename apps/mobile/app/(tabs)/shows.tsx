import React, { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Header, IconButton } from '../../components/Header';
import { EpisodeCard, UpcomingCard } from '../../components/cards';
import { Chip, EmptyState, Screen, SectionHeader, Spinner } from '../../components/primitives';
import { InfoBanner } from '../../components/InfoBanner';
import { useMarkEpisodeWatched, useRewatchEpisode, useUpcoming, useWatchNext, useActiveAnnouncement } from '../../api/hooks';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useDismissableFlag } from '../../hooks/useDismissableFlag';
import { pickLocale, runAnnouncementAction } from '../../lib/announcement';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing } from '../../theme/theme';
import { WatchNextBucket } from '@tvwatch/shared';

const VALID_ICONS = new Set([
  'information-circle-outline', 'megaphone-outline', 'download-outline', 'notifications-outline',
  'bulb-outline', 'gift-outline', 'star-outline', 'trophy-outline', 'flame-outline', 'sparkles-outline',
  'calendar-outline', 'pricetag-outline', 'film-outline', 'tv-outline', 'list-outline', 'people-outline',
  'chatbubble-outline', 'warning-outline', 'checkmark-circle-outline', 'rocket-outline',
]);

export default function ShowsScreen() {
  const [tab, setTab] = useState<'watchlist' | 'upcoming'>('watchlist');
  const [resetKey, setResetKey] = useState(0);
  const { t, i18n } = useTranslation(['shows', 'navigation', 'common']);
  const { tokens } = useAppearance();
  const { data: announcement } = useActiveAnnouncement();
  const dismissKey = announcement ? `announcement:${announcement.id}:rev:${announcement.revision}` : null;
  const { visible: showAnnouncementBanner, dismiss: dismissAnnouncementBanner } = useDismissableFlag(dismissKey ?? '');
  useTabPressReset(() => {
    setTab('watchlist');
    setResetKey((k) => k + 1);
  });
  const showBanner = !!announcement && !!dismissKey && showAnnouncementBanner === true;
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
      {tab === 'watchlist' && showBanner && announcement ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          <InfoBanner
            icon={(VALID_ICONS.has(announcement.icon) ? announcement.icon : 'information-circle-outline') as any}
            title={pickLocale(announcement.title, i18n.language)}
            message={pickLocale(announcement.message, i18n.language)}
            actionLabel={announcement.actionLabel ? pickLocale(announcement.actionLabel, i18n.language) : undefined}
            onAction={announcement.action?.type !== 'none' ? () => runAnnouncementAction(announcement.action) : undefined}
            onClose={dismissAnnouncementBanner}
          />
        </View>
      ) : null}
      {tab === 'watchlist' ? <WatchList key={resetKey} /> : <Upcoming />}
    </Screen>
  );
}

function WatchList() {
  const { tokens } = useAppearance();
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
  const rewatch = useRewatchEpisode();
  // Dedupe by episode id: an episode should appear at most once in the watchlist.
  // (Imports / double-marks can produce duplicate watch_history rows for the same episode.)
  const seenEpisode = new Set<string>();
  const items = (data?.items ?? []).filter((it) => {
    const k = it.episode.id;
    if (seenEpisode.has(k)) return false;
    seenEpisode.add(k);
    return true;
  });
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
    <ScrollView ref={scrollRef} contentContainerStyle={{ padding: spacing.lg }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}>
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
                // Non-History cards are keyed by showId so an optimistic mark-watched swap
                // (episode E → nextEpisode) updates the same component in place instead of
                // remounting. History rows keep the episode key (a show can appear multiple
                // times in History → showId would collide).
                key={it.bucket === WatchNextBucket.HISTORY ? it.episode.id : it.showId}
                item={it}
                onMarkWatched={() => mark.mutate({ id: it.episode.id, on: true })}
                onRewatch={() => rewatch.mutate(it.episode.id)}
                onUnwatch={() => mark.mutate({ id: it.episode.id, on: false })}
              />
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

function Upcoming() {
  const { tokens } = useAppearance();
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

  const UPCOMING_GROUP_KEYS: Record<string, string> = {
    TODAY: t('shows:today'),
    TOMORROW: t('shows:tomorrow'),
    THIS_WEEK: t('shows:thisWeek'),
    NEXT_WEEK: t('shows:nextWeek'),
    LATER: t('shows:later'),
  };

  const landingKey = ['TODAY', 'TOMORROW', 'THIS_WEEK'].find((k) => groups.some((g: any) => g.key === k));
  return (
    <ScrollView ref={scrollRef} contentContainerStyle={{ padding: spacing.lg }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}>
      {groups.map((g: any) => (
        <View
          key={g.key}
          style={{ marginBottom: spacing.lg }}
          onLayout={g.key === landingKey ? (e) => landOnToday(e.nativeEvent.layout.y) : undefined}
        >
          <SectionHeader title={UPCOMING_GROUP_KEYS[g.key] ?? g.label} />
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
