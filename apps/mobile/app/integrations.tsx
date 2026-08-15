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
  useConnectMediaServer,
  useDisconnectIntegration,
  useIntegrations,
  useStartIntegrationLink,
  useSelectPlexServer,
  useSyncIntegration,
} from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { radius, spacing } from '../theme/theme';
import { showConfirm, showError } from '../lib/dialog';
import { showToast } from '../lib/toast';
import type {
  IntegrationDto,
  IntegrationLinkStartDto,
  IntegrationProvider,
  PlexServerDto,
} from '@tvwatch/shared';
import { IntegrationIcon, type IntegrationBrand } from '../components/IntegrationIcon';

const PROVIDERS: Array<{
  provider: IntegrationBrand;
  name: string;
  website?: string;
}> = [
  { provider: 'SIMKL', name: 'SIMKL', website: 'https://simkl.com' },
  { provider: 'STREMIO', name: 'Stremio', website: 'https://www.stremio.com' },
  { provider: 'JELLYFIN', name: 'Jellyfin', website: 'https://jellyfin.org' },
  { provider: 'PLEX', name: 'Plex', website: 'https://www.plex.tv' },
  { provider: 'EMBY', name: 'Emby', website: 'https://emby.media' },
  { provider: 'TRAKT', name: 'Trakt' },
];

function isSupportedProvider(provider: IntegrationBrand): provider is IntegrationProvider {
  return provider !== 'TRAKT';
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
  const connectMediaServer = useConnectMediaServer();
  const selectPlexServer = useSelectPlexServer();
  const sync = useSyncIntegration();
  const disconnect = useDisconnectIntegration();
  const [pending, setPending] = useState<
    Partial<Record<IntegrationProvider, IntegrationLinkStartDto>>
  >({});
  const [serverForms, setServerForms] = useState<
    Record<'JELLYFIN' | 'EMBY', { serverUrl: string; username: string; password: string }>
  >({
    JELLYFIN: { serverUrl: '', username: '', password: '' },
    EMBY: { serverUrl: '', username: '', password: '' },
  });
  const [plexServers, setPlexServers] = useState<PlexServerDto[]>([]);

  const rows = new Map((integrations.data ?? []).map((row) => [row.provider, row]));
  const busy =
    startLink.isPending ||
    completeLink.isPending ||
    connectMediaServer.isPending ||
    selectPlexServer.isPending ||
    sync.isPending ||
    disconnect.isPending;

  const beginLink = async (provider: 'SIMKL' | 'STREMIO' | 'PLEX') => {
    try {
      const link = await startLink.mutateAsync(provider);
      setPending((current) => ({ ...current, [provider]: link }));
      await WebBrowser.openBrowserAsync(link.verificationUrl);
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    }
  };

  const finishLink = async (provider: 'SIMKL' | 'STREMIO' | 'PLEX') => {
    try {
      const result = await completeLink.mutateAsync(provider);
      setPending((current) => ({ ...current, [provider]: undefined }));
      if ('servers' in result) {
        setPlexServers(result.servers);
      } else {
        setPlexServers([]);
        showToast(t('settings:integrations.connected'));
        void syncNow(provider);
      }
    } catch {
      showError({
        title: t('settings:integrations.notConnectedYet'),
        description: t('common:pleaseTryAgain'),
      });
    }
  };

  const connectServer = async (provider: 'JELLYFIN' | 'EMBY') => {
    const form = serverForms[provider];
    try {
      await connectMediaServer.mutateAsync({ provider, ...form });
      showToast(t('settings:integrations.connected'));
      void syncNow(provider);
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    } finally {
      setServerForms((current) => ({
        ...current,
        [provider]: { ...current[provider], password: '' },
      }));
    }
  };

  const choosePlexServer = async (machineIdentifier: string) => {
    try {
      await selectPlexServer.mutateAsync(machineIdentifier);
      setPlexServers([]);
      showToast(t('settings:integrations.connected'));
      void syncNow('PLEX');
    } catch {
      showError({ description: t('common:pleaseTryAgain') });
    }
  };

  const syncNow = async (provider: IntegrationProvider) => {
    try {
      const result = await sync.mutateAsync(provider);
      showToast(
        t('settings:integrations.syncResult', {
          received: result.received,
          created: result.created,
          skipped: result.skipped,
          unmatched: result.unmatched,
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
          const linkProvider =
            provider === 'SIMKL' || provider === 'STREMIO' || provider === 'PLEX' ? provider : null;
          const link = linkProvider ? pending[linkProvider] : undefined;
          const serverProvider = provider === 'JELLYFIN' || provider === 'EMBY' ? provider : null;
          const serverForm = serverProvider ? serverForms[serverProvider] : null;
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
              ) : provider === 'PLEX' && plexServers.length ? (
                <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                  <T variant="caption" muted>
                    {t('settings:integrations.selectServer')}
                  </T>
                  {plexServers.map((server) => (
                    <Button
                      key={server.machineIdentifier}
                      title={server.name}
                      icon="server-outline"
                      variant="ghost"
                      onPress={() => choosePlexServer(server.machineIdentifier)}
                      loading={
                        selectPlexServer.isPending &&
                        selectPlexServer.variables === server.machineIdentifier
                      }
                      disabled={busy}
                    />
                  ))}
                </View>
              ) : serverProvider && serverForm ? (
                <View style={{ marginTop: spacing.md }}>
                  <TextField
                    label={t('settings:integrations.serverUrl', { provider: name })}
                    value={serverForm.serverUrl}
                    onChangeText={(serverUrl) =>
                      setServerForms((current) => ({
                        ...current,
                        [serverProvider]: { ...current[serverProvider], serverUrl },
                      }))
                    }
                    autoCapitalize="none"
                    keyboardType="url"
                  />
                  <TextField
                    label={t('settings:integrations.username')}
                    value={serverForm.username}
                    onChangeText={(username) =>
                      setServerForms((current) => ({
                        ...current,
                        [serverProvider]: { ...current[serverProvider], username },
                      }))
                    }
                    autoCapitalize="none"
                  />
                  <TextField
                    label={t('settings:integrations.password')}
                    value={serverForm.password}
                    onChangeText={(password) =>
                      setServerForms((current) => ({
                        ...current,
                        [serverProvider]: { ...current[serverProvider], password },
                      }))
                    }
                    secureTextEntry
                  />
                  <Button
                    title={t('settings:integrations.connectAndSync')}
                    icon="link-outline"
                    onPress={() => connectServer(serverProvider)}
                    loading={
                      connectMediaServer.isPending &&
                      connectMediaServer.variables?.provider === serverProvider
                    }
                    disabled={!serverForm.serverUrl || !serverForm.username || busy}
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
                    onPress={() => linkProvider && finishLink(linkProvider)}
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
                  onPress={() => linkProvider && beginLink(linkProvider)}
                  loading={startLink.isPending && startLink.variables === provider}
                  disabled={busy || !linkProvider}
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
