import { normalizeStoredThemePreference, resolveHydratedTheme } from '../theme-hydration';

describe('normalizeStoredThemePreference', () => {
  it('defaults new installs to dark while preserving every saved choice', () => {
    expect(normalizeStoredThemePreference(null)).toBe('dark');
    expect(normalizeStoredThemePreference('invalid')).toBe('dark');
    expect(normalizeStoredThemePreference('system')).toBe('system');
    expect(normalizeStoredThemePreference('light')).toBe('light');
    expect(normalizeStoredThemePreference('dark')).toBe('dark');
  });
});

describe('resolveHydratedTheme', () => {
  it('uses the dark default before web preference hydration', () => {
    expect(resolveHydratedTheme(false, 'dark', 'dark')).toBe('dark');
    expect(resolveHydratedTheme(false, 'system', 'light')).toBe('dark');
  });

  it('applies the saved preference after hydration', () => {
    expect(resolveHydratedTheme(true, 'dark', 'light')).toBe('dark');
    expect(resolveHydratedTheme(true, 'system', 'dark')).toBe('dark');
  });
});
