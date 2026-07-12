import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Header } from './Header';
import { Card, Chip, EmptyState, PosterImage, Screen, SectionHeader, Spinner, T, WatchButton } from './primitives';
import { EpisodeNavigationArrows } from './EpisodeNavigationArrows';
import { useEpisode, useMarkEpisodeWatched } from '../api/hooks';
import { api } from '../api/client';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../theme/theme';
import { showConfirm } from '../lib/dialog';

const HERO_HEIGHT = 240;

// Convert uppercase enum value to display case: "REFLECTIVE" → "Reflective"
function toDisplay(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

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
  const { tokens } = useAppearance();
  const { t } = useTranslation(['episode', 'common']);
  const [rating, setRating] = useState(0);
  const [reaction, setReaction] = useState<string | null>(null);
  const [device, setDevice] = useState<string>('PHONE');
  const lastSyncedKey = useRef<string>('');

  // Sync from server data whenever episode loads or changes
  useEffect(() => {
    if (!ep) return;
    const serverReaction = ep.userReaction ? toDisplay(ep.userReaction) : '';
    const syncKey = `${episodeId}:${ep.userRating ?? 0}:${serverReaction}:${ep.userDevice ?? ''}`;
    if (lastSyncedKey.current === syncKey) return;
    lastSyncedKey.current = syncKey;
    setRating(ep.userRating ?? 0);
    setReaction(serverReaction || null);
    setDevice(ep.userDevice ?? 'PHONE');
  }, [ep, episodeId]);

  // Auto-save feedback (debounced) + update cache so revisit shows saved values
  const saveTimeout = useRef<any>(null);
  const saveFeedback = useCallback((data: { rating?: number; reaction?: string | null; device?: string }) => {
    // Update local state immediately
    if (data.rating !== undefined) setRating(data.rating);
    if (data.reaction !== undefined) setReaction(data.reaction);
    if (data.device !== undefined) setDevice(data.device);

    // Update React Query cache with CORRECT field names (userRating, userReaction, userDevice)
    qc.setQueryData(['episode', episodeId], (old: any) => {
      if (!old) return old;
      const updated = { ...old };
      if (data.rating !== undefined) updated.userRating = data.rating;
      if (data.reaction !== undefined) updated.userReaction = data.reaction;
      if (data.device !== undefined) updated.userDevice = data.device;
      return updated;
    });

    // Debounced server save (convert reaction to uppercase for API)
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(async () => {
      try {
        const apiData: any = {};
        if (data.rating !== undefined) apiData.rating = data.rating;
        if (data.reaction !== undefined) apiData.reaction = data.reaction ? data.reaction.toUpperCase() : data.reaction;
        if (data.device !== undefined) apiData.device = data.device;
        await api.patch(`/episodes/${episodeId}/feedback`, apiData);
      } catch {
        // ignore — best effort
      }
    }, 800);
  }, [episodeId, qc]);

  const onRatingChange = (star: number) => {
    saveFeedback({ rating: star });
  };

  const onReactionChange = (r: string | null) => {
    // Store display value (capitalized) locally, API converts to uppercase
    saveFeedback({ reaction: r });
  };

  const onDeviceChange = (d: string) => {
    saveFeedback({ device: d });
  };

  const REACTIONS = ['Shocked', 'Frustrated', 'Sad', 'Reflective', 'Touched', 'Amused', 'Scared', 'Bored', 'Understanding', 'Thrilled', 'Confused', 'Tense'];
  const DEVICES: { key: string; icon: any; label: string }[] = [
    { key: 'PHONE', icon: 'phone-portrait-outline', label: t('episode:devices.Phone') },
    { key: 'TABLET', icon: 'tablet-portrait-outline', label: t('episode:devices.Tablet') },
    { key: 'COMPUTER', icon: 'laptop-outline', label: t('episode:devices.Computer') },
    { key: 'TV', icon: 'tv-outline', label: t('episode:devices.TV') },
  ];

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

  const voteCharacter = async (characterName?: string | null) => {
    if (!characterName || !ep.watched) return;
    try {
      await api.post(`/episodes/${episodeId}/character-vote`, { characterName });
      // Update cache manually — don't invalidate (would reset rating/reaction/device)
      qc.setQueryData(['episode', episodeId], (old: any) => old ? { ...old, favoriteCharacterId: characterName } : old);
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
              <T variant="caption" muted>{ep.watched ? t('episode:watched') : t('episode:notWatchedYet')}</T>
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
              size={44}
              onPress={() => mark.mutate({ id: episodeId, on: !ep.watched, ...(rating ? { rating } : {}) })}
            />
          </Card>

          {/* How did you watch / Rating / Reactions — only once watched */}
          {ep.watched ? (
            <>
              <Card>
                <T variant="h2" style={{ marginBottom: spacing.sm }}>{t('episode:howDidYouWatch')}</T>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  {DEVICES.map((d) => (
                    <Pressable
                      key={d.key}
                      onPress={() => onDeviceChange(d.key)}
                      style={[styles.deviceBtn, { borderColor: tokens.border }, device === d.key && { borderColor: tokens.primary }]}
                    >
                      <Ionicons name={d.icon} size={20} color={device === d.key ? tokens.primary : tokens.textMuted} />
                      <T variant="micro" style={{ color: device === d.key ? tokens.primary : tokens.textMuted, marginTop: 2 }}>{d.label}</T>
                    </Pressable>
                  ))}
                </View>
              </Card>

              <Card>
                <T variant="h2" style={{ marginBottom: spacing.sm }}>{t('episode:rateEpisode')}</T>
                <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.md }}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Pressable key={star} onPress={() => onRatingChange(star)} hitSlop={6}>
                      <Ionicons name={star <= rating ? 'star' : 'star-outline'} size={32} color={star <= rating ? tokens.primary : tokens.textDim} />
                    </Pressable>
                  ))}
                </View>
                <T variant="caption" muted style={{ marginTop: 6, textAlign: 'center' }}>
                  {['', t('episode:ratingBad'), t('episode:ratingOK'), t('episode:ratingGood'), t('episode:ratingGreat'), t('episode:ratingWow')][rating]}
                </T>
              </Card>

              <Card>
                <T variant="h2" style={{ marginBottom: spacing.sm }}>{t('episode:howDidItFeel')}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  {REACTIONS.map((r) => (
                    <Chip key={r} label={t('episode:reactions.' + r)} active={reaction === r} onPress={() => onReactionChange(reaction === r ? null : r)} />
                  ))}
                </View>
              </Card>
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

          {/* Cast & Characters — with favorite-character vote % */}
          {ep.cast?.length ? (
            <View>
              <SectionHeader title={t('episode:castAndCharacters')} />
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
                      <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: voted ? 3 : 0, borderColor: tokens.primary, overflow: 'hidden' }}>
                        <PosterImage uri={c.profileUrl} style={{ width: 64, height: 64, borderRadius: 32 }} />
                        {c.votePct > 0 ? (
                          // eslint-disable-next-line local/no-hardcoded-colors -- media vote badge over avatar
                          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.65)' }}>
                            <T variant="micro" style={{ textAlign: 'center', color: tokens.primary }}>{c.votePct}%</T>
                          </View>
                        ) : null}
                      </View>
                      <T variant="micro" style={{ textAlign: 'center', marginTop: 4 }} numberOfLines={2}>{c.name}</T>
                      {c.character ? <T variant="micro" muted numberOfLines={1}>{c.character}</T> : null}
                      {voted ? (
                        <T variant="micro" style={{ color: tokens.primary }}>{t('episode:yourPick')}</T>
                      ) : ep.watched ? (
                        <T variant="micro" muted>{t('episode:tapToVote')}</T>
                      ) : null}
                    </Pressable>
                  );
                })}
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
  deviceBtn: { alignItems: 'center', borderWidth: 1, borderRadius: radius.md, padding: spacing.sm, flex: 1, marginHorizontal: 2 },
});
