import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, FlatList, Pressable, StyleSheet, View } from 'react-native';
import Svg, { G, Line, Polyline, Circle, Text as SvgText } from 'react-native-svg';
import { T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import {
  normalizeRatingChartSeasons,
  safeRatingSeasonIndex,
  type RatingChartSeason,
} from '../lib/rating-chart';

type Season = RatingChartSeason;

export function RatingChart({ seasonRatings }: { seasonRatings: Season[] | undefined }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail', 'social']);
  const seasons = useMemo(() => normalizeRatingChartSeasons(seasonRatings), [seasonRatings]);

  // Default to first non-special season (seasonNumber > 0); specials appear when swiping back
  const firstRegular = seasons.findIndex((s) => s.seasonNumber > 0);
  const [active, setActive] = useState(safeRatingSeasonIndex(firstRegular, seasons.length));
  const ref = useRef<FlatList>(null);
  const [containerW, setContainerW] = useState(Dimensions.get('window').width - 48);
  const safeActive = safeRatingSeasonIndex(active, seasons.length);
  const seasonCountRef = useRef(seasons.length);
  seasonCountRef.current = seasons.length;
  const activeSeason = seasons[safeActive] ?? null;

  // These hooks must run even for an empty ratings payload. Keeping them below the
  // empty-state return caused Android's Rendered fewer hooks than expected crash.
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    const index = viewableItems?.[0]?.index;
    if (typeof index === 'number' && Number.isFinite(index)) {
      setActive(safeRatingSeasonIndex(index, seasonCountRef.current));
    }
  }).current;

  // A metadata refresh can replace the ratings array with fewer seasons while
  // this component remains mounted. Clamp the persisted page index immediately;
  // rendering seasons[active] before this guard caused the production crash.
  useEffect(() => {
    setActive((index) => safeRatingSeasonIndex(index, seasons.length));
  }, [seasons.length]);

  if (!activeSeason) {
    return (
      <View style={{ paddingVertical: 8 }}>
        <T variant="caption" muted>
          {t('showDetail:noRatings')}
        </T>
      </View>
    );
  }

  const getItemLayout = (_: any, index: number) => ({
    length: containerW,
    offset: containerW * index,
    index,
  });

  const go = (dir: number) => {
    const next = safeRatingSeasonIndex(safeActive + dir, seasons.length);
    setActive(next);
    ref.current?.scrollToIndex({ index: next, animated: true });
  };

  return (
    <View
      onLayout={(e) => {
        const width = e.nativeEvent.layout.width;
        if (width > 0) setContainerW(width);
      }}
    >
      <View style={styles.head}>
        <Pressable onPress={() => go(-1)} hitSlop={8} disabled={safeActive === 0}>
          <T
            variant="caption"
            style={{ color: safeActive === 0 ? tokens.textDim : tokens.primary }}
          >
            ‹
          </T>
        </Pressable>
        <T variant="h2">
          {activeSeason.seasonNumber === 0
            ? t('showDetail:specials')
            : t('showDetail:seasonLabel', { number: activeSeason.seasonNumber })}
        </T>
        <Pressable onPress={() => go(1)} hitSlop={8} disabled={safeActive === seasons.length - 1}>
          <T
            variant="caption"
            style={{ color: safeActive === seasons.length - 1 ? tokens.textDim : tokens.primary }}
          >
            ›
          </T>
        </Pressable>
      </View>
      <T variant="micro" muted style={{ textAlign: 'center', marginBottom: 4 }}>
        {t('social:chartCaption')}
      </T>
      <FlatList
        ref={ref}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        data={seasons}
        keyExtractor={(s) => String(s.seasonNumber)}
        getItemLayout={getItemLayout}
        initialScrollIndex={safeRatingSeasonIndex(firstRegular, seasons.length)}
        onMomentumScrollEnd={(e) => {
          const page = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, containerW));
          if (Number.isFinite(page)) setActive(safeRatingSeasonIndex(page, seasons.length));
        }}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        renderItem={({ item }) => (
          <SeasonLineChart season={item} width={containerW} tokens={tokens} />
        )}
      />
    </View>
  );
}

function SeasonLineChart({
  season,
  width,
  tokens,
}: {
  season: Season;
  width: number;
  tokens: ReturnType<typeof useAppearance>['tokens'];
}) {
  const height = 180;
  const padL = 26;
  const padB = 24;
  const padT = 12;
  const padR = 8;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const eps = season.episodes;
  const xFor = (i: number) => padL + (eps.length <= 1 ? plotW / 2 : (i / (eps.length - 1)) * plotW);
  const yFor = (r: number) => padT + plotH - (Math.max(0, Math.min(5, r)) / 5) * plotH;
  const points = eps.map((e, i) => `${xFor(i)},${yFor(e.rating)}`).join(' ');

  return (
    <View style={{ width }}>
      <Svg width={width} height={height}>
        {/* y gridlines 0..5 */}
        {[0, 1, 2, 3, 4, 5].map((v) => (
          <G key={v}>
            <Line
              x1={padL}
              x2={width - padR}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke={tokens.border}
              strokeWidth={1}
            />
            <SvgText x={4} y={yFor(v) + 4} fill={tokens.textMuted} fontSize={10}>
              {v}
            </SvgText>
          </G>
        ))}
        {/* x axis labels (episode numbers) */}
        {eps.map((e, i) =>
          eps.length <= 12 || i % Math.ceil(eps.length / 12) === 0 ? (
            <SvgText key={i} x={xFor(i) - 4} y={height - 6} fill={tokens.textMuted} fontSize={9}>
              {e.number}
            </SvgText>
          ) : null,
        )}
        {/* line */}
        {eps.length > 1 ? (
          <Polyline points={points} fill="none" stroke={tokens.primary} strokeWidth={2} />
        ) : null}
        {/* dots */}
        {eps.map((e, i) => (
          <Circle key={i} cx={xFor(i)} cy={yFor(e.rating)} r={3.5} fill={tokens.primary} />
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    marginBottom: 2,
  },
});
