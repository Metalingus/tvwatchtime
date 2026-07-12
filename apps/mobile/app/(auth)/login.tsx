import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Link, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useGoogleAuth } from '../../hooks/useSocialAuth';
import { useAppearance } from '../../context/PreferencesProvider';
import { Button, Card, Screen, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { spacing } from '../../theme/theme';
import { showError, showInfo } from '../../lib/dialog';
import { useTranslation } from 'react-i18next';

export default function LoginScreen() {
  const { tokens } = useAppearance();
  const { loginEmail, isSelfHosted, setSelfHosted } = useAuth();
  const { t } = useTranslation(['auth', 'common', 'settings']);
  const google = useGoogleAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [selfHostedChecked, setSelfHostedChecked] = useState(isSelfHosted);
  const [showPassword, setShowPassword] = useState(false);

  const toggleSelfHosted = async () => {
    const newVal = !selfHostedChecked;
    setSelfHostedChecked(newVal);
    if (newVal) {
      await setSelfHosted(true, serverUrl || 'http://localhost:4000/api');
    } else {
      await setSelfHosted(false);
    }
  };

  const submit = async () => {
    if (selfHostedChecked && !serverUrl) {
      showError({ title: t('auth:serverUrlRequired'), description: 'Enter your self-hosted backend URL' });
      return;
    }
    setLoading(true);
    try {
      if (selfHostedChecked) {
        await setSelfHosted(true, serverUrl);
      }
      await loginEmail({ email, password });
      router.replace('/(tabs)/shows');
    } catch (e: any) {
      showError({ title: t('auth:loginFailed'), description: e.message ?? 'Try again' });
    } finally {
      setLoading(false);
    }
  };

  const social = (provider: 'GOOGLE' | 'FACEBOOK') => {
    if (selfHostedChecked) return;
    showInfo({ title: 'OAuth', description: `Connect ${provider} via app config (EXPO/EAS). Use email login for local dev.` });
  };

  return (
    <Screen style={{ justifyContent: 'center', padding: spacing.xl }}>
      <View style={{ alignItems: 'center', marginBottom: spacing.xxl }}>
        <Ionicons name="tv-outline" size={56} color={tokens.primary} />
        <T variant="title" style={{ marginTop: spacing.md }}>{t('common:appName')}</T>
        <T variant="body" muted>{t('auth:tagline')}</T>
      </View>

      <Card>
        {/* Self-hosted toggle */}
        <PressableRow
          checked={selfHostedChecked}
          onToggle={toggleSelfHosted}
          label={t('auth:selfHosted')}
          hint={t('auth:selfHostedHint')}
        />

        {selfHostedChecked ? (
          <View style={{ marginTop: spacing.md }}>
            <TextField
              label={t('settings:backendUrl')}
              value={serverUrl}
              onChangeText={setServerUrl}
              autoCapitalize="none"
              keyboardType="url"
            />
            <T variant="micro" muted style={{ marginTop: 4 }}>
              e.g. http://192.168.1.100:4000/api
            </T>
          </View>
        ) : null}

        <TextField label={t('auth:email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextField label={t('auth:password')} value={password} onChangeText={setPassword} secureTextEntry={!showPassword} trailingIcon={{ name: showPassword ? 'eye-off-outline' : 'eye-outline', onPress: () => setShowPassword(!showPassword) }} />
        <Pressable onPress={() => router.push('/(auth)/forgot-password')} style={{ alignSelf: 'flex-end', marginTop: -spacing.sm, marginBottom: spacing.sm }}>
          <T variant="micro" style={{ color: tokens.primary }}>{t('auth:forgotPassword')}</T>
        </Pressable>
        <Button title={t('auth:login')} onPress={submit} loading={loading} style={{ marginTop: spacing.md }} icon="log-in-outline" />
      </Card>

      {!selfHostedChecked ? (
        <>
          <View style={styles.divider}>
          <View style={[styles.line, { backgroundColor: tokens.border }]} />
            <T variant="caption" muted style={{ marginHorizontal: spacing.md }}>{t('auth:or')}</T>
            <View style={[styles.line, { backgroundColor: tokens.border }]} />
          </View>

          {google.configured ? (
            <Button title={t('auth:continueGoogle')} variant="ghost" icon="logo-google" onPress={google.signIn} disabled={!google.ready} style={styles.social} />
          ) : null}
        </>
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg }}>
        <T variant="body" muted>{t('auth:noAccount')} </T>
        <Link href="/(auth)/register">
          <T variant="body" style={{ color: tokens.primary }}>{t('auth:createAccount')}</T>
        </Link>
      </View>
    </Screen>
  );
}

function PressableRow({ checked, onToggle, label, hint }: { checked: boolean; onToggle: () => void; label: string; hint?: string }) {
  const { tokens } = useAppearance();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        style={[styles.checkbox, { borderColor: tokens.border }, checked && { backgroundColor: tokens.primary, borderColor: tokens.primary }]}
      >
        {checked ? <Ionicons name="checkmark" size={16} color={tokens.primaryForeground} /> : null}
      </Pressable>
      <View style={{ flex: 1, marginLeft: spacing.sm }}>
        <T variant="body">{label}</T>
        {hint ? <T variant="micro" muted>{hint}</T> : null}
      </View>
    </View>
  );
}

import { Pressable } from 'react-native';

const styles = StyleSheet.create({
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg },
  line: { flex: 1, height: 1 },
  social: { marginBottom: spacing.sm },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
