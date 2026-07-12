import React, { useRef, useState } from 'react';
import { Dimensions, FlatList, Pressable, StyleSheet, View } from 'react-native';
import Svg, { G, Line, Polyline, Circle, Text as SvgText } from 'react-native-svg';
import { T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';

interface Ep { number: number; rating: number; votes: number }
interface Season { seasonNumber: number; episodes: Ep[] }

export function RatingChart({ seasonRatings }: { seasonRatings: Season[] | undefined }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail']);
  const seasons = (seasonRatings ?? [])
    .filter((s) => s.episodes.length > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber);

  // Default to first non-special season (seasonNumber > 0); specials appear when swiping back
  const firstRegular = seasons.findIndex((s) => s.seasonNumber > 0);
  const [active, setActive] = useState(Math.max(0, firstRegular));
  const ref = useRef<FlatList>(null);
  const [containerW, setContainerW] = useState(Dimensions.get('window').width - 48);

  if (!seasons.length) {
    return (
      <View style={{ paddingVertical: 8 }}>
        <T variant="caption" muted>{t('showDetail:noRatings')}</T>
      </View>
    );
  }

  const getItemLayout = (_: any, index: number) => ({ length: containerW, offset: containerW * index, index });

  const go = (dir: number) => {
    const next = Math.min(seasons.length - 1, Math.max(0, active + dir));
    setActive(next);
    ref.current?.scrollToIndex({ index: next, animated: true });
  };

  return (
    <View onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}>
      <View style={styles.head}>
        <Pressable onPress={() => go(-1)} hitSlop={8} disabled={active === 0}>
          <T variant="caption" style={{ color: active === 0 ? tokens.textDim : tokens.primary }}>‹</T>
        </Pressable>
        <T variant="h2">{seasons[active].seasonNumber === 0 ? t('showDetail:specials') : t('showDetail:seasonLabel', { number: seasons[active].seasonNumber })}</T>
        <Pressable onPress={() => go(1)} hitSlop={8} disabled={active === seasons.length - 1}>
          <T variant="caption" style={{ color: active === seasons.length - 1 ? tokens.textDim : tokens.primary }}>›</T>
        </Pressable>
      </View>
      <T variant="micro" muted style={{ textAlign: 'center', marginBottom: 4 }}>{t('showDetail:chartCaption')}</T>
      <FlatList
        ref={ref}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        data={seasons}
        keyExtractor={(s) => String(s.seasonNumber)}
        getItemLayout={getItemLayout}
        initialScrollIndex={Math.max(0, firstRegular)}
        onMomentumScrollEnd={(e) => setActive(Math.round(e.nativeEvent.contentOffset.x / containerW))}
        renderItem={({ item }) => <SeasonLineChart season={item} width={containerW} tokens={tokens} />}
      />
    </View>
  );
}

function SeasonLineChart({ season, width, tokens }: { season: Season; width: number; tokens: ReturnType<typeof useAppearance>['tokens'] }) {
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
            <Line x1={padL} x2={width - padR} y1={yFor(v)} y2={yFor(v)} stroke={tokens.border} strokeWidth={1} />
            <SvgText x={4} y={yFor(v) + 4} fill={tokens.textMuted} fontSize={10}>{v}</SvgText>
          </G>
        ))}
        {/* x axis labels (episode numbers) */}
        {eps.map((e, i) =>
          eps.length <= 12 || i % Math.ceil(eps.length / 12) === 0 ? (
            <SvgText key={i} x={xFor(i) - 4} y={height - 6} fill={tokens.textMuted} fontSize={9}>{e.number}</SvgText>
          ) : null,
        )}
        {/* line */}
        {eps.length > 1 ? <Polyline points={points} fill="none" stroke={tokens.primary} strokeWidth={2} /> : null}
        {/* dots */}
        {eps.map((e, i) => (
          <Circle key={i} cx={xFor(i)} cy={yFor(e.rating)} r={3.5} fill={tokens.primary} />
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, marginBottom: 2 },
});