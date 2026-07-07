import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthSessionDto, CurrentUserDto, EmailLoginDto, EmailRegisterDto } from '@tvwatch/shared';
import { api, HttpError } from '../api/client';
import { tokenStorage } from '../api/storage';
import { setBaseUrl, resetBaseUrl } from '../api/client';

interface AuthContextValue {
  user: CurrentUserDto | null;
  loading: boolean;
  isSelfHosted: boolean;
  loginEmail: (dto: EmailLoginDto) => Promise<void>;
  registerEmail: (dto: EmailRegisterDto) => Promise<void>;
  loginSocial: (provider: 'GOOGLE' | 'APPLE' | 'FACEBOOK', token: string) => Promise<void>;
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

  useEffect(() => {
    (async () => {
      const selfHosted = await tokenStorage.getIsSelfHosted();
      setIsSelfHostedState(selfHosted);
      const stored = await tokenStorage.getUser<CurrentUserDto>();
      if (stored) setUser(stored);
      const access = await tokenStorage.getAccess();
      if (access) {
        try {
          const me = await api.get<CurrentUserDto>('/me');
          setUser(me);
          await tokenStorage.setUser(me);
        } catch (e) {
          // 401 = access + refresh both invalid (refresh already attempted in client)
          if (e instanceof HttpError && e.status === 401) {
            await tokenStorage.clear();
            setUser(null);
          }
          // network errors etc. — keep stored user, will retry on next request
        }
      }
      setLoading(false);
    })();
  }, []);

  const setSelfHosted = useCallback(async (val: boolean, url?: string) => {
    await tokenStorage.setIsSelfHosted(val);
    setIsSelfHostedState(val);
    if (val && url) {
      await setBaseUrl(url);
    } else if (!val) {
      await resetBaseUrl();
    }
  }, []);

  const getApiUrl = useCallback(async () => {
    return tokenStorage.getApiUrl();
  }, []);

  const setSession = useCallback(async (s: AuthSessionDto) => {
    await tokenStorage.set(s.accessToken, s.refreshToken);
    await tokenStorage.setUser(s.user);
    setUser(s.user);
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
    async (provider: 'GOOGLE' | 'APPLE' | 'FACEBOOK', token: string, redirectUri?: string) => {
      const s = await api.post<AuthSessionDto>('/auth/social', {
        provider,
        authorizationCode: token,
        redirectUri,
      } as any);
      await setSession(s);
    },
    [setSession],
  );

  const logout = useCallback(async () => {
    await tokenStorage.clear();
    setUser(null);
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
    () => ({ user, loading, isSelfHosted, loginEmail, registerEmail, loginSocial, logout, refreshUser, setSelfHosted, getApiUrl, changePassword }),
    [user, loading, isSelfHosted, loginEmail, registerEmail, loginSocial, logout, refreshUser, setSelfHosted, getApiUrl, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
