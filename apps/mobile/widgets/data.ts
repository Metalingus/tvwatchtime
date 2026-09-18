import { formatReleaseDate } from '../lib/format';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import {
  firstNetwork,
  UPCOMING_NEAR_TERM_BUCKETS,
  WatchNextBucket,
  type UpcomingGroupDto,
  type WatchNextItemDto,
  type WatchNextResponseDto,
} from '@tvwatch/shared';
import { api } from '../api/client';
import i18n, { detectResolvedLocale, loadLocale } from '../i18n';

/** Widget kinds shared by Android (plugin widget names) and iOS (WidgetKit kind strings). */
export const WIDGET_KINDS = { watchNext: 'WatchNext', upcoming: 'Upcoming' } as const;

/** Localized strings rendered inside the widgets (headers + empty/sign-in states). */
export interface WidgetLabels {
  watchNext: string;
  upcoming: string;
  today: string;
  tomorrow: string;
  thisWeek: string;
  labelNew: string;
  labelPremiere: string;
  labelLatest: string;
  labelAired: string;
  labelFinale: string;
  emptyWatchNext: string;
  emptyUpcoming: string;
  signIn: string;
}

const LANG_KEY = 'pref:lang';

/** Load the user's stored locale into i18n when running headless (widget task) where
 *  PreferencesProvider never mounted. No-op when the locale is already active. */
export async function ensureWidgetLocale(): Promise<void> {
  try {
    const pref = await AsyncStorage.getItem(LANG_KEY);
    const resolved = detectResolvedLocale((pref as any) ?? 'system');
    if (i18n.language !== resolved) await loadLocale(resolved);
  } catch {
    // keep current language
  }
}

export function getWidgetLabels(): WidgetLabels {
  return {
    watchNext: i18n.t('shows:watchNext'),
    upcoming: i18n.t('shows:upcoming'),
    today: i18n.t('shows:today'),
    tomorrow: i18n.t('shows:tomorrow'),
    thisWeek: i18n.t('shows:thisWeek'),
    labelNew: i18n.t('shows:labelNew'),
    labelPremiere: i18n.t('shows:labelPremiere'),
    labelLatest: i18n.t('shows:labelLatest'),
    labelAired: i18n.t('shows:labelAired'),
    labelFinale: i18n.t('shows:labelFinale'),
    emptyWatchNext: i18n.t('shows:empty.watchlistTitle'),
    emptyUpcoming: i18n.t('shows:empty.upcomingTitle'),
    signIn: i18n.t('auth:login'),
  };
}

export function upcomingEpisodeLabel(label: string, labels: WidgetLabels): string {
  if (label === 'NEW') return labels.labelNew;
  if (label === 'PREMIERE') return labels.labelPremiere;
  if (label === 'LATEST') return labels.labelLatest;
  if (label === 'AIRED') return labels.labelAired;
  if (label === 'FINALE') return labels.labelFinale;
  return label;
}

/** Map a server upcoming bucket to its localized header (TODAY/TOMORROW/THIS_WEEK only). */
export function upcomingGroupTitle(key: string, labels: WidgetLabels, fallback: string): string {
  if (key === 'TODAY') return labels.today;
  if (key === 'TOMORROW') return labels.tomorrow;
  if (key === 'THIS_WEEK') return labels.thisWeek;
  return fallback;
}

export type WidgetFetchState<T> =
  { status: 'ok'; data: T } | { status: 'auth' } | { status: 'error' };

// Widget renders happen once per home-screen instance and headless fetches have no
// natural timeout — bound every request and memoize results briefly so N widget
// instances rendered in the same update round share ONE network call.
const WIDGET_FETCH_TIMEOUT_MS = 15000;
const WIDGET_CACHE_TTL_MS = 30000;
const WIDGET_IMAGE_PREFETCH_TIMEOUT_MS = 6000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('widget fetch timeout')), WIDGET_FETCH_TIMEOUT_MS),
    ),
  ]);
}

function toState<T>(fn: () => Promise<T>): Promise<WidgetFetchState<T>> {
  return withTimeout(fn())
    .then((data): WidgetFetchState<T> => ({ status: 'ok', data }))
    .catch((e: any): WidgetFetchState<T> => {
      if (e?.status === 401) return { status: 'auth' };
      return { status: 'error' };
    });
}

const resultCache = new Map<string, { at: number; value: WidgetFetchState<any> }>();

function cached<T>(
  key: string,
  fn: () => Promise<WidgetFetchState<T>>,
): Promise<WidgetFetchState<T>> {
  const hit = resultCache.get(key);
  if (hit && Date.now() - hit.at < WIDGET_CACHE_TTL_MS) return Promise.resolve(hit.value);
  return fn().then((value) => {
    resultCache.set(key, { at: Date.now(), value });
    return value;
  });
}

/** Drop memoized results (login/logout/credential changes must re-render from the network). */
export function invalidateWidgetDataCache(): void {
  resultCache.clear();
}

// Periodic OS re-renders (updatePeriodMillis) run headless while the device may be
// in Doze — background network is suspended and the fetch fails. Rendering the
// error/empty state then would blank the widget until the next app open, so persist
// the last successful payload and fall back to it on transient failures. A genuine
// auth failure (401 after a failed refresh) still drops the cache (logout / expired
// refresh token must not leave personal data on the home screen).
const DISK_CACHE_KEYS = {
  watchNext: 'widget:lastGood.watchNext',
  upcoming: 'widget:lastGood.upcoming',
} as const;

async function readLastGood<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeLastGood(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best effort
  }
}

async function dropLastGood(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // best effort
  }
}

/** Fetch with last-good fallback: ok persists the payload, auth drops it, error
 *  replays the last persisted payload instead of blanking the widget. */
async function fetchWithFallback<T>(
  diskKey: string,
  fetcher: () => Promise<WidgetFetchState<T>>,
): Promise<WidgetFetchState<T>> {
  const state = await fetcher();
  if (state.status === 'ok') {
    await writeLastGood(diskKey, state.data);
    return state;
  }
  if (state.status === 'auth') {
    await dropLastGood(diskKey);
    return state;
  }
  const lastGood = await readLastGood<T>(diskKey);
  return lastGood ? { status: 'ok', data: lastGood } : state;
}

/** Watch Next widget data: strictly the WATCH_NEXT bucket, deduped by episode id
 *  (mirrors the app's Shows tab dedupe). */
export async function fetchWatchNextItems(): Promise<WidgetFetchState<WatchNextItemDto[]>> {
  await ensureWidgetLocale();
  return fetchWithFallback(DISK_CACHE_KEYS.watchNext, () =>
    cached('watchNext', () =>
      toState(async () => {
        const res = await api.get<WatchNextResponseDto>('/me/watch-next');
        const seen = new Set<string>();
        return (
          (res.items ?? [])
            .filter((it) => {
              if (it.bucket !== WatchNextBucket.WATCH_NEXT) return false;
              const k = it.episode?.id;
              if (!k || seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            // Compact widget rows show only the first of a joined multi-network string.
            .map((it) => ({ ...it, network: firstNetwork(it.network) }))
        );
      }),
    ),
  );
}

/** Upcoming widget data: only the near-term groups (Today / Tomorrow / This week). */
export async function fetchUpcomingGroups(): Promise<WidgetFetchState<UpcomingGroupDto[]>> {
  await ensureWidgetLocale();
  return fetchWithFallback(DISK_CACHE_KEYS.upcoming, () =>
    cached('upcoming', () =>
      toState(async () => {
        const res = await api.get<{ groups: UpcomingGroupDto[] }>('/me/upcoming');
        const wanted = new Set<string>(UPCOMING_NEAR_TERM_BUCKETS);
        return (
          (res.groups ?? [])
            .filter((g) => wanted.has(g.key) && g.items?.length)
            // Compact widget rows show only the first of a joined multi-network string.
            .map((g) => ({
              ...g,
              items: g.items.map((it) => ({ ...it, network: firstNetwork(it.network) })),
            }))
        );
      }),
    ),
  );
}

export function pad2(n?: number | null): string {
  return String(n ?? 0).padStart(2, '0');
}

/** "S02 E05" episode code. */
export function episodeCode(
  season?: number | null,
  episode?: number | null,
  separator = ' ',
): string {
  return `S${pad2(season)}${separator}E${pad2(episode)}`;
}

/** "Tue, Jul 21" using the device locale. */
export function shortAirDate(airDate: string, precise = false): string {
  return formatReleaseDate(airDate, { weekday: 'short', month: 'short', day: 'numeric' }, undefined, precise);
}

export const EPISODE_URI = (episodeId: string) => `tvwatchtime://episode/${episodeId}`;
export const SHOWS_URI = 'tvwatchtime://shows';

/** Rewrite a TMDB image URL to a smaller variant for widget rendering (the widget
 *  library downloads every remote bitmap uncached). Non-TMDB URLs pass through. */
export function widgetImage(
  url: string | null | undefined,
  size: 'w185' | 'w300',
): string | undefined {
  if (!url) return undefined;
  return url.replace(/\/t\/p\/(?:w\d+|original)\//, `/t/p/${size}/`);
}

/** Resolve remote artwork to Expo's persistent disk cache before handing it to
 * the Android widget library. That library otherwise downloads every URL
 * synchronously for every light/dark render and cannot reuse the result. Local
 * files also keep working when a last-good payload contains an expired URL. */
export async function cacheWidgetImages(
  urls: Array<string | null | undefined>,
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(urls.filter((url): url is string => Boolean(url)))];
  const resolved = new Map<string, string>();

  const resolveCached = async (url: string): Promise<void> => {
    try {
      const path = await Image.getCachePathAsync(url);
      if (path) resolved.set(url, path.startsWith('file://') ? path : `file://${path}`);
    } catch {
      // A missing/temporarily unavailable image must not fail the whole widget.
    }
  };

  await Promise.all(unique.map(resolveCached));
  const missing = unique.filter((url) => !resolved.has(url));
  if (missing.length) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Image.prefetch(missing, { cachePolicy: 'disk' }).catch(() => false),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), WIDGET_IMAGE_PREFETCH_TIMEOUT_MS);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    await Promise.all(missing.map(resolveCached));
  }

  return resolved;
}
