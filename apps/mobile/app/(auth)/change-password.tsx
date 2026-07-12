import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { Button, Card, Screen, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { Header } from '../../components/Header';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';
import { useTranslation } from 'react-i18next';

export default function ChangePasswordScreen() {
  const { tokens } = useAppearance();
  const { changePassword } = useAuth();
  const { t } = useTranslation(['auth', 'common']);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (newPassword.length < 8) {
      showError({ title: t('auth:passwordTooShort'), description: t('auth:passwordMinChars') });
      return;
    }
    if (newPassword !== confirm) {
      showError({ title: t('auth:passwordMismatch'), description: t('auth:passwordsDoNotMatch') });
      return;
    }
    setLoading(true);
    try {
      await changePassword(oldPassword, newPassword);
      router.replace('/(tabs)/shows');
    } catch (e: any) {
      showError({ title: t('common:failed'), description: e.message ?? t('common:tryAgain') });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Header title={t('auth:changePasswordTitle')} />
      <View style={{ padding: spacing.xl }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
            <Ionicons name="shield-checkmark-outline" size={24} color={tokens.primary} style={{ marginRight: spacing.sm }} />
            <T variant="body">{t('auth:changePasswordDesc')}</T>
          </View>
          <TextField label={t('auth:currentPassword')} value={oldPassword} onChangeText={setOldPassword} secureTextEntry />
          <TextField label={t('auth:newPassword')} value={newPassword} onChangeText={setNewPassword} secureTextEntry />
          <TextField label={t('auth:confirmNewPassword')} value={confirm} onChangeText={setConfirm} secureTextEntry />
          <Button title={t('auth:updatePassword')} onPress={submit} loading={loading} icon="checkmark-circle-outline" style={{ marginTop: spacing.sm }} />
        </Card>
      </View>
    </Screen>
  );
}