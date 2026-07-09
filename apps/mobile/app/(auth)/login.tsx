import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Link, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useGoogleAuth, useFacebookAuth } from '../../hooks/useSocialAuth';
import { Button, Card, Screen, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { colors, spacing } from '../../theme/theme';

export default function LoginScreen() {
  const { loginEmail, isSelfHosted, setSelfHosted } = useAuth();
  const google = useGoogleAuth();
  const facebook = useFacebookAuth();
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
      Alert.alert('Server URL required', 'Enter your self-hosted backend URL');
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
      Alert.alert('Login failed', e.message ?? 'Try again');
    } finally {
      setLoading(false);
    }
  };

  const social = (provider: 'GOOGLE' | 'FACEBOOK') => {
    if (selfHostedChecked) return;
    Alert.alert('OAuth', `Connect ${provider} via app config (EXPO/EAS). Use email login for local dev.`);
  };

  return (
    <Screen style={{ justifyContent: 'center', padding: spacing.xl }}>
      <View style={{ alignItems: 'center', marginBottom: spacing.xxl }}>
        <Ionicons name="tv-outline" size={56} color={colors.primary} />
        <T variant="title" style={{ marginTop: spacing.md }}>TVWatchTime</T>
        <T variant="body" muted>Track everything you watch.</T>
      </View>

      <Card>
        {/* Self-hosted toggle */}
        <PressableRow
          checked={selfHostedChecked}
          onToggle={toggleSelfHosted}
          label="Self-hosted backend"
          hint="Connect to your own server"
        />

        {selfHostedChecked ? (
          <View style={{ marginTop: spacing.md }}>
            <TextField
              label="Backend URL"
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

        <TextField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextField label="Password" value={password} onChangeText={setPassword} secureTextEntry={!showPassword} trailingIcon={{ name: showPassword ? 'eye-off-outline' : 'eye-outline', onPress: () => setShowPassword(!showPassword) }} />
        <Pressable onPress={() => router.push('/(auth)/forgot-password')} style={{ alignSelf: 'flex-end', marginTop: -spacing.sm, marginBottom: spacing.sm }}>
          <T variant="micro" style={{ color: colors.primary }}>Forgot password?</T>
        </Pressable>
        <Button title="Log in" onPress={submit} loading={loading} style={{ marginTop: spacing.md }} icon="log-in-outline" />
      </Card>

      {!selfHostedChecked ? (
        <>
          <View style={styles.divider}>
            <View style={styles.line} />
            <T variant="caption" muted style={{ marginHorizontal: spacing.md }}>or</T>
            <View style={styles.line} />
          </View>

          {google.configured ? (
            <Button title="Continue with Google" variant="ghost" icon="logo-google" onPress={google.signIn} disabled={!google.ready} style={styles.social} />
          ) : null}

          {facebook.configured ? (
            <Button title="Continue with Facebook" variant="ghost" icon="logo-facebook" onPress={facebook.signIn} disabled={!facebook.ready} style={styles.social} />
          ) : null}
        </>
      ) : null}

      <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg }}>
        <T variant="body" muted>New here? </T>
        <Link href="/(auth)/register">
          <T variant="body" style={{ color: colors.primary }}>Create account</T>
        </Link>
      </View>
    </Screen>
  );
}

function PressableRow({ checked, onToggle, label, hint }: { checked: boolean; onToggle: () => void; label: string; hint?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        style={[styles.checkbox, checked && { backgroundColor: colors.primary, borderColor: colors.primary }]}
      >
        {checked ? <Ionicons name="checkmark" size={16} color="#0F1115" /> : null}
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
  line: { flex: 1, height: 1, backgroundColor: colors.border },
  social: { marginBottom: spacing.sm },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
});
