import React from 'react';
import { Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';

export function Header({
  title,
  showBack,
  right,
  subtitle,
  style,
  tone = 'default',
}: {
  title?: string;
  showBack?: boolean;
  right?: React.ReactNode;
  subtitle?: string;
  style?: ViewStyle;
  /** 'media' renders icons/text for legibility over artwork (always white); default follows theme. */
  tone?: 'default' | 'media';
}) {
  const insets = useSafeAreaInsets();
  const { tokens } = useAppearance();
  const fg = tone === 'media' ? tokens.mediaText : tokens.textPrimary;
  return (
    <View
      style={[
        styles.wrap,
        { paddingTop: insets.top + 8, backgroundColor: tone === 'media' ? 'transparent' : tokens.background },
        style,
      ]}
    >
      <View style={styles.row}>
        {showBack ? (
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginRight: spacing.sm }}>
            <Ionicons name="chevron-back" size={26} color={fg} />
          </Pressable>
        ) : null}
        {title ? (
          <View style={{ flex: 1 }}>
            <T variant="title" style={tone === 'media' ? { color: fg } : undefined}>
              {title}
            </T>
            {subtitle ? <T variant="caption" muted style={tone === 'media' ? { color: fg } : undefined}>{subtitle}</T> : null}
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {right}
      </View>
    </View>
  );
}

export function IconButton({ icon, onPress, badge, tone = 'default' }: { icon: keyof typeof Ionicons.glyphMap; onPress?: () => void; badge?: number; tone?: 'default' | 'media' }) {
  const { tokens } = useAppearance();
  const fg = tone === 'media' ? tokens.mediaText : tokens.textPrimary;
  return (
    <Pressable onPress={onPress} hitSlop={10} style={styles.iconBtn}>
      <Ionicons name={icon} size={24} color={fg} />
      {badge ? <View style={[styles.badge, { backgroundColor: tokens.primary }]} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
  iconBtn: { marginLeft: spacing.md, position: 'relative' },
  badge: { position: 'absolute', top: 0, right: 0, width: 8, height: 8, borderRadius: 4 },
});
