import React, { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { normalizeExploreSections, type ExploreSectionPreferences } from '@tvwatch/shared';
import { useAppearance } from '../context/PreferencesProvider';
import { WEB_PORTRAIT_MAX_WIDTH } from '../hooks/useContentWidth';
import { moveExploreSection } from '../lib/explore-sections';
import { radius, spacing } from '../theme/theme';
import { Button, T } from './primitives';

/** Editing, reset, and save errors stay inside this single native modal. */
export function ExploreSectionsSheet({
  initial,
  onSave,
  onClose,
}: {
  initial: ExploreSectionPreferences;
  onSave: (value: ExploreSectionPreferences) => Promise<void>;
  onClose: () => void;
}) {
  const { tokens } = useAppearance();
  const { bottom } = useSafeAreaInsets();
  const { t } = useTranslation(['explore', 'common']);
  const [draft, setDraft] = useState(() => normalizeExploreSections(initial));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => {
    if (!saving) onClose();
  };
  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await onSave(draft);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <View style={styles.container}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: tokens.overlay }]}
          onPress={close}
          accessibilityLabel={t('common:close')}
          accessibilityRole="button"
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: tokens.surface, paddingBottom: Math.max(bottom, spacing.lg) },
          ]}
        >
          <View style={styles.heading}>
            <T variant="h1" style={styles.grow}>
              {t('explore:sections.title')}
            </T>
            <Pressable
              onPress={close}
              disabled={saving}
              style={styles.control}
              accessibilityRole="button"
              accessibilityLabel={t('common:close')}
            >
              <Ionicons name="close" size={spacing.xl} color={tokens.textPrimary} />
            </Pressable>
          </View>
          <T variant="caption" muted style={styles.description}>
            {t('explore:sections.description')}
          </T>
          <ScrollView style={styles.rows} contentContainerStyle={styles.rowContent}>
            {draft.order.map((id, index) => {
              const label = t('explore:' + id);
              const enabled = !draft.hidden.includes(id);
              return (
                <View key={id} style={[styles.row, { borderColor: tokens.border }]}>
                  <Switch
                    value={enabled}
                    disabled={saving}
                    accessibilityLabel={t('explore:sections.showSection', { section: label })}
                    trackColor={{ false: tokens.border, true: tokens.primary }}
                    thumbColor={tokens.primaryForeground}
                    // Web exposes a separate active-thumb color; native uses thumbColor for both.
                    {...(Platform.OS === 'web'
                      ? { activeThumbColor: tokens.primaryForeground }
                      : {})}
                    onValueChange={(value) =>
                      setDraft((previous) => ({
                        ...previous,
                        hidden: value
                          ? previous.hidden.filter((item) => item !== id)
                          : previous.hidden.includes(id)
                            ? previous.hidden
                            : [...previous.hidden, id],
                      }))
                    }
                  />
                  <T variant="body" style={styles.grow}>
                    {label}
                  </T>
                  {([-1, 1] as const).map((direction) => {
                    const disabled =
                      saving || (direction === -1 ? index === 0 : index === draft.order.length - 1);
                    return (
                      <Pressable
                        key={direction}
                        disabled={disabled}
                        onPress={() =>
                          setDraft((previous) => moveExploreSection(previous, id, direction))
                        }
                        style={styles.control}
                        accessibilityRole="button"
                        accessibilityState={{ disabled }}
                        accessibilityLabel={t(
                          direction === -1
                            ? 'explore:sections.moveUp'
                            : 'explore:sections.moveDown',
                          { section: label },
                        )}
                      >
                        <Ionicons
                          name={direction === -1 ? 'arrow-up' : 'arrow-down'}
                          size={spacing.xl}
                          color={disabled ? tokens.textMuted : tokens.textPrimary}
                        />
                      </Pressable>
                    );
                  })}
                </View>
              );
            })}
          </ScrollView>
          {failed ? (
            <T
              variant="caption"
              style={{ color: tokens.danger, marginTop: spacing.md }}
              accessibilityLiveRegion="polite"
            >
              {t('explore:sections.saveFailed')}
            </T>
          ) : null}
          <Button
            title={t('explore:sections.reset')}
            variant="ghost"
            disabled={saving}
            onPress={() => setDraft(normalizeExploreSections(null))}
            style={{ marginTop: spacing.md }}
          />
          <View style={styles.actions}>
            <Button
              title={t('common:cancel')}
              variant="ghost"
              disabled={saving}
              onPress={close}
              style={styles.grow}
            />
            <Button
              title={t('common:save')}
              loading={saving}
              disabled={saving}
              onPress={save}
              style={styles.grow}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  sheet: {
    width: '100%',
    maxWidth: WEB_PORTRAIT_MAX_WIDTH,
    maxHeight: '90%',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  heading: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1 },
  description: { marginBottom: spacing.md },
  rows: { flexShrink: 1 },
  rowContent: { paddingBottom: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  control: {
    width: spacing.lg * 3,
    height: spacing.lg * 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
});
