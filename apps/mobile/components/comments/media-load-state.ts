export const COMMENT_MEDIA_TIMEOUT_MS = 30_000;
export const COMMENT_MEDIA_AUTO_RETRIES = 2;

export interface MediaLoadState {
  phase: 'idle' | 'loading' | 'refreshing' | 'retrying' | 'loaded' | 'failed';
  attempt: number;
  automaticRetries: number;
  retryDelayMs: number;
}

export const initialMediaLoadState: MediaLoadState = {
  phase: 'idle',
  attempt: 0,
  automaticRetries: 0,
  retryDelayMs: 0,
};
export type MediaLoadEvent =
  | { type: 'start'; archive: boolean }
  | { type: 'retry'; archive: boolean }
  | { type: 'retry-ready'; archive: boolean; attempt: number }
  | { type: 'image-error' | 'timeout'; attempt: number }
  | { type: 'request-error'; attempt: number; retryable: boolean; retryAfterMs: number }
  | { type: 'loaded' | 'refresh-ready' | 'failed'; attempt: number };

export function mediaRequestRetry(error: unknown): { retryable: boolean; retryAfterMs: number } {
  const response = error as { status?: number; data?: { retryAfterSeconds?: number } } | null;
  const status = response?.status ?? 0;
  const seconds = response?.data?.retryAfterSeconds;
  return {
    retryable: status === 0 || [408, 425, 429].includes(status) || status >= 500,
    retryAfterMs:
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
  };
}

function recover(state: MediaLoadState, retryAfterMs = 0): MediaLoadState {
  if (state.automaticRetries >= COMMENT_MEDIA_AUTO_RETRIES) return { ...state, phase: 'failed' };
  return {
    phase: 'retrying',
    attempt: state.attempt + 1,
    automaticRetries: state.automaticRetries + 1,
    retryDelayMs: Math.max(1000 * 2 ** state.automaticRetries, retryAfterMs),
  };
}

/** Automatic and manual retries replace the renderer and request a fresh archive URL. */
export function mediaLoadReducer(state: MediaLoadState, event: MediaLoadEvent): MediaLoadState {
  if (event.type === 'start')
    return state.phase === 'idle'
      ? { ...state, phase: event.archive ? 'refreshing' : 'loading' }
      : state;
  if (event.type === 'retry')
    return state.phase === 'failed'
      ? {
          ...initialMediaLoadState,
          phase: event.archive ? 'refreshing' : 'loading',
          attempt: state.attempt + 1,
        }
      : state;
  if (event.attempt !== state.attempt) return state;
  if (event.type === 'retry-ready')
    return state.phase === 'retrying'
      ? { ...state, phase: event.archive ? 'refreshing' : 'loading' }
      : state;
  switch (event.type) {
    case 'image-error':
      return state.phase === 'loading' || state.phase === 'loaded' ? recover(state) : state;
    case 'request-error':
      return state.phase === 'refreshing'
        ? event.retryable
          ? recover(state, event.retryAfterMs)
          : { ...state, phase: 'failed' }
        : state;
    case 'refresh-ready':
      return state.phase === 'refreshing' ? { ...state, phase: 'loading' } : state;
    case 'loaded':
      return state.phase === 'loading' ? { ...state, phase: 'loaded' } : state;
    case 'failed':
      return state.phase === 'refreshing' || state.phase === 'loading'
        ? { ...state, phase: 'failed' }
        : state;
    case 'timeout':
      return state.phase === 'loading' || state.phase === 'refreshing' ? recover(state) : state;
  }
}
