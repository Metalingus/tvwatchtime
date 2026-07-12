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

export default function ChangePasswordScreen() {
  const { tokens } = useAppearance();
  const { changePassword } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (newPassword.length < 8) {
      showError({ title: 'Password too short', description: 'New password must be at least 8 characters' });
      return;
    }
    if (newPassword !== confirm) {
      showError({ title: 'Mismatch', description: 'Passwords do not match' });
      return;
    }
    setLoading(true);
    try {
      await changePassword(oldPassword, newPassword);
      router.replace('/(tabs)/shows');
    } catch (e: any) {
      showError({ title: 'Failed', description: e.message ?? 'Try again' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Header title="Change Password" />
      <View style={{ padding: spacing.xl }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
            <Ionicons name="shield-checkmark-outline" size={24} color={tokens.primary} style={{ marginRight: spacing.sm }} />
            <T variant="body">Please set a new password to continue.</T>
          </View>
          <TextField label="Current password" value={oldPassword} onChangeText={setOldPassword} secureTextEntry />
          <TextField label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry />
          <TextField label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry />
          <Button title="Update password" onPress={submit} loading={loading} icon="checkmark-circle-outline" style={{ marginTop: spacing.sm }} />
        </Card>
      </View>
    </Screen>
  );
}
