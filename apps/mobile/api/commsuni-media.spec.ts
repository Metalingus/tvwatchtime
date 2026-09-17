import { CommsUniMediaBatcher } from './commsuni-media';
jest.mock('./client', () => ({ request: jest.fn() }));
const context = { scope: 'backend:user', threadType: 'MOVIE' as const, threadId: 'movie' };
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('batches visible images at 16 and coalesces duplicate IDs without caching signed URLs', async () => {
  const load = jest.fn(async (_context, ids: string[]) => ({
    grants: ids.map((commentId) => ({ commentId, url: 'https://media.test/' + commentId })),
  }));
  const batch = new CommsUniMediaBatcher(load);
  const requests = Array.from({ length: 18 }, (_, i) =>
    batch.get(context, String(i), new AbortController().signal),
  );
  requests.push(batch.get(context, '17', new AbortController().signal));
  jest.advanceTimersByTime(11);
  expect(await Promise.all(requests)).toHaveLength(19);
  expect(load).toHaveBeenCalledTimes(2);
  expect(load.mock.calls.every(([, ids]) => ids.length <= 16)).toBe(true);
  const again = batch.get(context, '0', new AbortController().signal);
  jest.advanceTimersByTime(11);
  await again;
  expect(load).toHaveBeenCalledTimes(3);
});
it('removes an abandoned attachment without aborting the other visible image', async () => {
  const load = jest.fn(async (_context, ids: string[]) => ({
    grants: ids.map((commentId) => ({ commentId, url: null })),
  }));
  const batch = new CommsUniMediaBatcher(load);
  const controller = new AbortController();
  const abandoned = batch.get(context, 'gone', controller.signal);
  const rejection = expect(abandoned).rejects.toThrow('canceled');
  const visible = batch.get(context, 'visible', new AbortController().signal);
  controller.abort();
  jest.advanceTimersByTime(11);
  await rejection;
  await visible;
  expect(load.mock.calls[0][1]).toEqual(['visible']);
});
it('does not reuse an aborted batch for a newly visible attachment', async () => {
  const load = jest.fn(async (_context, ids: string[], signal: AbortSignal) => {
    expect(signal.aborted).toBe(false);
    return { grants: ids.map((commentId) => ({ commentId, url: null })) };
  });
  const batch = new CommsUniMediaBatcher(load);
  const controller = new AbortController();
  const abandoned = batch.get(context, 'gone', controller.signal);
  const rejection = expect(abandoned).rejects.toThrow('canceled');
  controller.abort();
  const replacement = batch.get(context, 'replacement', new AbortController().signal);
  jest.advanceTimersByTime(11);
  await rejection;
  await replacement;
  expect(load).toHaveBeenCalledTimes(1);
});
