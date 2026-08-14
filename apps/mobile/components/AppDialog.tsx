import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, spacing } from '../theme/theme';
import { T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { pressDialogButton } from '@tvwatch/shared';
import type { DialogEntry } from '@tvwatch/shared';
import type { Tokens } from '@tvwatch/shared';
import { dialog } from '../lib/dialog';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

function variantBg(v: Variant, tokens: Tokens): string {
  switch (v) {
    case 'primary':
      return tokens.primary;
    case 'danger':
      return tokens.danger;
    case 'ghost':
      return 'transparent';
    case 'secondary':
    default:
      return tokens.surfaceElevated;
  }
}

function variantFg(v: Variant, tokens: Tokens): string {
  // 'secondary'/'ghost' sit on surfaceElevated/transparent, so they need the theme's
  // normal text color — primaryForeground is near-black in BOTH themes (it's meant
  // for text on the gold primary) and is unreadable on dark surfaces.
  return v === 'ghost' || v === 'secondary' ? tokens.textPrimary : tokens.primaryForeground;
}

export function AppDialog({ entry }: { entry: DialogEntry }) {
  const insets = useSafeAreaInsets();
  const { tokens } = useAppearance();
  const { title, description, content, dismissible, showCloseButton, buttons, id } = entry;
  // Concrete pixel cap — a percentage maxHeight does not resolve on the unbounded
  // dialog card (Android), letting long content push the card off screen. The cap
  // accounts for the real chrome: safe-area margins, card padding, title, and the
  // button row (which STACKS once there are more than two buttons, and WRAPS to a
  // second row for two long labels).
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  // Explicit pixel width — `width: '100%'` + `maxWidth` inside the padded backdrop
  // resolves against the parent's BORDER box on Android (Yoga quirk), and the
  // negative centering offset is clamped, so the card kept its left margin but
  // rendered flush against the right screen edge.
  const cardWidth = Math.min(windowWidth - spacing.lg * 2, 400);
  const buttonsHeight =
    (buttons.length > 2 ? buttons.length * 54 : buttons.length === 2 ? 2 * 54 : 64) + spacing.lg;
  const contentMaxHeight = Math.max(
    160,
    windowHeight -
      (insets.top + insets.bottom + spacing.lg * 2) - // card margins
      spacing.xl * 2 - // card padding
      48 - // title
      buttonsHeight,
  );

  const handleButton = (index: number) => {
    pressDialogButton(dialog, entry, index);
  };

  const close = () => {
    if (dismissible) dialog.dismiss(id);
  };

  const stackButtons = buttons.length > 2;

  const CustomContent = content as React.ReactNode | undefined;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={close} statusBarTranslucent>
      <Pressable
        style={[styles.backdrop, { backgroundColor: tokens.overlayStrong }]}
        onPress={close}
      >
        <Pressable
          style={[
            styles.card,
            {
              width: cardWidth,
              marginBottom: insets.bottom + spacing.lg,
              marginTop: insets.top + spacing.lg,
              backgroundColor: tokens.surface,
              borderColor: tokens.border,
            },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          {showCloseButton ? (
            <Pressable onPress={close} hitSlop={12} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={tokens.textMuted} />
            </Pressable>
          ) : null}

          <ScrollView
            bounces={false}
            style={{ maxHeight: contentMaxHeight }}
            contentContainerStyle={styles.scrollBody}
          >
            {title ? (
              <T variant="h1" style={styles.title}>
                {title}
              </T>
            ) : null}
            {description ? (
              <T variant="body" muted style={title ? styles.description : undefined}>
                {description}
              </T>
            ) : null}
            {CustomContent ? <View style={styles.content}>{CustomContent}</View> : null}
          </ScrollView>

          <View style={[styles.buttonRow, stackButtons && styles.buttonCol]}>
            {buttons.map((b, i) => {
              const bg = variantBg(b.variant as Variant, tokens);
              const fg = variantFg(b.variant as Variant, tokens);
              // Ghost + secondary blend into the dialog surface in the light theme
              // (white on white) — a hairline border keeps the button shape visible.
              const bordered = b.variant === 'ghost' || b.variant === 'secondary';
              const inner = b.loading ? (
                <ActivityIndicator color={fg} />
              ) : (
                <>
                  {(b.icon as React.ReactNode | undefined) ?? null}
                  <T variant="h2" style={{ color: fg }}>
                    {b.label}
                  </T>
                </>
              );
              return (
                <Pressable
                  key={`${b.label}-${i}`}
                  onPress={() => handleButton(i)}
                  disabled={b.disabled || b.loading}
                  style={[
                    styles.btn,
                    { backgroundColor: bg, opacity: b.disabled || b.loading ? 0.5 : 1 },
                    stackButtons ? styles.btnFull : null,
                    bordered ? [styles.btnBordered, { borderColor: tokens.border }] : null,
                  ]}
                >
                  {inner}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: spacing.xl,
    position: 'relative',
  },
  closeBtn: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    zIndex: 2,
  },
  scrollBody: {
    paddingBottom: spacing.sm,
  },
  title: {
    textAlign: 'center',
    marginBottom: spacing.sm,
    paddingRight: spacing.xl,
  },
  description: {
    textAlign: 'center',
    marginTop: 0,
  },
  content: {
    marginTop: spacing.md,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  buttonCol: {
    flexDirection: 'column-reverse',
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    minWidth: 96,
    // Grow to share the row evenly (friendlier than right-hugging buttons); when two
    // buttons can't both keep the 140px basis they wrap, each taking a full row.
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 140,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  } as ViewStyle,
  btnFull: {
    width: '100%',
    flexBasis: 'auto',
  },
  btnBordered: {
    borderWidth: 1,
  },
});
