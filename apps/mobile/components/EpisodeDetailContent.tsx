import React, { useEffect, useState } from 'react';
import { ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from './Header';
import { Card, Chip, EmptyState, PosterImage, Screen, SectionHeader, Spinner, T, WatchButton } from './primitives';
import { EpisodeNavigationArrows } from './EpisodeNavigationArrows';
import { useEpisode, useMarkEpisodeWatched } from '../api/hooks';
import { api } from '../api/client';
import { colors, radius, spacing } from '../theme/theme';
import { showConfirm } from '../lib/dialog';

const REACTIONS = [
  'Shocked', 'Frustrated', 'Sad', 'Reflective', 'Touched', 'Amused', 'Scared',
  'Bored', 'Understanding', 'Thrilled', 'Confused', 'Tense',
];
const DEVICES: { key: string; icon: any; label: string }[] = [
  { key: 'PHONE', icon: 'phone-portrait-outline', label: 'Phone' },
  { key: 'TABLET', icon: 'tablet-portrait-outline', label: 'Tablet' },
  { key: 'COMPUTER', icon: 'laptop-outline', label: 'Computer' },
  { key: 'TV', icon: 'tv-outline', label: 'TV' },
];

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
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [reaction, setReaction] = useState<string | null>(null);
  const [device, setDevice] = useState<string>('PHONE');

  // Initialize saved rating/reaction/device once the episode detail loads.
  useEffect(() => {
    if (!ep) return;
    setRating(ep.userRating ?? 0);
    setReaction(ep.userReaction ?? null);
    setDevice(ep.userDevice ?? 'PHONE');
  }, [ep]);

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
        <EmptyState title="Episode not found" subtitle="This episode may have been removed." icon="alert-circle-outline" />
      </Screen>
    );
  }

  const openComments = () => {
    const go = () => router.push(`/comments?type=EPISODE&threadId=${episodeId}`);
    if (ep.watched) return go();
    showConfirm({
      title: 'Spoilers ahead',
      description: 'Comments may contain spoilers for this episode. Do you want to continue?',
      confirmLabel: 'View comments',
      onConfirm: go,
    });
  };

  const voteCharacter = async (characterName?: string | null) => {
    if (!characterName || !ep.watched) return;
    try {
      await api.post(`/episodes/${episodeId}/character-vote`, { characterName });
      qc.invalidateQueries({ queryKey: ['episode'] });
    } catch {
      // ignore
    }
  };

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <ImageBackground
          source={{ uri: ep.stillUrl ?? ep.showImages.backdrop ?? undefined }}
          style={styles.hero}
          imageStyle={{ opacity: 0.6 }}
        >
          <View style={styles.overlay}>
            <Header
              showBack
              right={
                <Pressable hitSlop={10}>
                  <Ionicons name="share-outline" size={22} color={colors.text} />
                </Pressable>
              }
            />
            <View style={{ padding: spacing.lg }}>
              <Pressable onPress={() => router.push(`/show/${ep.showId}` as any)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.pill}>
                <T variant="caption" style={{ color: '#0F1115', fontWeight: '700' }}>{ep.showTitle}</T>
              </Pressable>
              <T variant="title" style={{ fontSize: 24, marginTop: spacing.sm }}>{ep.title}</T>
            </View>
            <EpisodeNavigationArrows
              onPrev={onPrev}
              onNext={onNext}
              center={
                <T variant="caption" style={styles.indicator}>
                  S{String(ep.seasonNumber).padStart(2, '0')} | E{String(ep.number).padStart(2, '0')}
                </T>
              }
            />
          </View>
        </ImageBackground>

        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg, marginTop: spacing.md }}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <T variant="caption" muted>{ep.watched ? 'Watched' : 'Not watched yet'}</T>
              {ep.airDate ? (
                <T variant="caption" muted>
                  Aired {new Date(ep.airDate).toLocaleDateString()}{ep.airTime ? ` at ${ep.airTime}` : ''}
                </T>
              ) : null}
            </View>
            <WatchButton
              watched={!!ep.watched}
              size={44}
              onPress={() => mark.mutate({ id: episodeId, on: !ep.watched, ...(rating ? { rating } : {}) })}
            />
          </Card>

          {/* How did you watch / Rating / Reactions — only once watched */}
          {ep.watched ? (
            <>
              <Card>
                <T variant="h2" style={{ marginBottom: spacing.sm }}>How did you watch?</T>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  {DEVICES.map((d) => (
                    <Pressable
                      key={d.key}
                      onPress={() => setDevice(d.key)}
                      style={[styles.deviceBtn, device === d.key && { borderColor: colors.primary }]}
                    >
                      <Ionicons name={d.icon} size={20} color={device === d.key ? colors.primary : colors.textMuted} />
                      <T variant="micro" style={{ color: device === d.key ? colors.primary : colors.textMuted, marginTop: 2 }}>{d.label}</T>
                    </Pressable>
                  ))}
                </View>
              </Card>

              <Card>
                <T variant="h2" style={{ marginBottom: spacing.sm }}>Rate this episode</T>
                <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.md }}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Pressable key={star} onPress={() => setRating(star)} hitSlop={6}>
                      <Ionicons name={star <= rating ? 'star' : 'star-outline'} size={32} color={star <= rating ? colors.primary : colors.textDim} />
                    </Pressable>
                  ))}
                </View>
                <T variant="caption" muted style={{ marginTop: 6, textAlign: 'center' }}>
                  {['', 'Bad', 'OK', 'Good', 'Great', 'Wow'][rating]}
                </T>
              </Card>

              <Card>
                <T variant="h2" style={{ marginBottom: spacing.sm }}>How did it feel?</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  {REACTIONS.map((r) => (
                    <Chip key={r} label={r} active={reaction === r} onPress={() => setReaction(reaction === r ? null : r)} />
                  ))}
                </View>
              </Card>
            </>
          ) : null}

          {/* Where to watch */}
          <Card>
            <SectionHeader title="Where to watch" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm }}>
              {ep.providers?.length ? ep.providers.map((p: any) => (
                <View key={p.id} style={{ alignItems: 'center', width: 64 }}>
                  <PosterImage uri={p.logoUrl} style={{ width: 44, height: 44, borderRadius: 8 }} />
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: 2 }}>{p.name}</T>
                </View>
              )) : <T variant="caption" muted>No providers available.</T>}
            </View>
          </Card>

          {/* Cast & Characters — with favorite-character vote % */}
          {ep.cast?.length ? (
            <View>
              <SectionHeader title="Cast & Characters" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {ep.cast.map((c: any) => {
                  const voted = !!ep.favoriteCharacterId && !!c.character && c.character.toLowerCase() === ep.favoriteCharacterId.toLowerCase();
                  return (
                    <Pressable
                      key={c.id}
                      disabled={!ep.watched || voted}
                      onPress={() => voteCharacter(c.character)}
                      style={{ width: 84, marginRight: spacing.md, alignItems: 'center' }}
                    >
                      <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: voted ? 3 : 0, borderColor: colors.primary, overflow: 'hidden' }}>
                        <PosterImage uri={c.profileUrl} style={{ width: 64, height: 64, borderRadius: 32 }} />
                        {c.votePct > 0 ? (
                          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.65)' }}>
                            <T variant="micro" style={{ textAlign: 'center', color: colors.primary }}>{c.votePct}%</T>
                          </View>
                        ) : null}
                      </View>
                      <T variant="micro" style={{ textAlign: 'center', marginTop: 4 }} numberOfLines={2}>{c.name}</T>
                      {c.character ? <T variant="micro" muted numberOfLines={1}>{c.character}</T> : null}
                      {voted ? (
                        <T variant="micro" style={{ color: colors.primary }}>Your pick</T>
                      ) : ep.watched ? (
                        <T variant="micro" muted>Tap to vote</T>
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          ) : null}

          <Card>
            <SectionHeader title="Episode info" />
            {ep.rating ? <T variant="caption" muted>Rating ★ {ep.rating.toFixed(1)}</T> : null}
            <T variant="body" muted style={{ marginTop: spacing.sm }}>{ep.overview ?? 'No description available.'}</T>
          </Card>

          <Pressable onPress={openComments}>
            <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View>
                <T variant="h2" style={{ color: colors.primary }}>Comments</T>
                {!ep.watched ? <T variant="micro" style={{ color: colors.orange }}>May contain spoilers</T> : null}
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
  overlay: { flex: 1, backgroundColor: 'rgba(15,17,21,0.6)' },
  pill: { alignSelf: 'flex-start', backgroundColor: colors.primary, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  indicator: {
    color: colors.text,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  deviceBtn: { alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, flex: 1, marginHorizontal: 2 },
});
