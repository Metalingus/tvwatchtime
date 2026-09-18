import { PrismaService } from './prisma/prisma.service';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Observable, Subscription } from 'rxjs';
import type { LanguagePreference, SupportedLocale } from '@tvwatch/shared';
import { resolveLocale, safeLangPref } from '@tvwatch/shared';
import { TIME_ZONE_HEADER, validTimeZone } from '@tvwatch/shared';
import { runInTimeZone } from './timezone.context';
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
  constructor(
    private readonly language: LanguageContext,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req: any = context.switchToHttp().getRequest();
    const locale = this.resolve(req?.headers?.['accept-language']);
    context.switchToHttp().getResponse()?.vary?.(TIME_ZONE_HEADER);
    return new Observable<unknown>((subscriber) => {
      let canceled = false;
      let inner: Subscription | undefined;
      void this.resolveTimeZone(req)
        .then((zone) => {
          if (canceled) return;
          runInTimeZone(zone, () =>
            this.language.run(locale, () => {
              inner = next.handle().subscribe(subscriber);
            }),
          );
        })
        .catch((error) => subscriber.error(error));
      return () => {
        canceled = true;
        inner?.unsubscribe();
      };
    });
  }

  private async resolveTimeZone(req: any): Promise<string> {
    const header = req?.headers?.[TIME_ZONE_HEADER.toLowerCase()];
    if (header !== undefined) return validTimeZone(header);
    // Older clients already registered their device timezone for notifications.
    const userId = req?.user?.id;
    if (!userId || !this.prisma) return 'UTC';
    const device = await this.prisma.device.findFirst({
      where: { userId, active: true, timezone: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { timezone: true },
    });
    if (device?.timezone) return validTimeZone(device.timezone);
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId },
      select: { timezone: true },
    });
    return validTimeZone(preference?.timezone);
  }

  /** Normalize an Accept-Language value to a supported locale, defaulting to English. */
  private resolve(header: string | undefined): SupportedLocale {
    if (!header) return 'en';
    // The mobile client sends its resolved locale (e.g. 'fr', 'pt-BR', 'zh-CN').
    // `safeLangPref` accepts supported codes and falls back to 'system'; for
    // 'system' we resolve against the header itself as the device-locale list.
    const pref = safeLangPref(header.split(',')[0].trim()) as LanguagePreference;
    if (pref !== 'system') return pref as SupportedLocale;
    return resolveLocale(
      'system',
      header.split(',').map((p) => p.split(';')[0].trim()),
    );
  }
}
