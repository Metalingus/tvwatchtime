// Semantic design tokens + light/dark palettes. Shared by mobile (StyleSheet) and admin
// (Tailwind/CSS vars) so both apps use one design vocabulary. Dark values match the previous
// hard-coded colors; light values are authored for accessible contrast (WCAG AA).
// Brand yellow and media-artwork colors are never mechanically inverted.

export type ResolvedTheme = 'light' | 'dark';

export interface Tokens {
  background: string;
  backgroundElevated: string;
  surface: string;
  surfaceAlt: string;
  surfaceElevated: string;
  border: string;
  divider: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  primary: string;
  primaryForeground: string;
  primaryMuted: string;
  success: string;
  danger: string;
  warning: string;
  info: string;
  purple: string;
  orange: string;
  inputBackground: string;
  placeholder: string;
  overlay: string;
  overlayStrong: string;
  skeleton: string;
  cardBackground: string;
  tabBarBackground: string;
  focusRing: string;
  chip: string;
  favorite: string;
  watched: string;
  gradient: [string, string];
}

const dark: Tokens = {
  background: '#0F1115',
  backgroundElevated: '#171A21',
  surface: '#171A21',
  surfaceAlt: '#1E222B',
  surfaceElevated: '#262B36',
  border: '#2A2F3A',
  divider: '#2A2F3A',
  textPrimary: '#FFFFFF',
  textSecondary: '#C7CDD8',
  textMuted: '#9AA3B2',
  textDim: '#6B7280',
  primary: '#FFD60A',
  primaryForeground: '#0F1115',
  primaryMuted: '#C9AC00',
  success: '#22C55E',
  danger: '#EF4444',
  warning: '#F59E0B',
  info: '#3B82F6',
  purple: '#8B5CF6',
  orange: '#F59E0B',
  inputBackground: '#1E222B',
  placeholder: '#6B7280',
  overlay: 'rgba(0,0,0,0.55)',
  overlayStrong: 'rgba(0,0,0,0.75)',
  skeleton: '#1E222B',
  cardBackground: '#171A21',
  tabBarBackground: '#0F1115',
  focusRing: '#FFD60A',
  chip: '#2C313C',
  favorite: '#EF4444',
  watched: '#22C55E',
  gradient: ['rgba(15,17,21,0)', 'rgba(15,17,21,0.85)'],
};

const light: Tokens = {
  background: '#F7F8FA',
  backgroundElevated: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F3F6',
  surfaceElevated: '#FFFFFF',
  border: '#E2E6EC',
  divider: '#E2E6EC',
  textPrimary: '#0F1115',
  textSecondary: '#3A4250',
  textMuted: '#6B7280',
  textDim: '#9AA3B2',
  primary: '#FFD60A',
  primaryForeground: '#0F1115',
  primaryMuted: '#C9AC00',
  success: '#16A34A',
  danger: '#DC2626',
  warning: '#D97706',
  info: '#2563EB',
  purple: '#7C3AED',
  orange: '#D97706',
  inputBackground: '#FFFFFF',
  placeholder: '#9AA3B2',
  overlay: 'rgba(0,0,0,0.45)',
  overlayStrong: 'rgba(0,0,0,0.65)',
  skeleton: '#ECEEF2',
  cardBackground: '#FFFFFF',
  tabBarBackground: '#FFFFFF',
  focusRing: '#FFD60A',
  chip: '#ECEEF2',
  favorite: '#EF4444',
  watched: '#16A34A',
  gradient: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.9)'],
};

export function buildTokens(resolved: ResolvedTheme): Tokens {
  return resolved === 'dark' ? dark : light;
}

// Admin (Tailwind/CSS vars): the raw token names + values per theme, for generating
// `:root` / `.dark` CSS variable blocks. Keys mirror the Tokens field names.
export const TOKEN_KEYS = Object.keys(dark) as (keyof Tokens)[];
export const tokenValues = (resolved: ResolvedTheme): Record<string, string> => {
  const t = buildTokens(resolved);
  const out: Record<string, string> = {};
  for (const k of TOKEN_KEYS) {
    const v = t[k];
    out[k] = Array.isArray(v) ? (v as string[]).join(',') : (v as string);
  }
  return out;
};
