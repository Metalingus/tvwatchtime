import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { PosterImage, Spinner, T, APP_ICON } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { formatWatchTime, useLeaderboard, usePrefetchLeaderboard } from '../api/hooks';
import type { LeaderboardEntryDto, LeaderboardType } from '@tvwatch/shared';
import { radius, spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

export function Leaderboard({ tabs, typeOverride }: { tabs: { key: string; label: string }[]; typeOverride?: 'shows' | 'movies' | 'combined' }) {
  const [activeTab, setActiveTab] = useState(0);
  const { tokens } = useAppearance();
  const typeMap: Record<string, 'shows' | 'movies' | 'combined'> = { shows: 'shows', movies: 'movies', combined: 'combined' };
  const activeType = typeOverride ?? typeMap[tabs[activeTab]?.key] ?? 'combined';

  return (
    <View>
      {tabs.length > 1 && !typeOverride ? (
        <View style={styles.tabsRow}>
          {tabs.map((t, i) => (
            <View key={t.key} style={[styles.tab, { backgroundColor: tokens.chip }, activeTab === i && { backgroundColor: tokens.primary }]}>
              <T variant="caption" style={{ color: activeTab === i ? tokens.primaryForeground : tokens.textMuted }} onPress={() => setActiveTab(i)}>
                {t.label}
              </T>
              {i < tabs.length - 1 ? (
                <T variant="micro" muted style={{ marginLeft: 'auto' }} onPress={() => setActiveTab(Math.min(tabs.length - 1, i + 1))}>›</T>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <LeaderboardPage type={activeType} />
    </View>
  );
}

function LeaderboardPage({ type }: { type: LeaderboardType }) {
  const [page, setPage] = useState(1);
  const { data, isLoading, refetch } = useLeaderboard(type, page);
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social', 'common']);
  const totalPages = data?.totalPages ?? 1;
  usePrefetchLeaderboard(type, page, totalPages);

  // Refetch on focus so a just-busted leaderboard cache is picked up without manual refresh.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );

  const entries = data?.entries ?? [];
  const me = data?.me ?? null;
  const showPager = totalPages > 1;

  const totalPagesRef = useRef(totalPages);
  totalPagesRef.current = totalPages;

  // Horizontal swipe to change page (native only). Axis-discriminated so the parent's
  // vertical scroll still works. Created once; reads current totalPages via a ref.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-15, 15])
        .failOffsetY([-10, 10])
        .onEnd((e) => {
          if (e.translationX > 40) setPage((p) => Math.max(1, p - 1));
          else if (e.translationX < -40) setPage((p) => Math.min(totalPagesRef.current, p + 1));
        }),
    [],
  );

  const body = (
    <View>
      {entries.map((e) => (
        <LeaderboardRow key={e.userId} entry={e} />
      ))}
      {me ? (
        <View>
          <View style={[styles.separator, { backgroundColor: tokens.border }]} />
          <LeaderboardRow entry={me} highlight />
        </View>
      ) : null}
      {!isLoading && entries.length === 0 && !me ? (
        <T variant="caption" muted style={{ paddingVertical: spacing.lg, textAlign: 'center' }}>
          {t('social:leaderboardEmpty')}
        </T>
      ) : null}
    </View>
  );

  return (
    <View>
      <View style={styles.headerRow}>
        <Pressable
          onPress={() => setPage((p) => Math.max(1, p - 1))}
          hitSlop={8}
          disabled={page <= 1}
          style={[styles.arrow, page <= 1 && styles.arrowDisabled]}
        >
          <Ionicons name="chevron-back-circle" size={24} color={page <= 1 ? tokens.textDim : tokens.textMuted} />
        </Pressable>
        <T variant="micro" muted>{showPager ? `${page} / ${totalPages}` : ''}</T>
        <Pressable
          onPress={() => setPage((p) => Math.min(totalPages, p + 1))}
          hitSlop={8}
          disabled={page >= totalPages}
          style={[styles.arrow, page >= totalPages && styles.arrowDisabled]}
        >
          <Ionicons name="chevron-forward-circle" size={24} color={page >= totalPages ? tokens.textDim : tokens.textMuted} />
        </Pressable>
      </View>

      {isLoading && entries.length === 0 ? (
        <View style={{ padding: spacing.lg }}><Spinner /></View>
      ) : Platform.OS === 'web' ? (
        body
      ) : (
        <GestureDetector gesture={pan}>{body}</GestureDetector>
      )}
    </View>
  );
}

function LeaderboardRow({ entry, highlight }: { entry: LeaderboardEntryDto; highlight?: boolean }) {
  const { tokens } = useAppearance();
  const medal = entry.position === 1 ? '🥇' : entry.position === 2 ? '🥈' : entry.position === 3 ? '🥉' : null;
  return (
    <View style={[styles.row, { borderBottomColor: tokens.border }, highlight && { backgroundColor: tokens.surfaceAlt }]}>
      <View style={styles.posCol}>
        {medal ? <T variant="h2">{medal}</T> : <T variant="h2" style={{ color: tokens.textMuted }}>{entry.position}</T>}
      </View>
      <PosterImage uri={entry.avatarUrl} fallback={APP_ICON} style={styles.avatar} />
      <View style={{ flex: 1 }}>
        <T variant="body" numberOfLines={1}>{entry.displayName ?? entry.username}</T>
        <T variant="micro" muted>@{entry.username}</T>
      </View>
      <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>{formatWatchTime(entry.totalMinutes)}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  privacyHint: { marginBottom: spacing.sm, lineHeight: 14 },
  tabsRow: { flexDirection: 'row', marginBottom: spacing.sm },
  tab: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: radius.pill, marginRight: spacing.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.xs, marginBottom: 2 },
  arrow: { paddingHorizontal: spacing.xs },
  arrowDisabled: { opacity: 0.4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1 },
  rowHighlight: { borderRadius: radius.md, paddingHorizontal: spacing.sm, marginTop: 4 },
  posCol: { width: 40, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, marginHorizontal: spacing.sm },
  separator: { height: 1, marginVertical: 8 },
});