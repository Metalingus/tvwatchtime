import {
  initialMediaLoadState,
  mediaLoadReducer,
  mediaRequestRetry,
  COMMENT_MEDIA_AUTO_RETRIES,
} from './media-load-state';

const start = (archive = true) =>
  mediaLoadReducer(initialMediaLoadState, { type: 'start', archive });
const ready = () => mediaLoadReducer(start(), { type: 'refresh-ready', attempt: 0 });
it('requests a fresh grant before rendering an archived image', () => {
  expect(start().phase).toBe('refreshing');
  expect(ready().phase).toBe('loading');
  expect(start(false).phase).toBe('loading');
});
it.each([true, false])(
  'recovers an image download failure automatically (archive=%s)',
  (archive) => {
    const loading = archive ? ready() : start(false);
    const retry = mediaLoadReducer(loading, { type: 'image-error', attempt: 0 });
    expect(retry).toMatchObject({
      phase: 'retrying',
      attempt: 1,
      automaticRetries: 1,
      retryDelayMs: 1000,
    });
    const next = mediaLoadReducer(retry, { type: 'retry-ready', archive, attempt: 1 });
    expect(next.phase).toBe(archive ? 'refreshing' : 'loading');
  },
);
it('retries temporary grant failures and respects the provider delay', () => {
  const retry = mediaLoadReducer(start(), {
    type: 'request-error',
    attempt: 0,
    retryable: true,
    retryAfterMs: 10000,
  });
  expect(retry).toMatchObject({ phase: 'retrying', retryDelayMs: 10000 });
});
it('stops bounded automatic retries instead of polling forever', () => {
  let state = start(false);
  for (let i = 0; i < COMMENT_MEDIA_AUTO_RETRIES; i++) {
    state = mediaLoadReducer(state, { type: 'image-error', attempt: state.attempt });
    expect(state.phase).toBe('retrying');
    state = mediaLoadReducer(state, {
      type: 'retry-ready',
      archive: false,
      attempt: state.attempt,
    });
  }
  state = mediaLoadReducer(state, { type: 'image-error', attempt: state.attempt });
  expect(state.phase).toBe('failed');
  expect(state.attempt).toBe(2);
});
it('keeps a failed row failed when visibility changes; manual Retry starts a new bounded attempt', () => {
  const failed = mediaLoadReducer(start(), { type: 'failed', attempt: 0 });
  expect(mediaLoadReducer(failed, { type: 'start', archive: true })).toBe(failed);
  expect(mediaLoadReducer(failed, { type: 'retry', archive: true })).toMatchObject({
    phase: 'refreshing',
    attempt: 1,
    automaticRetries: 0,
  });
});
it('retries timeouts without accepting old grant or image callbacks', () => {
  const retry = mediaLoadReducer(start(), { type: 'timeout', attempt: 0 });
  expect(retry.phase).toBe('retrying');
  for (const type of ['loaded', 'refresh-ready', 'image-error', 'failed', 'timeout'] as const)
    expect(mediaLoadReducer(retry, { type, attempt: 0 })).toBe(retry);
});
it('ignores stale retry timers', () => {
  const retry = mediaLoadReducer(start(false), { type: 'image-error', attempt: 0 });
  expect(mediaLoadReducer(retry, { type: 'retry-ready', attempt: 0, archive: false })).toBe(retry);
});
it('does not turn a loaded image into a failure because of a late timer or grant error', () => {
  const loaded = mediaLoadReducer(ready(), { type: 'loaded', attempt: 0 });
  expect(mediaLoadReducer(loaded, { type: 'timeout', attempt: 0 })).toBe(loaded);
  expect(
    mediaLoadReducer(loaded, {
      type: 'request-error',
      attempt: 0,
      retryable: true,
      retryAfterMs: 0,
    }),
  ).toBe(loaded);
  expect(mediaLoadReducer(loaded, { type: 'start', archive: true })).toBe(loaded);
});
it('does not retry definitive missing media or access errors', () => {
  expect(mediaLoadReducer(start(), { type: 'failed', attempt: 0 }).phase).toBe('failed');
  expect(
    mediaLoadReducer(start(), {
      type: 'request-error',
      attempt: 0,
      retryable: false,
      retryAfterMs: 0,
    }).phase,
  ).toBe('failed');
});
it.each([0, 408, 425, 429, 500, 502, 503])(
  'automatically recovers transient status %s',
  (status) => {
    expect(mediaRequestRetry({ status, data: { retryAfterSeconds: 8 } })).toEqual({
      retryable: true,
      retryAfterMs: 8000,
    });
  },
);
it.each([400, 401, 403, 404, 409])('does not repeat terminal status %s', (status) => {
  expect(mediaRequestRetry({ status }).retryable).toBe(false);
});
it('recovers a browser network exception without an HTTP response', () => {
  expect(mediaRequestRetry(new TypeError('Failed to fetch'))).toEqual({
    retryable: true,
    retryAfterMs: 0,
  });
});
