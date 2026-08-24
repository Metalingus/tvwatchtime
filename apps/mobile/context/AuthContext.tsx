import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import type {
  AppleLoginDto,
  AuthSessionDto,
  CurrentUserDto,
  EmailLoginDto,
  EmailRegisterDto,
} from '@tvwatch/shared';
import { api, HttpError } from '../api/client';
import { tokenStorage } from '../api/storage';
import {
  ensureFreshAccessToken,
  resetBaseUrl,
  setBaseUrl,
  setSessionExpiredHandler,
} from '../api/client';
import { clearWidgetCredentials, syncWidgetCredentials } from '../widgets/sync';
import { logFirstEvent, setAnalyticsUser } from '../lib/analytics';

interface AuthContextValue {
  user: CurrentUserDto | null;
  loading: boolean;
  isSelfHosted: boolean;
  loginEmail: (dto: EmailLoginDto) => Promise<void>;
  registerEmail: (dto: EmailRegisterDto) => Promise<void>;
  loginSocial: (
    provider: 'GOOGLE' | 'FACEBOOK',
    token: string,
    redirectUri?: string,
  ) => Promise<void>;
  loginApple: (dto: AppleLoginDto) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setSelfHosted: (val: boolean, url?: string) => Promise<void>;
  getApiUrl: () => Promise<string | null>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>(null as any);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<CurrentUserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSelfHosted, setIsSelfHostedState] = useState(false);
  const activeUserId = user?.id;

  useEffect(() => {
    setSessionExpiredHandler(async () => {
      setUser(null);
      setAnalyticsUser(null);
      void clearWidgetCredentials();
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    (async () => {
      const selfHosted = await tokenStorage.getIsSelfHosted();
      setIsSelfHostedState(selfHosted);
      const stored = await tokenStorage.getUser<CurrentUserDto>();
      if (stored) {
        setUser(stored);
        setAnalyticsUser(stored.id);
        // Render the app from the stored user IMMEDIATELY — the /me refresh
        // below continues in the background. Gating the whole app on that
        // network round trip added seconds to every cold start.
        setLoading(false);
      }
      const access = await tokenStorage.getAccess();
      if (access) {
        try {
          const me = await api.get<CurrentUserDto>('/me');
          setUser(me);
          await tokenStorage.setUser(me);
          setAnalyticsUser(me.id);
        } catch (e) {
          // 401 = access + refresh both invalid (refresh already attempted in client)
          if (e instanceof HttpError && e.status === 401) {
            await tokenStorage.clear();
            setUser(null);
          }
          // network errors etc. — keep stored user, will retry on next request
        }
      }
      // Push current tokens/base URL to the home-screen widgets (iOS App Group;
      // re-render on Android) after any silent refresh above settled.
      void syncWidgetCredentials();
      // No stored user: we waited for /me to know whether a session exists.
      if (!stored) setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!activeUserId) return;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const resumed = next === 'active' && previous !== 'active';
      previous = next;
      if (!resumed) return;
      void ensureFreshAccessToken().then((outcome) => {
        if (outcome.status === 'refreshed') void syncWidgetCredentials();
      });
    });
    return () => subscription.remove();
  }, [activeUserId]);

  const setSelfHosted = useCallback(async (val: boolean, url?: string) => {
    await tokenStorage.setIsSelfHosted(val);
    setIsSelfHostedState(val);
    if (val && url) {
      await setBaseUrl(url);
    } else if (!val) {
      await resetBaseUrl();
    }
    // Widgets fetch the API directly — they need the new backend URL.
    void syncWidgetCredentials();
  }, []);

  const getApiUrl = useCallback(async () => {
    return tokenStorage.getApiUrl();
  }, []);

  const setSession = useCallback(async (s: AuthSessionDto) => {
    await tokenStorage.set(s.accessToken, s.refreshToken);
    await tokenStorage.setUser(s.user);
    setUser(s.user);
    setAnalyticsUser(s.user.id);
    logFirstEvent('first_login', s.user.id);
    void syncWidgetCredentials();
  }, []);

  const loginEmail = useCallback(
    async (dto: EmailLoginDto) => {
      const s = await api.post<AuthSessionDto>('/auth/login', dto as any);
      await setSession(s);
    },
    [setSession],
  );

  const registerEmail = useCallback(
    async (dto: EmailRegisterDto) => {
      const s = await api.post<AuthSessionDto>('/auth/register', dto as any);
      await setSession(s);
    },
    [setSession],
  );

  const loginSocial = useCallback(
    async (provider: 'GOOGLE' | 'FACEBOOK', token: string, redirectUri?: string) => {
      const s = await api.post<AuthSessionDto>('/auth/social', {
        provider,
        authorizationCode: token,
        redirectUri,
      } as any);
      await setSession(s);
    },
    [setSession],
  );

  const loginApple = useCallback(
    async (dto: AppleLoginDto) => {
      const s = await api.post<AuthSessionDto>('/auth/apple', dto as any);
      await setSession(s);
    },
    [setSession],
  );

  const logout = useCallback(async () => {
    await tokenStorage.clear();
    setUser(null);
    setAnalyticsUser(null);
    void clearWidgetCredentials();
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const me = await api.get<CurrentUserDto>('/me');
      setUser(me);
      await tokenStorage.setUser(me);
    } catch {
      // ignore
    }
  }, []);

  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    await api.post('/auth/change-password', { oldPassword, newPassword });
    const me = await api.get<CurrentUserDto>('/me');
    setUser(me);
    await tokenStorage.setUser(me);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isSelfHosted,
      loginEmail,
      registerEmail,
      loginSocial,
      loginApple,
      logout,
      refreshUser,
      setSelfHosted,
      getApiUrl,
      changePassword,
    }),
    [
      user,
      loading,
      isSelfHosted,
      loginEmail,
      registerEmail,
      loginSocial,
      loginApple,
      logout,
      refreshUser,
      setSelfHosted,
      getApiUrl,
      changePassword,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
