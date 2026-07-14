import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Header } from '../../components/Header';
import { Carousel, PosterCard } from '../../components/cards';
import { Chip, Screen, Spinner, T } from '../../components/primitives';
import { useDiscoverSections, useSearch } from '../../api/hooks';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing, typography } from '../../theme/theme';
import { useTranslation } from 'react-i18next';

export default function ExploreScreen() {
  const { tokens } = useAppearance();
  const { width } = useWindowDimensions();
  const { t } = useTranslation(['explore', 'common']);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [category, setCategory] = useState<'feed' | 'discover'>('discover');
  const discoverRef = useRef<ScrollView>(null);

  // Debounce so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const searching = debouncedQ.length > 1;
  const search = useSearch(debouncedQ, undefined);
  const sections = useDiscoverSections();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await sections.refetch(); setRefreshing(false); }, [sections]);

  // Adaptive grid: column count scales with the available width (same approach
  // as My Shows). Renders pre-grouped rows per the project grid pattern.
  const containerW = Math.max(0, width - spacing.lg * 2);
  const gridGap = spacing.sm;
  const cols = Math.max(2, Math.floor((containerW + gridGap) / (110 + gridGap)));
  const cellW = Math.floor((containerW - gridGap * (cols - 1)) / cols);

  const searchItems = search.data?.items ?? [];
  const searchRows: typeof searchItems[] = [];
  for (let i = 0; i < searchItems.length; i += cols) searchRows.push(searchItems.slice(i, i + cols));

  useTabPressReset(() => {
    setQ('');
    setDebouncedQ('');
    discoverRef.current?.scrollTo({ y: 0, animated: true });
  });

  return (
    <Screen>
      <Header title={t('explore:title')} />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <View style={[styles.search, { backgroundColor: tokens.surface }]}>
          <Ionicons name="search" size={18} color={tokens.textMuted} style={{ marginHorizontal: spacing.sm }} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('explore:searchPlaceholder')}
            placeholderTextColor={tokens.placeholder}
            style={[styles.input, { color: tokens.textPrimary }]}
          />
          {q.length > 0 ? (
            <Pressable onPress={() => { setQ(''); setDebouncedQ(''); }} hitSlop={10} style={{ paddingHorizontal: spacing.sm }}>
              <Ionicons name="close-circle" size={20} color={tokens.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', marginTop: spacing.sm }}>
          <Chip label={t('explore:discover')} active={category === 'discover'} onPress={() => setCategory('discover')} />
          <Chip label={t('explore:feed')} active={category === 'feed'} onPress={() => setCategory('feed')} />
          <Chip label={t('explore:groups')} onPress={() => {}} />
        </View>
      </View>

      {/* Adaptive grid (chunked rows) when searching. */}
      {searching ? (
        search.isLoading ? (
          <Spinner />
        ) : (
          <FlatList
            data={searchRows}
            key={`grid-${cols}`}
            contentContainerStyle={{ padding: spacing.lg }}
            keyExtractor={(row, i) => row[0]?.id ?? `row-${i}`}
            ListEmptyComponent={<T variant="body" muted>{t('explore:noResults', { query: debouncedQ })}</T>}
            renderItem={({ item: row }) => {
              const fill = cols - row.length;
              return (
                <View style={{ flexDirection: 'row' }}>
                  {row.map((item) => (
                    <View key={item.id} style={{ width: cellW, marginRight: gridGap, marginBottom: gridGap }}>
                      <PosterCard id={item.id} kind={item.type === 'SHOW' ? 'shows' : 'movies'} title={item.title} poster={item.images?.poster ?? item.images?.backdrop} width={cellW} style={{ marginRight: 0 }} />
                    </View>
                  ))}
                  {fill > 0
                    ? Array.from({ length: fill }).map((_, i) => (
                        <View key={'pad_' + i} style={{ width: cellW, marginRight: gridGap }} />
                      ))
                    : null}
                </View>
              );
            }}
          />
        )
      ) : (
        <ScrollView ref={discoverRef} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}>
          {sections.isLoading ? (
            <Spinner />
          ) : (
            <>
              <Carousel title={t('explore:topShowsForYou')} data={sections.data?.topForYou ?? []} kind="shows" action={t('explore:seeAll')} onAction={() => router.push('/more?t=top-for-you')} />
              <Carousel title={t('explore:trendingShows')} data={sections.data?.trendingShows ?? []} kind="shows" action={t('explore:seeAll')} onAction={() => router.push('/more?t=trending-shows')} />
              <Carousel title={t('explore:trendingMovies')} data={sections.data?.trendingMovies ?? []} kind="movies" action={t('explore:seeAll')} onAction={() => router.push('/more?t=trending-movies')} />
            </>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
  },
  input: { flex: 1, ...typography.body },
});