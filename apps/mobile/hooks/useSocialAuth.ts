import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { showError } from '../lib/dialog';

const EXTRA = (Constants.expoConfig?.extra as any) || {};
const GOOGLE_CLIENT_ID = EXTRA.googleClientId || '';
const FACEBOOK_APP_ID = EXTRA.facebookAppId || '';
const API_BASE = EXTRA.apiBaseUrl || 'http://localhost:4000/api';

const OAUTH_REDIRECT = `${API_BASE}/auth/oauth-callback`;

function buildAuthUrl(
  authorizationEndpoint: string,
  clientId: string,
  scopes: string[],
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  });
  return `${authorizationEndpoint}?${params.toString()}`;
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
      WebBrowser.openBrowserAsync(url).catch(() => {
        showError({ title: 'Google sign-in failed', description: 'Could not open browser' });
      });
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
      WebBrowser.openBrowserAsync(url).catch(() => {
        showError({ title: 'Facebook sign-in failed', description: 'Could not open browser' });
      });
    },
  };
}
