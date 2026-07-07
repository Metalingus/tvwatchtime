import React from 'react';
import { Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from './primitives';
import { colors, spacing } from '../theme/theme';

export function Header({
  title,
  showBack,
  right,
  subtitle,
  style,
}: {
  title?: string;
  showBack?: boolean;
  right?: React.ReactNode;
  subtitle?: string;
  style?: ViewStyle;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }, style]}>
      <View style={styles.row}>
        {showBack ? (
          <Pressable onPress={() => router.back()} hitSlop={10} style={{ marginRight: spacing.sm }}>
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </Pressable>
        ) : null}
        {title ? (
          <View style={{ flex: 1 }}>
            <T variant="title">{title}</T>
            {subtitle ? <T variant="caption" muted>{subtitle}</T> : null}
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {right}
      </View>
    </View>
  );
}

export function IconButton({ icon, onPress, badge }: { icon: keyof typeof Ionicons.glyphMap; onPress?: () => void; badge?: number }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} style={styles.iconBtn}>
      <Ionicons name={icon} size={24} color={colors.text} />
      {badge ? <View style={styles.badge} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, backgroundColor: colors.background },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
  iconBtn: { marginLeft: spacing.md, position: 'relative' },
  badge: { position: 'absolute', top: 0, right: 0, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
});
