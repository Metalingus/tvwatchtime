'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getToken, setToken, clearToken } from '@/lib/api';

interface AdminUser {
  id: string;
  username: string;
  email: string;
  role: string;
}

interface AuthCtx {
  user: AdminUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>(null!);

const ADMIN_ROLES = ['VIEWER', 'SUPPORT', 'CONTENT_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) { setLoading(false); return; }
    api.get('/me').then((res) => {
      if (!ADMIN_ROLES.includes(res.data.role)) {
        clearToken(); setUser(null);
      } else {
        setUser(res.data);
      }
    }).catch(() => clearToken()).finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password });
    if (!ADMIN_ROLES.includes(res.data.user.role)) {
      throw new Error('You do not have admin access');
    }
    setToken(res.data.accessToken);
    setUser(res.data.user);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    window.location.href = '/login';
  }, []);

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() { return useContext(Ctx); }
