import { deviceTimeZone, TIME_ZONE_HEADER } from '@tvwatch/shared';
import Constants from 'expo-constants';
import type { ApiError, SupportedLocale } from '@tvwatch/shared';
import { COMMSUNI_CLIENT_HEADER, COMMSUNI_CLIENT_VERSION } from '@tvwatch/shared';
import { tokenStorage } from './storage';
import { accessTokenNeedsRefresh, isTerminalRefreshStatus } from './auth-token';

const DEFAULT_BASE_URL: string =
  (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';

/** Canonical fallback base URL — reused by the widget credential sync so the
 *  resolution chain lives in exactly one place. */
export const API_DEFAULT_BASE_URL = DEFAULT_BASE_URL;

// Cached runtime URL (updated when self-hosted URL changes)
let runtimeBaseUrl: string | null = null;

// Active app locale, sent as Accept-Language so the API returns localized media
// metadata (titles/overviews/images). Defaults to English; updated by the
// PreferencesProvider whenever the resolved locale changes.
let currentLocale: SupportedLocale = 'en';

/** Set the locale used for all subsequent API requests (Accept-Language header). */
export function setApiLocale(locale: SupportedLocale) {
  currentLocale = locale;
}

export async function getBaseUrl(): Promise<string> {
  if (runtimeBaseUrl) return runtimeBaseUrl;
  const stored = await tokenStorage.getApiUrl();
  const resolved = stored || DEFAULT_BASE_URL;
  runtimeBaseUrl = resolved;
  return resolved;
}

export async function setBaseUrl(url: string) {
  let normalized = url.replace(/\/+$/, '');
  if (!normalized.endsWith('/api')) normalized += '/api';
  runtimeBaseUrl = normalized;
  await tokenStorage.setApiUrl(normalized);
}

export async function resetBaseUrl() {
  runtimeBaseUrl = null;
  await tokenStorage.clearBackend();
}

export const PUBLIC_API_URL =
  (Constants.expoConfig?.extra as any)?.publicApiUrl || 'https://api.tvwatchtime.org/api';

export const SITE_URL = (Constants.expoConfig?.extra as any)?.siteUrl || 'https://tvwatchtime.org';

type Json = Record<string, unknown> | unknown[];

export class HttpError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export type RefreshOutcome =
  | { status: 'valid' }
  | { status: 'refreshed' }
  | { status: 'missing' }
  | { status: 'invalid'; error: HttpError }
  | { status: 'transient'; error: HttpError };

let sessionExpiredHandler: (() => void | Promise<void>) | null = null;

export function setSessionExpiredHandler(handler: (() => void | Promise<void>) | null) {
  sessionExpiredHandler = handler;
}

async function expireLocalSession() {
  await tokenStorage.clear();
  await sessionExpiredHandler?.();
}

let refreshing: Promise<RefreshOutcome> | null = null;

export async function refreshTokens(): Promise<RefreshOutcome> {
  if (refreshing) return refreshing;
  const work = (async (): Promise<RefreshOutcome> => {
    const refresh = await tokenStorage.getRefresh();
    if (!refresh) return { status: 'missing' };
    try {
      const res = await fetch(`${await getBaseUrl()}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) {
        let data: any = null;
        try {
          data = await res.json();
        } catch {
          // The status still tells us whether this is terminal or transient.
        }
        const error = new HttpError(res.status, data?.message || 'Session refresh failed', data);
        if (isTerminalRefreshStatus(res.status)) {
          await expireLocalSession();
          return { status: 'invalid', error };
        }
        return { status: 'transient', error };
      }
      const data = await res.json();
      if (!data?.accessToken || !data?.refreshToken) {
        return {
          status: 'transient',
          error: new HttpError(0, 'Session refresh returned an invalid response', data),
        };
      }
      await tokenStorage.set(data.accessToken, data.refreshToken);
      await tokenStorage.setUser(data.user);
      return { status: 'refreshed' };
    } catch (error) {
      return {
        status: 'transient',
        error:
          error instanceof HttpError
            ? error
            : new HttpError(0, 'Session refresh temporarily unavailable', null),
      };
    }
  })();
  refreshing = work.finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function ensureFreshAccessToken(): Promise<RefreshOutcome> {
  const [access, refresh] = await Promise.all([
    tokenStorage.getAccess(),
    tokenStorage.getRefresh(),
  ]);
  if (!accessTokenNeedsRefresh(access)) return { status: 'valid' };
  if (!refresh) return { status: 'missing' };
  return refreshTokens();
}

async function retryAfterUnauthorized(): Promise<void> {
  const outcome = await refreshTokens();
  if (outcome.status === 'refreshed') return;
  if (outcome.status === 'transient') throw outcome.error;
  if (outcome.status === 'invalid') throw outcome.error;
  throw new HttpError(401, 'Session expired', null);
}

/** Upload FormData using XMLHttpRequest — works on both native and web. */
function uploadViaXhr(url: string, headers: Record<string, string>, body: FormData): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.responseType = 'json';
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.status === 204 ? undefined : xhr.response);
      } else {
        reject(new HttpError(xhr.status, xhr.response?.message || 'Upload error', xhr.response));
      }
    };
    xhr.onerror = () => reject(new HttpError(0, 'Network error', null));
    xhr.send(body);
  });
}

export async function request<T>(
  path: string,
  opts: {
    method?: string;
    body?: Json | FormData;
    query?: Record<string, unknown>;
    auth?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const { method = 'GET', body, query, auth = true, signal } = opts;
  const BASE_URL = await getBaseUrl();
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    'Accept-Language': currentLocale,
    [TIME_ZONE_HEADER]: deviceTimeZone(),
    [COMMSUNI_CLIENT_HEADER]: COMMSUNI_CLIENT_VERSION,
  };
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';

  if (auth) {
    const access = await tokenStorage.getAccess();
    if (access) headers.Authorization = `Bearer ${access}`;
  }

  // FormData: use XMLHttpRequest (native fetch polyfill breaks with { uri, name, type })
  if (body instanceof FormData) {
    try {
      return (await uploadViaXhr(url.toString(), headers, body)) as T;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401 && auth) {
        await retryAfterUnauthorized();
        const access = await tokenStorage.getAccess();
        if (access) headers.Authorization = `Bearer ${access}`;
        try {
          return (await uploadViaXhr(url.toString(), headers, body)) as T;
        } catch (retryError) {
          if (retryError instanceof HttpError && retryError.status === 401) {
            await expireLocalSession();
          }
          throw retryError;
        }
      }
      throw e;
    }
  }

  const doFetch = () =>
    fetch(url.toString(), {
      method,
      headers,
      ...(signal ? { signal } : {}),
      body: body ? JSON.stringify(body) : undefined,
      // React Query is the cache for authenticated GETs. Browser caching can
      // otherwise revive an old offset page after the library order changes.
      cache: auth && method === 'GET' ? 'no-store' : 'default',
    });

  let res = await doFetch();
  if (res.status === 401 && auth) {
    await retryAfterUnauthorized();
    const access = await tokenStorage.getAccess();
    if (access) headers.Authorization = `Bearer ${access}`;
    res = await doFetch();
    if (res.status === 401) await expireLocalSession();
  }

  if (!res.ok) {
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    throw new HttpError(res.status, data?.message || res.statusText, data);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>) => request<T>(path, { query }),
  post: <T>(path: string, body?: Json | FormData) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: Json) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: Json) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  raw: DEFAULT_BASE_URL,
};

export type { ApiError };
