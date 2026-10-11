/**
 * Which remote URI an image should load given the URI that last failed. The fallback is
 * used only when the current primary is the one that failed, so a recycled cell with a
 * new primary retries it first. `canFallback` is false once there is nothing left to try
 * (no fallback, same URI, or already on the fallback) so an error never loops.
 */
export function resolveImageFallback(
  uri: string | null | undefined,
  fallbackUri: string | null | undefined,
  failedUri: string | null,
): { uri: string | null; canFallback: boolean } {
  if (!uri) return { uri: null, canFallback: false };
  if (fallbackUri && uri === failedUri) return { uri: fallbackUri, canFallback: false };
  return { uri, canFallback: !!fallbackUri && fallbackUri !== uri };
}
