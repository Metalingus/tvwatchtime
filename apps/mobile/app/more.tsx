import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { PosterGrid } from '../components/cards';
import { EmptyState, Screen, Spinner } from '../components/primitives';
import {
  useDiscoverSections,
  useFavorites,
  useTrendingMovies,
  useTrendingShows,
  useWatchlist,
} from '../api/hooks';

const TITLES: Record<string, string> = {
  'trending-shows': 'Trending Shows',
  'trending-movies': 'Trending Movies',
  'top-for-you': 'Top Shows For You',
  'watchlist-shows': 'My Shows',
  'watchlist-movies': 'My Movies',
  'favorites-shows': 'Favorite Shows',
  'favorites-movies': 'Favorite Movies',
};

export default function MoreScreen() {
  const { t } = useLocalSearchParams<{ t: string }>();
  const title = TITLES[t ?? ''] ?? 'Browse';
  const isMovies = t?.endsWith('movies');

  const trendingShows = useTrendingShows();
  const trendingMovies = useTrendingMovies();
  const sections = useDiscoverSections();
  const watchlistShows = useWatchlist(MediaType.SHOW);
  const watchlistMovies = useWatchlist(MediaType.MOVIE);
  const favShows = useFavorites(MediaType.SHOW);
  const favMovies = useFavorites(MediaType.MOVIE);

  let items: any[] = [];
  let loading = false;
  switch (t) {
    case 'trending-shows': items = trendingShows.data ?? []; loading = trendingShows.isLoading; break;
    case 'trending-movies': items = trendingMovies.data ?? []; loading = trendingMovies.isLoading; break;
    case 'top-for-you': items = sections.data?.topForYou ?? []; loading = sections.isLoading; break;
    case 'watchlist-shows': items = watchlistShows.data?.items ?? []; loading = watchlistShows.isLoading; break;
    case 'watchlist-movies': items = watchlistMovies.data?.items ?? []; loading = watchlistMovies.isLoading; break;
    case 'favorites-shows': items = favShows.data?.items ?? []; loading = favShows.isLoading; break;
    case 'favorites-movies': items = favMovies.data?.items ?? []; loading = favMovies.isLoading; break;
  }

  const kind: 'shows' | 'movies' = isMovies ? 'movies' : 'shows';

  return (
    <Screen>
      <Header title={title} showBack />
      {loading ? (
        <Spinner />
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}>
          <PosterGrid data={items} kind={kind} emptyTitle="Nothing here yet" minCardWidth={isMovies ? 160 : 110} />
        </ScrollView>
      )}
    </Screen>
  );
}
