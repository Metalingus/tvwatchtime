import Constants from 'expo-constants';
import type { ApiError } from '@tvwatch/shared';
import { tokenStorage } from './storage';

const DEFAULT_BASE_URL =
  (Constants.expoConfig?.extra as any)?.apiBaseUrl ||
  'http://localhost:4000/api';

// Cached runtime URL (updated when self-hosted URL changes)
let runtimeBaseUrl: string | null = null;

export async function getBaseUrl(): Promise<string> {
  if (runtimeBaseUrl) return runtimeBaseUrl;
  const stored = await tokenStorage.getApiUrl();
  runtimeBaseUrl = stored || DEFAULT_BASE_URL;
  return runtimeBaseUrl;
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
  (Constants.expoConfig?.extra as any)?.publicApiUrl ||
  'https://api.tvwatchtime.org/api';

export const SITE_URL =
  (Constants.expoConfig?.extra as any)?.siteUrl ||
  'https://tvwatchtime.org';

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

let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = await tokenStorage.getRefresh();
    if (!refresh) return false;
    try {
      const res = await fetch(`${await getBaseUrl()}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      await tokenStorage.set(data.accessToken, data.refreshToken);
      await tokenStorage.setUser(data.user);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
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
  opts: { method?: string; body?: Json | FormData; query?: Record<string, unknown>; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, query, auth = true } = opts;
  const BASE_URL = await getBaseUrl();
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {};
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';

  if (auth) {
    const access = await tokenStorage.getAccess();
    if (access) headers.Authorization = `Bearer ${access}`;
  }

  // FormData: use XMLHttpRequest (native fetch polyfill breaks with { uri, name, type })
  if (body instanceof FormData) {
    try {
      return await uploadViaXhr(url.toString(), headers, body) as T;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401 && auth) {
        const ok = await refreshTokens();
        if (ok) {
          const access = await tokenStorage.getAccess();
          if (access) headers.Authorization = `Bearer ${access}`;
          return await uploadViaXhr(url.toString(), headers, body) as T;
        }
      }
      throw e;
    }
  }

  const doFetch = () =>
    fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch();
  if (res.status === 401 && auth) {
    const ok = await refreshTokens();
    if (ok) {
      const access = await tokenStorage.getAccess();
      if (access) headers.Authorization = `Bearer ${access}`;
      res = await doFetch();
    }
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
  patch: <T>(path: string, body?: Json) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  raw: DEFAULT_BASE_URL,
};

export type { ApiError };
