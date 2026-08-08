import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  ImageBackground,
  Pressable,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { T, WatchButton, SectionHeader, useWatchMenu } from './primitives';
import { useMarkEpisodeWatched, useRewatchEpisode, useShowEpisodes, useUnwatchEpisodeOnce } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { formatAirDate, formatAirTime } from '../lib/format';
import { useContentWidth } from '../hooks/useContentWidth';
import { isEpisodeProgressEligible } from '../lib/episode-progress';

// eslint-disable-next-line local/no-hardcoded-colors -- intentional dark media scrim over episode stills, same as the show detail hero
const SCRIM_COLORS = ['rgba(15,17,21,0.55)', 'rgba(15,17,21,0.05)', 'rgba(15,17,21,0.85)'] as [string, string, string];
// eslint-disable-next-line local/no-hardcoded-colors -- dark chip behind the SxExx label over an episode still
const STILL_CHIP_BG = 'rgba(0,0,0,0.55)';
// eslint-disable-next-line local/no-hardcoded-colors -- dark disc behind the watch checkmark over an episode still
const STILL_DISC_BG = 'rgba(0,0,0,0.45)';

/**
 * Horizontal snap carousel of a show's progress-eligible episodes (history + next up),
 * shown on the show details screen above "Rate this show". Cards are 70% of the
 * screen width so ~15% of the adjacent cards peeks in from both edges; tapping a
 * peeking edge centers that card, tapping the active card opens episode details,
 * and the checkmark handles watch/rewatch/unwatch through the shared watch menu
 * (its optimistic `['showEpisodes']` updates keep the season lists in sync).
 * Specials (S0) and unaired episodes are excluded, matching every other
 * progress/history surface in the app.
 */
export function EpisodeHistoryCarousel({ showId }: { showId: string }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['episode', 'showDetail']);
  const { data: seasons } = useShowEpisodes(showId);
  const mark = useMarkEpisodeWatched();
  const rewatch = useRewatchEpisode();
  const unwatchOnce = useUnwatchEpisodeOnce();
  const menu = useWatchMenu();

  const screenW = useContentWidth();
  const cardW = Math.round(screenW * 0.7);
  // Ultra-wide cards: wide rectangles that stay short on phones (~2.6:1) but may
  // grow a bit taller on tablets (capped).
  const cardH = Math.min(Math.max(Math.round(cardW / 2.6), 100), 160);
  const gap = spacing.sm;
  const interval = cardW + gap;
  const sidePadding = Math.round((screenW - cardW) / 2);

  const episodes = useMemo(() => {
    const now = Date.now();
    const sorted = (seasons ?? [])
      .filter((s: any) => s.number > 0)
      // The season number comes from the parent season object — episode payloads
      // from /shows/:id/episodes don't carry seasonNumber.
      .flatMap((s: any) => (s.episodes ?? []).map((e: any) => ({ ...e, seasonNumber: s.number })))
      .filter((episode: any) => isEpisodeProgressEligible(episode.airDate, now))
      .sort((a: any, b: any) => a.seasonNumber - b.seasonNumber || a.number - b.number);
    // Defensive dedupe by (season, episode): imports/hydration can produce
    // duplicate episode rows; prefer the watched variant so a watched episode
    // never lands as "first unwatched" because of its unwatched twin.
    const byKey = new Map<string, any>();
    for (const e of sorted) {
      const k = `${e.seasonNumber}x${e.number}`;
      const prev = byKey.get(k);
      if (!prev || (!prev.watched && e.watched)) byKey.set(k, e);
    }
    return [...byKey.values()];
  }, [seasons]);

  // Land on the first unwatched episode (next to watch); when everything is
  // watched, land on the last watched episode IN SHOW ORDER (highest
  // season/episode), not by watchedAt (rewatching an old episode must not move
  // the landing back).
  const landingIndex = useMemo(() => {
    const unwatched = episodes.findIndex((e: any) => !e.watched);
    if (unwatched !== -1) return unwatched;
    let lastWatched = -1;
    episodes.forEach((e: any, i: number) => {
      if (e.watched) lastWatched = i;
    });
    return lastWatched !== -1 ? lastWatched : episodes.length - 1;
  }, [episodes]);

  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<FlatList<any>>(null);
  // Land on the next-unwatched episode, and RE-LAND whenever the target changes
  // for as long as the user still sits where we last landed them: the first data
  // can be a stale cache snapshot, and watch actions move the target forward.
  // Once the user scrolls/taps away from the landed position, never yank again.
  //
  // The INITIAL landing is free: exact card geometry (getItemLayout) lets
  // initialScrollIndex mount the list already at the target — no post-paint scroll,
  // so there is nothing to see move. Re-lands (fresh data / watch actions moving
  // the target) are single non-animated scrolls that stay PENDING until the real
  // offset confirms: firing scrollToOffset while only initialNumToRender cards
  // exist clamps the offset to the partial content, so every content-size growth
  // retries and onScroll confirms success.
  const lastLanded = useRef<number | null>(null);
  const pendingLand = useRef<number | null>(null);
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;
  const tryLand = useCallback(() => {
    const target = pendingLand.current;
    if (target == null) return;
    if (lastLanded.current === null || activeIndexRef.current !== lastLanded.current) {
      pendingLand.current = null;
      return;
    }
    listRef.current?.scrollToOffset({ offset: target * interval, animated: false });
  }, [interval]);
  useEffect(() => {
    if (episodes.length === 0) return;
    if (lastLanded.current !== null && activeIndex !== lastLanded.current) return;
    lastLanded.current = landingIndex;
    setActiveIndex(landingIndex);
    // On first mount initialScrollIndex already put us at the target, so this is a
    // no-op scroll (invisible) — but it doubles as a correction if a platform ever
    // mishandles initialScrollIndex. On re-lands it performs the actual move.
    pendingLand.current = landingIndex;
    const timer = setTimeout(tryLand, 0);
    return () => clearTimeout(timer);
  }, [episodes.length, landingIndex, interval, activeIndex, tryLand]);

  // Explicit snap offsets: snapToInterval misaligns by the side padding on some
  // platforms; offsets snap exactly to each card's centered position.
  const snapOffsets = useMemo(() => episodes.map((_: any, i: number) => i * interval), [episodes, interval]);

  const goTo = useCallback(
    (index: number) => {
      setActiveIndex(index);
      listRef.current?.scrollToOffset({ offset: index * interval, animated: true });
    },
    [interval],
  );

  const settleFromScroll = useCallback(
    (x: number) => {
      if (pendingLand.current !== null) return;
      const idx = Math.max(0, Math.min(episodes.length - 1, Math.round(x / interval)));
      setActiveIndex(idx);
    },
    [episodes.length, interval],
  );

  const renderItem = useCallback(
    ({ item: e, index }: { item: any; index: number }) => {
      const isActive = index === activeIndex;
      return (
        <Pressable
          onPress={() => (isActive ? router.push(`/episode/${e.id}`) : goTo(index))}
          style={{
            width: cardW,
            height: cardH,
            marginRight: gap,
            borderRadius: radius.md,
            overflow: 'hidden',
            backgroundColor: tokens.surfaceElevated,
          }}
        >
          <ImageBackground
            source={e.stillUrl ? { uri: e.stillUrl } : undefined}
            style={{ flex: 1 }}
            resizeMode="cover"
          >
            <LinearGradient
              colors={SCRIM_COLORS}
              locations={[0, 0.45, 1]}
              style={{ flex: 1, padding: spacing.sm, justifyContent: 'space-between' }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View
                  style={{
                    backgroundColor: STILL_CHIP_BG,
                    borderRadius: radius.sm,
                    paddingHorizontal: spacing.xs,
                    paddingVertical: 2,
                  }}
                >
                  <T variant="micro" style={{ color: tokens.mediaText, fontWeight: '700' }}>
                    S{e.seasonNumber}E{String(e.number).padStart(2, '0')}
                  </T>
                </View>
                <View style={{ backgroundColor: STILL_DISC_BG, borderRadius: 15 }}>
                  <WatchButton
                    watched={!!e.watched}
                    watchCount={e.watchCount ?? 0}
                    onPress={() =>
                      menu({
                        watched: !!e.watched,
                        watchCount: e.watchCount ?? 0,
                        onMarkWatched: () => mark.mutate({ id: e.id, on: true }),
                        onRewatch: () => rewatch.mutate(e.id),
                        onUnwatchOnce: () => unwatchOnce.mutate(e.id),
                        onUnwatch: () => mark.mutate({ id: e.id, on: false }),
                      })
                    }
                  />
                </View>
              </View>
              <View>
                <T variant="caption" numberOfLines={1} style={{ color: tokens.mediaText, fontWeight: '700' }}>
                  {e.title}
                </T>
                {e.airDate ? (
                  <T variant="micro" style={{ color: tokens.mediaText, opacity: 0.85 }}>
                    {e.airTime
                      ? t('episode:airedAtTime', {
                          date: formatAirDate(e.airDate),
                          time: formatAirTime(e.airTime),
                        })
                      : t('episode:airedAt', { date: formatAirDate(e.airDate) })}
                  </T>
                ) : null}
                {e.watched && e.watchedAt ? (
                  <T variant="micro" style={{ color: tokens.mediaText, opacity: 0.85 }}>
                    {t('episode:watchedAt', {
                      date: new Date(e.watchedAt).toLocaleDateString(undefined, {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      }),
                      time: new Date(e.watchedAt).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                      }),
                    })}
                  </T>
                ) : null}
              </View>
            </LinearGradient>
          </ImageBackground>
        </Pressable>
      );
    },
    [activeIndex, cardW, cardH, gap, tokens, menu, mark, rewatch, goTo, t],
  );

  if (episodes.length === 0) return null;

  return (
    <View>
      {/* Title aligned with the parent screen padding, not the centered card. */}
      <View style={{ paddingHorizontal: spacing.lg }}>
        <SectionHeader title={t('showDetail:episodes')} />
      </View>
      <FlatList
        ref={listRef}
        horizontal
        data={episodes}
        keyExtractor={(e: any) => e.id}
        renderItem={renderItem}
        showsHorizontalScrollIndicator={false}
        snapToOffsets={snapOffsets}
        decelerationRate="fast"
        disableIntervalMomentum
        initialScrollIndex={landingIndex}
        getItemLayout={(_, i) => ({ length: interval, offset: interval * i, index: i })}
        contentContainerStyle={{ paddingHorizontal: sidePadding }}
        onContentSizeChange={tryLand}
        onScroll={(e) => {
          // Consume the pending landing once the real offset confirms it stuck.
          const target = pendingLand.current;
          if (target !== null && Math.abs(e.nativeEvent.contentOffset.x - target * interval) < 2) {
            pendingLand.current = null;
          }
        }}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => settleFromScroll(e.nativeEvent.contentOffset.x)}
        onScrollEndDrag={(e) => settleFromScroll(e.nativeEvent.contentOffset.x)}
        initialNumToRender={8}
        maxToRenderPerBatch={6}
        windowSize={7}
      />
    </View>
  );
}
