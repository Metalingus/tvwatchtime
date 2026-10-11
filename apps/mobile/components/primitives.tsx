import React, { useCallback, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
  TextStyle,
  ImageStyle,
  StyleProp,
  ActivityIndicator,
  TouchableOpacity,
  FlatList,
  FlatListProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { radius, spacing, typography } from '../theme/theme';
import { useAppearance } from '../context/PreferencesProvider';
import { showDialog, showConfirm } from '../lib/dialog';
import { resolveImageFallback } from '../lib/image-fallback';

/** The bundled app icon, used as a default avatar placeholder. */
export const APP_ICON = require('../assets/icon.png');

// Animated.FlatList's layout-animation prop types don't compose with a spread
// FlatListProps<T>; cast once here so callers keep full FlatList typing.
const ReanimatedFlatListBase = Animated.FlatList as React.ComponentType<any>;

/**
 * FlatList with Reanimated layout transitions: when a refreshed payload
 * reorders/inserts/removes items (e.g. cached rail A B C D → server X A B Y),
 * new items fade in, removed ones fade out, and survivors SLIDE to their new
 * positions instead of the whole list swapping under the user's finger.
 * Initial mount never animates (skipEnteringExitingAnimations) so a screenful
 * of cards doesn't cascade in on first paint.
 */
export function AnimatedFlatList<T>(props: FlatListProps<T>) {
  return (
    <ReanimatedFlatListBase
      itemLayoutAnimation={LinearTransition.duration(250)}
      skipEnteringExitingAnimations
      {...props}
    />
  );
}

type TextProps = React.ComponentProps<typeof Text> & {
  variant?: keyof typeof typography;
  muted?: boolean;
  dim?: boolean;
};
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
  return (
    <View
      style={[styles.card, { backgroundColor: tokens.cardBackground }, style as ViewStyle]}
      {...rest}
    />
  );
}

interface BtnProps {
  title: string;
  subtitle?: string;
  onPress?: () => void;
  variant?: 'primary' | 'ghost' | 'watched' | 'danger';
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  style?: ViewStyle;
  disabled?: boolean;
}
export function Button({
  title,
  subtitle,
  onPress,
  variant = 'primary',
  icon,
  loading,
  style,
  disabled,
}: BtnProps) {
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
      style={[
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.5 : 1 },
        subtitle ? { paddingVertical: spacing.xs } : null,
        // Ghost buttons are surfaceElevated — white-on-white in the light theme,
        // so they need a hairline border to read as buttons.
        variant === 'ghost' ? { borderWidth: 1, borderColor: tokens.border } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} style={{ marginRight: 6 }} /> : null}
          {subtitle ? (
            <View style={{ flexShrink: 1, alignItems: 'center' }}>
              <T variant="h2" numberOfLines={1} style={{ color: fg, textAlign: 'center' }}>
                {title}
              </T>
              <T variant="micro" numberOfLines={1} style={{ color: fg, textAlign: 'center' }}>
                {subtitle}
              </T>
            </View>
          ) : (
            <T variant="h2" style={{ color: fg }}>
              {title}
            </T>
          )}
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
      style={[
        styles.chip,
        { backgroundColor: tokens.chip },
        active && { backgroundColor: tokens.primary },
        color ? { backgroundColor: color } : null,
      ]}
    >
      <T
        variant="caption"
        style={{ color: active || color ? tokens.primaryForeground : tokens.textMuted }}
      >
        {label}
      </T>
    </Comp>
  );
}

export function StatusChip({ label, color }: { label: string; color?: string }) {
  const { tokens } = useAppearance();
  return (
    <View
      style={[
        styles.statusChip,
        color ? { backgroundColor: color } : { backgroundColor: tokens.primary },
      ]}
    >
      <T variant="micro" style={{ color: tokens.primaryForeground }}>
        {label.toUpperCase()}
      </T>
    </View>
  );
}

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
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
          {
            width: `${Math.min(100, Math.max(0, value * 100))}%`,
            backgroundColor: color ?? tokens.primary,
          },
        ]}
      />
    </View>
  );
}

export function PosterImage({
  uri,
  style,
  fallback,
  fallbackUri,
  transition = 150,
}: {
  uri?: string | null;
  style?: StyleProp<ImageStyle>;
  fallback?: number | { uri: string };
  /** Remote image to show instead when `uri` fails to load (e.g. dead provider artwork). */
  fallbackUri?: string | null;
  /** Fade-in duration ms. Pass 0 in dense lists/grids — one JS-driven crossfade per
   *  cell (worst on web, where expo-image emulates transitions) causes scroll jank. */
  transition?: number;
}) {
  const { tokens } = useAppearance();
  // Keyed by the failed URI so a recycled cell with a new `uri` retries the primary.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const { uri: resolvedUri, canFallback } = resolveImageFallback(uri, fallbackUri, failedUri);
  const source = resolvedUri ? { uri: resolvedUri } : fallback;
  return (
    <Image
      source={source as any}
      style={[{ backgroundColor: tokens.surfaceElevated }, style]}
      contentFit="cover"
      transition={transition}
      cachePolicy="memory-disk"
      recyclingKey={resolvedUri ?? 'fallback'}
      onError={canFallback && uri ? () => setFailedUri(uri) : undefined}
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
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: watched ? tokens.watched : tokens.textMuted,
          backgroundColor: watched ? tokens.watched : 'transparent',
        },
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
 * rewatch/unwatch handlers are supplied), pressing opens a menu instead of toggling:
 * with multiple recorded watches it offers Rewatch / Unwatch once / Unwatch all —
 * Unwatch all asks for confirmation because it erases the whole rewatch history.
 * When not watched, it marks the item watched.
 */
export function useWatchMenu() {
  const { t } = useTranslation(['common']);
  return useCallback(
    (opts: {
      watched: boolean;
      watchCount?: number;
      onMarkWatched?: () => void;
      onRewatch?: () => void;
      onUnwatchOnce?: () => void;
      onUnwatch?: () => void;
    }) => {
      const { watched, watchCount = 0, onMarkWatched, onRewatch, onUnwatchOnce, onUnwatch } = opts;
      if (watched && (onRewatch || onUnwatch)) {
        const confirmUnwatchAll = () =>
          showConfirm({
            title: t('common:unwatchAllConfirmTitle'),
            description: t('common:unwatchAllConfirmDesc', { count: watchCount }),
            confirmLabel: t('common:unwatchAll'),
            destructive: true,
            onConfirm: () => onUnwatch?.(),
          });
        const buttons: {
          label: string;
          variant: 'primary' | 'secondary' | 'danger';
          onPress?: () => void;
        }[] = [];
        if (onRewatch)
          buttons.push({ label: t('common:rewatch'), variant: 'primary', onPress: onRewatch });
        if (watchCount >= 2 && onUnwatchOnce) {
          buttons.push({
            label: t('common:unwatchOnce'),
            variant: 'secondary',
            onPress: onUnwatchOnce,
          });
          buttons.push({
            label: t('common:unwatchAll'),
            variant: 'danger',
            onPress: confirmUnwatchAll,
          });
        } else if (onUnwatch) {
          buttons.push({ label: t('common:unwatch'), variant: 'danger', onPress: onUnwatch });
        }
        showDialog({ buttons });
        return;
      }
      onMarkWatched?.();
    },
    [t],
  );
}

export function FavoriteButton({
  active,
  onPress,
  size = 24,
}: {
  active: boolean;
  onPress?: () => void;
  size?: number;
}) {
  const { tokens } = useAppearance();
  return (
    <Pressable onPress={onPress} hitSlop={10}>
      <Ionicons
        name={active ? 'heart' : 'heart-outline'}
        size={size}
        color={active ? tokens.favorite : tokens.textMuted}
      />
    </Pressable>
  );
}

export function Skeleton({ style }: { style?: ViewStyle }) {
  const { tokens } = useAppearance();
  return <View style={[styles.skeleton, { backgroundColor: tokens.skeleton }, style]} />;
}

export function EmptyState({
  title,
  subtitle,
  cta,
  onCta,
  icon = 'film-outline',
}: {
  title: string;
  subtitle?: string;
  cta?: string;
  onCta?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
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
      {cta ? <Button title={cta} onPress={onCta} style={{ marginTop: spacing.lg }} /> : null}
    </View>
  );
}

export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { tokens } = useAppearance();
  // Flatten: Screen is the direct child of expo-router's <Slot>, which warns on array styles.
  return (
    <View
      style={StyleSheet.flatten([styles.screen, { backgroundColor: tokens.background }, style])}
    >
      {children}
    </View>
  );
}

export function Spinner() {
  const { tokens } = useAppearance();
  return <ActivityIndicator color={tokens.primary} style={{ padding: spacing.xl }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  card: { borderRadius: radius.lg, padding: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
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
  statusChip: {
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%' },
  watchBtn: { borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  skeleton: { borderRadius: radius.sm },
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
});
