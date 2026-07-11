import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { showError } from '../utils/alert';

const EXTRA = (Constants.expoConfig?.extra as any) || {};
const GOOGLE_CLIENT_ID = EXTRA.googleClientId || '';
const FACEBOOK_APP_ID = EXTRA.facebookAppId || '';
const API_BASE = EXTRA.apiBaseUrl || 'http://localhost:4000/api';

const OAUTH_REDIRECT = `${API_BASE}/auth/oauth-callback`;

function buildAuthUrl(authorizationEndpoint: string, clientId: string, scopes: string[], state: string): string {
  const isWeb = Platform.OS === 'web';
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT,
    response_type: 'code',
    scope: scopes.join(' '),
    state: isWeb ? `${state}:web` : state,
  });
  return `${authorizationEndpoint}?${params.toString()}`;
}

function openOAuth(url: string) {
  if (Platform.OS === 'web') {
    // Web: navigate in the same tab (no popup)
    window.location.href = url;
    return;
  }
  // Mobile: open system browser
  WebBrowser.openBrowserAsync(url).catch(() => {
    showError({ title: 'Sign-in failed', description: 'Could not open browser' });
  });
}

export function useGoogleAuth() {
  const configured = !!GOOGLE_CLIENT_ID;
  return {
    ready: configured,
    configured,
    signIn: () => {
      if (!configured) return;
      const url = buildAuthUrl(
        'https://accounts.google.com/o/oauth2/v2/auth',
        GOOGLE_CLIENT_ID,
        ['openid', 'email', 'profile'],
        'google',
      );
      openOAuth(url);
    },
  };
}

export function useFacebookAuth() {
  const configured = !!FACEBOOK_APP_ID;
  return {
    ready: configured,
    configured,
    signIn: () => {
      if (!configured) return;
      const url = buildAuthUrl(
        'https://www.facebook.com/v18.0/dialog/oauth',
        FACEBOOK_APP_ID,
        ['public_profile', 'email'],
        'facebook',
      );
      openOAuth(url);
    },
  };
}
