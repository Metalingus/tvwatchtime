import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useAuth } from '../../context/AuthContext';
import { useGoogleAuth } from '../../hooks/useSocialAuth';
import { Button, Card, Screen, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { SITE_URL } from '../../api/client';
import { colors, spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';

export default function RegisterScreen() {
  const { registerEmail, isSelfHosted, setSelfHosted } = useAuth();
  const google = useGoogleAuth();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [selfHostedChecked, setSelfHostedChecked] = useState(isSelfHosted);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

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
      showError({ title: 'Server URL required', description: 'Enter your self-hosted backend URL' });
      return;
    }
    if (password !== confirmPassword) {
      showError({ title: 'Password mismatch', description: 'Passwords do not match' });
      return;
    }
    if (!agreedTerms) {
      showError({ title: 'Terms required', description: 'Please agree to the Terms of Use and Privacy Policy' });
      return;
    }
    setLoading(true);
    try {
      if (selfHostedChecked) {
        await setSelfHosted(true, serverUrl);
      }
      await registerEmail({ email, username, password });
      router.replace('/(tabs)/shows');
    } catch (e: any) {
      showError({ title: 'Sign up failed', description: e.message ?? 'Try again' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen style={{ justifyContent: 'center', padding: spacing.xl }}>
      <View style={{ alignItems: 'center', marginBottom: spacing.xl }}>
        <Ionicons name="tv-outline" size={48} color={colors.primary} />
        <T variant="title" style={{ marginTop: spacing.md }}>Create account</T>
      </View>

      <Card>
        <Pressable
          onPress={toggleSelfHosted}
          style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}
        >
          <View style={[styles.checkbox, selfHostedChecked && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
            {selfHostedChecked ? <Ionicons name="checkmark" size={16} color="#0F1115" /> : null}
          </View>
          <View style={{ flex: 1, marginLeft: spacing.sm }}>
            <T variant="body">Self-hosted backend</T>
            <T variant="micro" muted>Connect to your own server</T>
          </View>
        </Pressable>

        {selfHostedChecked ? (
          <TextField label="Backend URL" value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" keyboardType="url" />
        ) : null}

        <TextField label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
        <TextField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <TextField label="Password" value={password} onChangeText={setPassword} secureTextEntry={!showPassword} trailingIcon={{ name: showPassword ? 'eye-off-outline' : 'eye-outline', onPress: () => setShowPassword(!showPassword) }} />
        <TextField label="Confirm password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry={!showConfirm} trailingIcon={{ name: showConfirm ? 'eye-off-outline' : 'eye-outline', onPress: () => setShowConfirm(!showConfirm) }} />

        <Pressable
          onPress={() => setAgreedTerms(!agreedTerms)}
          style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.sm }}
        >
          <View style={[styles.checkbox, agreedTerms && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
            {agreedTerms ? <Ionicons name="checkmark" size={16} color="#0F1115" /> : null}
          </View>
          <View style={{ flex: 1, marginLeft: spacing.sm }}>
            <T variant="micro">
              I agree to the{' '}
              <T variant="micro" style={{ color: colors.primary }} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/terms`)}>
                Terms of Use
              </T>
              {' '}and{' '}
              <T variant="micro" style={{ color: colors.primary }} onPress={() => WebBrowser.openBrowserAsync(`${SITE_URL}/privacy`)}>
                Privacy Policy
              </T>
            </T>
          </View>
        </Pressable>

        <Button title="Create account" onPress={submit} loading={loading} icon="person-add-outline" disabled={!agreedTerms} style={{ marginTop: spacing.sm }} />
      </Card>

      {!selfHostedChecked ? (
        <View style={styles.divider}>
          <View style={styles.line} />
          <T variant="caption" muted style={{ marginHorizontal: spacing.md }}>or</T>
          <View style={styles.line} />
        </View>
      ) : null}

      {!selfHostedChecked && google.configured ? (
        <Button title="Sign up with Google" variant="ghost" icon="logo-google" onPress={google.signIn} disabled={!google.ready} style={styles.social} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg },
  line: { flex: 1, height: 1, backgroundColor: colors.border },
  social: { marginBottom: spacing.sm },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
});
