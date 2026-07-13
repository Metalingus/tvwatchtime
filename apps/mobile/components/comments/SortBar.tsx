import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import type { CommentSortMode } from '../../api/hooks';

export function SortBar({
  sort,
  onChange,
  total,
  totalLabel,
}: {
  sort: CommentSortMode;
  onChange: (s: CommentSortMode) => void;
  total?: number;
  totalLabel?: (n: number) => string;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments']);

  const chip = (mode: CommentSortMode, icon: keyof typeof Ionicons.glyphMap, label: string) => {
    const active = sort === mode;
    return (
      <Pressable
        key={mode}
        onPress={() => onChange(mode)}
        style={[styles.chip, { backgroundColor: tokens.surface }, active && { backgroundColor: tokens.primary }]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
      >
        <Ionicons name={icon} size={14} color={active ? tokens.primaryForeground : tokens.textMuted} />
        <T variant="micro" style={{ marginLeft: 4, color: active ? tokens.primaryForeground : tokens.textMuted, fontWeight: '600' }}>
          {label}
        </T>
      </Pressable>
    );
  };

  return (
    <View style={[styles.bar, { borderBottomColor: tokens.border }]}>
      {chip('LATEST', 'time-outline', t('comments:sortRecent'))}
      {chip('MOST_LIKED', 'heart-outline', t('comments:sortTop'))}
      {total != null && totalLabel ? (
        <T variant="micro" muted style={{ marginLeft: 'auto' }}>
          {totalLabel(total)}
        </T>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
});
