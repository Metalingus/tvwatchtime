import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { TFunction } from 'i18next';
import { computePercentages, type CharacterVoteSectionDto, type EpisodeCastMemberDto } from '@tvwatch/shared';
import { PosterImage, T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { composeOptionLabel } from './meta';

const PORTRAIT_W = 72;
const PORTRAIT_H = 108;

export function FavoriteCharacterVote({
  cast,
  section,
  onSelect,
  pending,
  t,
}: {
  cast: EpisodeCastMemberDto[];
  section: CharacterVoteSectionDto;
  onSelect: (castId: string | null) => void;
  pending: boolean;
  t: TFunction;
}) {
  const { tokens } = useAppearance();
  const reveal = section.userVote !== null;
  const scrollRef = useRef<ScrollView>(null);

  // Once revealed, order the cast by community percentage (highest first); before
  // voting keep the original billing order. Tie-break by billing order for stability.
  const valueOpts = section.options.map((o) => ({ value: o.castId, count: o.count }));
  const percents = new Map(computePercentages(valueOpts, section.total).map((o) => [o.value, o.percent]));
  const orderedCast = reveal
    ? [...cast].sort(
        (a, b) => (percents.get(b.creditId) ?? 0) - (percents.get(a.creditId) ?? 0) || a.order - b.order,
      )
    : cast;

  // When the user casts/changes their vote the list reorders (voted character first);
  // scroll back to the start so the new order is visible instead of staying scrolled
  // away to the right.
  useEffect(() => {
    if (section.userVote) scrollRef.current?.scrollTo({ x: 0, animated: true });
  }, [section.userVote]);

  return (
    <ScrollView ref={scrollRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: spacing.md }}>
      {orderedCast.map((c) => {
        const selected = section.userVote === c.creditId;
        const pct = percents.get(c.creditId) ?? 0;
        const handlePress = () => {
          if (pending || selected) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
          onSelect(c.creditId);
        };
        const name = t('episode:a11y.characterOption', { name: c.character ?? c.name });
        return (
          <Pressable
            key={c.creditId}
            onPress={handlePress}
            disabled={pending}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={composeOptionLabel(t, name, selected, reveal, pct)}
            style={styles.item}
          >
            <View
              style={[
                styles.avatarWrap,
                { borderColor: selected ? tokens.primary : 'transparent', backgroundColor: tokens.surfaceElevated },
              ]}
            >
              <PosterImage uri={c.profileUrl} style={styles.avatar} />
              {selected ? (
                <View style={[styles.badge, { backgroundColor: tokens.primary }]}>
                  <Ionicons name="checkmark" size={12} color={tokens.primaryForeground} />
                </View>
              ) : null}
              {reveal ? (
                <View style={[styles.pctPill, { backgroundColor: tokens.overlayStrong }]}>
                  <T variant="micro" style={{ color: tokens.primary, fontWeight: '700' }}>{pct}%</T>
                </View>
              ) : null}
            </View>
            <T variant="micro" numberOfLines={2} style={{ textAlign: 'center', marginTop: 4 }}>{c.character ?? c.name}</T>
            {c.character ? <T variant="micro" muted numberOfLines={1} style={{ textAlign: 'center' }}>{c.name}</T> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  item: { width: 84, marginRight: spacing.md, alignItems: 'center' },
  avatarWrap: {
    width: PORTRAIT_W,
    height: PORTRAIT_H,
    borderRadius: radius.sm,
    borderWidth: 2,
    overflow: 'hidden',
  },
  avatar: { width: PORTRAIT_W, height: PORTRAIT_H, borderRadius: radius.sm },
  badge: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pctPill: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingVertical: 2, alignItems: 'center' },
});
