import { useEffect, useCallback } from 'react';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { Alert } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { router } from 'expo-router';

WebBrowser.maybeCompleteAuthSession();

const EXTRA = (Constants.expoConfig?.extra as any) || {};
const GOOGLE_CLIENT_ID = EXTRA.googleClientId || '';
const FACEBOOK_APP_ID = EXTRA.facebookAppId || '';

const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const FACEBOOK_DISCOVERY = {
  authorizationEndpoint: 'https://www.facebook.com/v18.0/dialog/oauth',
};

export function useGoogleAuth() {
  const { loginSocial } = useAuth();
  const redirectUri = AuthSession.makeRedirectUri({ useProxy: true, scheme: 'tvwatchtime' });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes: ['openid', 'email', 'profile'],
      redirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
    },
    GOOGLE_DISCOVERY,
  );

  useEffect(() => {
    if (response?.type === 'success' && response.params.code) {
      loginSocialWithCode('GOOGLE', response.params.code, redirectUri);
    } else if (response?.type === 'error') {
      Alert.alert('Google sign-in failed', response.error?.message ?? 'Please try again');
    }
  }, [response]);

  const loginSocialWithCode = async (provider: 'GOOGLE', code: string, redirect: string) => {
    try {
      await loginSocial(provider, code, redirect);
      router.replace('/(tabs)/shows');
    } catch (e: any) {
      Alert.alert('Login failed', e?.message ?? 'Please try again');
    }
  };

  return {
    ready: !!request && !!GOOGLE_CLIENT_ID,
    configured: !!GOOGLE_CLIENT_ID,
    signIn: () => promptAsync({ useProxy: true }),
  };
}

export function useFacebookAuth() {
  const { loginSocial } = useAuth();
  const redirectUri = AuthSession.makeRedirectUri({ useProxy: true, scheme: 'tvwatchtime' });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: FACEBOOK_APP_ID,
      scopes: ['public_profile', 'email'],
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
    },
    FACEBOOK_DISCOVERY,
  );

  useEffect(() => {
    if (response?.type === 'success' && response.params.code) {
      (async () => {
        try {
          await loginSocial('FACEBOOK', response.params.code, redirectUri);
          router.replace('/(tabs)/shows');
        } catch (e: any) {
          Alert.alert('Login failed', e?.message ?? 'Please try again');
        }
      })();
    } else if (response?.type === 'error') {
      Alert.alert('Facebook sign-in failed', response.error?.message ?? 'Please try again');
    }
  }, [response]);

  return {
    ready: !!request && !!FACEBOOK_APP_ID,
    configured: !!FACEBOOK_APP_ID,
    signIn: () => promptAsync({ useProxy: true }),
  };
}
