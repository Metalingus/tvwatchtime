import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Appearance, I18nManager, Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import {
  buildTokens,
  isRTL,
  type LanguagePreference,
  type ResolvedTheme,
  type SupportedLocale,
  type ThemePreference,
  type Tokens,
} from '@tvwatch/shared';
import { api, setApiLocale } from '../api/client';
import { useAuth } from './AuthContext';
import i18n, { detectResolvedLocale, loadLocale } from '../i18n';
import { syncWidgetLabels } from '../widgets/sync';
import {
  DEFAULT_THEME_PREFERENCE,
  normalizeStoredThemePreference,
  resolveHydratedTheme,
} from '../lib/theme-hydration';

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

  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(
    DEFAULT_THEME_PREFERENCE,
  );
  const [languagePreference, setLanguagePreferenceState] = useState<LanguagePreference>('system');
  const [locale, setLocale] = useState<SupportedLocale>('en');
  const [preferencesLoaded, setPreferencesLoaded] = useState(Platform.OS !== 'web');
  const appliedForUserId = useRef<string | null>(null);
  const prevLocaleRef = useRef<string | null>(null);
  const queryClient = useQueryClient();

  // Load local preferences once at startup (no network block).
  useEffect(() => {
    (async () => {
      try {
        const [t, l] = await Promise.all([
          AsyncStorage.getItem(THEME_KEY),
          AsyncStorage.getItem(LANG_KEY),
        ]);
        const tp = normalizeStoredThemePreference(t);
        const lp: LanguagePreference =
          l === 'system' || l === 'en' || l === 'fr' || l === 'es' || l === 'pt-BR' || l === 'de' || l === 'it' || l === 'ar' || l === 'tr' || l === 'hi' || l === 'id' || l === 'ja' || l === 'ko' || l === 'zh-CN'
            ? (l as LanguagePreference)
            : 'system';
        setThemePreferenceState(tp);
        setLanguagePreferenceState(lp);
        const resolved = detectResolvedLocale(lp);
        setLocale(resolved);
        void loadLocale(resolved);
      } catch {
        // Keep the dark theme and system-language defaults; storage must not block rendering.
      } finally {
        // Also release the deterministic web theme if storage is unavailable.
        setPreferencesLoaded(true);
      }
    })();
  }, []);

  // Account-wins on sign-in: apply the account's non-system prefs once per login.
  useEffect(() => {
    if (!preferencesLoaded) return;
    if (!user) {
      appliedForUserId.current = null;
      return;
    }
    if (appliedForUserId.current === user.id) return;
    appliedForUserId.current = user.id;
    if (user.themePreference) {
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
  }, [user, preferencesLoaded]);

  const resolvedTheme: ResolvedTheme = resolveHydratedTheme(
    preferencesLoaded,
    themePreference,
    (systemScheme as 'light' | 'dark' | null) ?? null,
  );
  const tokens = useMemo(() => buildTokens(resolvedTheme), [resolvedTheme]);
  const rtl = isRTL(locale);

  // Apply native RTL + web document direction/locale when the resolved locale changes.
  useEffect(() => {
    // Keep the API client's Accept-Language in sync so metadata comes back localized.
    setApiLocale(locale);
    // When the language actually changes (not the first mount), invalidate the React
    // Query cache so list/detail data refetches in the new language. We invalidate
    // (not clear()) so active query observers refetch instead of being stranded in a
    // pending/empty state, and inactive queries refetch on next mount.
    if (prevLocaleRef.current != null && prevLocaleRef.current !== locale) {
      queryClient.invalidateQueries();
      // Widgets render their own UI — push the new localized headers/labels.
      void syncWidgetLabels();
    }
    prevLocaleRef.current = locale;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = rtl ? 'rtl' : 'ltr';
      // Let browser-native controls (scrollbars, form focus rings, <select> dropdowns)
      // follow the active theme.
      document.documentElement.style.colorScheme = resolvedTheme;
    } else if (Platform.OS !== 'web') {
      // Native RTL requires a relaunch to fully apply; set the flag proactively.
      try {
        if (I18nManager.isRTL !== rtl) I18nManager.forceRTL(rtl);
      } catch {
        // ignore
      }
    }
  }, [locale, rtl, resolvedTheme]);

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
