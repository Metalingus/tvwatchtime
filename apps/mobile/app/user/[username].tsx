import React, { useState } from 'react';
import { ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Polygon } from 'react-native-svg';
import type { MediaCardLiteDto, ProfileTasteGenreDto } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  PosterImage,
  Screen,
  SectionHeader,
  Spinner,
  T,
  APP_ICON,
} from '../../components/primitives';
import { ListCard } from '../../components/ListCard';
import { PosterCard } from '../../components/cards';
import { ActivityFeed } from '../../components/ActivityFeed';
import {
  usePublicProfile,
  useFollowUser,
  useUnfollowUser,
  useUserLists,
  useProfileTaste,
} from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { useTranslation } from 'react-i18next';

type ProfileTab = 'timeline' | 'taste';

function MediaRail({ items }: { items: MediaCardLiteDto[] }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.fullBleedRail}
      contentContainerStyle={styles.fullBleedRailContent}
    >
      {items.map((item) => (
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
          width={112}
        />
      ))}
    </ScrollView>
  );
}

function GenrePodiumBadge({ genre, rank }: { genre: ProfileTasteGenreDto; rank: number }) {
  const { tokens } = useAppearance();
  const featured = rank === 1;
  const size = featured ? 68 : 58;
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        marginTop: featured ? 0 : spacing.lg,
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
          <Polygon
            points="50,3 92,26 92,74 50,97 8,74 8,26"
            fill={tokens.surfaceElevated}
            stroke={featured ? tokens.primary : tokens.border}
            strokeWidth={4}
          />
        </Svg>
        <T style={{ fontSize: featured ? 30 : 25, lineHeight: featured ? 36 : 31 }}>{medal}</T>
      </View>
      <T variant="caption" numberOfLines={1} style={{ marginTop: spacing.sm, textAlign: 'center' }}>
        {genre.name}
      </T>
      <T variant="micro" muted style={{ marginTop: 1 }}>
        {genre.count}
      </T>
    </View>
  );
}

function GenrePodium({ genres }: { genres: ProfileTasteGenreDto[] }) {
  const topGenres = genres.slice(0, 3);
  const entries = [
    topGenres[1] ? { genre: topGenres[1], rank: 2 } : null,
    topGenres[0] ? { genre: topGenres[0], rank: 1 } : null,
    topGenres[2] ? { genre: topGenres[2], rank: 3 } : null,
  ].filter((entry): entry is { genre: ProfileTasteGenreDto; rank: number } => !!entry);

  return (
    <View style={{ flexDirection: 'row', minHeight: 112, alignItems: 'flex-start' }}>
      {entries.map(({ genre, rank }) => (
        <GenrePodiumBadge key={genre.id} genre={genre} rank={rank} />
      ))}
    </View>
  );
}

export default function UserProfileScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social', 'common', 'lists']);
  const { username } = useLocalSearchParams<{ username: string }>();
  const { data: profile, isLoading } = usePublicProfile(username);
  const [tab, setTab] = useState<ProfileTab>('timeline');
  const canSee = !!profile && (!profile.isPrivate || profile.isMe || profile.isFollowing);
  const { data: lists } = useUserLists(username, canSee);
  const taste = useProfileTaste(username, canSee && tab === 'taste');
  const followMut = useFollowUser();
  const unfollowMut = useUnfollowUser();

  if (isLoading || !profile)
    return (
      <Screen>
        <Header showBack />
        <Spinner />
      </Screen>
    );

  const toggleFollow = () => {
    if (profile.isFollowing) unfollowMut.mutate(profile.id);
    else followMut.mutate(profile.id);
  };

  const profileHeader = (
    <View>
      <View style={{ position: 'relative', height: 180 }}>
        <ImageBackground
          source={profile.coverUrl ? { uri: profile.coverUrl } : undefined}
          style={StyleSheet.absoluteFill}
        >
          <LinearGradient
            colors={['transparent', tokens.background]}
            style={StyleSheet.absoluteFill}
          />
        </ImageBackground>
        <View style={styles.identity}>
          <PosterImage
            uri={profile.avatarUrl}
            fallback={APP_ICON}
            style={StyleSheet.flatten([styles.avatar, { borderColor: tokens.background }])}
          />
          <View style={{ flex: 1, marginLeft: spacing.md, paddingBottom: 4 }}>
            <T variant="h1">@{profile.username}</T>
            {profile.displayName ? (
              <T variant="body" muted>
                {profile.displayName}
              </T>
            ) : null}
          </View>
        </View>
      </View>
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
        {profile.bio ? (
          <Card>
            <T variant="body">{profile.bio}</T>
          </Card>
        ) : null}
        <View style={{ flexDirection: 'row', gap: spacing.lg }}>
          <Pressable onPress={() => router.push(`/follows?u=${profile.username}&t=followers`)}>
            <T variant="h2">{profile.followersCount}</T>
            <T variant="caption" muted>
              {t('common:followers')}
            </T>
          </Pressable>
          <Pressable onPress={() => router.push(`/follows?u=${profile.username}&t=following`)}>
            <T variant="h2">{profile.followingCount}</T>
            <T variant="caption" muted>
              {t('common:following')}
            </T>
          </Pressable>
        </View>
        {!profile.isMe ? (
          <Button
            title={profile.isFollowing ? t('common:following') : t('common:follow')}
            onPress={toggleFollow}
            loading={followMut.isPending || unfollowMut.isPending}
            icon={profile.isFollowing ? 'checkmark-circle-outline' : 'person-add-outline'}
            variant={profile.isFollowing ? 'ghost' : 'primary'}
          />
        ) : null}
        <View style={{ flexDirection: 'row' }}>
          <Chip
            label={t('social:profileTaste.timeline')}
            active={tab === 'timeline'}
            onPress={() => setTab('timeline')}
          />
          <Chip
            label={t('social:profileTaste.taste')}
            active={tab === 'taste'}
            onPress={() => setTab('taste')}
          />
        </View>
      </View>
    </View>
  );

  if (!canSee) {
    return (
      <Screen>
        <Header showBack />
        <ScrollView>
          {profileHeader}
          <EmptyState
            icon="lock-closed-outline"
            title={t('social:profileTaste.privateTitle')}
            subtitle={t('social:profileTaste.privateSubtitle')}
          />
        </ScrollView>
      </Screen>
    );
  }

  if (tab === 'timeline') {
    return (
      <Screen>
        <Header showBack />
        <ActivityFeed username={username} collapseRuns={false} listHeader={profileHeader} />
      </Screen>
    );
  }

  const data = taste.data;
  return (
    <Screen>
      <Header showBack />
      <ScrollView showsVerticalScrollIndicator={false}>
        {profileHeader}
        <View style={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 60 }}>
          {taste.isLoading ? <Spinner /> : null}
          {data?.topGenres.movies.length ? (
            <View>
              <SectionHeader title={t('social:profileTaste.topMovieGenres')} />
              <GenrePodium genres={data.topGenres.movies} />
            </View>
          ) : null}
          {data?.topGenres.shows.length ? (
            <View>
              <SectionHeader title={t('social:profileTaste.topShowGenres')} />
              <GenrePodium genres={data.topGenres.shows} />
            </View>
          ) : null}
          {!profile.isMe && data?.commonGenres.length ? (
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="sparkles" size={20} color={tokens.primary} />
                <T variant="h2" style={{ marginLeft: spacing.sm }}>
                  {t('social:profileTaste.inCommon')}
                </T>
              </View>
              <T variant="body" muted style={{ marginTop: spacing.xs }}>
                {t('social:profileTaste.commonGenres', {
                  genres: data.commonGenres.map((g) => g.name).join(', '),
                })}
              </T>
            </Card>
          ) : null}
          {!profile.isMe && data?.recommendations.items.length ? (
            <View>
              <SectionHeader
                title={t('social:profileTaste.forYou')}
                action={t('common:seeAll')}
                onAction={() => router.push(`/user/${username}/more?kind=recommendations` as any)}
              />
              <MediaRail items={data.recommendations.items} />
            </View>
          ) : null}
          {data?.favoriteMovies.items.length ? (
            <View>
              <SectionHeader
                title={t('social:profileTaste.favoriteMovies')}
                action={t('common:seeAll')}
                onAction={() => router.push(`/user/${username}/more?kind=movies` as any)}
              />
              <MediaRail items={data.favoriteMovies.items} />
            </View>
          ) : null}
          {data?.favoriteShows.items.length ? (
            <View>
              <SectionHeader
                title={t('social:profileTaste.favoriteShows')}
                action={t('common:seeAll')}
                onAction={() => router.push(`/user/${username}/more?kind=shows` as any)}
              />
              <MediaRail items={data.favoriteShows.items} />
            </View>
          ) : null}
          {lists?.length ? (
            <View>
              <SectionHeader title={t('lists:publicLists')} />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.fullBleedRail}
                contentContainerStyle={styles.fullBleedRailContent}
              >
                {lists.map((list) => (
                  <ListCard
                    key={list.id}
                    item={list}
                    onPress={() => router.push(`/list/${list.id}`)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fullBleedRail: { marginHorizontal: -spacing.lg },
  fullBleedRailContent: { paddingHorizontal: spacing.lg },
  avatar: { width: 80, height: 80, borderRadius: 40, borderWidth: 3 },
  identity: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.lg,
  },
});
