import { ImportEntityType } from '@prisma/client';

export interface NormalizedItem {
  entityType: ImportEntityType;
  title: string;
  normTitle: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  watchedAt?: Date | null;
  raw: Record<string, string>;
}

export type Profile =
  | 'tvtime_watched_episode'
  | 'tvtime_followed'
  | 'tvtime_show_data'
  | 'tvtime_tracking'
  | 'generic_episode'
  | 'generic_movie_watched'
  | 'generic_watchlist'
  | 'generic_favorite'
  | 'unknown';

const SKIP_PATTERNS =
  /vote|rating|emotion|comment|character|badge|where-to-watch|notification|count\.by\.timeframe|deployment|friend|connection|\bip\b|token|session|device|\bad_|ads_|install|facebook|quiz|poll|recommend|similar|webhook|gdpr|auth|routing|addiction|mail|social|special_status|appsflyer|access_token|refresh_token|last_updated|object_last|statistics|cache|seen_episode_latest|show_seen_episode_latest|recommended_show_excluded|similar_show|installed_app|install_tracking/i;

/** Parse a date that may be epoch-seconds, epoch-ms, "YYYY-MM-DD HH:MM:SS", or ISO. Treats 0001 dates as null. */
export function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  if (s.startsWith('0001')) return null;
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

const pick = (row: Record<string, string>, keys: string[]): string | undefined => {
  for (const k of Object.keys(row)) {
    if (keys.includes(k.toLowerCase().trim())) return row[k];
  }
  return undefined;
};
const toInt = (v: string | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const toDate = (v: string | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
};

/** Extract a 4-digit year from a title like "Hunters (2020)" and return cleaned title + year. */
export function splitTitleYear(title: string): { title: string; year: number | null } {
  const m = title.match(/\((19|20)\d{2}\)/);
  if (m) {
    const year = Number(m[0].replace(/\D/g, ''));
    return { title: title.replace(m[0], '').trim(), year };
  }
  return { title, year: null };
}

export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const TITLE_KEYS = ['title', 'name', 'show', 'show_name', 'tv_show_name', 'series_name', 'movie_name', 'movie_title'];
const SEASON_KEYS = ['season', 'season_number', 's', 'episode_season_number'];
const EPISODE_KEYS = ['episode', 'episode_number', 'ep', 'ep_no'];
const YEAR_KEYS = ['year', 'release_year', 'first_air_date', 'aired_year'];
const WATCHED_KEYS = ['watched_at', 'created_at', 'watchedon', 'watched_date', 'date', 'updated_at'];
const FOLLOW_KEYS = ['is_followed', 'followed', 'in_watchlist', 'watchlist', 'active'];
const FAV_KEYS = ['is_favorited', 'favorite', 'favorited'];

export function detectProfile(filename: string, headers: string[]): Profile {
  const f = filename.toLowerCase();
  if (SKIP_PATTERNS.test(f)) return 'unknown';

  // TVTime known files
  if (f.includes('seen_episode_source') || f.includes('watched_on_episode')) return 'tvtime_watched_episode';
  if (f.includes('followed_tv_show')) return 'tvtime_followed';
  if (f.includes('user_tv_show_data')) return 'tvtime_show_data';
  if (f.includes('tracking-prod-records')) return 'tvtime_tracking';

  const h = headers.map((x) => x.toLowerCase().trim());
  const has = (...keys: string[]) => keys.some((k) => h.includes(k));
  const hasSeasonEpisode = has('season', 'season_number', 'episode_season_number') && has('episode', 'episode_number');
  const hasTitle = has(...TITLE_KEYS);
  const looksMovie = f.includes('movie') || has('movie_name', 'movie_title');

  if (hasSeasonEpisode && hasTitle) return 'generic_episode';
  if (has(...FOLLOW_KEYS) && hasTitle) return looksMovie ? 'generic_watchlist' : 'generic_watchlist';
  if (has(...FAV_KEYS) && hasTitle) return 'generic_favorite';
  if (has(...WATCHED_KEYS) && hasTitle) return looksMovie ? 'generic_movie_watched' : 'generic_movie_watched';
  return 'unknown';
}

function baseItem(
  entityType: ImportEntityType,
  row: Record<string, string>,
  title: string,
  extra: Partial<NormalizedItem> = {},
): NormalizedItem {
  const { title: clean, year } = splitTitleYear((title || '').trim());
  return {
    entityType,
    title: clean,
    normTitle: normTitle(clean),
    year: extra.year ?? year,
    raw: row,
    ...extra,
  };
}

/** Convert one source row → 0..n normalized items (e.g. user_tv_show_data → watchlist + favorite). */
export function normalizeRow(profile: Profile, row: Record<string, string>): NormalizedItem[] {
  const boolVal = (v: string | undefined) => /^(1|true|yes|y)$/i.test(String(v ?? ''));
  const items: NormalizedItem[] = [];

  switch (profile) {
    case 'tvtime_watched_episode':
    case 'generic_episode': {
      const title = pick(row, TITLE_KEYS) ?? '';
      const season = toInt(pick(row, SEASON_KEYS));
      const episode = toInt(pick(row, EPISODE_KEYS));
      if (!title || season == null || episode == null) return [];
      items.push(
        baseItem('WATCHED_EPISODE', row, title, {
          season,
          episode,
          year: toInt(pick(row, YEAR_KEYS)),
          watchedAt: toDate(pick(row, WATCHED_KEYS)),
        }),
      );
      break;
    }
    case 'generic_movie_watched': {
      const title = pick(row, TITLE_KEYS) ?? '';
      if (!title) return [];
      items.push(
        baseItem('WATCHED_MOVIE', row, title, { year: toInt(pick(row, YEAR_KEYS)), watchedAt: toDate(pick(row, WATCHED_KEYS)) }),
      );
      break;
    }
    case 'tvtime_followed':
    case 'generic_watchlist': {
      const title = pick(row, TITLE_KEYS) ?? '';
      if (!title) return [];
      const on = profile === 'tvtime_followed' ? boolVal(pick(row, FOLLOW_KEYS)) || pick(row, FOLLOW_KEYS) == null : boolVal(pick(row, FOLLOW_KEYS));
      if (on) {
        const looksMovie = /movie/i.test(JSON.stringify(row));
        items.push(baseItem(looksMovie ? 'WATCHLIST_MOVIE' : 'WATCHLIST_SHOW', row, title, { year: toInt(pick(row, YEAR_KEYS)) }));
      }
      break;
    }
    case 'tvtime_show_data': {
      const title = pick(row, TITLE_KEYS) ?? '';
      if (!title) return [];
      if (boolVal(pick(row, ['is_followed']))) items.push(baseItem('WATCHLIST_SHOW', row, title));
      if (boolVal(pick(row, ['is_favorited']))) items.push(baseItem('FAVORITE_SHOW', row, title));
      break;
    }
    case 'generic_favorite': {
      const title = pick(row, TITLE_KEYS) ?? '';
      if (!title) return [];
      if (boolVal(pick(row, FAV_KEYS))) {
        const looksMovie = /movie/i.test(JSON.stringify(row));
        items.push(baseItem(looksMovie ? 'FAVORITE_MOVIE' : 'FAVORITE_SHOW', row, title));
      }
      break;
    }
    case 'tvtime_tracking': {
      // Handles both v1 (typed rows: watch/follow/towatch/last-episode-watched) and
      // v2 (aggregate table: is_followed/is_for_later). Reads columns defensively.
      const type = (pick(row, ['type']) ?? '').toLowerCase();
      const series = pick(row, ['series_name', 'series', 'show_name', 'show']);
      const movie = pick(row, ['movie_name', 'movie', 'movie_title']);
      const season = toInt(pick(row, ['season_number', 'season', 's_no']));
      const episode = toInt(pick(row, ['episode_number', 'episode', 'ep_no']));
      const watchedAt = parseDate(pick(row, ['watch_date', 'watched_at', 'most_recent_ep_watched', 'created_at', 'updated_at']));
      const followed = boolVal(pick(row, ['is_followed']));
      const forLater = boolVal(pick(row, ['is_for_later']));

      if (type === 'watch' || type === 'last-episode-watched') {
        if (series && season != null && episode != null) {
          items.push(baseItem('WATCHED_EPISODE', row, series, { season, episode, watchedAt }));
        } else if (movie) {
          items.push(baseItem('WATCHED_MOVIE', row, movie, { watchedAt }));
        }
      } else if (type === 'follow' || type === 'towatch') {
        if (series) items.push(baseItem('WATCHLIST_SHOW', row, series));
        else if (movie) items.push(baseItem('WATCHLIST_MOVIE', row, movie));
      } else if (!type) {
        // v2 aggregate table — two kinds of rows:
        // 1. Per-episode rows (have season_number + episode_number) = watched episodes
        // 2. Summary rows (have is_followed/is_for_later, no episode) = watchlist
        if (series && season != null && episode != null) {
          // v2 per-episode row = this episode was watched
          items.push(baseItem('WATCHED_EPISODE', row, series, { season, episode, watchedAt }));
        } else if (series && (followed || forLater)) {
          items.push(baseItem('WATCHLIST_SHOW', row, series));
        }
      }
      // count-watch-* / time-count aggregates are intentionally ignored.
      break;
    }
    default:
      return [];
  }
  return items.filter((i) => i.title && i.normTitle);
}
