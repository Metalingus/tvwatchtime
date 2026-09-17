import { COMMSUNI_CLIENT_HEADER, COMMSUNI_CLIENT_VERSION } from '@tvwatch/shared';
import { request } from './client';

jest.mock('expo-constants', () => ({ expoConfig: { extra: {} } }));
jest.mock('./storage', () => ({
  tokenStorage: {
    getApiUrl: jest.fn(async () => 'https://api.example.test/api'),
    getAccess: jest.fn(async () => 'test-access-token'),
  },
}));
const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
});
it('advertises CommsUni support on normal authenticated requests', async () => {
  const fetchMock = jest.fn(async () => new Response(JSON.stringify({ id: 'comment' })));
  globalThis.fetch = fetchMock as any;
  await request('/comments', { method: 'POST', body: { body: 'text' } });
  expect((fetchMock.mock.calls as any)[0][1].headers).toMatchObject({
    [COMMSUNI_CLIENT_HEADER]: COMMSUNI_CLIENT_VERSION,
    Authorization: 'Bearer test-access-token',
  });
});
it('advertises the same capability on the multipart upload path', async () => {
  let instance: any;
  class Xhr {
    status = 201;
    response = { commentImageId: 'image' };
    onload?: () => void;
    open = jest.fn();
    setRequestHeader = jest.fn();
    constructor() {
      instance = this;
    }
    send() {
      this.onload?.();
    }
  }
  globalThis.XMLHttpRequest = Xhr as any;
  await expect(
    request('/comments/comment/image', { method: 'POST', body: new FormData() }),
  ).resolves.toEqual({ commentImageId: 'image' });
  expect(instance.setRequestHeader).toHaveBeenCalledWith(
    COMMSUNI_CLIENT_HEADER,
    COMMSUNI_CLIENT_VERSION,
  );
  expect(instance.setRequestHeader).not.toHaveBeenCalledWith('Content-Type', expect.anything());
});
