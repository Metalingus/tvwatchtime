import { defer, firstValueFrom, of } from 'rxjs';
import { LanguageInterceptor } from './language.interceptor';
import { LanguageContext, currentLanguage } from './language.context';
import { currentTimeZone } from './timezone.context';

const context = (headers: Record<string, string>, user?: { id: string }) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers, user }),
      getResponse: () => ({ vary: jest.fn() }),
    }),
  }) as any;
const handler = {
  handle: () => defer(() => of({ zone: currentTimeZone(), language: currentLanguage() })),
};

it('isolates language and device timezone for simultaneous requests', async () => {
  const interceptor = new LanguageInterceptor(new LanguageContext());
  const results = await Promise.all([
    firstValueFrom(
      interceptor.intercept(
        context({ 'accept-language': 'fr', 'x-tvwatch-timezone': 'America/Los_Angeles' }),
        handler,
      ),
    ),
    firstValueFrom(
      interceptor.intercept(
        context({ 'accept-language': 'en', 'x-tvwatch-timezone': 'Asia/Tokyo' }),
        handler,
      ),
    ),
  ]);
  expect(results).toEqual([
    { zone: 'America/Los_Angeles', language: 'fr' },
    { zone: 'Asia/Tokyo', language: 'en' },
  ]);
});
it('uses a registered timezone for existing clients without the new header', async () => {
  const prisma: any = {
    device: { findFirst: jest.fn(async () => ({ timezone: 'America/New_York' })) },
    notificationPreference: { findUnique: jest.fn() },
  };
  const interceptor = new LanguageInterceptor(new LanguageContext(), prisma);
  expect(await firstValueFrom(interceptor.intercept(context({}, { id: 'user' }), handler))).toEqual(
    { zone: 'America/New_York', language: 'en' },
  );
  expect(prisma.notificationPreference.findUnique).not.toHaveBeenCalled();
});
it('falls back to UTC for malformed timezone headers', async () => {
  const interceptor = new LanguageInterceptor(new LanguageContext());
  expect(
    await firstValueFrom(
      interceptor.intercept(context({ 'x-tvwatch-timezone': 'invalid/zone' }), handler),
    ),
  ).toEqual({ zone: 'UTC', language: 'en' });
});
