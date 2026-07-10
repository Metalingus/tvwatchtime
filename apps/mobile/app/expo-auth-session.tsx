import { useEffect } from 'react';
import { View, ActivityIndicator, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme/theme';

const API_BASE = (require('expo-constants').default.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';
const OAUTH_REDIRECT = `${API_BASE}/auth/oauth-callback`;

export default function AuthSessionScreen() {
  const { loginSocial } = useAuth();
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string; error_description?: string; error_reason?: string }>();

  useEffect(() => {
    const code = params.code;
    const error = params.error || params.error_description || params.error_reason;

    if (error) {
      const msg = typeof error === 'string' ? error : 'OAuth error';
      Alert.alert('Sign-in failed', msg.includes('redirect') ? 'Redirect URI not configured for this provider. Contact support.' : msg);
      router.replace('/(auth)/login');
      return;
    }

    if (!code) {
      Alert.alert('Sign-in failed', 'No authorization code received. Please try again.');
      router.replace('/(auth)/login');
      return;
    }

    const provider = (params.state || '').includes('facebook') ? 'FACEBOOK' : 'GOOGLE';

    loginSocial(provider, code, OAUTH_REDIRECT)
      .then(() => router.replace('/(tabs)/shows'))
      .catch((e: any) => {
        Alert.alert('Login failed', e?.message ?? 'Please try again');
        router.replace('/(auth)/login');
      });
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
      <ActivityIndicator color={colors.primary} size="large" />
    </View>
  );
}
