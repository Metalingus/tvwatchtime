export function mediaAspectRatio(
  width?: number | null,
  height?: number | null,
): number | undefined {
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return undefined;
  const ratio = width / height;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

/** Bounded layout memory for recycled rows; no image bytes or comment content, never persisted. */
export function createMediaLayoutCache(limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid layout cache capacity');
  const sizes = new Map<string, { width: number; height: number }>();
  return {
    get(key: string) {
      const value = sizes.get(key);
      if (value) {
        sizes.delete(key);
        sizes.set(key, value);
      }
      return value;
    },
    set(key: string, width: number, height: number) {
      if (mediaAspectRatio(width, height) === undefined) return;
      sizes.delete(key);
      sizes.set(key, { width, height });
      while (sizes.size > limit) sizes.delete(sizes.keys().next().value!);
    },
  };
}
export const commentMediaLayouts = createMediaLayoutCache();

/** Viewability starts loading; leaving the viewport does not tear the media down. */
export function activateMediaKeys(previous: Set<string>, keys: string[]): Set<string> {
  const added = keys.filter((key) => !previous.has(key));
  return added.length ? new Set([...previous, ...added]) : previous;
}
