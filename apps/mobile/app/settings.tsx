import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
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
import { SUPPORTED_LOCALES, type LanguagePreference, type ThemePreference } from '@tvwatch/shared';
import { useMe, useUpdateProfile, useUploadAvatar, useUploadCover } from '../api/hooks';
import { api, setBaseUrl, SITE_URL } from '../api/client';
import { colors, radius, spacing } from '../theme/theme';
import { showError, showSuccess, showConfirm } from '../lib/dialog';

const API_BASE = (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';

export default function SettingsScreen() {
  const { data: me } = useMe();
  const update = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const uploadCover = useUploadCover();
  const { logout, isSelfHosted, getApiUrl } = useAuth();
  const { themePreference, setThemePreference, languagePreference, setLanguagePreference, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['settings', 'common']);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [backendUrl, setBackendUrl] = useState('');
  const [showBackendField, setShowBackendField] = useState(isSelfHosted);
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

  const save = () => update.mutate({ username, displayName, bio, avatarUrl, coverUrl });

  const togglePrivate = (next: boolean) =>
    update.mutate(
      { isPrivate: next },
      { onError: () => showError({ description: t('settings:privacyUpdateFailed') }) },
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
      } else {
        const res = await uploadCover.mutateAsync(manip.uri);
        setCoverUrl(`${res.url}?t=${Date.now()}`);
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
        await logout();
        router.replace('/(auth)/login');
      },
    });
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
              trackColor={{ false: colors.surfaceElevated, true: colors.primary }}
              thumbColor="#fff"
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
              <T variant="caption" style={{ color: colors.primary }}>{t('settings:changeAvatar')}</T>
            </Pressable>
          </View>
          {/* Cover picker */}
          <View style={{ marginBottom: spacing.md }}>
            <T variant="caption" muted style={{ marginBottom: 6 }}>{t('settings:cover')}</T>
            <Pressable onPress={() => pickImage('cover')} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              {coverUrl ? (
                <Image source={{ uri: coverUrl }} style={{ width: 120, height: 60, borderRadius: radius.sm }} contentFit="cover" />
              ) : (
                <View style={{ width: 120, height: 60, borderRadius: radius.sm, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="image" size={24} color={colors.textMuted} />
                </View>
              )}
              <T variant="caption" style={{ color: colors.primary }}>{t('settings:changeCover')}</T>
            </Pressable>
          </View>
          <Button title={t('settings:saveChanges')} onPress={save} loading={update.isPending} icon="save-outline" />
        </Card>

        <Card>
          <SectionHeader title={t('settings:appearance.title')} />
          <T variant="caption" muted style={{ marginBottom: spacing.sm }}>{t('settings:appearance.description')}</T>
          <OptionRow label={t('settings:appearance.system')} selected={themePreference === 'system'} onPress={() => setThemePreference('system')} icon="phone-portrait-outline" />
          <OptionRow label={t('settings:appearance.light')} selected={themePreference === 'light'} onPress={() => setThemePreference('light')} icon="sunny-outline" />
          <OptionRow label={t('settings:appearance.dark')} selected={themePreference === 'dark'} onPress={() => setThemePreference('dark')} icon="moon-outline" />
        </Card>

        <Card>
          <SectionHeader title={t('settings:language.title')} />
          <T variant="caption" muted style={{ marginBottom: spacing.sm }}>{t('settings:language.description')}</T>
          <OptionRow label={t('settings:language.system')} selected={languagePreference === 'system'} onPress={() => setLanguagePreference('system')} icon="language-outline" />
          {SUPPORTED_LOCALES.map((l) => (
            <OptionRow key={l.code} label={l.nativeName} selected={languagePreference === l.code} onPress={() => setLanguagePreference(l.code as LanguagePreference)} />
          ))}
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
                showSuccess({ title: t('settings:backendUpdated'), description: t('settings:backendSavedReloading') });
                setTimeout(() => { logout(); }, 1500);
              }} style={{ marginTop: spacing.sm }} />
            </View>
          ) : null}
          <Row icon="shield-checkmark-outline" label={t('settings:privacyPolicyRow')} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/privacy`)} />
          <Row icon="document-text-outline" label={t('settings:termsOfUseRow')} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/terms`)} />
          <Row icon="logo-discord" label={t('settings:joinDiscord')} onPress={() => WebBrowser.openBrowserAsync('https://discord.gg/g9JBPUeqQV')} />
          <Row icon="download-outline" label={t('settings:exportData')} onPress={async () => {
            try {
              const res = await api.post<{ downloadUrl: string }>('/me/export-request');
              WebBrowser.openBrowserAsync(res.downloadUrl);
            } catch (e: any) {
              showError({ title: t('settings:exportFailed'), description: e?.message ?? t('common:pleaseTryAgain') });
            }
          }} />
          <Row icon="trash-outline" label={t('settings:requestDataDeletion')} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/delete-account`)} />
        </Card>

        <Button title={t('settings:logout')} variant="ghost" icon="log-out-outline" onPress={logout} />
        <Button title={t('settings:deleteAccount')} variant="danger" icon="trash-outline" onPress={del} />
      </ScrollView>
    </Screen>
  );
}

function Row({ icon, label, onPress }: { icon: any; label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Ionicons name={icon} size={20} color={colors.text} />
      <T variant="body" style={{ flex: 1, marginLeft: spacing.md }}>{label}</T>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

function OptionRow({ label, selected, onPress, icon }: { label: string; selected: boolean; onPress: () => void; icon?: any }) {
  return (
    <Pressable onPress={onPress} style={styles.optionRow}>
      {icon ? <Ionicons name={icon} size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} /> : null}
      <T variant="body" style={{ flex: 1 }}>{label}</T>
      {selected ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md },
  optionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm + 2 },
});
