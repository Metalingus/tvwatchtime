import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import type { SupportedLocale } from '@tvwatch/shared';

interface LanguageStore {
  locale: SupportedLocale;
}

// Module-level singleton store shared by the DI LanguageContext (set by the
// global interceptor) and the standalone currentLanguage() accessor used by
// plain-function mappers/providers.
const languageAls = new AsyncLocalStorage<LanguageStore>();

/** The active request locale, defaulting to English (outside a request). */
export function currentLanguage(): SupportedLocale {
  return languageAls.getStore()?.locale ?? 'en';
}

/**
 * DI wrapper around the request-scoped language AsyncLocalStorage. A global
 * {@link LanguageInterceptor} resolves the request's language from the
 * `Accept-Language` header and runs the handler inside {@link run}. Mappers,
 * providers and services read the active locale via {@link currentLanguage}
 * without threading a `lang` parameter through every call site.
 */
@Injectable()
export class LanguageContext {
  /** Run `fn` with `locale` as the active language; returns fn's result. */
  run<T>(locale: SupportedLocale, fn: () => T): T {
    return languageAls.run({ locale }, fn);
  }

  /** The active request locale, defaulting to English. */
  get current(): SupportedLocale {
    return currentLanguage();
  }
}
