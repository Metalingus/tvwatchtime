import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Header } from '../../components/Header';
import { Carousel, PosterCard } from '../../components/cards';
import { Chip, Screen, Spinner, T } from '../../components/primitives';
import { useDiscoverSections, useSearch } from '../../api/hooks';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { colors, radius, spacing, typography } from '../../theme/theme';

export default function ExploreScreen() {
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

  useTabPressReset(() => {
    setQ('');
    setDebouncedQ('');
    discoverRef.current?.scrollTo({ y: 0, animated: true });
  });

  return (
    <Screen>
      <Header title="Explore" />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.textMuted} style={{ marginHorizontal: spacing.sm }} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search shows, movies, people…"
            placeholderTextColor={colors.textDim}
            style={styles.input}
          />
          {q.length > 0 ? (
            <Pressable onPress={() => { setQ(''); setDebouncedQ(''); }} hitSlop={10} style={{ paddingHorizontal: spacing.sm }}>
              <Ionicons name="close-circle" size={20} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', marginTop: spacing.sm }}>
          <Chip label="Discover" active={category === 'discover'} onPress={() => setCategory('discover')} />
          <Chip label="Feed" active={category === 'feed'} onPress={() => setCategory('feed')} />
          <Chip label="Groups" onPress={() => {}} />
        </View>
      </View>

      {/* Grid (FlatList, 3 cols) when searching — distinct type from the ScrollView below, so no numColumns reconciliation. */}
      {searching ? (
        search.isLoading ? (
          <Spinner />
        ) : (
          <FlatList
            data={search.data?.items ?? []}
            numColumns={3}
            contentContainerStyle={{ padding: spacing.lg }}
            keyExtractor={(i) => i.id}
            ListEmptyComponent={<T variant="body" muted>No results for “{debouncedQ}”.</T>}
            renderItem={({ item }) => (
              <PosterCard id={item.id} kind={item.type === 'SHOW' ? 'shows' : 'movies'} title={item.title} poster={item.images?.poster ?? item.images?.backdrop} width={108} />
            )}
          />
        )
      ) : (
        <ScrollView ref={discoverRef} showsVerticalScrollIndicator={false}>
          {sections.isLoading ? (
            <Spinner />
          ) : (
            <>
              <Carousel title="Top Shows For You" data={sections.data?.topForYou ?? []} kind="shows" action="See all" onAction={() => router.push('/more?t=top-for-you')} />
              <Carousel title="Trending Shows" data={sections.data?.trendingShows ?? []} kind="shows" action="See all" onAction={() => router.push('/more?t=trending-shows')} />
              <Carousel title="Trending Movies" data={sections.data?.trendingMovies ?? []} kind="movies" action="See all" onAction={() => router.push('/more?t=trending-movies')} />
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
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    height: 44,
  },
  input: { flex: 1, color: colors.text, ...typography.body },
});
