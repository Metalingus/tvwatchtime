import React, { useCallback, useRef, useState, useEffect } from 'react';
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
  useWatchMenu,
} from '../../components/primitives';
import {
  useEpisode,
  useMarkEpisodeWatched,
  useMarkSeasonWatched,
  useRewatchEpisode,
  useShow,
  useShowEpisodes,
  useToggleFavorite,
  useToggleWatchlist,
} from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useConfetti } from '../../components/Confetti';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../../theme/theme';

export default function ShowDetailScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail', 'common']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: show, isLoading, refetch } = useShow(id);
  const [tab, setTab] = useState<'about' | 'episodes'>('episodes');
  const watchlist = useToggleWatchlist();
  const favorite = useToggleFavorite();
  const [refreshing, setRefreshing] = useState(false);
  const { confettiEl, fire } = useConfetti();
  const prevProgress = useRef<number | null>(null);

  // Fire confetti only when progress crosses from <1 to >=1 (not every visit at 100%)
  useEffect(() => {
    if (!show) return;
    const current = show.userProgress ?? 0;
    if (prevProgress.current !== null && prevProgress.current < 1 && current >= 1) {
      fire();
    }
    prevProgress.current = current;
  }, [show?.userProgress]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);

  if (isLoading || !show) return <Screen><Header showBack /><Spinner /></Screen>;

  return (
    <Screen>
      {confettiEl}
      <ScrollView showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}>
        <ImageBackground source={{ uri: show.images.backdrop ?? show.images.poster ?? undefined }} style={styles.backdrop} imageStyle={{ opacity: 1 }}>
          {/* eslint-disable-next-line local/no-hardcoded-colors -- intentional dark media scrim over backdrop (both themes) */}
          <LinearGradient colors={['rgba(15,17,21,0.65)', 'rgba(15,17,21,0.05)', 'rgba(15,17,21,0.7)']} locations={[0, 0.45, 1]} style={styles.overlay}>
            <Header showBack right={<Pressable hitSlop={10}><Ionicons name="ellipsis-horizontal" size={24} color={tokens.mediaText} /></Pressable>} />
            <View style={{ padding: spacing.lg }}>
              <T variant="title" style={{ fontSize: 26, color: tokens.mediaText }}>{show.title}</T>
            </View>
            <View style={{ padding: spacing.lg, marginTop: 'auto' }}>
              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                <T variant="caption" style={{ color: tokens.mediaText }}>{t('showDetail:seasonsCount', { count: show.seasonsCount })}</T>
                {show.network ? <T variant="caption" style={{ color: tokens.mediaText }}>· {show.network}</T> : null}
                {show.rating ? <T variant="caption" style={{ color: tokens.primary }}>★ {show.rating.toFixed(1)}</T> : null}
              </View>
              <View style={{ marginTop: spacing.sm }}>
                <ProgressBar value={show.userProgress ?? 0} color={(show.userProgress ?? 0) >= 1 ? tokens.watched : tokens.primary} />
              </View>
            </View>
          </LinearGradient>
        </ImageBackground>

        <View style={{ paddingHorizontal: spacing.lg }}>
          <View style={styles.actions}>
            <Button
              title={show.inWatchlist ? t('showDetail:inWatchlist') : t('showDetail:addWatchlist')}
              variant={show.inWatchlist ? 'watched' : 'primary'}
              icon={show.inWatchlist ? 'checkmark' : 'add'}
              onPress={() => watchlist.mutate({ id, on: !show.inWatchlist })}
              style={{ flex: 1 }}
            />
            <Pressable onPress={() => favorite.mutate({ id, on: !show.favorite, kind: 'shows' })} style={[styles.favBtn, { backgroundColor: tokens.surfaceElevated }]}>
              <Ionicons name={show.favorite ? 'heart' : 'heart-outline'} size={22} color={show.favorite ? tokens.favorite : tokens.textPrimary} />
            </Pressable>
          </View>
        </View>

        <View style={[styles.tabs, { paddingHorizontal: spacing.lg }]}>
          <Chip label={t('showDetail:episodes')} active={tab === 'episodes'} onPress={() => setTab('episodes')} />
          <Chip label={t('showDetail:about')} active={tab === 'about'} onPress={() => setTab('about')} />
        </View>

        {tab === 'episodes' ? <EpisodesTab showId={id} /> : <AboutTab show={show} id={id} />}
        <View style={{ height: 40 }} />
      </ScrollView>
    </Screen>
  );
}

function EpisodesTab({ showId }: { showId: string }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail', 'common']);
  const { data: seasons, isLoading } = useShowEpisodes(showId);
  const [open, setOpen] = useState<string | null>(null);
  const markEp = useMarkEpisodeWatched();
  const rewatchEp = useRewatchEpisode();
  const markSeason = useMarkSeasonWatched();
  const menu = useWatchMenu();

  if (isLoading) return <Spinner />;
  return (
    <View style={{ paddingHorizontal: spacing.lg, marginTop: spacing.md }}>
      {seasons?.map((s: any) => {
        const isOpen = open === s.id;
        const now = new Date();
        // Only count episodes that have AIRED (airDate exists and is in the past)
        const aired = s.episodes.filter((e: any) => e.airDate && new Date(e.airDate) <= now);
        const watched = aired.filter((e: any) => e.watched).length;
        return (
          <Card key={s.id} style={{ marginBottom: spacing.md, padding: 0, overflow: 'hidden' }}>
            <Pressable
              style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.md }}
              onPress={() => setOpen(isOpen ? null : s.id)}
            >
              <View style={{ flex: 1 }}>
                <T variant="h2">{s.title}</T>
                {aired.length > 0 ? (
                  <>
                    <T variant="caption" muted>{t('showDetail:watchedSlashAired', { watched, total: aired.length })}</T>
                    <View style={{ marginTop: 6, width: 120 }}>
                      <ProgressBar value={watched / aired.length} color={tokens.watched} />
                    </View>
                  </>
                ) : (
                  <T variant="caption" muted>{t('showDetail:notAiredYet')}</T>
                )}
              </View>
              {aired.length > 0 ? (
                <Pressable
                  hitSlop={8}
                  onPress={() => markSeason.mutate({ id: s.id, on: watched < aired.length })}
                  style={{ paddingHorizontal: spacing.sm }}
                >
                  <T variant="caption" style={{ color: watched < aired.length ? tokens.primary : tokens.textMuted }}>
                    {watched < aired.length ? t('showDetail:markAll') : t('showDetail:reset')}
                  </T>
                </Pressable>
              ) : null}
              <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={18} color={tokens.textMuted} style={{ marginLeft: spacing.sm }} />
            </Pressable>
            {isOpen
              ? s.episodes.map((e: any) => {
                  const isUpcoming = e.airDate && new Date(e.airDate) > new Date();
                  return (
                    <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.sm, borderTopColor: tokens.border, borderTopWidth: 1, opacity: isUpcoming ? 0.4 : 1 }}>
                      <Link href={`/episode/${e.id}` as any} asChild>
                        <Pressable style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                          <PosterImage uri={e.stillUrl} style={{ width: 96, height: 54, borderRadius: radius.sm }} />
                          <View style={{ flex: 1, marginLeft: spacing.sm }}>
                            <T variant="caption" muted>S{String(s.number).padStart(2, '0')} E{String(e.number).padStart(2, '0')}{isUpcoming ? ` · ${t('showDetail:notAiredYet')}` : ''}</T>
                            <T variant="body" numberOfLines={1}>{e.title}</T>
                          </View>
                        </Pressable>
                      </Link>
                      {isUpcoming ? null : (
                        <View style={{ marginLeft: spacing.sm }}>
                          <WatchButton
                            watched={e.watched}
                            watchCount={e.watchCount}
                            onPress={() =>
                              menu({
                                watched: e.watched,
                                onMarkWatched: () => markEp.mutate({ id: e.id, on: true }),
                                onRewatch: () => rewatchEp.mutate(e.id),
                                onUnwatch: () => markEp.mutate({ id: e.id, on: false }),
                              })
                            }
                          />
                        </View>
                      )}
                    </View>
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
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail', 'common']);
  return (
    <View style={{ paddingHorizontal: spacing.lg, marginTop: spacing.md, gap: spacing.lg }}>
      <Card>
        <T variant="h2" style={{ marginBottom: spacing.sm }}>{t('showDetail:whereToWatch')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {show.providers?.length ? (
            show.providers.map((p: any) => (
              <View key={p.id} style={{ alignItems: 'center', width: 64 }}>
                <PosterImage uri={p.logoUrl} style={{ width: 44, height: 44, borderRadius: 8 }} />
                <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }}>{p.name}</T>
              </View>
            ))
          ) : (
            <T variant="caption" muted>{t('showDetail:noProviders')}</T>
          )}
        </View>
      </Card>

      <Card>
        <SectionHeader title={t('showDetail:communityRatings')} />
        <RatingChart seasonRatings={(show as any).seasonRatings} />
      </Card>

      <Card>
        <SectionHeader title={t('showDetail:showInfo')} />
        <InfoRow label={t('showDetail:years')} value={`${show.yearStart ?? '—'}${show.yearEnd ? `–${show.yearEnd}` : ''}`} />
        <InfoRow label={t('showDetail:status')} value={show.status} />
        <InfoRow label={t('showDetail:genres')} value={show.genres?.map((g: any) => g.name).join(', ')} />
        <InfoRow label={t('showDetail:runtime')} value={show.runtimeMinutes ? `${show.runtimeMinutes}m` : '—'} />
        <InfoRow label={t('showDetail:addedBy')} value={`${show.addedCount} users`} />
        <T variant="body" muted style={{ marginTop: spacing.sm }}>{show.overview}</T>
        {show.trailerUrl ? (
          <Button title={t('showDetail:watchTrailer')} variant="ghost" icon="play-circle-outline" onPress={() => Linking.openURL(show.trailerUrl!)} style={{ marginTop: spacing.md }} />
        ) : null}
      </Card>

      {show.cast?.length ? (
        <View>
          <SectionHeader title={t('showDetail:cast')} />
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
          <T variant="h2" style={{ color: tokens.primary }}>{t('showDetail:comments')}</T>
          <Ionicons name="chevron-forward" size={20} color={tokens.primary} />
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
  overlay: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md },
  favBtn: { marginLeft: spacing.sm, width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', marginTop: spacing.lg, paddingBottom: spacing.sm },
});
