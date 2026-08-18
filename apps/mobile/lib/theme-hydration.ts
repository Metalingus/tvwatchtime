import {
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@tvwatch/shared';

export const DEFAULT_THEME_PREFERENCE = 'dark' satisfies ThemePreference;

export function normalizeStoredThemePreference(value: string | null): ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
    ? value
    : DEFAULT_THEME_PREFERENCE;
}

/**
 * Static web rendering cannot read browser storage or media queries. Keep the
 * server and the browser's first hydration render identical, then apply the
 * real preference once local storage is available.
 */
export function resolveHydratedTheme(
  preferencesLoaded: boolean,
  preference: ThemePreference,
  systemScheme: 'light' | 'dark' | null | undefined,
): ResolvedTheme {
  return preferencesLoaded ? resolveTheme(preference, systemScheme) : DEFAULT_THEME_PREFERENCE;
}
