import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { PosterImage, Spinner, T } from './primitives';
import { formatWatchTime, useLeaderboard } from '../api/hooks';
import { colors, radius, spacing } from '../theme/theme';

interface Entry {
  userId: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  totalMinutes: number;
  position: number;
}

export function Leaderboard({ tabs }: { tabs: { key: string; label: string }[] }) {
  const [activeTab, setActiveTab] = useState(0);
  const typeMap: Record<string, 'shows' | 'movies' | 'combined'> = { shows: 'shows', movies: 'movies', combined: 'combined' };

  return (
    <View>
      {tabs.length > 1 ? (
        <View style={styles.tabsRow}>
          {tabs.map((t, i) => (
            <View key={t.key} style={[styles.tab, activeTab === i && styles.tabActive]}>
              <T variant="caption" style={{ color: activeTab === i ? '#0F1115' : colors.textMuted }} onPress={() => setActiveTab(i)}>
                {t.label}
              </T>
              {i < tabs.length - 1 ? (
                <T variant="micro" muted style={{ marginLeft: 'auto' }} onPress={() => setActiveTab(Math.min(tabs.length - 1, i + 1))}>›</T>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <LeaderboardPage type={typeMap[tabs[activeTab].key] || 'combined'} />
    </View>
  );
}

function LeaderboardPage({ type }: { type: 'shows' | 'movies' | 'combined' }) {
  const { data, isLoading } = useLeaderboard(type);

  if (isLoading) return <View style={{ padding: spacing.lg }}><Spinner /></View>;

  const top10: Entry[] = data?.top10 ?? [];
  const me: Entry | null = data?.me ?? null;

  return (
    <View>
      {top10.map((e) => (
        <LeaderboardRow key={e.userId} entry={e} />
      ))}
      {me ? (
        <View>
          <View style={styles.separator} />
          <LeaderboardRow entry={me} highlight />
        </View>
      ) : null}
      {top10.length === 0 && !me ? (
        <T variant="caption" muted style={{ paddingVertical: spacing.lg, textAlign: 'center' }}>
          No data yet. Follow people to see the leaderboard!
        </T>
      ) : null}
    </View>
  );
}

function LeaderboardRow({ entry, highlight }: { entry: Entry; highlight?: boolean }) {
  const medal = entry.position === 1 ? '🥇' : entry.position === 2 ? '🥈' : entry.position === 3 ? '🥉' : null;
  return (
    <View style={[styles.row, highlight && styles.rowHighlight]}>
      <View style={styles.posCol}>
        {medal ? <T variant="h2">{medal}</T> : <T variant="h2" style={{ color: colors.textMuted }}>{entry.position}</T>}
      </View>
      <PosterImage uri={entry.avatarUrl} style={styles.avatar} />
      <View style={{ flex: 1 }}>
        <T variant="body" numberOfLines={1}>{entry.displayName ?? entry.username}</T>
        <T variant="micro" muted>@{entry.username}</T>
      </View>
      <T variant="caption" style={{ color: colors.primary, fontWeight: '700' }}>{formatWatchTime(entry.totalMinutes)}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  tabsRow: { flexDirection: 'row', marginBottom: spacing.sm },
  tab: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: radius.pill, marginRight: spacing.sm, backgroundColor: colors.chip },
  tabActive: { backgroundColor: colors.primary },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomColor: colors.border, borderBottomWidth: 1 },
  rowHighlight: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.sm, marginTop: 4 },
  posCol: { width: 40, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, marginHorizontal: spacing.sm },
  separator: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
});
