import React, { useState, useCallback, useEffect } from 'react';
import { ActivityIndicator, Dimensions, FlatList, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { PosterCard } from '../components/cards';
import { EmptyState, Screen, Spinner } from '../components/primitives';
import { useDiscoverSections, useFavorites, useWatchlist } from '../api/hooks';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';

const TITLES: Record<string, string> = {
  'trending-shows': 'Trending Shows',
  'trending-movies': 'Trending Movies',
  'top-for-you': 'Top Shows For You',
  'watchlist-shows': 'My Shows',
  'watchlist-movies': 'My Movies',
  'favorites-shows': 'Favorite Shows',
  'favorites-movies': 'Favorite Movies',
};

function useColumns() {
  const [width, setWidth] = useState(Dimensions.get('window').width);
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => setWidth(window.width));
    return () => sub?.remove();
  }, []);
  if (width >= 1200) return 6;
  if (width >= 900) return 5;
  if (width >= 768) return 4;
  return 3;
}

export default function MoreScreen() {
  const { tokens } = useAppearance();
  const { t } = useLocalSearchParams<{ t: string }>();
  const title = TITLES[t ?? ''] ?? 'Browse';
  const isMovies = t?.endsWith('movies');
  const kind: 'shows' | 'movies' = isMovies ? 'movies' : 'shows';
  const isTrending = t === 'trending-shows' || t === 'trending-movies';
  const trendingType = t === 'trending-movies' ? 'movies' : 'shows';

  const cols = useColumns();
  const screenWidth = Dimensions.get('window').width;
  const containerW = Math.min(screenWidth - spacing.lg * 2, 1200);
  const cardW = Math.floor((containerW - spacing.md * (cols - 1)) / cols);

  // --- Pagination for trending ---
  const [page, setPage] = useState(1);
  const [allItems, setAllItems] = useState<any[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const pageQuery = useQuery({
    queryKey: ['trending-page', trendingType, page],
    queryFn: () => api.get<{ items: any[]; hasMore: boolean }>(`/trending/${trendingType}?page=${page}`),
    enabled: isTrending,
    staleTime: 60000,
  });

  useEffect(() => {
    if (!isTrending || !pageQuery.data) return;
    const newItems = pageQuery.data.items ?? [];
    setAllItems((prev) => (page === 1 ? newItems : [...prev, ...newItems]));
    setHasMore(pageQuery.data.hasMore ?? false);
    setLoadingMore(false);
  }, [pageQuery.data, page, isTrending]);

  // Reset when tab changes
  useEffect(() => {
    if (isTrending) {
      setAllItems([]);
      setPage(1);
      setHasMore(true);
      setLoadingMore(false);
    }
  }, [t]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || pageQuery.isFetching) return;
    setLoadingMore(true);
    setPage((p) => p + 1);
  }, [hasMore, loadingMore, pageQuery.isFetching]);

  // --- Non-paginated hooks ---
  const sections = useDiscoverSections();
  const watchlistShows = useWatchlist(MediaType.SHOW);
  const watchlistMovies = useWatchlist(MediaType.MOVIE);
  const favShows = useFavorites(MediaType.SHOW);
  const favMovies = useFavorites(MediaType.MOVIE);

  // --- Collect items ---
  let items: any[] = [];
  let loading = false;
  if (isTrending) {
    items = allItems;
    loading = page === 1 && allItems.length === 0 && pageQuery.isLoading;
  } else {
    switch (t) {
      case 'top-for-you': items = sections.data?.topForYou ?? []; loading = sections.isLoading; break;
      case 'watchlist-shows': items = watchlistShows.data?.items ?? []; loading = watchlistShows.isLoading; break;
      case 'watchlist-movies': items = watchlistMovies.data?.items ?? []; loading = watchlistMovies.isLoading; break;
      case 'favorites-shows': items = favShows.data?.items ?? []; loading = favShows.isLoading; break;
      case 'favorites-movies': items = favMovies.data?.items ?? []; loading = favMovies.isLoading; break;
    }
  }

  // --- Chunk into rows ---
  const rows: { key: string; cards: any[] }[] = [];
  for (let i = 0; i < items.length; i += cols) {
    rows.push({ key: `row_${i}`, cards: items.slice(i, i + cols) });
  }

  return (
    <Screen>
      <Header title={title} showBack />
      {loading ? (
        <Spinner />
      ) : (
        <FlatList
          key={cols}
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ padding: spacing.lg, maxWidth: 1200, width: '100%', alignSelf: 'center' }}
          ListEmptyComponent={<EmptyState title="Nothing here yet" icon="film-outline" />}
          onEndReached={isTrending ? loadMore : undefined}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            isTrending && loadingMore ? (
              <ActivityIndicator color={tokens.primary} style={{ padding: spacing.lg }} />
            ) : null
          }
          renderItem={({ item: row }) => {
            const fillCount = cols - row.cards.length;
            return (
              <View style={{ flexDirection: 'row', marginBottom: spacing.md }}>
                {row.cards.map((item) => (
                  <PosterCard
                    key={item.id}
                    id={item.id}
                    kind={kind}
                    title={item.title}
                    poster={item.posterUrl ?? item.images?.poster}
                    progress={item.userProgress}
                    width={cardW}
                    style={{ marginRight: spacing.md }}
                  />
                ))}
                {Array.from({ length: fillCount }).map((_, i) => (
                  <View key={`pad_${i}`} style={{ width: cardW, marginRight: spacing.md }} />
                ))}
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}
