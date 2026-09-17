import { lastValueFrom, Observable } from 'rxjs';
import { COMMSUNI_CLIENT_HEADER, COMMSUNI_CLIENT_VERSION } from '@tvwatch/shared';
import {
  ClientCapabilitiesInterceptor,
  isLegacyClientRequest,
  runWithCommsUniClient,
} from './client-capabilities';

function request(version?: string) {
  const context: any = {
    getType: () => 'http',
    switchToHttp: () => ({
      getResponse: () => ({ vary: jest.fn() }),
      getRequest: () => ({
        headers: version ? { [COMMSUNI_CLIENT_HEADER.toLowerCase()]: version } : {},
      }),
    }),
  };
  return lastValueFrom(
    new ClientCapabilitiesInterceptor().intercept(context, {
      handle: () =>
        new Observable((subscriber) => {
          Promise.resolve().then(() => {
            subscriber.next(isLegacyClientRequest());
            subscriber.complete();
          });
        }),
    }),
  );
}
it('treats an absent or unknown capability as legacy without rejecting the request', async () => {
  expect(await request()).toBe(true);
  expect(await request('unknown')).toBe(true);
  expect(await request(COMMSUNI_CLIENT_VERSION)).toBe(false);
});
it('keeps concurrent old/new requests isolated', async () => {
  expect(await Promise.all([request(), request(COMMSUNI_CLIENT_VERSION), request()])).toEqual([
    true,
    false,
    true,
  ]);
  expect(isLegacyClientRequest()).toBe(false);
});
it('allows an explicitly new endpoint to opt in without affecting its caller', async () => {
  await runWithCommsUniClient(false, async () => {
    expect(isLegacyClientRequest()).toBe(true);
    expect(await runWithCommsUniClient(true, async () => isLegacyClientRequest())).toBe(false);
    expect(isLegacyClientRequest()).toBe(true);
  });
});
