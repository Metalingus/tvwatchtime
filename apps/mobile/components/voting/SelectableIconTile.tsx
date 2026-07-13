import React, { useState } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { VotingPercentage } from './VotingPercentage';

export interface SelectableIconTileProps {
  /** Ionicons glyph (vector icons). Mutually exclusive with `emoji`. */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Native emoji glyph. Mutually exclusive with `icon`. */
  emoji?: string;
  label: string;
  selected: boolean;
  /** Whether community percentages are visible (user has voted in this section). */
  reveal: boolean;
  percent?: number;
  disabled?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle;
  iconSize?: number;
  /** When true, tapping a selected tile fires onPress (toggle/deselect) instead of no-op. */
  toggle?: boolean;
}

/**
 * A single selectable voting option rendered as a themed tile. Selection is
 * communicated by primary-accent border + fill + a checkmark (not colour alone).
 * Supports pressed/hovered/focused/selected/disabled states across native + web.
 */
export function SelectableIconTile({
  icon,
  emoji,
  label,
  selected,
  reveal,
  percent,
  disabled,
  onPress,
  accessibilityLabel,
  style,
  iconSize = 26,
  toggle = false,
}: SelectableIconTileProps) {
  const { tokens } = useAppearance();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const handlePress = () => {
    if (disabled) return;
    // Single-select tiles no-op on re-tap; toggle tiles always fire (deselect).
    if (selected && !toggle) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onPress?.();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.tile,
        {
          backgroundColor: selected ? tokens.primaryMuted : tokens.surfaceAlt,
          borderColor: selected ? tokens.primary : tokens.border,
          borderWidth: selected ? 2 : 1,
          opacity: disabled && !selected ? 0.5 : 1,
        },
        hovered && !selected && { borderColor: tokens.textMuted },
        (focused || pressed) && { borderColor: tokens.focusRing },
        pressed && { transform: [{ scale: 0.97 }] },
        style,
      ]}
    >
      {selected ? (
        <View style={[styles.check, { backgroundColor: tokens.primary }]} pointerEvents="none">
          <Ionicons name="checkmark" size={12} color={tokens.primaryForeground} />
        </View>
      ) : null}

      <View style={styles.iconWrap}>
        {icon ? (
          <Ionicons name={icon} size={iconSize} color={selected ? tokens.primary : tokens.textSecondary} />
        ) : (
          <T style={{ fontSize: iconSize, lineHeight: iconSize + 4 }}>{emoji}</T>
        )}
      </View>

      <T
        variant="caption"
        numberOfLines={2}
        style={{ color: selected ? tokens.primary : tokens.textMuted, textAlign: 'center', marginTop: 2 }}
      >
        {label}
      </T>

      <View style={{ marginTop: 4, minHeight: 12, alignItems: 'center' }}>
        <VotingPercentage percent={percent ?? 0} reveal={reveal} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
  },
  iconWrap: { height: 32, justifyContent: 'center', alignItems: 'center' },
  check: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
