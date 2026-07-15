/**
 * Normalized provider errors. Provider-specific HTTP failures are mapped to a
 * small set of categories so import/search/matching code never has to pattern-match
 * raw status codes or library exceptions.
 *
 * Throttling (an internal fixed-window limit being reached) is NOT represented here —
 * see ProviderRateLimiter, which returns a retry delay instead of throwing.
 */
export type ProviderErrorCategory =
  | 'not_found' // 404 (negative-cacheable)
  | 'auth' // 401 — caller may re-auth then retry once (TVDB token)
  | 'rate_limited' // real provider 429 (distinct from internal throttling)
  | 'timeout' // AbortController timeout
  | 'upstream' // 5xx (retryable)
  | 'client' // non-retriable 4xx (400/403/409…) — our request is invalid, do not retry
  | 'network' // fetch threw (DNS/connection/reset)
  | 'circuit_open'; // breaker open for this provider

export class ProviderError extends Error {
  constructor(
    public readonly category: ProviderErrorCategory,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Whether the gateway may automatically retry this error. */
  get retryable(): boolean {
    return (
      this.category === 'rate_limited' ||
      this.category === 'upstream' ||
      this.category === 'network' ||
      this.category === 'timeout'
    );
  }

  get notFound(): boolean {
    return this.category === 'not_found';
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;
