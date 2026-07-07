import React from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle, TextStyle, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { colors, radius, spacing, typography } from '../theme/theme';

type TextProps = React.ComponentProps<typeof Text> & { variant?: keyof typeof typography; muted?: boolean; dim?: boolean };
export function T({ variant = 'body', muted, dim, style, ...rest }: TextProps) {
  return (
    <Text
      style={[
        typography[variant],
        { color: muted ? colors.textMuted : dim ? colors.textDim : colors.text },
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
  return <View style={[styles.card, style as ViewStyle]} {...rest} />;
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
  const bg =
    variant === 'primary'
      ? colors.primary
      : variant === 'watched'
        ? colors.watched
        : variant === 'danger'
          ? colors.danger
          : colors.surfaceElevated;
  const fg = variant === 'ghost' ? colors.text : '#0F1115';
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
  const Comp = onPress ? Pressable : View;
  return (
    <Comp
      onPress={onPress}
      style={[styles.chip, active && { backgroundColor: colors.primary }, color ? { backgroundColor: color } : null]}
    >
      <T variant="caption" style={{ color: active || color ? '#0F1115' : colors.textMuted }}>
        {label}
      </T>
    </Comp>
  );
}

export function StatusChip({ label, color }: { label: string; color?: string }) {
  return (
    <View style={[styles.statusChip, color ? { backgroundColor: color } : { backgroundColor: colors.primary }]}>
      <T variant="micro" style={{ color: '#0F1115' }}>
        {label.toUpperCase()}
      </T>
    </View>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.row}>
      <T variant="h1">{title}</T>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <T variant="caption" style={{ color: colors.primary }}>
            {action} ›
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ProgressBar({ value, color }: { value: number; color?: string }) {
  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          { width: `${Math.min(100, Math.max(0, value * 100))}%`, backgroundColor: color ?? colors.primary },
        ]}
      />
    </View>
  );
}

export function PosterImage({ uri, style }: { uri?: string | null; style?: ViewStyle }) {
  return (
    <Image
      source={uri ? { uri } : undefined}
      style={[{ backgroundColor: colors.surfaceElevated }, style]}
      contentFit="cover"
      transition={150}
    />
  );
}

export function WatchButton({ watched, onPress, size = 26 }: { watched: boolean; onPress?: () => void; size?: number }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={[
        styles.watchBtn,
        { width: size, height: size, borderRadius: size / 2, borderColor: watched ? colors.watched : colors.textMuted, backgroundColor: watched ? colors.watched : 'transparent' },
      ]}
    >
      {watched ? <Ionicons name="checkmark" size={size * 0.7} color="#0F1115" /> : null}
    </Pressable>
  );
}

export function FavoriteButton({ active, onPress, size = 24 }: { active: boolean; onPress?: () => void; size?: number }) {
  return (
    <Pressable onPress={onPress} hitSlop={10}>
      <Ionicons name={active ? 'heart' : 'heart-outline'} size={size} color={active ? colors.favorite : colors.textMuted} />
    </Pressable>
  );
}

export function Skeleton({ style }: { style?: ViewStyle }) {
  return <View style={[styles.skeleton, style]} />;
}

export function EmptyState({ title, subtitle, cta, onCta, icon = 'film-outline' }: { title: string; subtitle?: string; cta?: string; onCta?: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={48} color={colors.surfaceElevated} />
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
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Spinner() {
  return <ActivityIndicator color={colors.primary} style={{ padding: spacing.xl }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md },
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
    backgroundColor: colors.chip,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    marginRight: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusChip: { paddingVertical: 3, paddingHorizontal: 6, borderRadius: 4, alignSelf: 'flex-start' },
  progressTrack: { height: 4, backgroundColor: colors.surfaceElevated, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%' },
  watchBtn: { borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  skeleton: { backgroundColor: colors.surfaceElevated, borderRadius: radius.sm },
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
});
