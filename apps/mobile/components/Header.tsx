import React from 'react';
import { Pressable, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation(['common']);
  const fg = tone === 'media' ? tokens.mediaText : tokens.textPrimary;
  return (
    <View
      style={[
        styles.wrap,
        {
          paddingTop: insets.top + HEADER_TOP_GAP,
          backgroundColor: tone === 'media' ? 'transparent' : tokens.background,
        },
        style,
      ]}
    >
      <View style={styles.row}>
        {showBack ? (
          <Pressable
            onPress={() => router.back()}
            hitSlop={BACK_HIT_SLOP}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel={t('common:back')}
          >
            <Ionicons name="chevron-back" size={BACK_ICON_SIZE} color={fg} />
          </Pressable>
        ) : null}
        {title ? (
          <View style={{ flex: 1 }}>
            <T variant="title" style={tone === 'media' ? { color: fg } : undefined}>
              {title}
            </T>
            {subtitle ? (
              <T variant="caption" muted style={tone === 'media' ? { color: fg } : undefined}>
                {subtitle}
              </T>
            ) : null}
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {right}
      </View>
    </View>
  );
}

export function IconButton({
  icon,
  onPress,
  badge,
  tone = 'default',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  badge?: number;
  tone?: 'default' | 'media';
}) {
  const { tokens } = useAppearance();
  const fg = tone === 'media' ? tokens.mediaText : tokens.textPrimary;
  const badgeLabel = badge && badge > 99 ? '99+' : badge ? String(badge) : '';
  return (
    <Pressable onPress={onPress} hitSlop={10} style={styles.iconBtn}>
      <Ionicons name={icon} size={24} color={fg} />
      {badge ? (
        <View style={[styles.badge, { backgroundColor: tokens.primary }]}>
          <T
            variant="micro"
            style={{ color: tokens.primaryForeground, fontSize: 9, fontWeight: '700' }}
          >
            {badgeLabel}
          </T>
        </View>
      ) : null}
    </Pressable>
  );
}

// The back button sits over tappable hero artwork on media pages, and hitSlop is ignored on
// web, so the pressable itself carries a 48px touch target (Material minimum). Negative
// margins keep the icon and title where a bare 26px icon would put them, and keep the 40px
// row height unchanged. hitSlop only extends it on native, and Android drops the part that
// falls outside the header, so ArtworkHero also ignores near-misses in the header band.
const BACK_ICON_SIZE = 26;
const BACK_TARGET_SIZE = 48;
const BACK_HIT_SLOP = 12;
const BACK_INSET = (BACK_TARGET_SIZE - BACK_ICON_SIZE) / 2;
const HEADER_TOP_GAP = 8;
const ROW_MIN_HEIGHT = 40;
/** Header height below the top safe-area inset. */
export const HEADER_HEIGHT = HEADER_TOP_GAP + ROW_MIN_HEIGHT;

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: ROW_MIN_HEIGHT },
  backBtn: {
    width: BACK_TARGET_SIZE,
    height: BACK_TARGET_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -BACK_INSET,
    marginRight: spacing.sm - BACK_INSET,
    marginVertical: (ROW_MIN_HEIGHT - BACK_TARGET_SIZE) / 2,
  },
  iconBtn: { marginLeft: spacing.md, position: 'relative' },
  badge: {
    position: 'absolute',
    top: -6,
    right: -8,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 3,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
