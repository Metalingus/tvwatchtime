import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T } from './primitives';
import { colors, radius, spacing } from '../theme/theme';

/**
 * Small dismissible info banner. Use above a section to surface a one-time tip;
 * pair with useDismissableFlag so closing it hides it permanently.
 */
export function InfoBanner({
  icon = 'information-circle-outline',
  title,
  message,
  actionLabel,
  onAction,
  onClose,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <Ionicons name={icon} size={20} color={colors.primary} style={styles.icon} />
      <View style={{ flex: 1 }}>
        {title ? <T variant="h2" style={styles.title}>{title}</T> : null}
        <T variant="caption" muted style={styles.message}>{message}</T>
        {actionLabel && onAction ? (
          <Pressable onPress={onAction} hitSlop={8}>
            <T variant="caption" style={styles.action}>{actionLabel}</T>
          </Pressable>
        ) : null}
      </View>
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={12} style={styles.close}>
          <Ionicons name="close" size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  icon: { marginRight: spacing.sm, marginTop: 2 },
  title: { marginBottom: 2 },
  message: { lineHeight: 16 },
  action: { color: colors.primary, marginTop: spacing.xs, fontWeight: '700' },
  close: { marginLeft: spacing.sm, padding: 2 },
});
