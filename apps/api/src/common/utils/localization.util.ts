import { currentLanguage } from '../language.context';
import type { SupportedLocale } from '@tvwatch/shared';

type Obj = Record<string, any> | null | undefined;

/**
 * Resolve a localized field with an English fallback.
 *
 * Resolution order: `obj[overrideField][lang]` → `obj[overrideField]['en']`
 * (when lang != en) → `obj[baseField]`. The base column is always English; the
 * JSON override column maps locale codes (e.g. `{ fr: '...', es: '...' }`).
 *
 * Empty strings in overrides are skipped so the fallback engages.
 */
export function localized(
  obj: Obj,
  overrideField: string,
  baseField: string,
  lang?: SupportedLocale,
): any {
  if (!obj) return undefined;
  const l = lang ?? currentLanguage();
  const overrides = obj[overrideField];
  if (overrides && typeof overrides === 'object') {
    const lv = overrides[l];
    if (lv != null && lv !== '') return lv;
    if (l !== 'en') {
      const en = overrides['en'];
      if (en != null && en !== '') return en;
    }
  }
  return obj[baseField];
}

/** Merge a localized override value into a JSON map (mutates+returns the map). */
export function setOverride(
  map: Record<string, string> | null | undefined,
  lang: string,
  value: string | null | undefined,
): Record<string, string> {
  if (value == null || value === '') return map ?? {};
  const next = map && typeof map === 'object' ? { ...map } : {};
  next[lang] = value;
  return next;
}

/**
 * Merge a locale's value and its English base into an existing JSON override map.
 * - `lang === 'en'`: stores the value under `'en'` (single fetch, value is English).
 * - otherwise: stores the English base under `'en'` (when provided) and the locale
 *   value under `lang`. Empty values are skipped so fallbacks engage.
 * Existing entries for other locales are preserved.
 */
export function mergeLocalized(
  existing: Record<string, string> | null | undefined,
  lang: string,
  localeValue: string | null | undefined,
  englishValue: string | null | undefined,
): Record<string, string> {
  const map = existing && typeof existing === 'object' ? { ...existing } : {};
  const en = lang === 'en' ? localeValue : englishValue;
  if (en != null && en !== '') map['en'] = en;
  if (lang !== 'en' && localeValue != null && localeValue !== '') map[lang] = localeValue;
  return map;
}
