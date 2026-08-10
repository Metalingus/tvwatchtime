import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { PosterCard, cardProgress, cardYear } from '../components/cards';
import { LibraryEmptyState } from '../components/LibraryEmptyState';
import { Chip, EmptyState, Screen, Spinner, AnimatedFlatList } from '../components/primitives';
import { useFavoritePages, useGenres, useWatchedMoviePages, useWatchlistPages } from '../api/hooks';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAppearance } from '../context/PreferencesProvider';
import { useContentWidth } from '../hooks/useContentWidth';
import { spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

function useColumns() {
  const width = useContentWidth();
  if (width >= 1200) return 6;
  if (width >= 900) return 5;
  if (width >= 768) return 4;
  return 3;
}

export default function MoreScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social', 'common']);
  const {
    t: tab,
    g: initialGenre,
    x,
    s,
    c,
    a,
    k,
  } = useLocalSearchParams<{
    t: string;
    g?: string;
    /** Explore filters handed over as route params (x=excluded genres, k=tags, s=sort, c=country, a=hide anime). */
    x?: string;
    s?: string;
    c?: string;
    a?: string;
    k?: string;
  }>();
  // Genre filter (explore hands its active chip over via the `g` route param).
  const [genre, setGenre] = useState<string | null>(initialGenre ?? null);
  const genres = useGenres();
  const exploreFilters = {
    excludeGenres: x || undefined,
    tags: k || undefined,
    sort: s || undefined,
    country: c || undefined,
    hideAnime: a === '1' ? true : undefined,
  };

  const TITLES: Record<string, string> = {
    'trending-shows': t('social:more.trendingShows'),
    'trending-movies': t('social:more.trendingMovies'),
    'top-for-you': t('social:more.topShowsForYou'),
    'top-movies-for-you': t('social:more.topMoviesForYou'),
    'top-rated-shows': t('social:more.topRatedShows'),
    'top-rated-movies': t('social:more.topRatedMovies'),
    'now-playing-movies': t('social:more.nowPlayingMovies'),
    'watchlist-shows': t('social:more.myShows'),
    'watchlist-movies': t('social:more.myMovies'),
    'favorites-shows': t('social:more.favoriteShows'),
    'favorites-movies': t('social:more.favoriteMovies'),
  };

  const title = TITLES[tab ?? ''] ?? t('social:more.browse');
  const isMovies = tab === 'top-movies-for-you' || tab?.endsWith('movies');
  const kind: 'shows' | 'movies' = isMovies ? 'movies' : 'shows';
  const isTrending = tab === 'trending-shows' || tab === 'trending-movies';
  const trendingType = tab === 'trending-movies' ? 'movies' : 'shows';
  // Server-paged sections: trending, curated lists + personalized rails (all paginate).
  const LIST_PATHS: Record<string, string> = {
    'top-rated-shows': '/top-rated/shows',
    'top-rated-movies': '/top-rated/movies',
    'now-playing-movies': '/now-playing/movies',
  };
  const pagedPath =
    tab === 'top-for-you'
      ? '/discover/for-you/shows'
      : tab === 'top-movies-for-you'
        ? '/discover/for-you/movies'
        : isTrending
          ? `/trending/${trendingType}`
          : (LIST_PATHS[tab ?? ''] ?? null);

  const cols = useColumns();
  const screenWidth = useContentWidth();
  const containerW = Math.min(screenWidth - spacing.lg * 2, 1200);
  const cardW = Math.floor((containerW - spacing.md * (cols - 1)) / cols);

  // --- Pagination for server-paged sections ---
  // useInfiniteQuery owns the page list: refetches REPLACE page data in place,
  // so pages never duplicate and the FlatList never remounts mid-scroll (the
  // previous manual page/allItems accumulation re-appended the current page on
  // every refetch and reset scroll to the top). Filter changes are just a new
  // query key — no reset effects.
  const pageQuery = useInfiniteQuery({
    queryKey: ['more', pagedPath, genre ?? '', x ?? '', k ?? '', s ?? '', c ?? '', a ?? ''],
    queryFn: ({ pageParam }) =>
      api.get<{ items: any[]; hasMore: boolean; snapshotId?: string }>(pagedPath!, {
        page: pageParam.page,
        snapshot: pageParam.snapshot,
        genre: genre || undefined,
        ...exploreFilters,
      }),
    initialPageParam: { page: 1, snapshot: undefined as string | undefined },
    getNextPageParam: (last, pages) =>
      last.hasMore ? { page: pages.length + 1, snapshot: last.snapshotId } : undefined,
    enabled: !!pagedPath,
    staleTime: 60000,
  });

  const loadMore = useCallback(() => {
    if (!pageQuery.hasNextPage || pageQuery.isFetchingNextPage) return;
    pageQuery.fetchNextPage();
  }, [pageQuery]);

  // --- User collections: only the active collection fetches, 60 cards at a time. ---
  const watchlistShows = useWatchlistPages(MediaType.SHOW, genre, tab === 'watchlist-shows');
  const watchlistMovies = useWatchlistPages(MediaType.MOVIE, genre, tab === 'watchlist-movies');
  const favShows = useFavoritePages(MediaType.SHOW, genre, tab === 'favorites-shows');
  const favMovies = useFavoritePages(MediaType.MOVIE, genre, tab === 'favorites-movies');
  // Profile's My Movies destination is the watchlist collection. When that list is
  // empty, probe the other movie collections with one item each so we only describe
  // the whole library as empty when the user truly has no tracked movies anywhere.
  const isProfileMovieLibrary = tab === 'watchlist-movies' && !genre;
  const watchedMovieProbe = useWatchedMoviePages(isProfileMovieLibrary, 1);
  const favoriteMovieProbe = useFavoritePages(MediaType.MOVIE, null, isProfileMovieLibrary, 1);

  const collectionQuery =
    tab === 'watchlist-shows'
      ? watchlistShows
      : tab === 'watchlist-movies'
        ? watchlistMovies
        : tab === 'favorites-shows'
          ? favShows
          : tab === 'favorites-movies'
            ? favMovies
            : null;

  // --- Collect items ---
  const items: any[] = pagedPath
    ? (pageQuery.data?.pages.flatMap((p) => p.items ?? []) ?? [])
    : (collectionQuery?.items ?? []);
  const loading = pagedPath ? pageQuery.isLoading : !!collectionQuery?.isLoading;
  const checkingMovieLibraryEmpty =
    isProfileMovieLibrary &&
    watchlistMovies.isSuccess &&
    watchlistMovies.items.length === 0 &&
    (watchedMovieProbe.isPending || favoriteMovieProbe.isPending);
  const movieLibraryEmpty =
    isProfileMovieLibrary &&
    watchlistMovies.isSuccess &&
    watchedMovieProbe.isSuccess &&
    favoriteMovieProbe.isSuccess &&
    watchlistMovies.items.length === 0 &&
    watchedMovieProbe.items.length === 0 &&
    favoriteMovieProbe.items.length === 0;
  const loadNext = useCallback(() => {
    if (pagedPath) {
      loadMore();
      return;
    }
    if (collectionQuery?.hasNextPage && !collectionQuery.isFetchingNextPage) {
      collectionQuery.fetchNextPage();
    }
  }, [pagedPath, loadMore, collectionQuery]);

  // --- Chunk into rows ---
  // Row keys carry the first card's id (not just the index): when a refreshed
  // page inserts/removes items, Reanimated can slide surviving rows and fade
  // new ones in — index-keyed rows would silently swap content in place.
  const rows: { key: string; cards: any[] }[] = [];
  for (let i = 0; i < items.length; i += cols) {
    const slice = items.slice(i, i + cols);
    rows.push({ key: `row_${slice[0]?.id ?? i}_${i}`, cards: slice });
  }

  // Gate the grid on the first screenful of posters: every cell mounts at once and,
  // on a cold image cache, the placeholders sit empty for ~1s and then all pop in
  // together. Prefetching the visible rows first shows the spinner a beat longer,
  // then the grid appears with its posters (mirrors movies.tsx cache warming).
  const preloadKey = items
    .slice(0, cols * 4)
    .map((it) => it.posterUrl ?? it.images?.poster)
    .filter(Boolean)
    .join('|');
  const [postersReady, setPostersReady] = useState(false);
  // Gate ONLY the first paint. Re-gating whenever the first rows' data changed
  // (refetch, appended page) flipped postersReady back to false, which unmounted
  // the FlatList → visible flicker and scroll reset to the top. Appended pages
  // load their posters inline instead.
  const postersGatedRef = useRef(false);
  useEffect(() => {
    if (!preloadKey) {
      setPostersReady(true);
      return;
    }
    if (postersGatedRef.current) return;
    postersGatedRef.current = true;
    let alive = true;
    setPostersReady(false);
    // Fail-safe: never trap the grid behind a stalled prefetch.
    const failSafe = setTimeout(() => {
      if (alive) setPostersReady(true);
    }, 2000);
    Image.prefetch(preloadKey.split('|'))
      .catch(() => undefined)
      .finally(() => {
        if (alive) {
          clearTimeout(failSafe);
          setPostersReady(true);
        }
      });
    return () => {
      alive = false;
      clearTimeout(failSafe);
    };
  }, [preloadKey]);

  if (checkingMovieLibraryEmpty) {
    return (
      <Screen>
        <Header title={title} showBack />
        <Spinner />
      </Screen>
    );
  }

  if (movieLibraryEmpty) {
    return (
      <Screen>
        <Header title={title} showBack />
        <LibraryEmptyState
          kind="movies"
          refreshing={
            watchlistMovies.isRefetching ||
            watchedMovieProbe.isRefetching ||
            favoriteMovieProbe.isRefetching
          }
          onRefresh={() => {
            void Promise.all([
              watchlistMovies.refetch(),
              watchedMovieProbe.refetch(),
              favoriteMovieProbe.refetch(),
            ]);
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={title} showBack />
      {/* flexShrink: 0 — on web the default flex-shrink: 1 let the growing grid
          squeeze this row smaller with every paginated append. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0, marginBottom: spacing.sm }}
        contentContainerStyle={{ paddingHorizontal: spacing.lg }}
      >
        <Chip label={t('common:all')} active={!genre} onPress={() => setGenre(null)} />
        {(genres.data ?? []).map((g) => (
          <Chip
            key={g.id}
            label={g.name}
            active={genre === g.slug}
            onPress={() => setGenre(genre === g.slug ? null : g.slug)}
          />
        ))}
      </ScrollView>
      {loading || !postersReady ? (
        <Spinner />
      ) : (
        <AnimatedFlatList
          key={cols}
          data={rows}
          keyExtractor={(r) => r.key}
          initialNumToRender={cols * 4}
          maxToRenderPerBatch={cols * 4}
          windowSize={7}
          contentContainerStyle={{
            padding: spacing.lg,
            maxWidth: 1200,
            width: '100%',
            alignSelf: 'center',
          }}
          ListEmptyComponent={<EmptyState title={t('common:nothingHereYet')} icon="film-outline" />}
          onEndReached={pagedPath || collectionQuery ? loadNext : undefined}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            (pagedPath ? pageQuery.isFetchingNextPage : collectionQuery?.isFetchingNextPage) ? (
              <ActivityIndicator color={tokens.primary} style={{ padding: spacing.lg }} />
            ) : null
          }
          renderItem={({ item: row }) => {
            const fillCount = cols - row.cards.length;
            return (
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginBottom: spacing.md,
                }}
              >
                {row.cards.map((item) => (
                  <PosterCard
                    key={item.id}
                    id={item.id}
                    kind={kind}
                    title={item.title}
                    poster={item.posterUrl ?? item.images?.poster}
                    progress={cardProgress(item)}
                    rating={item.rating}
                    year={cardYear(item)}
                    width={cardW}
                    style={{ marginRight: 0 }}
                  />
                ))}
                {Array.from({ length: fillCount }).map((_, i) => (
                  <View key={`pad_${i}`} style={{ width: cardW }} />
                ))}
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}
