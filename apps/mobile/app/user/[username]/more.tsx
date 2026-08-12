import React, { useMemo } from 'react';
import { FlatList, View } from 'react-native';
import { MediaType } from '@tvwatch/shared';
import { useLocalSearchParams } from 'expo-router';
import { Header } from '../../../components/Header';
import { PosterCard } from '../../../components/cards';
import { Screen, Spinner } from '../../../components/primitives';
import { usePublicFavorites, useTasteRecommendations } from '../../../api/hooks';
import { spacing } from '../../../theme/theme';
import { useContentWidth } from '../../../hooks/useContentWidth';
import { useTranslation } from 'react-i18next';

export default function UserTasteMoreScreen() {
  const { username, kind } = useLocalSearchParams<{ username: string; kind: string }>();
  const { t } = useTranslation(['social']);
  const recommendations = useTasteRecommendations(username, undefined, kind === 'recommendations');
  const favoriteType = kind === 'movies' ? MediaType.MOVIE : MediaType.SHOW;
  const favorites = usePublicFavorites(username, favoriteType, kind !== 'recommendations');
  const query = kind === 'recommendations' ? recommendations : favorites;
  const items = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  );
  const width = useContentWidth();
  const contentWidth = width - spacing.lg * 2;
  const gap = spacing.sm;
  const cols = Math.max(3, Math.floor((contentWidth + gap) / (96 + gap)));
  const cardWidth = Math.floor((contentWidth - gap * (cols - 1)) / cols);
  const rows = useMemo(() => {
    const result: (typeof items)[] = [];
    for (let index = 0; index < items.length; index += cols)
      result.push(items.slice(index, index + cols));
    return result;
  }, [cols, items]);
  const title =
    kind === 'recommendations'
      ? t('social:profileTaste.forYou')
      : kind === 'movies'
        ? t('social:profileTaste.favoriteMovies')
        : t('social:profileTaste.favoriteShows');

  return (
    <Screen>
      <Header showBack title={title} />
      <FlatList
        data={rows}
        key={`taste-${cols}`}
        contentContainerStyle={{ padding: spacing.lg }}
        keyExtractor={(row, index) => row[0]?.id ?? String(index)}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
        }}
        onEndReachedThreshold={0.6}
        ListFooterComponent={query.isFetchingNextPage || query.isLoading ? <Spinner /> : null}
        renderItem={({ item: row }) => (
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: gap }}
          >
            {row.map((item) => (
              <PosterCard
                key={item.id}
                id={item.id}
                kind={item.type === 'SHOW' ? 'shows' : 'movies'}
                title={item.title}
                poster={item.images.poster ?? item.images.backdrop}
                rating={item.rating}
                year={item.year}
                progress={item.userProgress}
                showLibraryControl
                inWatchlist={item.inWatchlist}
                watched={item.watched}
                width={cardWidth}
                style={{ marginRight: 0 }}
              />
            ))}
            {Array.from({ length: cols - row.length }).map((_, index) => (
              <View key={`spacer-${index}`} style={{ width: cardWidth }} />
            ))}
          </View>
        )}
      />
    </Screen>
  );
}
