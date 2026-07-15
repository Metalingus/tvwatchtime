import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { PosterCard } from '../../components/cards';
import { EmptyState, Screen, Spinner, T } from '../../components/primitives';
import { useFavorites, useHistory, useWatchlist } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions } from 'react-native';
import { spacing } from '../../theme/theme';

interface MovieItem { id: string; title: string; posterUrl?: string | null; progress?: number; watched?: boolean }
type SectionKey = 'watchlist' | 'watched' | 'favorites';

interface FlatRow {
  type: 'header' | 'empty' | 'cards';
  key: string;
  title?: string;
  count?: number;
  section?: SectionKey;
  message?: string;
  cards?: MovieItem[];
}

export default function MoviesScreen() {
  const { width } = useWindowDimensions();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['movies', 'common']);
  const watchlist = useWatchlist(MediaType.MOVIE);
  const watched = useHistory({ mediaType: MediaType.MOVIE, page: 1 });
  const favorites = useFavorites(MediaType.MOVIE);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([watchlist.refetch(), watched.refetch(), favorites.refetch()]);
    setRefreshing(false);
  }, [watchlist, watched, favorites]);
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({ watchlist: true, watched: false, favorites: true });
  const [listRef] = useState<{ current: FlatList | null }>({ current: null });

  const containerW = width - 32;
  const gap = 8;
  const cols = Math.max(2, Math.floor((containerW + gap) / (160 + gap))); // wider cards for movies
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);

  const watchedIds = new Set((watched.data?.items ?? []).map((h: any) => h.mediaId));
  const watchlistItems: MovieItem[] = (watchlist.data?.items ?? []).map((m: any) => {
    const watched = watchedIds.has(m.id);
    return { id: m.id, title: m.title, posterUrl: m.images?.poster ?? m.posterUrl, watched, progress: watched ? 1 : undefined };
  });
  const watchedItems: MovieItem[] = (watched.data?.items ?? []).map((h: any) => ({
    id: h.mediaId, title: h.title, posterUrl: h.posterUrl, watched: true, progress: 1,
  }));
  const favoriteItems = (favorites.data?.items ?? []).map((m: any) => {
    const watched = watchedIds.has(m.id);
    return { id: m.id, title: m.title, posterUrl: m.images?.poster ?? m.posterUrl, watched, progress: watched ? 1 : undefined };
  });

  const sections: { key: SectionKey; title: string; empty: string; items: MovieItem[] }[] = [
    { key: 'watchlist', title: t('movies:watchlist'), empty: t('movies:watchlistEmpty'), items: watchlistItems },
    { key: 'watched', title: t('movies:watched'), empty: t('movies:watchedEmpty'), items: watchedItems },
    { key: 'favorites', title: t('movies:favorites'), empty: t('movies:favoritesEmpty'), items: favoriteItems },
  ];

  const rows: FlatRow[] = [];
  for (const s of sections) {
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

  const anyLoading = watchlist.isLoading || watched.isLoading || favorites.isLoading;

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
      return <View style={styles.emptyWrap}><EmptyState title={item.message!} icon="film-outline" /></View>;
    }
    const cards = item.cards!;
    const fillCount = cols - cards.length;
    return (
      <View style={styles.cardRow}>
        {cards.map((it) => (
          <View key={it.id} style={{ width: cellW, marginRight: gap, marginBottom: gap }}>
            <PosterCard id={it.id} kind="movies" title={it.title} poster={it.posterUrl} progress={it.progress} width={cellW} style={{ marginRight: 0 }} />
          </View>
        ))}
        {Array.from({ length: fillCount }).map((_, i) => (
          <View key={'pad_' + i} style={{ width: cellW, marginRight: gap }} />
        ))}
      </View>
    );
  };

  if (anyLoading) {
    return (
      <Screen>
        <Header title={t('movies:title')} />
        <Spinner />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Movies" />
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        stickyHeaderIndices={stickyIndices}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        renderItem={renderItem}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}
        windowSize={6}
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
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  cardRow: { flexDirection: 'row' },
  emptyWrap: { paddingVertical: 20 },
});
