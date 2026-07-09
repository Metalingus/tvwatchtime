import React, { useCallback, useState } from 'react';
import { ImageBackground, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, router, Link } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../../components/Header';
import { BadgeGrid, Carousel } from '../../components/cards';
import { RatingChart } from '../../components/RatingChart';
import {
  Box,
  Button,
  Card,
  Chip,
  FavoriteButton,
  PosterImage,
  ProgressBar,
  Screen,
  SectionHeader,
  Spinner,
  StatusChip,
  T,
  WatchButton,
} from '../../components/primitives';
import {
  useEpisode,
  useMarkEpisodeWatched,
  useMarkSeasonWatched,
  useShow,
  useShowEpisodes,
  useToggleFavorite,
  useToggleWatchlist,
} from '../../api/hooks';
import { colors, radius, spacing } from '../../theme/theme';

export default function ShowDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: show, isLoading, refetch } = useShow(id);
  const [tab, setTab] = useState<'about' | 'episodes'>('episodes');
  const watchlist = useToggleWatchlist();
  const favorite = useToggleFavorite();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);

  if (isLoading || !show) return <Screen><Header showBack /><Spinner /></Screen>;

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}>
        <ImageBackground source={{ uri: show.images.backdrop ?? show.images.poster ?? undefined }} style={styles.backdrop} imageStyle={{ opacity: 1 }}>
          <LinearGradient colors={['rgba(15,17,21,0.65)', 'rgba(15,17,21,0.05)', 'rgba(15,17,21,0.7)']} locations={[0, 0.45, 1]} style={styles.overlay}>
            <Header showBack right={<Pressable hitSlop={10}><Ionicons name="ellipsis-horizontal" size={24} color={colors.text} /></Pressable>} />
            <View style={{ padding: spacing.lg }}>
              <T variant="title" style={{ fontSize: 26 }}>{show.title}</T>
            </View>
            <View style={{ padding: spacing.lg, marginTop: 'auto' }}>
              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                <T variant="caption" muted>{show.seasonsCount} seasons</T>
                {show.network ? <T variant="caption" muted>· {show.network}</T> : null}
                {show.rating ? <T variant="caption" style={{ color: colors.primary }}>★ {show.rating.toFixed(1)}</T> : null}
              </View>
              <View style={{ marginTop: spacing.sm }}>
                <ProgressBar value={show.userProgress ?? 0} color={(show.userProgress ?? 0) >= 1 ? colors.watched : colors.primary} />
              </View>
            </View>
          </LinearGradient>
        </ImageBackground>

        <View style={{ paddingHorizontal: spacing.lg }}>
          <View style={styles.actions}>
            <Button
              title={show.inWatchlist ? 'In Watchlist' : 'Add to Watchlist'}
              variant={show.inWatchlist ? 'watched' : 'primary'}
              icon={show.inWatchlist ? 'checkmark' : 'add'}
              onPress={() => watchlist.mutate({ id, on: !show.inWatchlist })}
              style={{ flex: 1 }}
            />
            <Pressable onPress={() => favorite.mutate({ id, on: !show.favorite, kind: 'shows' })} style={styles.favBtn}>
              <Ionicons name={show.favorite ? 'heart' : 'heart-outline'} size={22} color={show.favorite ? colors.favorite : colors.text} />
            </Pressable>
          </View>
        </View>

        <View style={[styles.tabs, { paddingHorizontal: spacing.lg }]}>
          <Chip label="Episodes" active={tab === 'episodes'} onPress={() => setTab('episodes')} />
          <Chip label="About" active={tab === 'about'} onPress={() => setTab('about')} />
        </View>

        {tab === 'episodes' ? <EpisodesTab showId={id} /> : <AboutTab show={show} id={id} />}
        <View style={{ height: 40 }} />
      </ScrollView>
    </Screen>
  );
}

function EpisodesTab({ showId }: { showId: string }) {
  const { data: seasons, isLoading } = useShowEpisodes(showId);
  const [open, setOpen] = useState<string | null>(null);
  const markEp = useMarkEpisodeWatched();
  const markSeason = useMarkSeasonWatched();

  if (isLoading) return <Spinner />;
  return (
    <View style={{ paddingHorizontal: spacing.lg, marginTop: spacing.md }}>
      {seasons?.map((s: any) => {
        const isOpen = open === s.id;
        const now = new Date();
        const aired = s.episodes.filter((e: any) => !e.airDate || new Date(e.airDate) <= now);
        const watched = aired.filter((e: any) => e.watched).length;
        return (
          <Card key={s.id} style={{ marginBottom: spacing.md, padding: 0, overflow: 'hidden' }}>
            <Pressable
              style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.md }}
              onPress={() => setOpen(isOpen ? null : s.id)}
            >
              <View style={{ flex: 1 }}>
                <T variant="h2">{s.title}</T>
                <T variant="caption" muted>{watched}/{aired.length} watched</T>
                <View style={{ marginTop: 6, width: 120 }}>
                  <ProgressBar value={aired.length ? watched / aired.length : 0} color={colors.watched} />
                </View>
              </View>
              <Pressable
                hitSlop={8}
                onPress={() => markSeason.mutate({ id: s.id, on: watched < aired.length })}
                style={{ paddingHorizontal: spacing.sm }}
              >
                <T variant="caption" style={{ color: watched < s.episodes.length ? colors.primary : colors.textMuted }}>
                  {watched < s.episodes.length ? 'Mark all' : 'Reset'}
                </T>
              </Pressable>
              <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} style={{ marginLeft: spacing.sm }} />
            </Pressable>
            {isOpen
              ? s.episodes.map((e: any) => {
                  const isUpcoming = e.airDate && new Date(e.airDate) > new Date();
                  return (
                    <Link key={e.id} href={`/episode/${e.id}` as any} asChild>
                      <Pressable style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.sm, borderTopColor: colors.border, borderTopWidth: 1, opacity: isUpcoming ? 0.4 : 1 }}>
                        <PosterImage uri={e.stillUrl} style={{ width: 96, height: 54, borderRadius: radius.sm }} />
                        <View style={{ flex: 1, marginLeft: spacing.sm }}>
                          <T variant="caption" muted>S{String(s.number).padStart(2, '0')} E{String(e.number).padStart(2, '0')}{isUpcoming ? ' · Not aired yet' : ''}</T>
                          <T variant="body" numberOfLines={1}>{e.title}</T>
                        </View>
                        {isUpcoming ? null : <WatchButton watched={e.watched} onPress={() => markEp.mutate({ id: e.id, on: !e.watched })} />}
                      </Pressable>
                    </Link>
                  );
                })
              : null}
          </Card>
        );
      })}
    </View>
  );
}

function AboutTab({ show, id }: { show: any; id: string }) {
  return (
    <View style={{ paddingHorizontal: spacing.lg, marginTop: spacing.md, gap: spacing.lg }}>
      <Card>
        <T variant="h2" style={{ marginBottom: spacing.sm }}>Where to watch</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {show.providers?.length ? (
            show.providers.map((p: any) => (
              <View key={p.id} style={{ alignItems: 'center', width: 64 }}>
                <PosterImage uri={p.logoUrl} style={{ width: 44, height: 44, borderRadius: 8 }} />
                <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }}>{p.name}</T>
              </View>
            ))
          ) : (
            <T variant="caption" muted>No providers available.</T>
          )}
        </View>
      </Card>

      <Card>
        <SectionHeader title="Community ratings" />
        <RatingChart seasonRatings={(show as any).seasonRatings} />
      </Card>

      <Card>
        <SectionHeader title="Show info" />
        <InfoRow label="Years" value={`${show.yearStart ?? '—'}${show.yearEnd ? `–${show.yearEnd}` : ''}`} />
        <InfoRow label="Status" value={show.status} />
        <InfoRow label="Genres" value={show.genres?.map((g: any) => g.name).join(', ')} />
        <InfoRow label="Runtime" value={show.runtimeMinutes ? `${show.runtimeMinutes}m` : '—'} />
        <InfoRow label="Added by" value={`${show.addedCount} users`} />
        <T variant="body" muted style={{ marginTop: spacing.sm }}>{show.overview}</T>
        {show.trailerUrl ? (
          <Button title="Watch trailer" variant="ghost" icon="play-circle-outline" onPress={() => Linking.openURL(show.trailerUrl!)} style={{ marginTop: spacing.md }} />
        ) : null}
      </Card>

      {show.cast?.length ? (
        <View>
          <SectionHeader title="Cast" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {show.cast.map((c: any) => (
              <View key={c.id} style={{ width: 80, marginRight: spacing.md, alignItems: 'center' }}>
                <PosterImage uri={c.profileUrl} style={{ width: 64, height: 64, borderRadius: 32 }} />
                <T variant="micro" style={{ textAlign: 'center', marginTop: 4 }} numberOfLines={2}>{c.name}</T>
                <T variant="micro" muted numberOfLines={1}>{c.character}</T>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <Pressable onPress={() => router.push(`/comments?type=SHOW&threadId=${id}`)}>
        <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T variant="h2" style={{ color: colors.primary }}>Comments</T>
          <Ionicons name="chevron-forward" size={20} color={colors.primary} />
        </Card>
      </Pressable>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <T variant="caption" muted>{label}</T>
      <T variant="caption">{value}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { height: 260 },
  overlay: { flex: 1, backgroundColor: 'rgba(15,17,21,0.6)' },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md },
  favBtn: { marginLeft: spacing.sm, width: 50, height: 50, borderRadius: 25, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', marginTop: spacing.lg, paddingBottom: spacing.sm },
});
