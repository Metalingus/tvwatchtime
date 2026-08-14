import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { Header } from '../components/Header';
import { Button, Card, Screen, SectionHeader, Spinner, T } from '../components/primitives';
import { TextField } from '../components/TextField';
import { IntegrationAdvancedSettings } from '../components/IntegrationAdvancedSettings';
import {
  useCompleteIntegrationLink,
  useConnectJellyfin,
  useDisconnectIntegration,
  useIntegrations,
  useStartIntegrationLink,
  useSyncIntegration,
} from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../theme/theme';
import { showConfirm, showError } from '../lib/dialog';
import { showToast } from '../lib/toast';
import type { IntegrationDto, IntegrationLinkStartDto, IntegrationProvider } from '@tvwatch/shared';
import { IntegrationIcon, type IntegrationBrand } from '../components/IntegrationIcon';

const PROVIDERS: Array<{
  provider: IntegrationBrand;
  name: string;
  website?: string;
}> = [
  { provider: 'SIMKL', name: 'SIMKL', website: 'https://simkl.com' },
  { provider: 'STREMIO', name: 'Stremio', website: 'https://www.stremio.com' },
  { provider: 'JELLYFIN', name: 'Jellyfin' },
  { provider: 'PLEX', name: 'Plex' },
  { provider: 'TRAKT', name: 'Trakt' },
  { provider: 'EMBY', name: 'Emby' },
];

function isSupportedProvider(provider: IntegrationBrand): provider is IntegrationProvider {
  return provider === 'SIMKL' || provider === 'STREMIO' || provider === 'JELLYFIN';
}

function ProviderHeader({
  provider,
  name,
  description,
  status,
  connected = false,
  disabled = false,
  website,
}: {
  provider: IntegrationBrand;
  name: string;
  description: string;
  status: string;
  connected?: boolean;
  disabled?: boolean;
  website?: string;
}) {
  const { tokens } = useAppearance();
  const title = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
      <T
        variant="h2"
        style={
          disabled ? { color: tokens.textMuted } : website ? { color: tokens.primary } : undefined
        }
      >
        {name}
      </T>
      {website && !disabled ? (
        <Ionicons name="open-outline" size={16} color={tokens.primary} />
      ) : null}
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
      <View
        style={{
          width: 64,
          height: 44,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.surfaceElevated,
        }}
      >
        <IntegrationIcon provider={provider} size={30} disabled={disabled} />
      </View>
      <View style={{ flex: 1 }}>
        {website && !disabled ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={name}
            onPress={() => WebBrowser.openBrowserAsync(website)}
          >
            {title}
          </Pressable>
        ) : (
          title
        )}
        <T variant="micro" muted>
          {description}
        </T>
      </View>
      <View
        style={{
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          borderRadius: radius.md,
          backgroundColor: connected || disabled ? tokens.surfaceElevated : 'transparent',
        }}
      >
        <T variant="micro" style={{ color: connected ? tokens.primary : tokens.textMuted }}>
          {status}
        </T>
      </View>
    </View>
  );
}

export default function IntegrationsScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['settings', 'common']);
  const integrations = useIntegrations();
  const startLink = useStartIntegrationLink();
  const completeLink = useCompleteIntegrationLink();
  const connectJellyfin = useConnectJellyfin();
  const sync = useSyncIntegration();
  const disconnect = useDisconnectIntegration();
  const [pending, setPending] = useState<
    Partial<Record<IntegrationProvider, IntegrationLinkStartDto>>
  >({});
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const rows = new Map((integrations.data ?? []).map((row) => [row.provider, row]));
  const busy =
    startLink.isPending ||
    completeLink.isPending ||
    connectJellyfin.isPending ||
    sync.isPending ||
    disconnect.isPending;

  const beginLink = async (provider: 'SIMKL' | 'STREMIO') => {
    try {
      const link = await startLink.mutateAsync(provider);
      setPending((current) => ({ ...current, [provider]: link }));
      await WebBrowser.openBrowserAsync(link.verificationUrl);
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    }
  };

  const finishLink = async (provider: 'SIMKL' | 'STREMIO') => {
    try {
      await completeLink.mutateAsync(provider);
      setPending((current) => ({ ...current, [provider]: undefined }));
      showToast(t('settings:integrations.syncComplete'));
    } catch {
      showError({
        title: t('settings:integrations.notConnectedYet'),
        description: t('common:pleaseTryAgain'),
      });
    }
  };

  const connectServer = async () => {
    try {
      await connectJellyfin.mutateAsync({ serverUrl, username, password });
      showToast(t('settings:integrations.syncComplete'));
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    } finally {
      setPassword('');
    }
  };

  const syncNow = async (provider: IntegrationProvider) => {
    try {
      const result = await sync.mutateAsync(provider);
      showToast(
        t('settings:integrations.syncResult', {
          created: result.created,
          skipped: result.skipped,
        }),
      );
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    }
  };

  const remove = (provider: IntegrationProvider) =>
    showConfirm({
      title: t('settings:integrations.disconnectTitle', { provider }),
      description: t('settings:integrations.disconnectDescription'),
      confirmLabel: t('settings:integrations.disconnect'),
      destructive: true,
      onConfirm: () => disconnect.mutateAsync(provider),
    });

  if (integrations.isLoading) {
    return (
      <Screen>
        <Header title={t('settings:integrations.title')} showBack />
        <Spinner />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={t('settings:integrations.title')} showBack />
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={integrations.isRefetching}
            onRefresh={() => integrations.refetch()}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        }
        contentContainerStyle={{
          padding: spacing.lg,
          gap: spacing.lg,
          paddingBottom: spacing.xxl * 2,
        }}
      >
        <Card>
          <SectionHeader title={t('settings:integrations.inboundOnly')} />
          <T variant="caption" muted>
            {t('settings:integrations.description')}
          </T>
        </Card>

        {PROVIDERS.map(({ provider, name, website }) => {
          if (!isSupportedProvider(provider)) {
            return (
              <Card key={provider}>
                <ProviderHeader
                  provider={provider}
                  name={name}
                  description={t('settings:integrations.notSupportedYet')}
                  status={t('settings:integrations.comingSoon')}
                  disabled
                />
              </Card>
            );
          }
          const row = rows.get(provider);
          const link = pending[provider];
          return (
            <Card key={provider}>
              <ProviderHeader
                provider={provider}
                name={name}
                website={website}
                description={t(`settings:integrations.capabilities.${provider.toLowerCase()}`)}
                status={
                  row?.connected
                    ? t('settings:integrations.connected')
                    : t('settings:integrations.notConnected')
                }
                connected={row?.connected}
              />

              {!row?.available ? (
                <T variant="caption" muted style={{ marginTop: spacing.md }}>
                  {t('settings:integrations.unavailable')}
                </T>
              ) : row?.connected ? (
                <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                  {row.displayName || row.serverUrl ? (
                    <T variant="caption" muted>
                      {row.displayName ?? row.serverUrl}
                    </T>
                  ) : null}
                  <T variant="micro" muted>
                    {row.lastSyncedAt
                      ? t('settings:integrations.lastSynced', {
                          date: new Date(row.lastSyncedAt).toLocaleString(),
                        })
                      : t('settings:integrations.neverSynced')}
                  </T>
                  {row.lastSyncStatus === 'FAILED' && row.lastSyncError ? (
                    <T variant="micro" style={{ color: tokens.danger }}>
                      {row.lastSyncError}
                    </T>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <Button
                      title={t('settings:integrations.syncNow')}
                      icon="sync-outline"
                      onPress={() => syncNow(provider)}
                      loading={sync.isPending && sync.variables === provider}
                      disabled={busy || row.paused || row.itemsDisabled}
                      style={{ flex: 1 }}
                    />
                    <Button
                      title={t('settings:integrations.disconnect')}
                      variant="ghost"
                      onPress={() => remove(provider)}
                      disabled={busy}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              ) : provider === 'JELLYFIN' ? (
                <View style={{ marginTop: spacing.md }}>
                  <TextField
                    label={t('settings:integrations.serverUrl')}
                    value={serverUrl}
                    onChangeText={setServerUrl}
                    autoCapitalize="none"
                    keyboardType="url"
                  />
                  <TextField
                    label={t('settings:integrations.username')}
                    value={username}
                    onChangeText={setUsername}
                    autoCapitalize="none"
                  />
                  <TextField
                    label={t('settings:integrations.password')}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                  />
                  <Button
                    title={t('settings:integrations.connectAndSync')}
                    icon="link-outline"
                    onPress={connectServer}
                    loading={connectJellyfin.isPending}
                    disabled={!serverUrl || !username || busy}
                  />
                </View>
              ) : link ? (
                <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                  <T variant="caption" muted>
                    {t('settings:integrations.enterCode')}
                  </T>
                  <Pressable onPress={() => WebBrowser.openBrowserAsync(link.verificationUrl)}>
                    <T variant="h2" style={{ color: tokens.primary, textAlign: 'center' }}>
                      {link.code}
                    </T>
                  </Pressable>
                  <Button
                    title={t('settings:integrations.finishConnection')}
                    onPress={() => finishLink(provider)}
                    loading={completeLink.isPending}
                    disabled={busy}
                  />
                  <Button
                    title={t('settings:integrations.openAuthorization')}
                    variant="ghost"
                    onPress={() => WebBrowser.openBrowserAsync(link.verificationUrl)}
                  />
                </View>
              ) : (
                <Button
                  title={t('settings:integrations.connect')}
                  icon="link-outline"
                  style={{ marginTop: spacing.md }}
                  onPress={() => beginLink(provider)}
                  loading={startLink.isPending && startLink.variables === provider}
                  disabled={busy}
                />
              )}
              {row && (row.connected || row.syncedItemCount > 0) ? (
                <IntegrationAdvancedSettings row={row} actionsDisabled={busy} />
              ) : null}
            </Card>
          );
        })}
      </ScrollView>
    </Screen>
  );
}
