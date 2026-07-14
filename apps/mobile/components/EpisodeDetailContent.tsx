import React from 'react';
import { ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from './Header';
import { Card, EmptyState, PosterImage, Screen, SectionHeader, Spinner, T, WatchButton, useWatchMenu } from './primitives';
import { EpisodeNavigationArrows } from './EpisodeNavigationArrows';
import { VotingSection, DeviceTiles, StarRatingControl, ReactionGrid, FavoriteCharacterVote } from './voting';
import { useEpisode, useMarkEpisodeWatched, useEpisodeVotes, useRewatchEpisode } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../theme/theme';
import { showConfirm, showError } from '../lib/dialog';

const HERO_HEIGHT = 240;

/**
 * Full episode detail body for a single episode. Fetches its own detail so it can be
 * rendered independently inside the pager (one per page).
 */
export function EpisodeDetailContent({
  episodeId,
  onPrev,
  onNext,
}: {
  episodeId: string;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const { data: ep, isLoading } = useEpisode(episodeId);
  const mark = useMarkEpisodeWatched();
  const rewatch = useRewatchEpisode();
  const votes = useEpisodeVotes(episodeId);
  const { tokens } = useAppearance();
  const { t } = useTranslation(['episode', 'common']);
  const menu = useWatchMenu();

  if (isLoading) {
    return (
      <Screen>
        <Header showBack />
        <Spinner />
      </Screen>
    );
  }
  if (!ep) {
    return (
      <Screen>
        <Header showBack />
        <EmptyState title={t('episode:episodeNotFound')} subtitle={t('episode:episodeRemoved')} icon="alert-circle-outline" />
      </Screen>
    );
  }

  const openComments = () => {
    const go = () => router.push(`/comments?type=EPISODE&threadId=${episodeId}`);
    if (ep.watched) return go();
    showConfirm({
      title: t('episode:spoilersAhead'),
      description: t('episode:spoilersDesc'),
      confirmLabel: t('episode:viewComments'),
      onConfirm: go,
    });
  };

  // App-level error feedback (themed dialog, never a native alert).
  const onVoteError = () => showError({ description: t('episode:voteFailed') });
  const interactions = ep.interactions;

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <ImageBackground
          source={{ uri: ep.stillUrl ?? ep.showImages.backdrop ?? undefined }}
          style={styles.hero}
          imageStyle={{ opacity: 0.6 }}
        >
          <View style={[styles.overlay, { backgroundColor: tokens.mediaScrim }]}>
            <Header
              tone="media"
              showBack
              right={
                <Pressable hitSlop={10}>
                  <Ionicons name="share-outline" size={22} color={tokens.mediaText} />
                </Pressable>
              }
            />
            <View style={{ padding: spacing.lg }}>
              <Pressable onPress={() => router.push(`/show/${ep.showId}` as any)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={[styles.pill, { backgroundColor: tokens.primary }]}>
                <T variant="caption" style={{ color: tokens.primaryForeground, fontWeight: '700' }}>{ep.showTitle}</T>
              </Pressable>
              <T variant="title" style={{ fontSize: 24, marginTop: spacing.sm, color: tokens.mediaText }}>{ep.title}</T>
            </View>
            <EpisodeNavigationArrows
              onPrev={onPrev}
              onNext={onNext}
              center={
                <T variant="caption" style={[styles.indicator, { color: tokens.mediaText }]}>
                  S{String(ep.seasonNumber).padStart(2, '0')} | E{String(ep.number).padStart(2, '0')}
                </T>
              }
            />
          </View>
        </ImageBackground>

        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg, marginTop: spacing.md }}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              {ep.watched ? (
                ep.watchedAt ? (
                  <T variant="caption" muted>
                    {t('episode:watchedAt', {
                      date: new Date(ep.watchedAt).toLocaleDateString(undefined, {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      }),
                      time: new Date(ep.watchedAt).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                      }),
                    })}
                    {(ep.watchCount ?? 0) >= 2 ? `  ·  ×${ep.watchCount}` : ''}
                  </T>
                ) : (
                  <T variant="caption" muted>{t('episode:watched')}</T>
                )
              ) : (
                <T variant="caption" muted>{t('episode:notWatchedYet')}</T>
              )}
              {ep.airDate ? (
                <T variant="caption" muted>
                  {ep.airTime
                    ? t('episode:airedAtTime', { date: new Date(ep.airDate).toLocaleDateString(), time: ep.airTime })
                    : t('episode:airedAt', { date: new Date(ep.airDate).toLocaleDateString() })}
                </T>
              ) : null}
            </View>
            <WatchButton
              watched={!!ep.watched}
              watchCount={ep.watchCount ?? 0}
              size={44}
              onPress={() =>
                menu({
                  watched: !!ep.watched,
                  onMarkWatched: () => mark.mutate({ id: episodeId, on: true }),
                  onRewatch: () => rewatch.mutate(episodeId),
                  onUnwatch: () => mark.mutate({ id: episodeId, on: false }),
                })
              }
            />
          </Card>

          {/* Icon-based voting sections — only once watched */}
          {ep.watched && interactions ? (
            <>
              <VotingSection title={t('episode:howDidYouWatch')}>
                <DeviceTiles
                  section={interactions.device}
                  onSelect={(v) => votes.device.mutate(v, { onError: onVoteError })}
                  pending={votes.device.isPending}
                  t={t}
                />
              </VotingSection>

              <VotingSection title={t('episode:rateEpisode')}>
                <StarRatingControl
                  section={interactions.rating}
                  onSelect={(v) => votes.rating.mutate(v, { onError: onVoteError })}
                  pending={votes.rating.isPending}
                  t={t}
                />
              </VotingSection>

              <VotingSection title={t('episode:howDidItFeel')}>
                <ReactionGrid
                  section={interactions.reaction}
                  onSelect={(v) => votes.reaction.mutate(v, { onError: onVoteError })}
                  pending={votes.reaction.isPending}
                  t={t}
                />
              </VotingSection>

              {interactions.character && ep.cast?.length ? (
                <VotingSection title={t('episode:favoriteCharacter')}>
                  <FavoriteCharacterVote
                    cast={ep.cast}
                    section={interactions.character}
                    onSelect={(v) => votes.character.mutate(v, { onError: onVoteError })}
                    pending={votes.character.isPending}
                    t={t}
                  />
                </VotingSection>
              ) : null}
            </>
          ) : null}

          {/* Where to watch */}
          <Card>
            <SectionHeader title={t('episode:whereToWatch')} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm }}>
              {ep.providers?.length ? ep.providers.map((p: any) => (
                <View key={p.id} style={{ alignItems: 'center', width: 64 }}>
                  <PosterImage uri={p.logoUrl} style={{ width: 44, height: 44, borderRadius: 8 }} />
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }}>{p.name}</T>
                </View>
              )) : <T variant="caption" muted>{t('episode:noProviders')}</T>}
            </View>
          </Card>

          {/* Cast & Characters — browse-only (favorite voting is its own section above) */}
          {ep.cast?.length ? (
            <View>
              <SectionHeader title={t('episode:castAndCharacters')} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {ep.cast.map((c: any) => (
                  <View key={c.creditId} style={{ width: 84, marginRight: spacing.md, alignItems: 'center' }}>
                    <PosterImage uri={c.profileUrl} style={{ width: 64, height: 64, borderRadius: 32 }} />
                    <T variant="micro" numberOfLines={2} style={{ textAlign: 'center', marginTop: 4 }}>{c.name}</T>
                    {c.character ? <T variant="micro" muted numberOfLines={1} style={{ textAlign: 'center' }}>{c.character}</T> : null}
                  </View>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <Card>
            <SectionHeader title={t('episode:episodeInfo')} />
            {ep.rating ? <T variant="caption" muted>{t('episode:ratingLabel', { value: ep.rating.toFixed(1) })}</T> : null}
            <T variant="body" muted style={{ marginTop: spacing.sm }}>{ep.overview ?? t('episode:noDescription')}</T>
          </Card>

          <Pressable onPress={openComments}>
            <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View>
                <T variant="h2" style={{ color: tokens.primary }}>{t('episode:comments')}</T>
                {!ep.watched ? <T variant="micro" style={{ color: tokens.orange }}>{t('episode:mayContainSpoilers')}</T> : null}
              </View>
              <T variant="caption" muted>{ep.commentsCount}</T>
            </Card>
          </Pressable>
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { height: HERO_HEIGHT },
  overlay: { flex: 1 },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  indicator: {
    fontWeight: '700',
  },
});
