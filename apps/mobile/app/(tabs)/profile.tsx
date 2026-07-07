import React, { useRef } from 'react';
import { ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { MediaType } from '@tvwatch/shared';
import { Header, IconButton } from '../../components/Header';
import { Carousel } from '../../components/cards';
import { Leaderboard } from '../../components/Leaderboard';
import { Box, Button, Card, EmptyState, FavoriteButton, PosterImage, ProgressBar, Screen, SectionHeader, Skeleton, Spinner, StatsCard, T } from '../../components/primitives';
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
  const { data: me } = useMe();
  const summary = useStatsSummary();
  const shows = useWatchlist(MediaType.SHOW);
  const movies = useWatchlist(MediaType.MOVIE);
  const favShows = useFavorites(MediaType.SHOW);
  const favMovies = useFavorites(MediaType.MOVIE);
  const scrollRef = useRef<ScrollView>(null);
  useTabPressReset(() => scrollRef.current?.scrollTo({ y: 0, animated: true }));

  return (
    <Screen>
      <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
        <ProfileHeader user={me ?? null} />

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

          <Button title="Import watch history" variant="ghost" icon="cloud-upload-outline" onPress={() => router.push('/import')} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function ProfileHeader({ user }: { user: any }) {
  const insets = useSafeAreaInsets();
  return (
    <View>
      <ImageBackground source={{ uri: user?.coverUrl }} style={styles.cover} imageStyle={{ opacity: 0.7 }}>
        <View style={styles.coverOverlay}>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingTop: insets.top + 4, paddingHorizontal: spacing.sm }}>
            <IconButton icon="notifications-outline" onPress={() => router.push('/notifications')} />
            <IconButton icon="settings-outline" onPress={() => router.push('/settings')} />
          </View>
          <View style={styles.profileRow}>
            <PosterImage uri={user?.avatarUrl} style={styles.avatar} />
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
