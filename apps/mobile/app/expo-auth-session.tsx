import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { useAppearance } from '../context/PreferencesProvider';
import { showError } from '../lib/dialog';
import { useTranslation } from 'react-i18next';

const API_BASE = (require('expo-constants').default.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';
const OAUTH_REDIRECT = `${API_BASE}/auth/oauth-callback`;

export default function AuthSessionScreen() {
  const { loginSocial } = useAuth();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['auth', 'common']);
  const params = useLocalSearchParams<{ code?: string; state?: string; error?: string; error_description?: string; error_reason?: string }>();

  useEffect(() => {
    const code = params.code;
    const error = params.error || params.error_description || params.error_reason;

    if (error) {
      const msg = typeof error === 'string' ? error : 'OAuth error';
      showError({ title: t('auth:signInFailed'), description: msg.includes('redirect') ? t('auth:redirectNotConfigured') : msg });
      router.replace('/(auth)/login');
      return;
    }

    if (!code) {
      showError({ title: t('auth:signInFailed'), description: t('auth:noAuthCode') });
      router.replace('/(auth)/login');
      return;
    }

    const provider = (params.state || '').includes('facebook') ? 'FACEBOOK' : 'GOOGLE';

    loginSocial(provider, code, OAUTH_REDIRECT)
      .then(() => router.replace('/(tabs)/shows'))
      .catch((e: any) => {
        showError({ title: t('auth:loginFailedGeneric'), description: e?.message ?? t('common:pleaseTryAgain') });
        router.replace('/(auth)/login');
      });
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.background }}>
      <ActivityIndicator color={tokens.primary} size="large" />
    </View>
  );
}