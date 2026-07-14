import React, { useCallback, useState } from 'react';
import { ImageBackground, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../../components/Header';
import { Button, Card, PosterImage, ProgressBar, Screen, SectionHeader, Spinner, T, useWatchMenu } from '../../components/primitives';
import {
  useMarkMovieWatched,
  useMovie,
  useRewatchMovie,
  useToggleFavorite,
  useToggleMovieWatchlist,
} from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../../theme/theme';

export default function MovieDetailScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['movies', 'common']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: movie, isLoading, refetch } = useMovie(id);
  const watched = useMarkMovieWatched();
  const rewatch = useRewatchMovie();
  const movieWatchlist = useToggleMovieWatchlist();
  const favorite = useToggleFavorite();
  const menu = useWatchMenu();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);

  if (isLoading || !movie) return <Screen><Header showBack /><Spinner /></Screen>;

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}>
        <ImageBackground source={{ uri: movie.images.backdrop ?? movie.images.poster ?? undefined }} style={styles.backdrop} imageStyle={{ opacity: 0.6 }}>
          <View style={[styles.overlay, { backgroundColor: tokens.mediaScrim }]}>
            <Header showBack />
            <View style={{ flexDirection: 'row', padding: spacing.lg }}>
              <PosterImage uri={movie.images.poster} style={{ width: 100, height: 150, borderRadius: radius.md }} />
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <T variant="title" style={{ fontSize: 22 }}>{movie.title}</T>
                <View style={{ flexDirection: 'row', marginTop: 6, gap: spacing.md }}>
                  {movie.releaseYear ? <T variant="caption" muted>{movie.releaseYear}</T> : null}
                  {movie.runtimeMinutes ? <T variant="caption" muted>· {movie.runtimeMinutes}m</T> : null}
                  {movie.rating ? <T variant="caption" style={{ color: tokens.primary }}>★ {movie.rating.toFixed(1)}</T> : null}
                </View>
                <T variant="caption" muted style={{ marginTop: spacing.sm }}>{movie.genres?.map((g: any) => g.name).join(' · ')}</T>
              </View>
            </View>
          </View>
        </ImageBackground>

        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg, marginTop: spacing.md }}>
          <View style={styles.actions}>
            <Button
              title={
                movie.watched
                  ? (movie.watchCount ?? 0) >= 2
                    ? t('movies:watchedButtonCount', { count: movie.watchCount })
                    : t('movies:watchedButton')
                  : t('movies:markAsWatched')
              }
              variant={movie.watched ? 'watched' : 'primary'}
              icon={movie.watched ? 'checkmark' : 'eye-outline'}
              onPress={() =>
                menu({
                  watched: !!movie.watched,
                  onMarkWatched: () => watched.mutate({ id, on: true }),
                  onRewatch: () => rewatch.mutate(id),
                  onUnwatch: () => watched.mutate({ id, on: false }),
                })
              }
              style={{ flex: 1 }}
            />
            <Button
              title={movie.inWatchlist ? t('movies:inWatchlist') : t('movies:addWatchlist')}
              variant={movie.inWatchlist ? 'watched' : 'ghost'}
              icon={movie.inWatchlist ? 'checkmark' : 'bookmark-outline'}
              onPress={() => movieWatchlist.mutate({ id, on: !movie.inWatchlist })}
              style={{ flex: 1, marginLeft: spacing.sm }}
            />
            <Pressable onPress={() => favorite.mutate({ id, on: !movie.favorite, kind: 'movies' })} style={[styles.favBtn, { backgroundColor: tokens.surfaceElevated }]}>
              <Ionicons name={movie.favorite ? 'heart' : 'heart-outline'} size={22} color={movie.favorite ? tokens.favorite : tokens.textPrimary} />
            </Pressable>
          </View>

          <Card>
            <T variant="h2" style={{ marginBottom: spacing.sm }}>{t('movies:overview')}</T>
            <T variant="body" muted>{movie.overview ?? t('movies:noOverview')}</T>
            {movie.trailerUrl ? <Button title={t('movies:watchTrailer')} variant="ghost" icon="play-circle-outline" style={{ marginTop: spacing.md }} onPress={() => Linking.openURL(movie.trailerUrl)} /> : null}
          </Card>

          <Card>
            <SectionHeader title={t('movies:whereToWatch')} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {movie.providers?.length ? movie.providers.map((p: any) => (
                <View key={p.id} style={{ alignItems: 'center', width: 64 }}>
                  <PosterImage uri={p.logoUrl} style={{ width: 44, height: 44, borderRadius: 8 }} />
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }}>{p.name}</T>
                </View>
              )) : <T variant="caption" muted>{t('movies:noProviders')}</T>}
            </View>
          </Card>

          {movie.cast?.length ? (
            <View>
              <SectionHeader title={t('movies:cast')} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {movie.cast.map((c: any) => (
                  <View key={c.id} style={{ width: 80, marginRight: spacing.md, alignItems: 'center' }}>
                    <PosterImage uri={c.profileUrl} style={{ width: 64, height: 64, borderRadius: 32 }} />
                    <T variant="micro" style={{ textAlign: 'center', marginTop: 4 }} numberOfLines={2}>{c.name}</T>
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <Pressable onPress={() => router.push(`/comments?type=MOVIE&threadId=${id}`)}>
            <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <T variant="h2" style={{ color: tokens.primary }}>{t('common:comments')}</T>
              <Ionicons name="chevron-forward" size={20} color={tokens.primary} />
            </Card>
          </Pressable>
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  backdrop: { height: 240 },
  overlay: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  favBtn: { marginLeft: spacing.sm, width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
});
