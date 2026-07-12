import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../../components/Header';
import { Button, Card, Screen, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { api } from '../../api/client';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';
import { useTranslation } from 'react-i18next';

export default function ForgotPasswordScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['auth', 'common']);
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
      showError({ title: t('common:failed'), description: e?.message ?? t('common:pleaseTryAgain') });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen style={{ justifyContent: 'center', padding: spacing.xl }}>
      <View style={{ alignItems: 'center', marginBottom: spacing.xl }}>
        <Ionicons name="lock-closed-outline" size={48} color={tokens.primary} />
      </View>

      {sent ? (
        <Card>
          <T variant="h2" style={{ textAlign: 'center', marginBottom: spacing.sm }}>{t('auth:resetSent')}</T>
          <T variant="body" muted style={{ textAlign: 'center' }}>
            {t('auth:resetSentDesc', { email })}
          </T>
          <Button title={t('auth:backToLogin')} onPress={() => router.replace('/(auth)/login')} icon="arrow-back" style={{ marginTop: spacing.lg }} />
        </Card>
      ) : (
        <Card>
          <T variant="h2" style={{ textAlign: 'center', marginBottom: spacing.sm }}>{t('auth:forgotPasswordTitle')}</T>
          <T variant="body" muted style={{ textAlign: 'center', marginBottom: spacing.md }}>
            {t('auth:forgotPasswordDesc')}
          </T>
          <TextField label={t('auth:email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder={t('auth:emailPlaceholder')} />
          <Button title={t('auth:sendResetLink')} onPress={submit} loading={loading} icon="mail-outline" />
          <Pressable onPress={() => router.back()} style={{ alignItems: 'center', marginTop: spacing.md }}>
            <T variant="micro" muted>{t('auth:backToLogin')}</T>
          </Pressable>
        </Card>
      )}
    </Screen>
  );
}