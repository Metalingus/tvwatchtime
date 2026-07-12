import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Appearance, I18nManager, Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildTokens,
  isRTL,
  resolveTheme,
  type LanguagePreference,
  type ResolvedTheme,
  type SupportedLocale,
  type ThemePreference,
  type Tokens,
} from '@tvwatch/shared';
import { api } from '../api/client';
import { useAuth } from './AuthContext';
import i18n, { detectResolvedLocale, loadLocale } from '../i18n';

const THEME_KEY = 'pref:theme';
const LANG_KEY = 'pref:lang';

interface AppearanceContextValue {
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  tokens: Tokens;
  setThemePreference: (p: ThemePreference) => void;
  languagePreference: LanguagePreference;
  resolvedLocale: SupportedLocale;
  setLanguagePreference: (l: LanguagePreference) => void;
  rtl: boolean;
}

const AppearanceContext = createContext<AppearanceContextValue>(null as any);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null/undefined

  const [themePreference, setThemePreferenceState] = useState<ThemePreference>('system');
  const [languagePreference, setLanguagePreferenceState] = useState<LanguagePreference>('system');
  const [locale, setLocale] = useState<SupportedLocale>('en');
  const appliedForUserId = useRef<string | null>(null);

  // Load local preferences once at startup (no network block).
  useEffect(() => {
    (async () => {
      const [t, l] = await Promise.all([AsyncStorage.getItem(THEME_KEY), AsyncStorage.getItem(LANG_KEY)]);
      const tp: ThemePreference = t === 'light' || t === 'dark' ? t : 'system';
      const lp: LanguagePreference =
        l === 'system' || l === 'en' || l === 'fr' || l === 'es' || l === 'pt-BR' || l === 'de' || l === 'it' || l === 'ar' || l === 'tr' || l === 'hi' || l === 'id' || l === 'ja' || l === 'ko' || l === 'zh-CN'
          ? (l as LanguagePreference)
          : 'system';
      setThemePreferenceState(tp);
      setLanguagePreferenceState(lp);
      const resolved = detectResolvedLocale(lp);
      setLocale(resolved);
      void loadLocale(resolved);
    })();
  }, []);

  // Account-wins on sign-in: apply the account's non-system prefs once per login.
  useEffect(() => {
    if (!user || appliedForUserId.current === user.id) return;
    appliedForUserId.current = user.id;
    if (user.themePreference && user.themePreference !== 'system') {
      setThemePreferenceState(user.themePreference);
      void AsyncStorage.setItem(THEME_KEY, user.themePreference);
    }
    if (user.languagePreference && user.languagePreference !== 'system') {
      const lp = user.languagePreference;
      setLanguagePreferenceState(lp);
      void AsyncStorage.setItem(LANG_KEY, lp);
      const resolved = detectResolvedLocale(lp);
      setLocale(resolved);
      void loadLocale(resolved);
    }
  }, [user]);

  const resolvedTheme: ResolvedTheme = resolveTheme(themePreference, (systemScheme as 'light' | 'dark' | null) ?? null);
  const tokens = useMemo(() => buildTokens(resolvedTheme), [resolvedTheme]);
  const rtl = isRTL(locale);

  // Apply native RTL + web document direction/locale when the resolved locale changes.
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    } else if (Platform.OS !== 'web') {
      // Native RTL requires a relaunch to fully apply; set the flag proactively.
      try {
        if (I18nManager.isRTL !== rtl) I18nManager.forceRTL(rtl);
      } catch {
        // ignore
      }
    }
  }, [locale, rtl]);

  const setThemePreference = useCallback(
    (p: ThemePreference) => {
      setThemePreferenceState(p);
      void AsyncStorage.setItem(THEME_KEY, p);
      if (user) api.patch('/me', { themePreference: p }).catch(() => undefined);
    },
    [user],
  );

  const setLanguagePreference = useCallback(
    (l: LanguagePreference) => {
      setLanguagePreferenceState(l);
      void AsyncStorage.setItem(LANG_KEY, l);
      const resolved = detectResolvedLocale(l);
      setLocale(resolved);
      void loadLocale(resolved);
      if (user) api.patch('/me', { languagePreference: l }).catch(() => undefined);
    },
    [user],
  );

  const value = useMemo<AppearanceContextValue>(
    () => ({
      themePreference,
      resolvedTheme,
      tokens,
      setThemePreference,
      languagePreference,
      resolvedLocale: locale,
      setLanguagePreference,
      rtl,
    }),
    [themePreference, resolvedTheme, tokens, setThemePreference, languagePreference, locale, setLanguagePreference, rtl],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  return useContext(AppearanceContext);
}

// Re-export for convenience so migrated components can import tokens from context.
export { Appearance };
