import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../../components/Header';
import { Button, Card, Screen, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { api } from '../../api/client';
import { colors, spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (!email.trim()) return;
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (e: any) {
      showError({ title: 'Failed', description: e?.message ?? 'Please try again' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen style={{ justifyContent: 'center', padding: spacing.xl }}>
      <View style={{ alignItems: 'center', marginBottom: spacing.xl }}>
        <Ionicons name="lock-closed-outline" size={48} color={colors.primary} />
      </View>

      {sent ? (
        <Card>
          <T variant="h2" style={{ textAlign: 'center', marginBottom: spacing.sm }}>Check your email</T>
          <T variant="body" muted style={{ textAlign: 'center' }}>
            If an account exists for {email}, a password reset link has been sent. Check your inbox and spam folder.
          </T>
          <Button title="Back to login" onPress={() => router.replace('/(auth)/login')} icon="arrow-back" style={{ marginTop: spacing.lg }} />
        </Card>
      ) : (
        <Card>
          <T variant="h2" style={{ textAlign: 'center', marginBottom: spacing.sm }}>Forgot password?</T>
          <T variant="body" muted style={{ textAlign: 'center', marginBottom: spacing.md }}>
            Enter your email and we'll send you a link to reset your password.
          </T>
          <TextField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="you@example.com" />
          <Button title="Send reset link" onPress={submit} loading={loading} icon="mail-outline" />
          <Pressable onPress={() => router.back()} style={{ alignItems: 'center', marginTop: spacing.md }}>
            <T variant="micro" muted>Back to login</T>
          </Pressable>
        </Card>
      )}
    </Screen>
  );
}
