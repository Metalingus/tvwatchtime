import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';
import { resolveLocale, type LanguagePreference, type SupportedLocale } from '@tvwatch/shared';

// English (fallback) is bundled. Other locales are loaded on demand by loadLocale().
import common from '../locales/en/common.json';
import settings from '../locales/en/settings.json';
import navigation from '../locales/en/navigation.json';
import auth from '../locales/en/auth.json';
import shows from '../locales/en/shows.json';
import movies from '../locales/en/movies.json';
import explore from '../locales/en/explore.json';
import profile from '../locales/en/profile.json';
import notifications from '../locales/en/notifications.json';
import importNs from '../locales/en/import.json';
import stats from '../locales/en/stats.json';
import showDetail from '../locales/en/showDetail.json';
import episode from '../locales/en/episode.json';
import comments from '../locales/en/comments.json';
import lists from '../locales/en/lists.json';
import social from '../locales/en/social.json';

export const DEFAULT_NS = 'common';
export const NAMESPACES = [
  'common', 'settings', 'navigation', 'auth', 'shows', 'movies', 'explore',
  'profile', 'notifications', 'import', 'stats', 'showDetail', 'episode',
  'comments', 'lists', 'social',
] as const;

i18n.use(initReactI18next).init({
  resources: {
    en: {
      common, settings, navigation, auth, shows, movies, explore,
      profile, notifications, import: importNs, stats, showDetail, episode,
      comments, lists, social,
    },
  },
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: DEFAULT_NS,
  ns: NAMESPACES,
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Resolve the active supported locale for a stored preference (uses device locales). */
export function detectResolvedLocale(pref: LanguagePreference): SupportedLocale {
  return resolveLocale(pref, Localization.getLocales?.().map((l: any) => l.languageTag ?? l.languageCode) ?? []);
}

/** Load a locale's namespace bundles and switch to it. Metro-compatible: each locale is a
 *  static require (not a dynamic import()) so the bundler can resolve it at build time.
 *  English is always bundled inline (fallback). Add a `case` + a `locales/<code>/index.ts`
 *  when shipping a new language — keys missing from that locale fall back to English. */
export async function loadLocale(locale: SupportedLocale): Promise<void> {
  if (locale !== 'en') {
    let bundles: { default?: Record<string, any> } | Record<string, any> | null = null;
    try {
      switch (locale) {
        case 'fr': bundles = require('../locales/fr'); break;
        case 'es': bundles = require('../locales/es'); break;
        case 'pt-BR': bundles = require('../locales/pt-BR'); break;
        case 'de': bundles = require('../locales/de'); break;
        case 'it': bundles = require('../locales/it'); break;
        case 'ar': bundles = require('../locales/ar'); break;
        case 'tr': bundles = require('../locales/tr'); break;
        case 'hi': bundles = require('../locales/hi'); break;
        case 'id': bundles = require('../locales/id'); break;
        case 'ja': bundles = require('../locales/ja'); break;
        case 'ko': bundles = require('../locales/ko'); break;
        case 'zh-CN': bundles = require('../locales/zh-CN'); break;
        default:
          break;
      }
    } catch {
      bundles = null;
    }
    if (bundles) {
      const mod = (bundles as any).default ?? bundles;
      for (const ns of NAMESPACES) {
        if (mod[ns] && !i18n.hasResourceBundle(locale, ns)) i18n.addResourceBundle(locale, ns, mod[ns], true, true);
      }
    }
  }
  await i18n.changeLanguage(locale);
}

export default i18n;
