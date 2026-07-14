import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle, TextStyle, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { radius, spacing, typography } from '../theme/theme';
import { useAppearance } from '../context/PreferencesProvider';
import { showDialog } from '../lib/dialog';

/** The bundled app icon, used as a default avatar placeholder. */
export const APP_ICON = require('../assets/icon.png');

type TextProps = React.ComponentProps<typeof Text> & { variant?: keyof typeof typography; muted?: boolean; dim?: boolean };
export function T({ variant = 'body', muted, dim, style, ...rest }: TextProps) {
  const { tokens } = useAppearance();
  return (
    <Text
      style={[
        typography[variant],
        { color: muted ? tokens.textMuted : dim ? tokens.textDim : tokens.textPrimary },
        style as TextStyle,
      ]}
      {...rest}
    />
  );
}

export function Box({ style, ...rest }: React.ComponentProps<typeof View>) {
  return <View style={style as ViewStyle} {...rest} />;
}

export function Card({ style, ...rest }: React.ComponentProps<typeof View>) {
  const { tokens } = useAppearance();
  return <View style={[styles.card, { backgroundColor: tokens.cardBackground }, style as ViewStyle]} {...rest} />;
}

interface BtnProps {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'ghost' | 'watched' | 'danger';
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  style?: ViewStyle;
  disabled?: boolean;
}
export function Button({ title, onPress, variant = 'primary', icon, loading, style, disabled }: BtnProps) {
  const { tokens } = useAppearance();
  const bg =
    variant === 'primary'
      ? tokens.primary
      : variant === 'watched'
        ? tokens.watched
        : variant === 'danger'
          ? tokens.danger
          : tokens.surfaceElevated;
  const fg = variant === 'ghost' ? tokens.textPrimary : tokens.primaryForeground;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
      style={[styles.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : 1 }, style]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} style={{ marginRight: 6 }} /> : null}
          <T variant="h2" style={{ color: fg }}>
            {title}
          </T>
        </>
      )}
    </TouchableOpacity>
  );
}

interface ChipProps {
  label: string;
  active?: boolean;
  onPress?: () => void;
  color?: string;
}
export function Chip({ label, active, onPress, color }: ChipProps) {
  const { tokens } = useAppearance();
  const Comp = onPress ? Pressable : View;
  return (
    <Comp
      onPress={onPress}
      style={[styles.chip, { backgroundColor: tokens.chip }, active && { backgroundColor: tokens.primary }, color ? { backgroundColor: color } : null]}
    >
      <T variant="caption" style={{ color: active || color ? tokens.primaryForeground : tokens.textMuted }}>
        {label}
      </T>
    </Comp>
  );
}

export function StatusChip({ label, color }: { label: string; color?: string }) {
  const { tokens } = useAppearance();
  return (
    <View style={[styles.statusChip, color ? { backgroundColor: color } : { backgroundColor: tokens.primary }]}>
      <T variant="micro" style={{ color: tokens.primaryForeground }}>
        {label.toUpperCase()}
      </T>
    </View>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const { tokens } = useAppearance();
  return (
    <View style={styles.row}>
      <T variant="h1">{title}</T>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <T variant="caption" style={{ color: tokens.primary }}>
            {action} ›
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  const { tokens } = useAppearance();
  return (
    <View style={[styles.progressTrack, { backgroundColor: tokens.surfaceElevated }]}>
      <View
        style={[
          styles.progressFill,
          { width: `${Math.min(100, Math.max(0, value * 100))}%`, backgroundColor: color ?? tokens.primary },
        ]}
      />
    </View>
  );
}

export function PosterImage({
  uri,
  style,
  fallback,
}: {
  uri?: string | null;
  style?: ViewStyle;
  fallback?: number | { uri: string };
}) {
  const { tokens } = useAppearance();
  const source = uri ? { uri } : fallback;
  return (
    <Image
      source={source as any}
      style={[{ backgroundColor: tokens.surfaceElevated }, style]}
      contentFit="cover"
      transition={150}
    />
  );
}

export function WatchButton({
  watched,
  watchCount = 0,
  onPress,
  size = 26,
}: {
  watched: boolean;
  watchCount?: number;
  onPress?: () => void;
  size?: number;
}) {
  const { tokens } = useAppearance();
  // Rewatched episodes (2+) show "×N" in place of the checkmark so the rewatch
  // tally is visible everywhere the watch button appears.
  const showCount = watched && watchCount >= 2;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={[
        styles.watchBtn,
        { width: size, height: size, borderRadius: size / 2, borderColor: watched ? tokens.watched : tokens.textMuted, backgroundColor: watched ? tokens.watched : 'transparent' },
      ]}
    >
      {watched ? (
        showCount ? (
          <Text
            numberOfLines={1}
            allowFontScaling={false}
            style={{ color: tokens.primaryForeground, fontSize: size * 0.42, fontWeight: '700' }}
          >
            ×{watchCount}
          </Text>
        ) : (
          <Ionicons name="checkmark" size={size * 0.7} color={tokens.primaryForeground} />
        )
      ) : null}
    </Pressable>
  );
}

/**
 * Build a press handler for a watch button. When the item is already watched (and
 * rewatch/unwatch handlers are supplied), pressing opens a Rewatch / Unwatch menu
 * instead of toggling. When not watched, it marks the item watched.
 */
export function useWatchMenu() {
  const { t } = useTranslation(['common']);
  return useCallback(
    (opts: { watched: boolean; onMarkWatched?: () => void; onRewatch?: () => void; onUnwatch?: () => void }) => {
      const { watched, onMarkWatched, onRewatch, onUnwatch } = opts;
      if (watched && (onRewatch || onUnwatch)) {
        showDialog({
          buttons: [
            { label: t('common:rewatch'), variant: 'primary', onPress: onRewatch },
            { label: t('common:unwatch'), variant: 'danger', onPress: onUnwatch },
          ],
        });
        return;
      }
      onMarkWatched?.();
    },
    [t],
  );
}

export function FavoriteButton({ active, onPress, size = 24 }: { active: boolean; onPress?: () => void; size?: number }) {
  const { tokens } = useAppearance();
  return (
    <Pressable onPress={onPress} hitSlop={10}>
      <Ionicons name={active ? 'heart' : 'heart-outline'} size={size} color={active ? tokens.favorite : tokens.textMuted} />
    </Pressable>
  );
}

export function Skeleton({ style }: { style?: ViewStyle }) {
  const { tokens } = useAppearance();
  return <View style={[styles.skeleton, { backgroundColor: tokens.skeleton }, style]} />;
}

export function EmptyState({ title, subtitle, cta, onCta, icon = 'film-outline' }: { title: string; subtitle?: string; cta?: string; onCta?: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  const { tokens } = useAppearance();
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={48} color={tokens.surfaceElevated} />
      <T variant="h2" style={{ marginTop: spacing.md }}>
        {title}
      </T>
      {subtitle ? (
        <T variant="body" muted style={{ marginTop: spacing.xs, textAlign: 'center' }}>
          {subtitle}
        </T>
      ) : null}
      {cta ? (
        <Button title={cta} onPress={onCta} style={{ marginTop: spacing.lg }} />
      ) : null}
    </View>
  );
}

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { tokens } = useAppearance();
  // Flatten: Screen is the direct child of expo-router's <Slot>, which warns on array styles.
  return <View style={StyleSheet.flatten([styles.screen, { backgroundColor: tokens.background }, style])}>{children}</View>;
}

export function Spinner() {
  const { tokens } = useAppearance();
  return <ActivityIndicator color={tokens.primary} style={{ padding: spacing.xl }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  card: { borderRadius: radius.lg, padding: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    marginRight: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusChip: { paddingVertical: 3, paddingHorizontal: 6, borderRadius: 4, alignSelf: 'flex-start' },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%' },
  watchBtn: { borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  skeleton: { borderRadius: radius.sm },
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
});
