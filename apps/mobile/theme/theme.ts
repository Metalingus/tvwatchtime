import { buildTokens } from '@tvwatch/shared';
export type { Tokens } from '@tvwatch/shared';
export { buildTokens };

// NOTE: `colors` below is the DARK palette kept for backward compatibility with components
// that haven't migrated to the theme tokens yet. New code should use `useAppearance().tokens`
// (see context/PreferencesProvider) which returns light/dark tokens based on the resolved theme.
export const colors = {
  background: '#0F1115',
  surface: '#171A21',
  surfaceAlt: '#1E222B',
  surfaceElevated: '#262B36',
  border: '#2A2F3A',
  text: '#FFFFFF',
  textMuted: '#9AA3B2',
  textDim: '#6B7280',

  // Accents
  primary: '#FFD60A', // yellow — primary actions
  primaryMuted: '#C9AC00',
  watched: '#22C55E', // green — watched/completed
  watchedMuted: '#16A34A',
  danger: '#EF4444',
  favorite: '#EF4444',
  info: '#3B82F6',
  purple: '#8B5CF6',
  orange: '#F59E0B',
  chip: '#2C313C',

  overlay: 'rgba(0,0,0,0.55)',
  overlayStrong: 'rgba(0,0,0,0.75)',
  gradient: ['rgba(15,17,21,0)', 'rgba(15,17,21,0.85)'],
};

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

export const theme = { colors, spacing, radius, typography, poster };
export type Theme = typeof theme;
