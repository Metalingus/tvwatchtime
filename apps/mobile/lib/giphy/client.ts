import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Narrow local model for a GIPHY result. Only the fields the UI needs.
 * Analytics URLs are never persisted to our database.
 */
export interface GiphyGif {
  id: string;
  title: string;
  previewUrl: string;
  gifUrl: string;
  width?: number;
  height?: number;
  analytics?: {
    onload?: string;
    onclick?: string;
    onsent?: string;
  };
}

/** Frontend-only state for a chosen GIF. Only `gifUrl` is sent to the API. */
export interface SelectedGif {
  id: string;
  title: string;
  previewUrl: string;
  gifUrl: string;
  width?: number;
  height?: number;
  analyticsOnSentUrl?: string;
}

export type GiphyErrorKind =
  | 'config'
  | 'invalid-key'
  | 'rate-limit'
  | 'network';

export class GiphyError extends Error {
  kind: GiphyErrorKind;
  constructor(kind: GiphyErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'GiphyError';
  }
}

const PAGE_LIMIT = 25;
const MAX_QUERY_LENGTH = 50;
const BASE = 'https://api.giphy.com/v1/gifs';

/**
 * Selects the correct GIPHY API key for the running platform. Keys live in
 * `app.json` under `expo.extra` (`giphyApiKeyAndroid|Ios|Web`) and are read via
 * expo-constants — the same pattern used for apiBaseUrl / googleClientId.
 * Returns null when unconfigured, so the picker shows a config error.
 */
export function selectGiphyApiKey(): string | null {
  const extra = (Constants.expoConfig?.extra as Record<string, string | undefined> | undefined) ?? {};
  if (Platform.OS === 'android') {
    return extra.giphyApiKeyAndroid || null;
  }
  if (Platform.OS === 'ios') {
    return extra.giphyApiKeyIos || null;
  }
  if (Platform.OS === 'web') {
    return extra.giphyApiKeyWeb || null;
  }
  return null;
}

function renditionUrl(...candidates: (string | undefined | null)[]): string | undefined {
  for (const c of candidates) {
    if (c && typeof c === 'string') return c;
  }
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseInt(v, 10) : (v as number);
  return Number.isFinite(n as number) ? (n as number) : undefined;
}

interface RawGif {
  id?: string;
  title?: string;
  images?: Record<string, any>;
  analytics?: Record<string, { url?: string } | undefined>;
}

/** Map a raw GIPHY item to the narrow UI model. */
export function buildGiphyGif(raw: RawGif): GiphyGif | null {
  const id = raw.id;
  if (!id) return null;
  const images = raw.images || {};

  // Picker grid preview: fixed_width webp -> fixed_width url -> fixed_height url
  const previewUrl = renditionUrl(
    images.fixed_width?.webp,
    images.fixed_width?.url,
    images.fixed_height?.url,
  );
  // Stored/posted gif: downsized_medium -> downsized -> original
  const gifUrl = renditionUrl(
    images.downsized_medium?.url,
    images.downsized?.url,
    images.original?.url,
  );
  if (!previewUrl || !gifUrl) return null;

  const dimSource = images.fixed_width || images.downsized_medium || images.original || {};
  const analytics = raw.analytics;
  return {
    id,
    title: raw.title ?? '',
    previewUrl,
    gifUrl,
    width: num(dimSource.width),
    height: num(dimSource.height),
    analytics: analytics
      ? {
          onload: analytics.onload?.url,
          onclick: analytics.onclick?.url,
          onsent: analytics.onsent?.url,
        }
      : undefined,
  };
}

export interface GiphyPage {
  items: GiphyGif[];
  totalCount: number;
}

function buildParams(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

async function fetchPage(endpoint: string, queryParams: Record<string, string | number | undefined>): Promise<GiphyPage> {
  const apiKey = selectGiphyApiKey();
  if (!apiKey) throw new GiphyError('config', 'GIPHY API key is not configured');

  const qs = buildParams({ api_key: apiKey, limit: PAGE_LIMIT, rating: 'pg', bundle: 'messaging_non_clips', ...queryParams });
  let res: Response;
  try {
    res = await fetch(`${endpoint}?${qs}`, { method: 'GET' });
  } catch {
    throw new GiphyError('network', 'Unable to reach GIPHY');
  }
  if (res.status === 401 || res.status === 403) {
    throw new GiphyError('invalid-key', 'Invalid GIPHY API key');
  }
  if (res.status === 429) {
    throw new GiphyError('rate-limit', 'GIPHY rate limit reached');
  }
  if (!res.ok) {
    throw new GiphyError('network', `GIPHY request failed (${res.status})`);
  }
  const data = await res.json();
  const rawItems: RawGif[] = Array.isArray(data?.data) ? data.data : [];
  const items = rawItems.map(buildGiphyGif).filter((g): g is GiphyGif => g !== null);
  const totalCount = typeof data?.pagination?.total_count === 'number' ? data.pagination.total_count : items.length;
  return { items, totalCount };
}

/** Trending GIFs (shown when search is empty). */
export function fetchTrending(opts: { offset?: number; lang?: string } = {}): Promise<GiphyPage> {
  return fetchPage(`${BASE}/trending`, { offset: opts.offset ?? 0, lang: opts.lang ?? 'en' });
}

/** Search GIFs. The query is trimmed and clamped to 50 chars. */
export function fetchSearch(opts: { q: string; offset?: number; lang?: string }): Promise<GiphyPage> {
  const q = (opts.q || '').trim().slice(0, MAX_QUERY_LENGTH);
  return fetchPage(`${BASE}/search`, { q, offset: opts.offset ?? 0, lang: opts.lang ?? 'en' });
}

export const GIPHY_PAGE_LIMIT = PAGE_LIMIT;
export const GIPHY_MAX_QUERY_LENGTH = MAX_QUERY_LENGTH;
export const GIPHY_DEBOUNCE_MS = 350;

/**
 * Map the app's resolved locale to a GIPHY `lang` code (ISO 639-1). Defaults
 * to `en` for unsupported locales.
 */
export function giphyLangFromLocale(locale: string | undefined | null): string {
  if (!locale) return 'en';
  const base = String(locale).split('-')[0].toLowerCase();
  return base || 'en';
}
