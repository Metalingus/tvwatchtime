import { mediaAspectRatio, createMediaLayoutCache, activateMediaKeys } from './media-layout';
it('fits a wide GIF to its own dimensions instead of a square letterbox', () => {
  const ratio = mediaAspectRatio(640, 360)!;
  expect(ratio).toBeCloseTo(16 / 9);
  expect(656 / ratio).toBeCloseTo(369);
});
it('retains portrait and square image proportions', () => {
  expect(mediaAspectRatio(300, 600)).toBe(0.5);
  expect(mediaAspectRatio(400, 400)).toBe(1);
});
it.each([
  [0, 360],
  [640, 0],
  [NaN, 20],
  [10, Infinity],
  [-2, 20],
  [undefined, undefined],
])('ignores invalid dimensions', (w, h) => {
  expect(mediaAspectRatio(w, h)).toBeUndefined();
});

it('does not deactivate previously visible media as the viewport moves', () => {
  const first = activateMediaKeys(new Set(), ['gif-a']);
  const next = activateMediaKeys(first, ['gif-b']);
  expect([...next]).toEqual(['gif-a', 'gif-b']);
  expect(activateMediaKeys(next, [])).toBe(next);
  expect(activateMediaKeys(next, ['gif-a', 'gif-b'])).toBe(next);
});
it('remembers proportions across recycling without replacing them with invalid dimensions', () => {
  const cache = createMediaLayoutCache(2);
  cache.set('actor-a:comment', 840, 360);
  cache.set('actor-a:comment', 0, 0);
  expect(cache.get('actor-a:comment')).toEqual({ width: 840, height: 360 });
  expect(cache.get('actor-b:comment')).toBeUndefined();
});
it('bounds layout memory and keeps recently used sizes', () => {
  const cache = createMediaLayoutCache(2);
  cache.set('a', 840, 360);
  cache.set('b', 200, 400);
  cache.get('a');
  cache.set('c', 400, 400);
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toEqual({ width: 840, height: 360 });
});
it('rejects unsafe ratios and cache limits', () => {
  expect(mediaAspectRatio(1e308, 1e-308)).toBeUndefined();
  expect(() => createMediaLayoutCache(-1)).toThrow();
});
