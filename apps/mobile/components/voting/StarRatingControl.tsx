import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { TFunction } from 'i18next';
import type { VoteSectionDto } from '@tvwatch/shared';
import { T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { RATING_META, RATING_ORDER, composeOptionLabel, sectionPercents } from './meta';
import { VotingPercentage } from './VotingPercentage';
import { spacing } from '../../theme/theme';

export function StarRatingControl({
  section,
  onSelect,
  pending,
  t,
}: {
  section: VoteSectionDto;
  onSelect: (value: number) => void;
  pending: boolean;
  t: TFunction;
}) {
  const { tokens } = useAppearance();
  const percents = sectionPercents(section);
  const selected = section.userVote ? Number(section.userVote) : 0;
  const reveal = section.userVote !== null;

  return (
    <View style={styles.row}>
      {RATING_ORDER.map((star) => {
        const filled = star <= selected;
        const isSel = star === selected;
        const pct = percents.get(String(star));
        const name = t('episode:a11y.ratingOption', { n: star, label: t(RATING_META[star]) });
        const handlePress = () => {
          if (pending || isSel) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
          onSelect(star);
        };
        return (
          <Pressable
            key={star}
            onPress={handlePress}
            disabled={pending}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSel }}
            accessibilityLabel={composeOptionLabel(t, name, isSel, reveal, pct)}
            style={({ pressed }) => [styles.col, pressed && { transform: [{ scale: 0.95 }] }]}
          >
            <Ionicons name={filled ? 'star' : 'star-outline'} size={30} color={filled ? tokens.primary : tokens.textDim} />
            <T variant="micro" style={{ color: isSel ? tokens.primary : tokens.textMuted, marginTop: 3 }}>
              {t(RATING_META[star])}
            </T>
            <View style={{ minHeight: 12, marginTop: 2, alignItems: 'center' }}>
              <VotingPercentage percent={pct ?? 0} reveal={reveal} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center' },
  col: { alignItems: 'center', marginHorizontal: spacing.sm },
});
