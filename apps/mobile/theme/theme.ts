import { buildTokens } from '@tvwatch/shared';
export type { Tokens } from '@tvwatch/shared';
export { buildTokens };

// Runtime UI colors come from useAppearance().tokens (see context/PreferencesProvider),
// which resolves light/dark from the shared design tokens. This file now holds only
// theme-independent (static) design primitives.

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
};

export const typography = {
  title: { fontSize: 22, fontWeight: '800' as const },
  h1: { fontSize: 18, fontWeight: '700' as const },
  h2: { fontSize: 16, fontWeight: '700' as const },
  body: { fontSize: 14, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '500' as const },
  micro: { fontSize: 10, fontWeight: '700' as const },
};

export const poster = {
  width: 120,
  height: 180,
  ratio: 2 / 3,
};

/** Static, theme-independent design primitives (spacing/radius/typography/poster). */
export const design = { spacing, radius, typography, poster };
export type Design = typeof design;
