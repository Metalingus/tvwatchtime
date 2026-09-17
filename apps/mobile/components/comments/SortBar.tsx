import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { T } from '../primitives';
import { CommsUniAttribution } from './CommsUniAttribution';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import type { CommentSortMode } from '../../api/hooks';

export function SortBar({
  sort,
  onChange,
  total,
  totalLabel,
  attribution = false,
}: {
  sort: CommentSortMode;
  onChange: (s: CommentSortMode) => void;
  total?: number;
  totalLabel?: (n: number) => string;
  attribution?: boolean;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments']);

  const chip = (mode: CommentSortMode, icon: keyof typeof Ionicons.glyphMap, label: string) => {
    const active = sort === mode;
    return (
      <Pressable
        key={mode}
        onPress={() => onChange(mode)}
        style={[
          styles.chip,
          { backgroundColor: tokens.surface },
          active && { backgroundColor: tokens.primary },
          attribution && { paddingHorizontal: spacing.sm },
        ]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
      >
        {!attribution ? (
          <Ionicons
            name={icon}
            size={14}
            color={active ? tokens.primaryForeground : tokens.textMuted}
          />
        ) : null}
        <T
          variant="micro"
          style={{
            marginLeft: attribution ? 0 : spacing.xs,
            color: active ? tokens.primaryForeground : tokens.textMuted,
            fontWeight: '600',
          }}
        >
          {label}
        </T>
      </Pressable>
    );
  };

  const controls = (
    <>
      {chip('LATEST', 'time-outline', t('comments:sortRecent'))}
      {chip('MOST_LIKED', 'heart-outline', t('comments:sortTop'))}
    </>
  );
  if (attribution)
    return (
      <CommsUniAttribution
        leading={
          <View style={{ flexShrink: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              {controls}
            </View>
            {total != null && totalLabel ? (
              <T variant="micro" muted style={{ marginTop: spacing.xs }}>
                {totalLabel(total)}
              </T>
            ) : null}
          </View>
        }
      />
    );

  return (
    <View style={[styles.bar, { borderBottomColor: tokens.border }]}>
      {controls}
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
