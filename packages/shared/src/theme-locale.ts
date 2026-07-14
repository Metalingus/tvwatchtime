// Appearance + locale preference models and a single shared resolver used by mobile,
// admin, and the backend. Preference (not the resolved value) is what gets persisted.

import type { ResolvedTheme } from './design-tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

export type LanguagePreference =
  | 'system'
  | 'en'
  | 'fr'
  | 'es'
  | 'pt-BR'
  | 'de'
  | 'it'
  | 'ar'
  | 'tr'
  | 'hi'
  | 'id'
  | 'ja'
  | 'ko'
  | 'zh-CN';

export type SupportedLocale = Exclude<LanguagePreference, 'system'>;

/** Display name (native) + BCP-47 code for the language picker. No flags. */
export const SUPPORTED_LOCALES: { code: SupportedLocale; nativeName: string }[] = [
  { code: 'en', nativeName: 'English' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'es', nativeName: 'Español' },
  { code: 'pt-BR', nativeName: 'Português (Brasil)' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'it', nativeName: 'Italiano' },
  { code: 'ar', nativeName: 'العربية' },
  { code: 'tr', nativeName: 'Türkçe' },
  { code: 'hi', nativeName: 'हिन्दी' },
  { code: 'id', nativeName: 'Bahasa Indonesia' },
  { code: 'ja', nativeName: '日本語' },
  { code: 'ko', nativeName: '한국어' },
  { code: 'zh-CN', nativeName: '简体中文' },
];

export const RTL_LOCALES: SupportedLocale[] = ['ar'];

export function isRTL(locale: SupportedLocale): boolean {
  return RTL_LOCALES.includes(locale);
}

/**
 * Map a supported app locale to a provider-specific language code for metadata
 * requests. These power per-user localized titles/overviews/images.
 */
const TMDB_LANG: Record<SupportedLocale, string> = {
  en: 'en-US',
  fr: 'fr-FR',
  es: 'es-ES',
  'pt-BR': 'pt-BR',
  de: 'de-DE',
  it: 'it-IT',
  ar: 'ar-SA',
  tr: 'tr-TR',
  hi: 'hi-IN',
  id: 'id-ID',
  ja: 'ja-JP',
  ko: 'ko-KR',
  'zh-CN': 'zh-CN',
};

/** TMDb language code (BCP-47) for a supported locale, defaulting to English. */
export function tmdbCode(locale: SupportedLocale | string | null | undefined): string {
  return (TMDB_LANG as Record<string, string>)[String(locale)] ?? 'en-US';
}

/** TVDB Accept-Language code (2-letter base) for a supported locale, defaulting to English. */
export function tvdbCode(locale: SupportedLocale | string | null | undefined): string {
  const l = String(locale ?? 'en');
  return (TMDB_LANG as Record<string, string>)[l] ? l.split('-')[0] : 'en';
}

/** Resolve a theme preference against the OS color scheme. Unknown → dark. */
export function resolveTheme(pref: ThemePreference, systemScheme: 'light' | 'dark' | null | undefined): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemScheme === 'light' ? 'light' : 'dark';
}

const LOCALE_ALIASES: Record<string, SupportedLocale> = {
  'zh-hans': 'zh-CN',
  'zh-cn': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh': 'zh-CN',
  'pt': 'pt-BR',
  'pt-br': 'pt-BR',
  'pt-pt': 'pt-BR', // product decision: fold PT-PT into the Brazilian bundle for v1
};

const SUPPORTED_SET = new Set<string>(SUPPORTED_LOCALES.map((l) => l.code.toLowerCase()));

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/_/g, '-');
}

/**
 * Resolve a language preference to a supported locale.
 * 1) exact supported  2) known alias  3) base-language match  4) English.
 *   fr-CA → fr, es-MX → es, pt-BR → pt-BR, zh-Hans → zh-CN, unsupported → en.
 */
export function resolveLocale(pref: LanguagePreference, deviceLocales: string[]): SupportedLocale {
  if (pref !== 'system') return pref;
  const candidates = (deviceLocales?.length ? deviceLocales : []).map(norm);
  for (const c of candidates) {
    if (SUPPORTED_SET.has(c)) return c as SupportedLocale; // exact (e.g. pt-br)
    if (LOCALE_ALIASES[c]) return LOCALE_ALIASES[c]; // alias (e.g. zh-hans)
    const base = c.split('-')[0];
    if (base && SUPPORTED_SET.has(base)) return base as SupportedLocale; // base match (fr-ca → fr)
    if (LOCALE_ALIASES[base]) return LOCALE_ALIASES[base];
  }
  return 'en';
}

/** Normalize arbitrary stored values to a safe preference (old/invalid clients). */
export function safeThemePref(v: string | null | undefined): ThemePreference {
  return v === 'light' || v === 'dark' ? v : 'system';
}
export function safeLangPref(v: string | null | undefined): LanguagePreference {
  if (v === 'system') return 'system';
  if (v && SUPPORTED_SET.has(norm(v))) return norm(v) as LanguagePreference;
  return 'system';
}
