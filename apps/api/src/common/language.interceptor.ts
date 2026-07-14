import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { LanguagePreference, SupportedLocale } from '@tvwatch/shared';
import { resolveLocale, safeLangPref } from '@tvwatch/shared';
import { LanguageContext } from './language.context';

/**
 * Resolves the request language from the `Accept-Language` header and exposes
 * it to the request via {@link LanguageContext} (AsyncLocalStorage). Registered
 * globally so every route — including unauthenticated OptionalJwt metadata
 * routes — is localized. Defaults to English.
 *
 * The handler is subscribed INSIDE `language.run(...)` so the route handler
 * (and its awaited continuations, e.g. mappers reading the locale) execute
 * within the language context. Wrapping only `next.handle()` is not enough
 * because the handler runs lazily on subscription, outside the `run` call.
 */
@Injectable()
export class LanguageInterceptor implements NestInterceptor {
  constructor(private readonly language: LanguageContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req: any = context.switchToHttp().getRequest();
    const locale = this.resolve(req?.headers?.['accept-language']);
    return new Observable<unknown>((subscriber) => {
      this.language.run(locale, () => {
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => subscriber.error(e),
          complete: () => subscriber.complete(),
        });
      });
    });
  }

  /** Normalize an Accept-Language value to a supported locale, defaulting to English. */
  private resolve(header: string | undefined): SupportedLocale {
    if (!header) return 'en';
    // The mobile client sends its resolved locale (e.g. 'fr', 'pt-BR', 'zh-CN').
    // `safeLangPref` accepts supported codes and falls back to 'system'; for
    // 'system' we resolve against the header itself as the device-locale list.
    const pref = safeLangPref(header.split(',')[0].trim()) as LanguagePreference;
    if (pref !== 'system') return pref as SupportedLocale;
    return resolveLocale('system', header.split(',').map((p) => p.split(';')[0].trim()));
  }
}
