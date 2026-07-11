import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ImageBackground, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { MediaType } from '@tvwatch/shared';
import { Header, IconButton } from '../../components/Header';
import { Carousel } from '../../components/cards';
import { Leaderboard } from '../../components/Leaderboard';
import { Box, Button, Card, EmptyState, FavoriteButton, PosterImage, ProgressBar, Screen, SectionHeader, Skeleton, Spinner, StatsCard, T, APP_ICON } from '../../components/primitives';
import { ListCard } from '../../components/ListCard';
import { useMyLists, useFollowedLists } from '../../api/hooks';
import { useFavorites, useMe, useStatsSummary, useWatchlist } from '../../api/hooks';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { colors, radius, spacing } from '../../theme/theme';

export function fmtDuration(d?: { months: number; days: number; hours: number } | null): string {
  if (!d) return '0h';
  const parts: string[] = [];
  if (d.months) parts.push(`${d.months}mo`);
  if (d.days) parts.push(`${d.days}d`);
  if (d.hours) parts.push(`${d.hours}h`);
  return parts.join(' ') || '0h';
}

export default function ProfileScreen() {
  const { data: me, refetch: refetchMe } = useMe();
  const summary = useStatsSummary();
  const shows = useWatchlist(MediaType.SHOW);
  const movies = useWatchlist(MediaType.MOVIE);
  const favShows = useFavorites(MediaType.SHOW);
  const favMovies = useFavorites(MediaType.MOVIE);
  const myLists = useMyLists();
  const followedLists = useFollowedLists();
  const scrollRef = useRef<ScrollView>(null);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchMe(), summary.refetch(), shows.refetch(), movies.refetch(), favShows.refetch(), favMovies.refetch(), myLists.refetch(), followedLists.refetch()]);
    setRefreshing(false);
  }, [refetchMe, summary, shows, movies, favShows, favMovies]);
  useTabPressReset(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));

  // When the user has no cover image, fall back to a random backdrop from their watchlist.
  const coverFallback = useMemo(() => {
    const items = [...(shows.data?.items ?? []), ...(movies.data?.items ?? [])];
    const urls = items
      .map((it: any) => it.images?.backdrop ?? it.backdropUrl)
      .filter(Boolean) as string[];
    return urls.length ? urls[Math.floor(Math.random() * urls.length)] : undefined;
  }, [shows.data, movies.data]);

  return (
    <Screen>
      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}>
        <ProfileHeader user={me ?? null} fallbackCover={coverFallback} />

        {/* Stats carousel */}
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.lg }}>
            <MiniStat label="TV time watched" value={fmtDuration(summary.data?.tvTime)} icon="time-outline" />
            <MiniStat label="Episodes watched" value={`${summary.data?.episodesWatched ?? 0}`} icon="tv-outline" />
            <MiniStat label="Movie time watched" value={fmtDuration(summary.data?.movieTime)} icon="film-outline" />
            <MiniStat label="Movies watched" value={`${summary.data?.moviesWatched ?? 0}`} icon="videocam-outline" />
          </ScrollView>
        </View>

        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg, paddingBottom: 60 }}>
          {/* Stats link */}
          <Pressable onPress={() => router.push('/stats')}>
            <Card style={styles.chevron}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="stats-chart" size={20} color={colors.primary} />
                <T variant="h2" style={{ marginLeft: spacing.sm }}>Stats</T>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Card>
          </Pressable>

          {/* Find users */}
          <Pressable onPress={() => router.push('/find-user')}>
            <Card style={styles.chevron}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name="person-search-outline" size={20} color={colors.primary} />
                <T variant="h2" style={{ marginLeft: spacing.sm }}>Find Users</T>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Card>
          </Pressable>

          {/* Followers/Following quick links */}
          {me ? (
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Pressable onPress={() => router.push(`/follows?u=${me.username}&t=followers`)} style={{ flex: 1 }}>
                <Card style={{ alignItems: 'center' }}>
                  <T variant="h2">{me.followersCount ?? 0}</T>
                  <T variant="caption" muted>Followers</T>
                </Card>
              </Pressable>
              <Pressable onPress={() => router.push(`/follows?u=${me.username}&t=following`)} style={{ flex: 1 }}>
                <Card style={{ alignItems: 'center' }}>
                  <T variant="h2">{me.followingCount ?? 0}</T>
                  <T variant="caption" muted>Following</T>
                </Card>
              </Pressable>
            </View>
          ) : null}

          {/* Leaderboard */}
          <View>
            <SectionHeader title="Leaderboard" />
            <Leaderboard tabs={[{ key: 'combined', label: 'Total watch time' }]} />
          </View>

          {/* Shows */}
          <View>
            <SectionHeader title="Shows" action="See all" onAction={() => router.push('/myshows')} />
            <ShowsRow items={shows.data?.items ?? []} />
          </View>

          {/* Movies */}
          <View>
            <SectionHeader title="Movies" action="See all" onAction={() => router.push('/more?t=watchlist-movies')} />
            <ShowsRow items={movies.data?.items ?? []} kind="movies" />
          </View>

          {/* Favorite shows */}
          <View>
            <SectionHeader title="Favorite Shows" action="See all" onAction={() => router.push('/more?t=favorites-shows')} />
            {favShows.isLoading ? <Spinner /> : (favShows.data?.items?.length ? <ShowsRow items={favShows.data.items} /> : <FavEmpty label="Add favorite shows" />)}
          </View>

          {/* Favorite movies */}
          <View>
            <SectionHeader title="Favorite Movies" action="See all" onAction={() => router.push('/more?t=favorites-movies')} />
            {favMovies.isLoading ? <Spinner /> : (favMovies.data?.items?.length ? <ShowsRow items={favMovies.data.items} kind="movies" /> : <FavEmpty label="Add favorite movies" />)}
          </View>

          {/* My Lists */}
          <View>
            <SectionHeader title="My Lists" action="See all" onAction={() => router.push('/my-lists')} />
            {myLists.data?.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg }}>
                {myLists.data.map((list: any) => (
                  <ListCard key={list.id} item={list} onPress={() => router.push(`/list/${list.id}`)} />
                ))}
                <Pressable onPress={() => router.push('/create-list')} style={[{ width: 160, height: 220, borderRadius: 12, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' }]}>
                  <Ionicons name="add" size={32} color={colors.primary} />
                  <T variant="caption" style={{ color: colors.primary, marginTop: 4 }}>New list</T>
                </Pressable>
              </ScrollView>
            ) : (
              <Pressable onPress={() => router.push('/create-list')} style={{ alignItems: 'center', paddingVertical: spacing.lg }}>
                <Ionicons name="add-circle-outline" size={32} color={colors.primary} />
                <T variant="caption" muted style={{ marginTop: 4 }}>Create your first list</T>
              </Pressable>
            )}
          </View>

          {/* Followed Lists */}
          {followedLists.data?.length ? (
            <View>
              <SectionHeader title="Followed Lists" action="See all" onAction={() => router.push('/followed-lists')} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg }}>
                {followedLists.data.map((list: any) => (
                  <ListCard key={list.id} item={list} onPress={() => router.push(`/list/${list.id}`)} />
                ))}
              </ScrollView>
            </View>
          ) : null}

          <Button title="Import watch history" variant="ghost" icon="cloud-upload-outline" onPress={() => router.push('/import')} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function ProfileHeader({ user, fallbackCover }: { user: any; fallbackCover?: string }) {
  const insets = useSafeAreaInsets();
  const cover = user?.coverUrl ?? fallbackCover;
  return (
    <View>
      <ImageBackground source={cover ? { uri: cover } : undefined} style={styles.cover} imageStyle={{ opacity: 0.7 }}>
        <View style={styles.coverOverlay}>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingTop: insets.top + 4, paddingHorizontal: spacing.sm }}>
            <IconButton icon="notifications-outline" onPress={() => router.push('/notifications')} />
            <IconButton icon="settings-outline" onPress={() => router.push('/settings')} />
          </View>
          <View style={styles.profileRow}>
            <PosterImage uri={user?.avatarUrl} fallback={APP_ICON} style={styles.avatar} />
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <T variant="title">{user?.username ?? '…'}</T>
              <View style={{ flexDirection: 'row', marginTop: 6, gap: spacing.lg }}>
                <Counter label="Following" value={user?.followingCount} />
                <Counter label="Followers" value={user?.followersCount} />
                <Counter label="Comments" value={user?.commentsCount} />
              </View>
            </View>
          </View>
        </View>
      </ImageBackground>
    </View>
  );
}

function Counter({ label, value }: { label: string; value?: number }) {
  return (
    <View>
      <T variant="h2">{value ?? 0}</T>
      <T variant="micro" muted>{label}</T>
    </View>
  );
}

function MiniStat({ label, value, icon }: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap }) {
  return (
    <Card style={{ width: 150, marginRight: spacing.md, alignItems: 'flex-start' }}>
      <Ionicons name={icon} size={20} color={colors.primary} />
      <T variant="title" style={{ marginTop: spacing.sm }}>{value}</T>
      <T variant="caption" muted style={{ marginTop: 2 }}>{label}</T>
    </Card>
  );
}

function ShowsRow({ items, kind = 'shows' }: { items: any[]; kind?: 'shows' | 'movies' }) {
  const route = kind === 'shows' ? 'show' : 'movie';
  if (!items || items.length === 0) return <EmptyState title="Nothing here yet" icon="layers-outline" />;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: spacing.sm }}>
      {items.slice(0, 10).map((it) => (
        <Link key={it.id} href={`/${route}/${it.id}` as any} asChild>
          <Pressable style={{ marginRight: spacing.md }}>
            <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
              <PosterImage uri={it.images?.poster ?? it.posterUrl} style={{ width: 110, height: 165 }} />
              {it.userProgress !== undefined ? (
                <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 4 }}>
                  <ProgressBar value={it.userProgress} color={it.userProgress >= 1 ? colors.watched : colors.primary} />
                </View>
              ) : null}
            </View>
            <T variant="caption" numberOfLines={1} style={{ width: 110, marginTop: 4 }}>{it.title}</T>
          </Pressable>
        </Link>
      ))}
    </ScrollView>
  );
}

function FavEmpty({ label }: { label: string }) {
  return (
    <Card style={{ alignItems: 'center', padding: spacing.xl, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' }}>
      <Ionicons name="heart-outline" size={28} color={colors.favorite} />
      <T variant="body" muted style={{ marginTop: spacing.sm }}>{label}</T>
    </Card>
  );
}

const styles = StyleSheet.create({
  cover: { height: 170 },
  coverOverlay: { flex: 1, backgroundColor: 'rgba(15,17,21,0.55)', justifyContent: 'flex-end' },
  profileRow: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  avatar: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: colors.primary },
  chevron: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
