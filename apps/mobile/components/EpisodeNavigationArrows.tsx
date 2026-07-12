import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';

const SIDE_WIDTH = 44;

/**
 * Bottom navigation row of the episode cover: [left arrow] [center indicator] [right arrow].
 * The center element stays horizontally centered regardless of which arrows are present,
 * because the side slots reserve a fixed width. Plain chevrons (no background) with a
 * subtle shadow for legibility over any image. pointerEvents="box-none" lets taps pass
 * through to the cover content beneath except on the arrows themselves.
 */
export function EpisodeNavigationArrows({
  onPrev,
  onNext,
  center,
}: {
  onPrev?: () => void;
  onNext?: () => void;
  center?: React.ReactNode;
}) {
  const { tokens } = useAppearance();
  if (!onPrev && !onNext && !center) return null;
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.side}>
        {onPrev ? (
          <Pressable onPress={onPrev} hitSlop={14} style={styles.arrowBtn}>
            <Ionicons name="chevron-back" size={30} color={tokens.mediaText} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.center}>{center ?? null}</View>
      <View style={styles.side}>
        {onNext ? (
          <Pressable onPress={onNext} hitSlop={14} style={styles.arrowBtn}>
            <Ionicons name="chevron-forward" size={30} color={tokens.mediaText} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  side: {
    width: SIDE_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowBtn: {
    padding: spacing.xs,
  },
});
