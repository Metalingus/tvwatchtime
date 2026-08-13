import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { Header } from '../components/Header';
import { Button, Card, Screen, SectionHeader, T, APP_ICON } from '../components/primitives';
import { TextField } from '../components/TextField';
import { useAuth } from '../context/AuthContext';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { SUPPORTED_LOCALES, type LanguagePreference, type ThemePreference } from '@tvwatch/shared';
import { useMe, useUpdateProfile, useUploadAvatar, useUploadCover } from '../api/hooks';
import { api, HttpError, setBaseUrl, SITE_URL } from '../api/client';
import { radius, spacing } from '../theme/theme';
import { showError, showConfirm, showDialog, dismissAllDialogs } from '../lib/dialog';
import { showToast } from '../lib/toast';
import { logEvent } from '../lib/analytics';

const API_BASE = (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';

// Provider attribution (same logos as the public site footer). TMDB only serves
// their logo as SVG — expo-image renders it on native + web.
const TMDB_LOGO =
  'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg';
const TVDB_LOGO = 'https://www.thetvdb.com/images/attribution/logo1.png';
const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/tv-watch-time/id6793281668';

export default function SettingsScreen() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const update = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const uploadCover = useUploadCover();
  const { logout, isSelfHosted, getApiUrl } = useAuth();
  const { themePreference, setThemePreference, languagePreference, setLanguagePreference, resolvedLocale, tokens } = useAppearance();
  const { t } = useTranslation(['settings', 'common']);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [backendUrl, setBackendUrl] = useState('');
  const [showBackendField, setShowBackendField] = useState(isSelfHosted);
  const [exportingData, setExportingData] = useState(false);
  const skipNextRefetch = useRef(false);

  useEffect(() => {
    if (me) {
      setUsername(me.username);
      setDisplayName(me.displayName ?? '');
      setBio(me.bio ?? '');
      // Don't overwrite avatar/cover URLs if we just uploaded (avoid cache flash)
      if (!skipNextRefetch.current) {
        setAvatarUrl(me.avatarUrl ?? '');
        setCoverUrl(me.coverUrl ?? '');
      }
      skipNextRefetch.current = false;
    }
    if (isSelfHosted) {
      getApiUrl().then((url) => setBackendUrl(url ?? ''));
    }
  }, [me, isSelfHosted]);

  const save = () =>
    update.mutate(
      { username, displayName, bio, avatarUrl, coverUrl },
      { onSuccess: () => showToast(t('settings:toast.saved')) },
    );

  /** Single-select popup (FilterPicker-style): tap applies and dismisses. */
  const openSingleSelect = ({
    title,
    options,
    selected,
    onSelect,
  }: {
    title: string;
    options: { value: string; label: string }[];
    selected: string;
    onSelect: (value: string) => void;
  }) => {
    showDialog({
      title,
      content: (
        <ScrollView style={{ maxHeight: 420 }}>
          <View style={{ gap: spacing.sm }}>
            {options.map((o) => (
              <Pressable
                key={o.value}
                onPress={() => {
                  onSelect(o.value);
                  dismissAllDialogs();
                }}
                style={({ pressed }) => [
                  styles.optionRow,
                  {
                    backgroundColor: tokens.surfaceElevated,
                    borderRadius: radius.md,
                    padding: spacing.sm,
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={o.label}
              >
                <T variant="body" style={{ flex: 1 }} numberOfLines={1}>
                  {o.label}
                </T>
                <Ionicons
                  name={selected === o.value ? 'checkmark-circle' : 'ellipse-outline'}
                  size={20}
                  color={selected === o.value ? tokens.primary : tokens.textMuted}
                />
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ),
      buttons: [{ label: t('common:cancel'), variant: 'ghost' }],
    });
  };

  const togglePrivate = (next: boolean) =>
    update.mutate(
      { isPrivate: next },
      {
        onSuccess: () => showToast(t('settings:toast.privacyUpdated')),
        onError: () => showError({ description: t('settings:privacyUpdateFailed') }),
      },
    );

  // Explore/discover/trending results are filtered server-side by this flag — drop the
  // cached lists so the change is visible on the next Explore open.
  const toggleHideAnime = (next: boolean) =>
    update.mutate(
      { hideAnimeInExplore: next },
      {
        onSuccess: () => {
          for (const key of [
            'search',
            'discoverSections',
            'forYou',
            'discoverShows',
            'discoverMovies',
            'trendingShows',
            'trendingMovies',
            'trendingShowsPage',
            'trendingMoviesPage',
          ]) {
            qc.invalidateQueries({ queryKey: [key] });
          }
          showToast(t('settings:toast.saved'));
        },
        onError: () => showError({ description: t('common:tryAgain') }),
      },
    );

  const pickImage = async (type: 'avatar' | 'cover') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { showError({ title: t('settings:permissionNeeded'), description: t('settings:allowPhotoAccess') }); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: type === 'avatar',
      aspect: type === 'avatar' ? [1, 1] : [16, 9],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const resizeWidth = type === 'avatar' ? 400 : 1280;
    const manip = await ImageManipulator.manipulateAsync(
      result.assets[0].uri,
      [{ resize: { width: resizeWidth } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    try {
      skipNextRefetch.current = true;
      if (type === 'avatar') {
        const res = await uploadAvatar.mutateAsync(manip.uri);
        setAvatarUrl(`${res.url}?t=${Date.now()}`);
        showToast(t('settings:toast.avatarUpdated'));
      } else {
        const res = await uploadCover.mutateAsync(manip.uri);
        setCoverUrl(`${res.url}?t=${Date.now()}`);
        showToast(t('settings:toast.coverUpdated'));
      }
    } catch (e: any) {
      showError({ title: t('settings:uploadFailed'), description: e?.message ?? t('common:tryAgain') });
    }
  };

  const del = () => {
    showConfirm({
      title: t('settings:deleteAccountConfirm'),
      description: t('settings:deleteAccountDesc'),
      confirmLabel: t('common:delete'),
      destructive: true,
      onConfirm: async () => {
        await api.del('/me');
        logEvent('delete_account');
        await logout();
        router.replace('/(auth)/login');
      },
    });
  };

  const requestDataExport = async () => {
    if (exportingData) return;
    setExportingData(true);
    try {
      const result = await api.post<{
        downloadUrl: string;
        expiresAt: string;
        reused: boolean;
      }>('/me/export-request');
      showDialog({
        title: t('settings:exportReady'),
        description: result.reused
          ? t('settings:exportReadyReusedDescription')
          : t('settings:exportReadyDescription'),
        buttons: [
          { label: t('common:close'), variant: 'secondary' },
          {
            label: t('settings:downloadExport'),
            variant: 'primary',
            closeOnPress: 'before',
            onPress: () => WebBrowser.openBrowserAsync(result.downloadUrl),
          },
        ],
      });
    } catch (error: unknown) {
      const busy = error instanceof HttpError && error.status === 429;
      showError({
        title: t('settings:exportFailed'),
        description: busy ? t('settings:exportBusy') : t('common:pleaseTryAgain'),
      });
    } finally {
      setExportingData(false);
    }
  };

  return (
    <Screen>
      <Header title={t('settings:title')} showBack />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 60 }}>
        <Card>
          <SectionHeader title={t('settings:profile')} />
          <TextField label={t('settings:username')} value={username} onChangeText={setUsername} autoCapitalize="none" />
          <TextField label={t('settings:displayName')} value={displayName} onChangeText={setDisplayName} />
          <TextField label={t('settings:bio')} value={bio} onChangeText={setBio} multiline />
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, marginRight: spacing.md }}>
              <T variant="body">{t('settings:private')}</T>
              <T variant="micro" muted>{t('settings:privateHint')}</T>
            </View>
            <Switch
              value={me?.isPrivate ?? false}
              onValueChange={togglePrivate}
              trackColor={{ false: tokens.controlTrackOff, true: tokens.primary }}
              thumbColor={tokens.controlThumb}
            />
          </View>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, marginRight: spacing.md }}>
              <T variant="body">{t('settings:hideAnime')}</T>
              <T variant="micro" muted>{t('settings:hideAnimeHint')}</T>
            </View>
            <Switch
              value={me?.hideAnimeInExplore ?? false}
              onValueChange={toggleHideAnime}
              trackColor={{ false: tokens.controlTrackOff, true: tokens.primary }}
              thumbColor={tokens.controlThumb}
            />
          </View>
          {/* Avatar picker */}
          <View style={{ marginBottom: spacing.md }}>
            <T variant="caption" muted style={{ marginBottom: 6 }}>{t('settings:avatar')}</T>
            <Pressable onPress={() => pickImage('avatar')} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={{ width: 64, height: 64, borderRadius: 32 }} contentFit="cover" />
              ) : (
                <Image source={APP_ICON} style={{ width: 64, height: 64, borderRadius: 32 }} contentFit="cover" />
              )}
              <T variant="caption" style={{ color: tokens.primary }}>{t('settings:changeAvatar')}</T>
            </Pressable>
          </View>
          {/* Cover picker */}
          <View style={{ marginBottom: spacing.md }}>
            <T variant="caption" muted style={{ marginBottom: 6 }}>{t('settings:cover')}</T>
            <Pressable onPress={() => pickImage('cover')} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              {coverUrl ? (
                <Image source={{ uri: coverUrl }} style={{ width: 120, height: 60, borderRadius: radius.sm }} contentFit="cover" />
              ) : (
                <View style={{ width: 120, height: 60, borderRadius: radius.sm, backgroundColor: tokens.surfaceElevated, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="image" size={24} color={tokens.textMuted} />
                </View>
              )}
              <T variant="caption" style={{ color: tokens.primary }}>{t('settings:changeCover')}</T>
            </Pressable>
          </View>
          <Button title={t('settings:saveChanges')} onPress={save} loading={update.isPending} icon="save-outline" />
        </Card>

        <Card>
          <SectionHeader title={t('settings:appearance.title')} />
          <T variant="caption" muted style={{ marginBottom: spacing.sm }}>{t('settings:appearance.description')}</T>
          <SelectRow
            icon="moon-outline"
            label={t('settings:appearance.title')}
            valueLabel={t(`settings:appearance.${themePreference}`)}
            onPress={() =>
              openSingleSelect({
                title: t('settings:appearance.title'),
                options: [
                  { value: 'system', label: t('settings:appearance.system') },
                  { value: 'light', label: t('settings:appearance.light') },
                  { value: 'dark', label: t('settings:appearance.dark') },
                ],
                selected: themePreference,
                onSelect: (v) => {
                  setThemePreference(v as ThemePreference);
                  showToast(t('settings:toast.themeUpdated'));
                },
              })
            }
          />
        </Card>

        <Card>
          <SectionHeader title={t('settings:language.title')} />
          <T variant="caption" muted style={{ marginBottom: spacing.sm }}>{t('settings:language.description')}</T>
          <SelectRow
            icon="language-outline"
            label={t('settings:language.title')}
            valueLabel={
              languagePreference === 'system'
                ? t('settings:language.system')
                : (SUPPORTED_LOCALES.find((l) => l.code === languagePreference)?.nativeName ?? languagePreference)
            }
            onPress={() =>
              openSingleSelect({
                title: t('settings:language.title'),
                options: [
                  { value: 'system', label: t('settings:language.system') },
                  ...SUPPORTED_LOCALES.map((l) => ({ value: l.code, label: l.nativeName })),
                ],
                selected: languagePreference,
                onSelect: (v) => {
                  setLanguagePreference(v as LanguagePreference);
                  showToast(t('settings:toast.languageUpdated'));
                },
              })
            }
          />
          {resolvedLocale === 'ar' ? (
            <T variant="micro" muted style={{ marginTop: spacing.xs }}>{t('settings:language.rtlRestartNotice')}</T>
          ) : null}
        </Card>

        <Card>
          <SectionHeader title={t('settings:account')} />
          {isSelfHosted ? (
            <View style={{ marginBottom: spacing.md }}>
              <TextField label={t('settings:backendUrl')} value={backendUrl} onChangeText={setBackendUrl} autoCapitalize="none" keyboardType="url" />
              <Button title={t('settings:updateBackend')} variant="ghost" icon="server-outline" onPress={async () => {
                await setBaseUrl(backendUrl);
                showToast(t('settings:toast.backendUpdated'));
                setTimeout(() => { logout(); }, 1500);
              }} style={{ marginTop: spacing.sm }} />
            </View>
          ) : null}
          <Row icon="flash-outline" label={t('settings:quickSetup')} subtitle={t('settings:quickSetupDesc')} onPress={() => {
            logEvent('onboarding_reopened');
            router.push('/onboarding' as any);
          }} />
          <Row icon="chatbubbles-outline" label={t('settings:contactSupport')} onPress={() => router.push('/contact' as any)} />
          <Row icon="shield-checkmark-outline" label={t('settings:privacyPolicyRow')} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/privacy`)} />
          <Row icon="document-text-outline" label={t('settings:termsOfUseRow')} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/terms`)} />
          <Row icon="logo-discord" label={t('settings:joinDiscord')} onPress={() => WebBrowser.openBrowserAsync('https://discord.gg/g9JBPUeqQV')} />
          <Row icon="globe-outline" label={t('settings:website')} onPress={() => WebBrowser.openBrowserAsync('https://tvwatchtime.org/')} />
          {Platform.OS === 'web' ? (
            <>
              <Row
                icon="logo-apple"
                label={t('settings:iosAppStore')}
                onPress={() => WebBrowser.openBrowserAsync(IOS_APP_STORE_URL)}
              />
              <Row
                icon="logo-android"
                label={t('settings:githubReleases')}
                onPress={() =>
                  WebBrowser.openBrowserAsync(
                    'https://play.google.com/store/apps/details?id=app.tvwatchtime.mobile',
                  )
                }
              />
            </>
          ) : null}
          <Row
            icon="download-outline"
            label={t('settings:exportData')}
            subtitle={exportingData ? t('settings:exportPreparing') : t('settings:exportDataHint')}
            onPress={requestDataExport}
            loading={exportingData}
            disabled={exportingData}
          />
          <Row icon="trash-outline" label={t('settings:requestDataDeletion')} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/delete-account`)} />
        </Card>

        <Button title={t('settings:logout')} variant="ghost" icon="log-out-outline" onPress={logout} />
        <Button title={t('settings:deleteAccount')} variant="danger" icon="trash-outline" onPress={del} />

        {/* Provider attribution — mirrors the public site footer */}
        <View style={{ alignItems: 'center', marginTop: spacing.md }}>
          <T variant="caption" muted>{t('settings:poweredBy')}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm }}>
            <Pressable onPress={() => WebBrowser.openBrowserAsync('https://www.themoviedb.org')} hitSlop={8}>
              <Image source={{ uri: TMDB_LOGO }} style={{ width: 48, height: 48 }} contentFit="contain" transition={150} />
            </Pressable>
            <Pressable onPress={() => WebBrowser.openBrowserAsync('https://thetvdb.com')} hitSlop={8}>
              <Image source={{ uri: TVDB_LOGO }} style={{ width: 110, height: 32 }} contentFit="contain" transition={150} />
            </Pressable>
          </View>
          <T variant="micro" muted style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {t('settings:metadataAttribution')}
          </T>
          <Pressable onPress={() => WebBrowser.openBrowserAsync('https://thetvdb.com/subscribe')} hitSlop={8} style={{ marginTop: spacing.xs }}>
            <T variant="micro" style={{ color: tokens.primary, textAlign: 'center', textDecorationLine: 'underline' }}>
              {t('settings:tvdbSubscribe')}
            </T>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

function Row({
  icon,
  label,
  subtitle,
  onPress,
  loading = false,
  disabled = false,
}: {
  icon: any;
  label: string;
  subtitle?: string;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const { tokens } = useAppearance();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      style={({ pressed }) => [
        styles.row,
        { borderTopColor: tokens.divider, opacity: disabled ? 0.6 : pressed ? 0.8 : 1 },
      ]}
    >
      <Ionicons name={icon} size={20} color={tokens.textPrimary} />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <T variant="body">{label}</T>
        {subtitle ? (
          <T variant="micro" muted>
            {subtitle}
          </T>
        ) : null}
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={tokens.primary} />
      ) : (
        <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
      )}
    </Pressable>
  );
}

/** Settings row that shows ONLY the current selection and opens a popup picker
 *  (same interaction as the explore FilterPicker) instead of listing every option. */
function SelectRow({ icon, label, valueLabel, onPress }: { icon: any; label: string; valueLabel: string; onPress?: () => void }) {
  const { tokens } = useAppearance();
  return (
    <Pressable onPress={onPress} style={[styles.row, { borderTopColor: tokens.divider }]} accessibilityRole="button">
      <Ionicons name={icon} size={20} color={tokens.textPrimary} />
      <T variant="body" style={{ flex: 1, marginLeft: spacing.md }}>{label}</T>
      <T variant="caption" muted numberOfLines={1} style={{ maxWidth: '50%' }}>{valueLabel}</T>
      <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} style={{ marginLeft: spacing.xs }} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md },
  optionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm + 2 },
});
