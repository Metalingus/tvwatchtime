import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../components/Header';
import { PosterCard } from '../components/cards';
import { EmptyState, Screen, Spinner, T } from '../components/primitives';
import { api } from '../api/client';
import { useQuery } from '@tanstack/react-query';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

interface StatusItem { id: string; title: string; posterUrl?: string | null; progress: number }
type SectionKey = 'watching' | 'notStarted' | 'finished';

interface FlatRow {
  type: 'header' | 'empty' | 'cards';
  key: string;
  title?: string;
  count?: number;
  section?: SectionKey;
  message?: string;
  cards?: StatusItem[];
}

export default function MyShowsScreen() {
  const { width } = useWindowDimensions();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social', 'common']);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['showsByStatus'],
    queryFn: () => api.get<{ watching: StatusItem[]; notStarted: StatusItem[]; finished: StatusItem[] }>('/me/shows/progress'),
  });
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({ watching: true, notStarted: true, finished: true });

  if (isLoading) return <Screen><Header title={t('social:myShows.title')} showBack /><Spinner /></Screen>;

  const containerW = width - 32; // spacing.lg * 2
  const gap = 8;
  const cols = Math.max(2, Math.floor((containerW + gap) / (110 + gap)));
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);

  const defs: { key: SectionKey; title: string; empty: string; items: StatusItem[] }[] = [
    { key: 'watching', title: t('social:myShows.toWatch'), empty: t('social:myShows.toWatchEmpty'), items: data?.watching ?? [] },
    { key: 'notStarted', title: t('social:myShows.notStarted'), empty: t('social:myShows.notStartedEmpty'), items: data?.notStarted ?? [] },
    { key: 'finished', title: t('social:myShows.finished'), empty: t('social:myShows.finishedEmpty'), items: data?.finished ?? [] },
  ];

  const rows: FlatRow[] = [];
  for (const s of defs) {
    rows.push({ type: 'header', key: `h_${s.key}`, title: s.title, count: s.items.length, section: s.key });
    if (expanded[s.key]) {
      if (s.items.length === 0) {
        rows.push({ type: 'empty', key: `e_${s.key}`, message: s.empty });
      } else {
        for (let i = 0; i < s.items.length; i += cols) {
          rows.push({ type: 'cards', key: `r_${s.key}_${i}`, cards: s.items.slice(i, i + cols) });
        }
      }
    }
  }

  const stickyIndices: number[] = [];
  rows.forEach((r, i) => { if (r.type === 'header') stickyIndices.push(i); });

  const renderItem = ({ item }: { item: FlatRow }) => {
    if (item.type === 'header') {
      const sec = item.section!;
      const open = expanded[sec];
      return (
        <Pressable
          style={[styles.header, { backgroundColor: tokens.background, borderBottomColor: tokens.divider }]}
          onPress={() => setExpanded((e) => ({ ...e, [sec]: !e[sec] }))}
        >
          <View style={{ flex: 1 }}>
            <View style={styles.headerLeft}>
              <T variant="h1">{item.title}</T>
              <View style={[styles.pill, { backgroundColor: tokens.chip }]}><T variant="micro" style={{ color: tokens.primary }}>{item.count}</T></View>
            </View>
          </View>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={tokens.textMuted} />
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

    // cards row
    const cards = item.cards!;
    const fillCount = cols - cards.length;
    return (
      <View style={styles.cardRow}>
        {cards.map((it) => (
          <View key={it.id} style={{ width: cellW, marginRight: gap, marginBottom: gap }}>
            <PosterCard id={it.id} kind="shows" title={it.title} poster={it.posterUrl} progress={it.progress} width={cellW} style={{ marginRight: 0 }} />
          </View>
        ))}
        {Array.from({ length: fillCount }).map((_, i) => (
          <View key={'pad_' + i} style={{ width: cellW, marginRight: gap }} />
        ))}
      </View>
    );
  };

  return (
    <Screen>
      <Header title={t('social:myShows.title')} showBack />
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        stickyHeaderIndices={stickyIndices}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        renderItem={renderItem}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={6}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
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
  },
  emptyWrap: {
    paddingVertical: 20,
  },
});