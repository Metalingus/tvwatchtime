jest.mock('../../api/commsuni-media', () => ({
  requestCommsUniMedia: (context: any, id: string, signal: AbortSignal) =>
    mockRequest('/conversations/comments/' + id + '/media', {
      query: { threadType: context.threadType, threadId: context.threadId },
      signal,
    }),
}));
import React from 'react';
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};
import { CommentMediaFrame, CommentMediaAsset, CommentMedia } from './CommentMedia';

let mockTheme: 'light' | 'dark' = 'light';
const mockImages: any[] = [];
const mockRequest = jest.fn();
jest.mock('react-native', () => jest.requireActual('react-native-web'));
jest.mock('expo-image', () => ({
  Image: (props: any) => {
    mockImages.push(props);
    return React.createElement('div', { 'data-expoimage': true });
  },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../api/commsuni', () => ({
  useCommsUniScope: () => ({ key: ['https://backend.example/api', 'user'], ready: true }),
}));
jest.mock('../../api/client', () => ({ request: (...args: unknown[]) => mockRequest(...args) }));
jest.mock('./MediaViewer', () => ({ MediaViewer: () => null }));
jest.mock('../../context/PreferencesProvider', () => ({
  useAppearance: () => ({ tokens: jest.requireActual('@tvwatch/shared').buildTokens(mockTheme) }),
}));
jest.mock('../primitives', () => ({
  T: ({ children, style }: any) =>
    React.createElement(jest.requireActual('react-native-web').Text, { style }, children),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const data = jest.requireActual('../../locales/en/comments.json');
      return data[key.replace('comments:', '')] ?? key;
    },
  }),
}));

it.each(['light', 'dark'] as const)(
  'removes the empty image wrapper and full-size reservation on failure in %s',
  (theme) => {
    mockTheme = theme;
    const html = renderToStaticMarkup(
      <CommentMediaFrame
        aspectRatio={16 / 9}
        failed
        loading={false}
        ready={false}
        onOpen={jest.fn()}
        onRetry={jest.fn()}
      >
        <div data-expoimage="true" style={{ width: '100%', height: '100%' }} />
      </CommentMediaFrame>,
    );
    expect(html).toContain('comment-media-unavailable');
    expect(html).toContain('Image unavailable');
    expect(html).toContain('Retry');
    expect(html).not.toContain('data-expoimage');
    expect(html).not.toContain('aspect-ratio');
    expect(html).not.toContain('comment-media-frame');
  },
);
it.each([true, false])(
  'preserves the image frame while loading=%s, with a visible loading indicator only when needed',
  (loading) => {
    const html = renderToStaticMarkup(
      <CommentMediaFrame
        aspectRatio={16 / 9}
        failed={false}
        loading={loading}
        ready={!loading}
        onOpen={jest.fn()}
        onRetry={jest.fn()}
      >
        <div data-expoimage="true" />
      </CommentMediaFrame>,
    );
    expect(html).toContain('comment-media-frame');
    expect(html).toContain('aspect-ratio');
    expect(html).toContain('data-expoimage');
    expect(html.includes('role="progressbar"')).toBe(loading);
    expect(html).not.toContain('comment-media-unavailable');
  },
);

const props = {
  media: { kind: 'archive' as const },
  mediaKey: 'scoped-comment',
  threadType: 'EPISODE' as const,
  threadId: 'episode',
  commentId: 'comment',
  visible: true,
  scopeReady: true,
};
const signedUrl = 'https://images.example.test/same-signed-url';
function draw(
  phase: 'idle' | 'loading' | 'refreshing' | 'retrying' | 'loaded' | 'failed',
  attempt = 0,
  grant: { attempt: number; url: string } | null = null,
  retryDelayMs = 1000,
) {
  const dispatch = jest.fn();
  const setGrant = jest.fn();
  const effects: (() => void | (() => void))[] = [];
  const reducer = jest
    .spyOn(React, 'useReducer')
    .mockImplementationOnce(
      () => [{ phase, attempt, automaticRetries: attempt, retryDelayMs }, dispatch] as any,
    );
  const state = jest
    .spyOn(React, 'useState')
    .mockImplementationOnce(() => [false, jest.fn()] as any)
    .mockImplementationOnce(() => [null, jest.fn()] as any)
    .mockImplementationOnce(() => [grant, setGrant] as any);
  const memo = jest.spyOn(React, 'useMemo').mockImplementation((factory) => factory());
  const effect = jest.spyOn(React, 'useEffect').mockImplementation((fn) => {
    effects.push(fn);
  });
  const tree = CommentMediaAsset(props);
  reducer.mockRestore();
  state.mockRestore();
  memo.mockRestore();
  effect.mockRestore();
  mockImages.length = 0;
  const html = renderToStaticMarkup(tree);
  return { html, image: mockImages[0], dispatch, setGrant, effects };
}
afterEach(() => {
  jest.useRealTimers();
  mockRequest.mockReset();
});

it('removes an errored renderer while retrying and uses a new renderer for the same URL', () => {
  const first = draw('loading', 0, { attempt: 0, url: signedUrl });
  expect(first.image.source).toEqual({ uri: signedUrl, cacheKey: 'scoped-comment' });
  first.image.onError();
  expect(first.dispatch).toHaveBeenCalledWith({ type: 'image-error', attempt: 0 });
  const recovering = draw('retrying', 1, { attempt: 0, url: signedUrl });
  expect(recovering.image).toBeUndefined();
  expect(recovering.html).toContain('role="progressbar"');
  expect(recovering.html).not.toContain('Image unavailable');
  const retry = draw('loading', 1, { attempt: 1, url: signedUrl });
  expect(retry.image.source).toEqual(first.image.source);
  expect(retry.image.recyclingKey).not.toBe(first.image.recyclingKey);
});

it('gets a fresh signed URL per attempt and never renders a previous attempt URL', async () => {
  mockRequest.mockResolvedValue({ url: signedUrl });
  const first = draw('refreshing');
  const cancelFirst = first.effects[1]();
  await Promise.resolve();
  expect(first.setGrant).toHaveBeenCalledWith({ attempt: 0, url: signedUrl });
  expect(first.dispatch).toHaveBeenCalledWith({ type: 'refresh-ready', attempt: 0 });
  if (typeof cancelFirst === 'function') cancelFirst();
  const second = draw('refreshing', 1, { attempt: 0, url: signedUrl });
  const cancelSecond = second.effects[1]();
  await Promise.resolve();
  expect(second.image).toBeUndefined();
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(second.setGrant).toHaveBeenCalledWith({ attempt: 1, url: signedUrl });
  if (typeof cancelSecond === 'function') cancelSecond();
});

it('turns a transient link error into bounded recovery with the provider retry delay', async () => {
  mockRequest.mockRejectedValue({ status: 429, data: { retryAfterSeconds: 8 } });
  const current = draw('refreshing');
  const cleanup = current.effects[1]();
  await Promise.resolve();
  expect(current.dispatch).toHaveBeenCalledWith({
    type: 'request-error',
    attempt: 0,
    retryable: true,
    retryAfterMs: 8000,
  });
  if (typeof cleanup === 'function') cleanup();
});

it('waits through the retry delay and shows loading instead of unavailable', () => {
  jest.useFakeTimers();
  const current = draw('retrying', 1, null, 8000);
  const cleanup = current.effects[2]();
  jest.advanceTimersByTime(7999);
  expect(current.dispatch).not.toHaveBeenCalled();
  expect(current.html).toContain('role="progressbar"');
  jest.advanceTimersByTime(251);
  expect(current.dispatch).toHaveBeenCalledWith({ type: 'retry-ready', attempt: 1, archive: true });
  if (typeof cleanup === 'function') cleanup();
});

it('aborts a discarded grant request and ignores its late response', async () => {
  let finish!: (data: { url: string }) => void;
  mockRequest.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const current = draw('refreshing');
  const cleanup = current.effects[1]();
  const signal = mockRequest.mock.calls[0][1].signal as AbortSignal;
  if (typeof cleanup === 'function') cleanup();
  expect(signal.aborted).toBe(true);
  finish({ url: signedUrl });
  await Promise.resolve();
  expect(current.setGrant).not.toHaveBeenCalled();
  expect(current.dispatch).not.toHaveBeenCalled();
});

it('keeps definitive missing media compact and does not display a stale URL', async () => {
  mockRequest.mockResolvedValue({ url: null });
  const current = draw('refreshing', 1, { attempt: 0, url: signedUrl });
  const cleanup = current.effects[1]();
  await Promise.resolve();
  expect(current.dispatch).toHaveBeenCalledWith({ type: 'failed', attempt: 1 });
  expect(current.setGrant).not.toHaveBeenCalled();
  const failed = draw('failed', 1);
  expect(failed.html).toContain('Image unavailable');
  expect(failed.html).not.toContain('comment-media-frame');
  if (typeof cleanup === 'function') cleanup();
});

it('uses the selected backend for local images and the same renderer as provider media', () => {
  const tree = CommentMedia({
    image: { id: 'local-image', status: 'ready', width: 400, height: 200 },
  }) as React.ReactElement<any>;
  expect(tree.type).toBe(CommentMediaAsset);
  expect(tree.props.media).toMatchObject({
    kind: 'external',
    url: 'https://backend.example/api/comment-images/local-image',
    width: 400,
    height: 200,
  });
  expect(tree.props.mediaKey).toContain('https://backend.example/api');
  expect(mockRequest).not.toHaveBeenCalled();
});
it('keeps archive media on the grant path with its exact conversation context', () => {
  const tree = CommentMedia({
    shared: {
      threadType: 'EPISODE',
      threadId: 'episode',
      comment: { id: 'remote', media: { kind: 'archive' } } as any,
    },
  }) as React.ReactElement<any>;
  expect(tree.type).toBe(CommentMediaAsset);
  expect(tree.props).toMatchObject({
    commentId: 'remote',
    threadId: 'episode',
    threadType: 'EPISODE',
    media: { kind: 'archive' },
  });
});
it('renders neither an image nor a grant request for rejected local media', () => {
  expect(CommentMedia({ image: { id: 'rejected', status: 'rejected' } })).toBeNull();
  expect(mockRequest).not.toHaveBeenCalled();
});
