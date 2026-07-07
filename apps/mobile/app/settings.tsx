import React, { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { Header } from '../components/Header';
import { Button, Card, Screen, SectionHeader, T } from '../components/primitives';
import { TextField } from '../components/TextField';
import { useAuth } from '../context/AuthContext';
import { useMe, useUpdateProfile, useUploadAvatar, useUploadCover } from '../api/hooks';
import { api, setBaseUrl, SITE_URL } from '../api/client';
import { colors, radius, spacing } from '../theme/theme';

const API_BASE = (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';

export default function SettingsScreen() {
  const { data: me } = useMe();
  const update = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();
  const uploadCover = useUploadCover();
  const { logout, isSelfHosted, getApiUrl } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [backendUrl, setBackendUrl] = useState('');
  const [showBackendField, setShowBackendField] = useState(isSelfHosted);

  useEffect(() => {
    if (me) {
      setUsername(me.username);
      setDisplayName(me.displayName ?? '');
      setBio(me.bio ?? '');
      setAvatarUrl(me.avatarUrl ?? '');
      setCoverUrl(me.coverUrl ?? '');
    }
    if (isSelfHosted) {
      getApiUrl().then((url) => setBackendUrl(url ?? ''));
    }
  }, [me, isSelfHosted]);

  const save = () => update.mutate({ username, displayName, bio, avatarUrl, coverUrl });

  const pickImage = async (type: 'avatar' | 'cover') => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', 'Please allow photo access'); return; }
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
      if (type === 'avatar') {
        const res = await uploadAvatar.mutateAsync(manip.uri);
        setAvatarUrl(res.url);
      } else {
        const res = await uploadCover.mutateAsync(manip.uri);
        setCoverUrl(res.url);
      }
    } catch (e: any) {
      Alert.alert('Upload failed', e?.message ?? 'Try again');
    }
  };

  const del = () => {
    Alert.alert('Delete account', 'This permanently deletes your account and data.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api.del('/me');
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return (
    <Screen>
      <Header title="Settings" showBack />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 60 }}>
        <Card>
          <SectionHeader title="Profile" />
          <TextField label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
          <TextField label="Display name" value={displayName} onChangeText={setDisplayName} />
          <TextField label="Bio" value={bio} onChangeText={setBio} multiline />
          {/* Avatar picker */}
          <View style={{ marginBottom: spacing.md }}>
            <T variant="caption" muted style={{ marginBottom: 6 }}>Avatar</T>
            <Pressable onPress={() => pickImage('avatar')} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={{ width: 64, height: 64, borderRadius: 32 }} contentFit="cover" />
              ) : (
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="person" size={28} color={colors.textMuted} />
                </View>
              )}
              <T variant="caption" style={{ color: colors.primary }}>Change avatar</T>
            </Pressable>
          </View>
          {/* Cover picker */}
          <View style={{ marginBottom: spacing.md }}>
            <T variant="caption" muted style={{ marginBottom: 6 }}>Cover image</T>
            <Pressable onPress={() => pickImage('cover')} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              {coverUrl ? (
                <Image source={{ uri: coverUrl }} style={{ width: 120, height: 60, borderRadius: radius.sm }} contentFit="cover" />
              ) : (
                <View style={{ width: 120, height: 60, borderRadius: radius.sm, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="image" size={24} color={colors.textMuted} />
                </View>
              )}
              <T variant="caption" style={{ color: colors.primary }}>Change cover</T>
            </Pressable>
          </View>
          <Button title="Save changes" onPress={save} loading={update.isPending} icon="save-outline" />
        </Card>

        <Card>
          <SectionHeader title="Account" />
          {isSelfHosted ? (
            <View style={{ marginBottom: spacing.md }}>
              <TextField label="Backend URL" value={backendUrl} onChangeText={setBackendUrl} autoCapitalize="none" keyboardType="url" />
              <Button title="Update backend" variant="ghost" icon="server-outline" onPress={async () => {
                await setBaseUrl(backendUrl);
                Alert.alert('Updated', 'Backend URL saved. Reloading...');
                setTimeout(() => { logout(); }, 1500);
              }} style={{ marginTop: spacing.sm }} />
            </View>
          ) : null}
          <Row icon="shield-checkmark-outline" label="Privacy Policy" onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/privacy`)} />
          <Row icon="document-text-outline" label="Terms of Use" onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/terms`)} />
          <Row icon="download-outline" label="Export my data" onPress={() => {}} />
        </Card>

        <Button title="Log out" variant="ghost" icon="log-out-outline" onPress={logout} />
        <Button title="Delete account" variant="danger" icon="trash-outline" onPress={del} />
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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
});
