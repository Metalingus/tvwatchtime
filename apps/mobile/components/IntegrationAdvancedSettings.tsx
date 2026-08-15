import React, { useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type {
  IntegrationCapability,
  IntegrationDto,
  IntegrationMediaSyncSettings,
} from '@tvwatch/shared';
import {
  useDeleteIntegrationItems,
  useSetIntegrationItemsEnabled,
  useUpdateIntegrationSettings,
} from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { showConfirm, showError } from '../lib/dialog';
import { showToast } from '../lib/toast';
import { spacing } from '../theme/theme';
import { Button, T } from './primitives';

type SettingKey = keyof IntegrationMediaSyncSettings;
const SETTINGS: Array<{ key: SettingKey; capability: IntegrationCapability }> = [
  { key: 'watched', capability: 'WATCHED' },
  { key: 'watchlist', capability: 'WATCHLIST' },
  { key: 'favorites', capability: 'FAVORITES' },
  { key: 'ratings', capability: 'RATINGS' },
];

function ToggleRow({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const { tokens } = useAppearance();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <View style={{ flex: 1, marginRight: spacing.md }}>
        <T variant="body">{label}</T>
        {hint ? (
          <T variant="micro" muted>
            {hint}
          </T>
        ) : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: tokens.controlTrackOff, true: tokens.primary }}
        thumbColor={tokens.controlThumb}
      />
    </View>
  );
}

export function IntegrationAdvancedSettings({
  row,
  actionsDisabled = false,
}: {
  row: IntegrationDto;
  actionsDisabled?: boolean;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['settings', 'common']);
  const [expanded, setExpanded] = useState(false);
  const update = useUpdateIntegrationSettings();
  const setEnabled = useSetIntegrationItemsEnabled();
  const deleteItems = useDeleteIntegrationItems();
  const busy = update.isPending || setEnabled.isPending || deleteItems.isPending || actionsDisabled;
  const supported = new Set(row.capabilities);
  const supportedSettings = SETTINGS.filter((setting) => supported.has(setting.capability));
  const collectionsSupported = supported.has('COLLECTIONS');
  const allSelected =
    (['movies', 'shows'] as const).every((media) =>
      supportedSettings.every((setting) => row.syncSettings[media][setting.key]),
    ) &&
    (!collectionsSupported || row.syncSettings.collections);

  const save = async (settings: Parameters<typeof update.mutateAsync>[0]['settings']) => {
    try {
      await update.mutateAsync({ provider: row.provider, settings });
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    }
  };

  const setAll = (value: boolean) => {
    const media = Object.fromEntries(
      supportedSettings.map((setting) => [setting.key, value]),
    ) as Partial<IntegrationMediaSyncSettings>;
    void save({
      syncSettings: {
        movies: media,
        shows: media,
        ...(collectionsSupported ? { collections: value } : {}),
      },
    });
  };

  const toggleItems = async () => {
    try {
      await setEnabled.mutateAsync({ provider: row.provider, enabled: row.itemsDisabled });
      showToast(
        t(
          row.itemsDisabled
            ? 'settings:integrations.advanced.itemsEnabled'
            : 'settings:integrations.advanced.itemsDisabled',
        ),
      );
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    }
  };

  const removeItems = () =>
    showConfirm({
      title: t('settings:integrations.advanced.deleteTitle', { provider: row.provider }),
      description: t('settings:integrations.advanced.deleteDescription'),
      confirmLabel: t('settings:integrations.advanced.deleteConfirm'),
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteItems.mutateAsync(row.provider);
          showToast(t('settings:integrations.advanced.itemsDeleted'));
        } catch {
          showError({ description: t('common:pleaseTryAgain') });
        }
      },
    });

  return (
    <View style={{ marginTop: spacing.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: spacing.sm,
        }}
      >
        <T variant="body" style={{ color: tokens.primary }}>
          {t('settings:integrations.advanced.title')}
        </T>
        <Ionicons
          name={expanded ? 'chevron-up-outline' : 'chevron-down-outline'}
          size={20}
          color={tokens.primary}
        />
      </Pressable>

      {expanded ? (
        <View style={{ gap: spacing.sm }}>
          <T variant="micro" muted>
            {t('settings:integrations.advanced.syncedItems', { count: row.syncedItemCount })}
          </T>
          <ToggleRow
            label={t('settings:integrations.advanced.all')}
            value={allSelected}
            disabled={busy || !supportedSettings.length}
            onChange={setAll}
          />
          {(['movies', 'shows'] as const).map((media) => (
            <View key={media} style={{ marginTop: spacing.xs }}>
              <T variant="caption" style={{ color: tokens.textMuted }}>
                {t(`settings:integrations.advanced.${media}`)}
              </T>
              {SETTINGS.map((setting) => {
                const available = supported.has(setting.capability);
                return (
                  <ToggleRow
                    key={`${media}-${setting.key}`}
                    label={t(`settings:integrations.advanced.${setting.key}`)}
                    hint={available ? undefined : t('settings:integrations.advanced.notAvailable')}
                    value={available && row.syncSettings[media][setting.key]}
                    disabled={busy || !available}
                    onChange={(value) =>
                      void save({ syncSettings: { [media]: { [setting.key]: value } } })
                    }
                  />
                );
              })}
            </View>
          ))}
          {collectionsSupported ? (
            <ToggleRow
              label={t('settings:integrations.advanced.collections')}
              hint={t('settings:integrations.advanced.collectionsDescription')}
              value={row.syncSettings.collections}
              disabled={busy}
              onChange={(collections) => void save({ syncSettings: { collections } })}
            />
          ) : null}
          <ToggleRow
            label={t('settings:integrations.advanced.pause')}
            hint={t('settings:integrations.advanced.pauseDescription')}
            value={row.paused}
            disabled={busy}
            onChange={(paused) => void save({ paused })}
          />
          <T variant="micro" muted>
            {t('settings:integrations.advanced.authorityDescription')}
          </T>
          <Button
            title={t(
              row.itemsDisabled
                ? 'settings:integrations.advanced.enableItems'
                : 'settings:integrations.advanced.disableItems',
            )}
            icon={row.itemsDisabled ? 'eye-outline' : 'eye-off-outline'}
            variant="ghost"
            onPress={toggleItems}
            loading={setEnabled.isPending}
            disabled={busy || (row.itemsDisabled && (!row.connected || row.paused))}
          />
          <Button
            title={t('settings:integrations.advanced.deleteItems')}
            icon="trash-outline"
            variant="danger"
            onPress={removeItems}
            loading={deleteItems.isPending}
            disabled={busy || row.syncedItemCount === 0}
          />
        </View>
      ) : null}
    </View>
  );
}
