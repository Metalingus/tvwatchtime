import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '../theme/theme';
import { T } from './primitives';
import { pressDialogButton } from '@tvwatch/shared';
import type { DialogEntry } from '@tvwatch/shared';
import { dialog } from '../lib/dialog';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

function variantBg(v: Variant): string {
  switch (v) {
    case 'primary':
      return colors.primary;
    case 'danger':
      return colors.danger;
    case 'ghost':
      return 'transparent';
    case 'secondary':
    default:
      return colors.surfaceElevated;
  }
}

function variantFg(v: Variant): string {
  return v === 'ghost' ? colors.text : '#0F1115';
}

export function AppDialog({ entry }: { entry: DialogEntry }) {
  const insets = useSafeAreaInsets();
  const { title, description, content, dismissible, showCloseButton, buttons, id } = entry;

  const handleButton = (index: number) => {
    pressDialogButton(dialog, entry, index);
  };

  const close = () => {
    if (dismissible) dialog.dismiss(id);
  };

  const stackButtons = buttons.length > 2;

  const CustomContent = content as React.ReactNode | undefined;

  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onRequestClose={close}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable
          style={[styles.card, { marginBottom: insets.bottom + spacing.lg, marginTop: insets.top + spacing.lg }]}
          onPress={(e) => e.stopPropagation()}
        >
          {showCloseButton ? (
            <Pressable onPress={close} hitSlop={12} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </Pressable>
          ) : null}

          <ScrollView
            bounces={false}
            style={{ maxHeight: '70%' }}
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
              const bg = variantBg(b.variant as Variant);
              const fg = variantFg(b.variant as Variant);
              const isGhost = b.variant === 'ghost';
              const inner = b.loading ? (
                <ActivityIndicator color={fg} />
              ) : (
                <T variant="h2" style={{ color: fg }}>
                  {b.label}
                </T>
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
                    isGhost ? styles.btnGhost : null,
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
    backgroundColor: colors.overlayStrong,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
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
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    minWidth: 96,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  } as ViewStyle,
  btnFull: {
    width: '100%',
  },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
});
