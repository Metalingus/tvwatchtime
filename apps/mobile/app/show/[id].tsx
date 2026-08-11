import React, { useCallback, useRef, useState, useEffect } from 'react';
import {
  ImageBackground,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useLocalSearchParams, router, Link } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

/** Rows rendered when a season is first opened; the rest load via "show more". */
const INITIAL_EPISODES = 20;
// eslint-disable-next-line local/no-hardcoded-colors -- intentional dark media scrim over backdrop in both themes
const SHOW_SCRIM_COLORS = ['rgba(15,17,21,0.65)', 'rgba(15,17,21,0.05)', 'rgba(15,17,21,0.7)'] as [
  string,
  string,
  string,
];
import { Header } from '../../components/Header';
import { BadgeGrid, Carousel } from '../../components/cards';
import { RatingChart } from '../../components/RatingChart';
import { StarRatingControl, VotingSection } from '../../components/voting';
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
  qk,
  useEpisode,
  useDropMedia,
  useMarkEpisodeWatched,
  useMarkSeasonWatched,
  useRefreshShowMetadata,
  useRewatchEpisode,
  useRewatchSeason,
  useUnwatchEpisodeOnce,
  useUnwatchSeasonOnce,
  useShow,
  useShowEpisodes,
  useShowVotes,
  useToggleFavorite,
  useToggleTrackingPause,
  useToggleWatchlist,
} from '../../api/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { MediaStatus } from '@tvwatch/shared';
import { useAddToList } from '../../hooks/useAddToList';
import { useAppearance } from '../../context/PreferencesProvider';
import { useConfetti } from '../../components/Confetti';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../../theme/theme';
import { showError, showConfirm, showDialog } from '../../lib/dialog';
import { countryFlag } from '../../lib/country';
import { formatRuntime } from '../../lib/format';
import { EpisodeHistoryCarousel } from '../../components/EpisodeHistoryCarousel';
import { WhereToWatch } from '../../components/WhereToWatch';
import {
  countUnwatchedPreviousEpisodes,
  isEpisodeProgressEligible,
} from '../../lib/episode-progress';

export default function ShowDetailScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail', 'common', 'episode']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: show, isLoading, isError, isPlaceholderData, refetch } = useShow(id);
  // Canonicalize numeric-TMDB-id URLs (Similar rail): seed the detail cache under the
  // INTERNAL id and replace the route, so every hook/mutation (votes, favorite,
  // watchlist, episodes, comments) keys on one consistent id — no alias drift.
  useEffect(() => {
    if (show && id && show.id !== id) {
      qc.setQueryData(qk.show(show.id), show);
      router.replace(`/show/${show.id}`);
    }
  }, [show?.id]);
  const votes = useShowVotes(id);
  const [tab, setTab] = useState<'about' | 'episodes'>('about');
  const watchlist = useToggleWatchlist();
  const favorite = useToggleFavorite();
  const pause = useToggleTrackingPause();
  const droppedState = useDropMedia();
  const addToList = useAddToList();
  const [refreshing, setRefreshing] = useState(false);
  const refreshMetadata = useRefreshShowMetadata();
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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshMetadata.mutateAsync(id);
    } catch {
      // Provider outages still leave pull-to-refresh useful for local state.
      await Promise.all([
        refetch(),
        qc.refetchQueries({ queryKey: qk.showEpisodes(id), type: 'active' }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [id, qc, refetch, refreshMetadata]);
  const onVoteError = () => showError({ description: t('episode:voteFailed') });

  if (isError && !show)
    return (
      <Screen>
        <Header showBack />
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.md,
            padding: spacing.lg,
          }}
        >
          <T variant="h2">{t('common:failed')}</T>
          <Button title={t('common:retry')} onPress={() => void refetch()} />
        </View>
      </Screen>
    );

  if (isLoading || !show || show.id !== id)
    return (
      <Screen>
        <Header showBack />
        <Spinner />
      </Screen>
    );

  // Years + run status on their own row: "2024 – 2026 · Ended", "2024 – Returning",
  // or just "2024" when neither the end year nor the status is known.
  const statusLabel =
    show.status === MediaStatus.ENDED
      ? t('showDetail:statusEnded')
      : show.status === MediaStatus.CANCELED
        ? t('showDetail:statusCanceled')
        : show.status === MediaStatus.RETURNING
          ? t('showDetail:statusReturning')
          : null;
  const yearsText = !show.yearStart
    ? null
    : show.yearEnd
      ? `${show.yearStart} – ${show.yearEnd}${statusLabel ? ` · ${statusLabel}` : ''}`
      : show.status === MediaStatus.RETURNING && statusLabel
        ? `${show.yearStart} – ${statusLabel}`
        : `${show.yearStart}${statusLabel ? ` · ${statusLabel}` : ''}`;

  return (
    <Screen>
      {confettiEl}
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
          source={{ uri: show.images.backdrop ?? show.images.poster ?? undefined }}
          style={styles.backdrop}
          imageStyle={{ opacity: 1 }}
        >
          <LinearGradient
            colors={SHOW_SCRIM_COLORS}
            locations={[0, 0.45, 1]}
            style={styles.overlay}
          >
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
                      id: show.id,
                      title: show.title,
                      kind: 'show',
                      inWatchlist: show.inWatchlist,
                      dropped: show.dropped,
                      trackingPaused: show.trackingPaused,
                    })
                  }
                >
                  <Ionicons name="ellipsis-horizontal" size={24} color={tokens.mediaText} />
                </Pressable>
              }
            />
            <View style={{ padding: spacing.lg }}>
              <T variant="title" style={{ fontSize: 26, color: tokens.mediaText }}>
                {show.title}
              </T>
            </View>
            <View style={{ padding: spacing.lg, marginTop: 'auto' }}>
              {yearsText ? (
                <T variant="caption" style={{ color: tokens.mediaText, marginBottom: spacing.xs }}>
                  {yearsText}
                </T>
              ) : null}
              <View
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: spacing.xs,
                }}
              >
                <T variant="caption" style={{ color: tokens.mediaText }}>
                  {[
                    t('showDetail:seasonsCount', { count: show.seasonsCount }),
                    show.network || null,
                    ...(show.originCountries ?? []).map(countryFlag),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </T>
                {show.rating ? (
                  <>
                    <Ionicons name="star" size={11} color={tokens.warning} />
                    <T variant="caption" style={{ color: tokens.mediaText }}>
                      {show.rating.toFixed(1)}
                    </T>
                  </>
                ) : null}
              </View>
              <View style={{ marginTop: spacing.sm }}>
                <ProgressBar
                  value={show.userProgress ?? 0}
                  color={(show.userProgress ?? 0) >= 1 ? tokens.watched : tokens.primary}
                />
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
            <Pressable
              onPress={() => favorite.mutate({ id, on: !show.favorite, kind: 'shows' })}
              style={[styles.favBtn, { backgroundColor: tokens.surfaceElevated }]}
            >
              <Ionicons
                name={show.favorite ? 'heart' : 'heart-outline'}
                size={22}
                color={show.favorite ? tokens.favorite : tokens.textPrimary}
              />
            </Pressable>
          </View>

          {show.dropped ? (
            <Pressable
              onPress={() =>
                showConfirm({
                  title: t('showDetail:trackingDropped'),
                  description: t('showDetail:trackingDroppedDesc'),
                  confirmLabel: t('showDetail:resumeTracking'),
                  onConfirm: () => droppedState.mutate({ id, kind: 'show', dropped: false }),
                })
              }
              style={({ pressed }) => ({
                marginTop: spacing.sm,
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.xs,
                backgroundColor: tokens.surfaceElevated,
                borderRadius: radius.md,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Ionicons name="close-circle" size={18} color={tokens.warning} />
              <T variant="caption" style={{ flex: 1 }}>
                {t('showDetail:trackingDropped')}
              </T>
              <Ionicons name="chevron-forward" size={16} color={tokens.textMuted} />
            </Pressable>
          ) : show.trackingPaused ? (
            <Pressable
              onPress={() =>
                showConfirm({
                  title: t('showDetail:trackingPaused'),
                  description: t('showDetail:trackingPausedDesc', {
                    date: show.trackingPausedAt
                      ? new Date(show.trackingPausedAt).toLocaleDateString(undefined, {
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—',
                  }),
                  confirmLabel: t('showDetail:resumeTracking'),
                  onConfirm: () => pause.mutate({ id, paused: false }),
                })
              }
              style={({ pressed }) => ({
                marginTop: spacing.sm,
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.xs,
                backgroundColor: tokens.surfaceElevated,
                borderRadius: radius.md,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Ionicons name="pause-circle" size={18} color={tokens.warning} />
              <T variant="caption" style={{ flex: 1 }}>
                {t('showDetail:trackingPaused')}
              </T>
              <Ionicons name="chevron-forward" size={16} color={tokens.textMuted} />
            </Pressable>
          ) : null}

          {/* Negative margins break out of the parent's horizontal padding so the
              adjacent-card peeks sit flush with the screen edges. */}
          <View style={{ marginTop: spacing.lg, marginHorizontal: -spacing.lg }}>
            <EpisodeHistoryCarousel showId={id} />
          </View>

          {show.inWatchlist && (show.userProgress ?? 0) > 0 && show.interactions?.rating ? (
            <View style={{ marginTop: spacing.lg }}>
              <VotingSection title={t('showDetail:rateShow')}>
                <StarRatingControl
                  section={show.interactions.rating}
                  onSelect={(v) => votes.rating.mutate(v, { onError: onVoteError })}
                  pending={votes.rating.isPending}
                  t={t}
                />
              </VotingSection>
            </View>
          ) : null}
        </View>

        <View style={[styles.tabs, { paddingHorizontal: spacing.lg }]}>
          <Chip
            label={t('showDetail:about')}
            active={tab === 'about'}
            onPress={() => setTab('about')}
          />
          <Chip
            label={t('showDetail:episodes')}
            active={tab === 'episodes'}
            onPress={() => setTab('episodes')}
          />
        </View>

        {tab === 'episodes' ? (
          <EpisodesTab showId={id} />
        ) : isPlaceholderData ? (
          // Seeded hero from the list cache (title/artwork) — body waits for
          // the real detail payload so partial fields never flash.
          <Spinner />
        ) : (
          <AboutTab show={show} id={id} />
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
      {/* useAddToList contract: the calling screen renders the reassign modal
          (currently movie-only, but keeps the hook's render contract intact). */}
      {addToList.reassignModal}
    </Screen>
  );
}

function EpisodesTab({ showId }: { showId: string }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail', 'common']);
  const { data: seasons, isLoading } = useShowEpisodes(showId);
  const [open, setOpen] = useState<string | null>(null);
  // Seasons open with the first INITIAL_EPISODES rows only — soaps/anime with
  // 100–200+ episode seasons rendered every row (with images) inside the page
  // ScrollView otherwise. Expanded per season via the "show more" row.
  const [expandedAll, setExpandedAll] = useState<Record<string, boolean>>({});
  const markEp = useMarkEpisodeWatched();
  const rewatchEp = useRewatchEpisode();
  const unwatchOnceEp = useUnwatchEpisodeOnce();
  const markSeason = useMarkSeasonWatched();
  const rewatchSeason = useRewatchSeason();
  const unwatchSeasonOnce = useUnwatchSeasonOnce();
  const menu = useWatchMenu();

  const markEpisodeWatched = (season: any, episode: any) => {
    const previousCount = countUnwatchedPreviousEpisodes(seasons, season.number, episode.number);
    if (previousCount === 0) {
      markEp.mutate({ id: episode.id, on: true });
      return;
    }
    showDialog({
      title: t('showDetail:markPreviousTitle'),
      description: t('showDetail:markPreviousDescription', { count: previousCount }),
      buttons: [
        {
          label: t('showDetail:markPrevious'),
          variant: 'primary',
          onPress: () => markEp.mutate({ id: episode.id, on: true, includePrevious: true }),
        },
        {
          label: t('showDetail:onlyThisEpisode'),
          variant: 'secondary',
          onPress: () => markEp.mutate({ id: episode.id, on: true }),
        },
        { label: t('common:cancel'), variant: 'ghost' },
      ],
    });
  };

  if (isLoading) return <Spinner />;
  return (
    <View style={{ paddingHorizontal: spacing.lg, marginTop: spacing.md }}>
      {seasons?.map((s: any) => {
        const isOpen = open === s.id;
        const now = Date.now();
        // TVDB official episodes may be undated; exclude only explicit future episodes.
        const eligible = s.episodes.filter((e: any) => isEpisodeProgressEligible(e.airDate, now));
        const watched = eligible.filter((e: any) => e.watched).length;
        const fullyWatched = eligible.length > 0 && watched === eligible.length;
        // Season rewatch counter: the number of COMPLETE season viewings is the min
        // watchCount across ALL progress-eligible episodes — an unwatched episode counts 0,
        // so the badge drops as soon as the season is no longer complete (shown from
        // the 2nd complete viewing).
        const seasonWatchCount = eligible.length
          ? Math.min(...eligible.map((e: any) => (e.watched ? (e.watchCount ?? 0) : 0)))
          : 0;
        const shownEpisodes = expandedAll[s.id]
          ? s.episodes
          : s.episodes.slice(0, INITIAL_EPISODES);
        const hiddenCount = s.episodes.length - shownEpisodes.length;
        return (
          <Card key={s.id} style={{ marginBottom: spacing.md, padding: 0, overflow: 'hidden' }}>
            <Pressable
              style={{ flexDirection: 'row', alignItems: 'center', padding: spacing.md }}
              onPress={() => setOpen(isOpen ? null : s.id)}
            >
              <View style={{ flex: 1 }}>
                <T variant="h2">{s.title}</T>
                {eligible.length > 0 ? (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <T variant="caption" muted>
                        {t('showDetail:watchedSlashAired', { watched, total: eligible.length })}
                      </T>
                      {seasonWatchCount >= 2 ? (
                        <T variant="caption" style={{ color: tokens.primary }}>
                          {t('showDetail:rewatchCount', { count: seasonWatchCount })}
                        </T>
                      ) : null}
                    </View>
                    <View style={{ marginTop: 6, width: 120 }}>
                      <ProgressBar value={watched / eligible.length} color={tokens.watched} />
                    </View>
                  </>
                ) : (
                  <T variant="caption" muted>
                    {t('showDetail:notAiredYet')}
                  </T>
                )}
              </View>
              {eligible.length > 0 ? (
                fullyWatched ? (
                  <Pressable
                    hitSlop={8}
                    onPress={() => {
                      const confirmUnwatchSeason = () =>
                        showConfirm({
                          title: t('showDetail:unwatchSeasonConfirmTitle'),
                          description: t('showDetail:unwatchSeasonConfirmDesc', { title: s.title }),
                          confirmLabel: t('showDetail:unwatchSeason'),
                          destructive: true,
                          onConfirm: () => markSeason.mutate({ id: s.id, on: false }),
                        });
                      const buttons: {
                        label: string;
                        variant: 'primary' | 'secondary' | 'danger';
                        onPress: () => void;
                      }[] = [
                        {
                          label: t('showDetail:rewatchAll'),
                          variant: 'primary',
                          onPress: () => rewatchSeason.mutate(s.id),
                        },
                      ];
                      if (seasonWatchCount >= 2) {
                        buttons.push({
                          label: t('common:unwatchOnce'),
                          variant: 'secondary',
                          onPress: () => unwatchSeasonOnce.mutate(s.id),
                        });
                      }
                      buttons.push({
                        label: t('showDetail:unwatchSeason'),
                        variant: 'danger',
                        onPress: confirmUnwatchSeason,
                      });
                      showDialog({ title: s.title, buttons });
                    }}
                    style={{ paddingHorizontal: spacing.sm }}
                  >
                    <Ionicons name="ellipsis-horizontal" size={20} color={tokens.textMuted} />
                  </Pressable>
                ) : (
                  <Pressable
                    hitSlop={8}
                    onPress={() => markSeason.mutate({ id: s.id, on: true })}
                    style={{ paddingHorizontal: spacing.sm }}
                  >
                    <T variant="caption" style={{ color: tokens.primary }}>
                      {t('showDetail:markAll')}
                    </T>
                  </Pressable>
                )
              ) : null}
              <Ionicons
                name={isOpen ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={tokens.textMuted}
                style={{ marginLeft: spacing.sm }}
              />
            </Pressable>
            {isOpen ? (
              <>
                {shownEpisodes.map((e: any) => {
                  const isUpcoming = e.airDate && new Date(e.airDate) > new Date();
                  return (
                    <View
                      key={e.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        padding: spacing.sm,
                        borderTopColor: tokens.border,
                        borderTopWidth: 1,
                        opacity: isUpcoming ? 0.4 : 1,
                      }}
                    >
                      <Link href={`/episode/${e.id}` as any} asChild>
                        <Pressable style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
                          <PosterImage
                            uri={e.stillUrl}
                            style={{ width: 96, height: 54, borderRadius: radius.sm }}
                          />
                          <View style={{ flex: 1, marginLeft: spacing.sm }}>
                            <T variant="caption" muted>
                              S{String(s.number).padStart(2, '0')} E
                              {String(e.number).padStart(2, '0')}
                              {isUpcoming ? ` · ${t('showDetail:notAiredYet')}` : ''}
                            </T>
                            <T variant="body" numberOfLines={1}>
                              {e.title}
                            </T>
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
                                watchCount: e.watchCount ?? 0,
                                onMarkWatched: () => markEpisodeWatched(s, e),
                                onRewatch: () => rewatchEp.mutate(e.id),
                                onUnwatchOnce: () => unwatchOnceEp.mutate(e.id),
                                onUnwatch: () => markEp.mutate({ id: e.id, on: false }),
                              })
                            }
                          />
                        </View>
                      )}
                    </View>
                  );
                })}
                {hiddenCount > 0 ? (
                  <Pressable
                    onPress={() => setExpandedAll((p) => ({ ...p, [s.id]: true }))}
                    style={{
                      padding: spacing.md,
                      borderTopColor: tokens.border,
                      borderTopWidth: 1,
                    }}
                  >
                    <T variant="caption" style={{ color: tokens.primary, textAlign: 'center' }}>
                      {t('showDetail:showMoreEpisodes', { count: hiddenCount })}
                    </T>
                  </Pressable>
                ) : null}
              </>
            ) : null}
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
        <T variant="h2" style={{ marginBottom: spacing.sm }}>
          {t('showDetail:whereToWatch')}
        </T>
        <WhereToWatch
          watchProviders={show.watchProviders}
          legacyProviders={show.providers}
          emptyLabel={t('showDetail:noProviders')}
          mediaId={id}
        />
      </Card>

      <Card>
        <SectionHeader title={t('showDetail:communityRatings')} />
        <RatingChart seasonRatings={(show as any).seasonRatings} />
      </Card>

      <Card>
        <SectionHeader title={t('showDetail:showInfo')} />
        {show.originalTitle ? (
          <InfoRow label={t('showDetail:originalTitle')} value={show.originalTitle} />
        ) : null}
        <InfoRow
          label={t('showDetail:years')}
          value={`${show.yearStart ?? '—'}${show.yearEnd ? `–${show.yearEnd}` : ''}`}
        />
        <InfoRow
          label={t('showDetail:originCountry')}
          value={
            show.originCountries?.length ? show.originCountries.map(countryFlag).join(' ') : null
          }
        />
        <InfoRow label={t('showDetail:status')} value={show.status} />
        <InfoRow
          label={t('showDetail:genres')}
          value={show.genres?.map((g: any) => g.name).join(', ')}
        />
        <InfoRow
          label={t('showDetail:runtime')}
          value={formatRuntime(show.runtimeMinutes) ?? '—'}
        />
        <InfoRow label={t('showDetail:addedBy')} value={`${show.addedCount} users`} />
        <T variant="body" muted style={{ marginTop: spacing.sm }}>
          {show.overview}
        </T>
        {show.trailerUrl ? (
          <Button
            title={t('showDetail:watchTrailer')}
            variant="ghost"
            icon="play-circle-outline"
            onPress={() => Linking.openURL(show.trailerUrl!)}
            style={{ marginTop: spacing.md }}
          />
        ) : null}
      </Card>

      {show.cast?.length ? (
        <View>
          <SectionHeader title={t('showDetail:cast')} />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginHorizontal: -spacing.lg }}
            contentContainerStyle={{ paddingHorizontal: spacing.lg }}
          >
            {show.cast.map((c: any) => (
              <Pressable
                key={c.id}
                onPress={() => router.push(`/person/${c.id}` as any)}
                style={{ width: 80, marginRight: spacing.md, alignItems: 'center' }}
              >
                <PosterImage
                  uri={c.profileUrl}
                  style={{ width: 64, height: 64, borderRadius: 32 }}
                />
                <T variant="micro" style={{ textAlign: 'center', marginTop: 4 }} numberOfLines={2}>
                  {c.name}
                </T>
                <T variant="micro" muted numberOfLines={1}>
                  {c.character}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {show.recommendations?.length ? (
        <View style={{ marginHorizontal: -spacing.lg }}>
          <Carousel
            title={t('showDetail:similar')}
            kind="shows"
            // Recommendation items carry the TMDB id (not our internal id) — show/[id]
            // resolves numeric TMDB ids via the same route shape.
            data={show.recommendations
              .filter((r: any) => r.type !== 'MOVIE')
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

      <Pressable onPress={() => router.push(`/comments?type=SHOW&threadId=${id}`)}>
        <Card
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <T variant="h2" style={{ color: tokens.primary }}>
            {t('showDetail:comments')}
          </T>
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
      <T variant="caption" muted>
        {label}
      </T>
      <T variant="caption">{value}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { height: 260 },
  overlay: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md },
  favBtn: {
    marginLeft: spacing.sm,
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: { flexDirection: 'row', marginTop: spacing.lg, paddingBottom: spacing.sm },
});
