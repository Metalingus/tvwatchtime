import React, { useCallback, useEffect, useState } from 'react';
import {
  ImageBackground,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../../components/Header';
import { Carousel } from '../../components/cards';
import {
  Button,
  Card,
  PosterImage,
  ProgressBar,
  Screen,
  SectionHeader,
  Spinner,
  T,
  useWatchMenu,
} from '../../components/primitives';
import {
  FavoriteCharacterVote,
  ReactionGrid,
  StarRatingControl,
  VotingSection,
} from '../../components/voting';
import {
  qk,
  useMarkMovieWatched,
  useMovie,
  useMovieVotes,
  useRewatchMovie,
  useToggleFavorite,
  useToggleMovieWatchlist,
} from '../../api/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { useAddToList } from '../../hooks/useAddToList';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';
import { countryFlag } from '../../lib/country';
import { formatRuntime } from '../../lib/format';
import { WhereToWatch } from '../../components/WhereToWatch';

export default function MovieDetailScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['movies', 'common', 'episode']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: movie, isLoading, isPlaceholderData, refetch } = useMovie(id);
  const qc = useQueryClient();
  // Canonicalize numeric-TMDB-id URLs (Similar rail): seed the detail cache under the
  // INTERNAL id and replace the route, so every hook/mutation (votes, favorite,
  // watchlist, watched, comments) keys on one consistent id — no alias drift.
  useEffect(() => {
    if (movie && id && movie.id !== id) {
      qc.setQueryData(qk.movie(movie.id), movie);
      router.replace(`/movie/${movie.id}`);
    }
  }, [movie?.id]);
  const votes = useMovieVotes(id);
  const watched = useMarkMovieWatched();
  const rewatch = useRewatchMovie();
  const movieWatchlist = useToggleMovieWatchlist();
  const favorite = useToggleFavorite();
  const menu = useWatchMenu();
  const addToList = useAddToList();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);
  const onVoteError = () => showError({ description: t('episode:voteFailed') });

  if (isLoading || !movie || movie.id !== id)
    return (
      <Screen>
        <Header showBack />
        <Spinner />
      </Screen>
    );

  return (
    <Screen>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        }
      >
        <ImageBackground
          source={{ uri: movie.images.backdrop ?? movie.images.poster ?? undefined }}
          style={styles.backdrop}
          imageStyle={{ opacity: 0.6 }}
        >
          <View style={[styles.overlay, { backgroundColor: tokens.mediaScrim }]}>
            <Header
              showBack
              tone="media"
              right={
                <Pressable
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t('common:moreOptions')}
                  onPress={() =>
                    addToList.openMediaMenu({
                      id: movie.id,
                      title: movie.title,
                      kind: 'movie',
                      inWatchlist: movie.inWatchlist,
                      canReassign: movie.canReassign,
                    })
                  }
                >
                  <Ionicons name="ellipsis-horizontal" size={24} color={tokens.mediaText} />
                </Pressable>
              }
            />
            <View style={{ flexDirection: 'row', padding: spacing.lg }}>
              <PosterImage
                uri={movie.images.poster}
                style={{ width: 100, height: 150, borderRadius: radius.md }}
              />
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <T variant="title" style={{ fontSize: 22 }}>
                  {movie.title}
                </T>
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    marginTop: 6,
                    gap: spacing.xs,
                  }}
                >
                  <T variant="caption" muted>
                    {[
                      movie.releaseYear ? String(movie.releaseYear) : null,
                      formatRuntime(movie.runtimeMinutes),
                      movie.country ? countryFlag(movie.country) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </T>
                  {movie.rating ? (
                    <>
                      <Ionicons name="star" size={11} color={tokens.warning} />
                      <T variant="caption" muted>
                        {movie.rating.toFixed(1)}
                      </T>
                    </>
                  ) : null}
                </View>
                <T variant="caption" muted style={{ marginTop: spacing.sm }}>
                  {movie.genres?.map((g: any) => g.name).join(' · ')}
                </T>
              </View>
            </View>
          </View>
        </ImageBackground>

        {isPlaceholderData ? (
          // Seeded hero from the list cache (title/artwork/year/rating) — body
          // waits for the real detail payload so partial fields never flash.
          <Spinner />
        ) : (
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg, marginTop: spacing.md }}>
            <View style={styles.actions}>
              <Button
                title={
                  movie.watched
                    ? (movie.watchCount ?? 0) >= 2
                      ? t('movies:watchedButtonCount', { count: movie.watchCount })
                      : t('movies:watchedButton')
                    : t('common:watch')
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
                style={styles.mainAction}
              />
              {!movie.watched ? (
                <Button
                  title={movie.inWatchlist ? t('movies:inWatchlist') : t('movies:addWatchlist')}
                  variant={movie.inWatchlist ? 'watched' : 'ghost'}
                  icon={movie.inWatchlist ? 'checkmark' : 'bookmark-outline'}
                  onPress={() => movieWatchlist.mutate({ id, on: !movie.inWatchlist })}
                  style={styles.watchlistAction}
                />
              ) : null}
              <Pressable
                onPress={() => favorite.mutate({ id, on: !movie.favorite, kind: 'movies' })}
                style={[styles.favBtn, { backgroundColor: tokens.surfaceElevated }]}
              >
                <Ionicons
                  name={movie.favorite ? 'heart' : 'heart-outline'}
                  size={22}
                  color={movie.favorite ? tokens.favorite : tokens.textPrimary}
                />
              </Pressable>
            </View>

            {movie.watched && movie.interactions?.rating ? (
              <VotingSection title={t('movies:rateMovie')}>
                <StarRatingControl
                  section={movie.interactions.rating}
                  onSelect={(v) => votes.rating.mutate(v, { onError: onVoteError })}
                  pending={votes.rating.isPending}
                  t={t}
                />
              </VotingSection>
            ) : null}

            {movie.watched && movie.interactions?.reaction ? (
              <VotingSection title={t('episode:howDidItFeel')}>
                <ReactionGrid
                  section={movie.interactions.reaction}
                  onSelect={(v) => votes.reaction.mutate(v, { onError: onVoteError })}
                  pending={votes.reaction.isPending}
                  t={t}
                />
              </VotingSection>
            ) : null}

            {movie.watched && movie.interactions?.character && movie.cast?.length ? (
              <VotingSection title={t('common:favoriteCharacter')}>
                <FavoriteCharacterVote
                  cast={movie.cast}
                  section={movie.interactions.character}
                  onSelect={(v) => votes.character.mutate(v, { onError: onVoteError })}
                  pending={votes.character.isPending}
                  horizontalInset={spacing.lg}
                  t={t}
                />
              </VotingSection>
            ) : null}

            <Card>
              <T variant="h2" style={{ marginBottom: spacing.sm }}>
                {t('movies:overview')}
              </T>
              <T variant="body" muted>
                {movie.overview ?? t('movies:noOverview')}
              </T>
              {movie.trailerUrl ? (
                <Button
                  title={t('movies:watchTrailer')}
                  variant="ghost"
                  icon="play-circle-outline"
                  style={{ marginTop: spacing.md }}
                  onPress={() => Linking.openURL(movie.trailerUrl!)}
                />
              ) : null}
            </Card>

            <Card>
              <SectionHeader title={t('movies:whereToWatch')} />
              <WhereToWatch
                watchProviders={movie.watchProviders}
                legacyProviders={movie.providers}
                emptyLabel={t('movies:noProviders')}
                mediaId={movie.id}
              />
            </Card>

            {movie.cast?.length ? (
              <View>
                <SectionHeader title={t('movies:cast')} />
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginHorizontal: -spacing.lg }}
                  contentContainerStyle={{ paddingHorizontal: spacing.lg }}
                >
                  {movie.cast.map((c: any) => (
                    <Pressable
                      key={c.id}
                      onPress={() => router.push(`/person/${c.id}` as any)}
                      style={{ width: 80, marginRight: spacing.md, alignItems: 'center' }}
                    >
                      <PosterImage
                        uri={c.profileUrl}
                        style={{ width: 64, height: 64, borderRadius: 32 }}
                      />
                      <T
                        variant="micro"
                        style={{ textAlign: 'center', marginTop: 4 }}
                        numberOfLines={2}
                      >
                        {c.name}
                      </T>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            {movie.recommendations?.length ? (
              <View style={{ marginHorizontal: -spacing.lg }}>
                <Carousel
                  title={t('movies:similar')}
                  kind="movies"
                  // Recommendation items carry the TMDB id (not our internal id) —
                  // movie/[id] resolves numeric TMDB ids via the same route shape.
                  data={movie.recommendations
                    .filter((r: any) => r.type !== 'SHOW')
                    .map((r: any) => ({
                      id: String(r.tmdbId),
                      title: r.title,
                      posterUrl: r.posterUrl,
                      year: r.year,
                      rating: r.rating,
                    }))}
                />
              </View>
            ) : null}

            <Pressable onPress={() => router.push(`/comments?type=MOVIE&threadId=${id}`)}>
              <Card
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <T variant="h2" style={{ color: tokens.primary }}>
                  {t('common:comments')}
                </T>
                <Ionicons name="chevron-forward" size={20} color={tokens.primary} />
              </Card>
            </Pressable>
          </View>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
      {addToList.reassignModal}
    </Screen>
  );
}

const styles = StyleSheet.create({
  backdrop: { height: 240 },
  overlay: { flex: 1 },
  // stretch (default) so the two action buttons are always equal height — in some
  // languages one label wraps to two lines while the other stays on one.
  actions: { flexDirection: 'row' },
  mainAction: { flex: 1 },
  watchlistAction: { flex: 1, marginLeft: spacing.sm },
  favBtn: {
    marginLeft: spacing.sm,
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
});
