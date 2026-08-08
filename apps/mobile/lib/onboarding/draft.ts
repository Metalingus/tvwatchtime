import {
  ONBOARDING_VERSION,
  OnboardingApplyDto,
  OnboardingStatus,
} from '@tvwatch/shared';
import { isEpisodeProgressEligible } from '../episode-progress';

/**
 * Pure quick-setup draft logic — NO React Native imports so this runs under the
 * mobile Jest config (same constraint as watch-next-optimistic.spec.ts).
 * The React hook + AsyncStorage persistence live in useOnboardingDraft.ts.
 */

export type DraftShowAction = 'CAUGHT_UP' | 'WATCHED_THROUGH' | 'WATCHLIST';
export type DraftMovieAction = 'WATCHED' | 'WATCHLIST';

export interface DraftShow {
  action: DraftShowAction;
  throughSeasonNumber?: number;
  throughEpisodeNumber?: number;
  /** Pre-rendered "S2 E14" label so the review screens don't need episode data. */
  throughLabel?: string;
  /** Title of the boundary episode, shown under the "Through S2 E14" status. */
  throughEpisodeTitle?: string;
  /** Progress-eligible, non-special episode total from loaded metadata. */
  airedCount?: number;
  /** Episodes the WATCHED_THROUGH boundary would mark (inclusive), from loaded metadata. */
  throughCount?: number;
}

export interface DraftMovie {
  action: DraftMovieAction;
}

export interface DraftMeta {
  title: string;
  poster?: string | null;
  year?: number | null;
  type: 'SHOW' | 'MOVIE';
}

export interface OnboardingDraft {
  shows: Record<string, DraftShow>;
  movies: Record<string, DraftMovie>;
  meta: Record<string, DraftMeta>;
}

export const emptyDraft = (): OnboardingDraft => ({ shows: {}, movies: {}, meta: {} });

export type DraftAction =
  | { type: 'toggleWatched'; id: string; mediaType: 'SHOW' | 'MOVIE'; meta: DraftMeta }
  | { type: 'toggleWatchlist'; id: string; mediaType: 'SHOW' | 'MOVIE'; meta: DraftMeta }
  | { type: 'setCaughtUp'; id: string }
  | { type: 'moveToWatchlist'; id: string }
  | {
      type: 'setThrough';
      id: string;
      seasonNumber: number;
      episodeNumber: number;
      label: string;
      episodeTitle?: string;
      count?: number;
    }
  | { type: 'setCounts'; id: string; airedCount: number; throughCount?: number }
  | { type: 'remove'; id: string; mediaType: 'SHOW' | 'MOVIE' }
  | { type: 'keepOnly'; ids: string[] }
  | { type: 'clear' }
  | { type: 'hydrate'; draft: OnboardingDraft };

const bucketOf = (mediaType: 'SHOW' | 'MOVIE') => (mediaType === 'SHOW' ? 'shows' : 'movies');

/**
 * A title is one entry with one action, so watched and watchlist can never
 * coexist for the same id. The watched screen converts a watchlist pick into a
 * watched pick on tap; the watchlist screen refuses watched picks (the caller
 * shows a non-blocking message instead).
 */
export function draftReducer(state: OnboardingDraft, action: DraftAction): OnboardingDraft {
  switch (action.type) {
    case 'toggleWatched': {
      const bucket = bucketOf(action.mediaType);
      const existing = state[bucket][action.id];
      if (existing && existing.action !== 'WATCHLIST') {
        const next = { ...state, [bucket]: { ...state[bucket] } };
        delete next[bucket][action.id];
        return next;
      }
      const entry =
        action.mediaType === 'SHOW'
          ? ({
              action: 'CAUGHT_UP',
              // Keep already-loaded episode metadata across the conversion.
              ...(existing?.action === 'WATCHLIST' && 'airedCount' in existing
                ? { airedCount: (existing as DraftShow).airedCount }
                : {}),
            } satisfies DraftShow)
          : ({ action: 'WATCHED' } satisfies DraftMovie);
      return {
        ...state,
        [bucket]: { ...state[bucket], [action.id]: entry },
        meta: { ...state.meta, [action.id]: action.meta },
      };
    }
    case 'toggleWatchlist': {
      const bucket = bucketOf(action.mediaType);
      const existing = state[bucket][action.id];
      // Watched wins — the watchlist screen never converts a watched pick.
      if (existing && existing.action !== 'WATCHLIST') return state;
      if (existing) {
        const next = { ...state, [bucket]: { ...state[bucket] } };
        delete next[bucket][action.id];
        return next;
      }
      const entry =
        action.mediaType === 'SHOW'
          ? ({ action: 'WATCHLIST' } satisfies DraftShow)
          : ({ action: 'WATCHLIST' } satisfies DraftMovie);
      return {
        ...state,
        [bucket]: { ...state[bucket], [action.id]: entry },
        meta: { ...state.meta, [action.id]: action.meta },
      };
    }
    case 'setCaughtUp': {
      const existing = state.shows[action.id];
      if (!existing || existing.action === 'WATCHLIST') return state;
      if (existing.action === 'CAUGHT_UP') return state;
      // Switching rules clears any stale watched-through boundary.
      return {
        ...state,
        shows: {
          ...state.shows,
          [action.id]: { action: 'CAUGHT_UP', ...(existing.airedCount != null ? { airedCount: existing.airedCount } : {}) },
        },
      };
    }
    case 'moveToWatchlist': {
      const existing = state.shows[action.id];
      if (!existing || existing.action === 'WATCHLIST') return state;
      return {
        ...state,
        shows: { ...state.shows, [action.id]: { action: 'WATCHLIST' } },
      };
    }
    case 'setThrough': {
      const existing = state.shows[action.id];
      if (!existing || existing.action === 'WATCHLIST') return state;
      return {
        ...state,
        shows: {
          ...state.shows,
          [action.id]: {
            action: 'WATCHED_THROUGH',
            throughSeasonNumber: action.seasonNumber,
            throughEpisodeNumber: action.episodeNumber,
            throughLabel: action.label,
            ...(action.episodeTitle ? { throughEpisodeTitle: action.episodeTitle } : {}),
            ...(existing.airedCount != null ? { airedCount: existing.airedCount } : {}),
            ...(action.count != null ? { throughCount: action.count } : {}),
          },
        },
      };
    }
    case 'setCounts': {
      const existing = state.shows[action.id];
      if (!existing || existing.action === 'WATCHLIST') return state;
      // No-change guard: episode queries resolve asynchronously on every screen
      // mount — returning the SAME state object avoids a persist/render loop.
      if (
        existing.airedCount === action.airedCount &&
        (action.throughCount === undefined || existing.throughCount === action.throughCount)
      ) {
        return state;
      }
      return {
        ...state,
        shows: {
          ...state.shows,
          [action.id]: {
            ...existing,
            airedCount: action.airedCount,
            ...(action.throughCount !== undefined ? { throughCount: action.throughCount } : {}),
          },
        },
      };
    }
    case 'remove': {
      const bucket = bucketOf(action.mediaType);
      if (!state[bucket][action.id]) return state;
      const next = { ...state, [bucket]: { ...state[bucket] } };
      delete next[bucket][action.id];
      return next;
    }
    case 'keepOnly': {
      // Partial-apply recovery: keep only the failed titles so a retry re-applies
      // exactly those (the successful ones are already persisted server-side).
      const keep = new Set(action.ids);
      const shows = Object.fromEntries(Object.entries(state.shows).filter(([id]) => keep.has(id)));
      const movies = Object.fromEntries(Object.entries(state.movies).filter(([id]) => keep.has(id)));
      return { ...state, shows, movies };
    }
    case 'clear':
      return emptyDraft();
    case 'hydrate':
      return action.draft;
    default:
      return state;
  }
}

export interface SelectionCounts {
  showsWatched: number;
  showsWatchlisted: number;
  moviesWatched: number;
  moviesWatchlisted: number;
  total: number;
}

export function selectionCounts(draft: OnboardingDraft): SelectionCounts {
  const shows = Object.values(draft.shows);
  const movies = Object.values(draft.movies);
  const showsWatchlisted = shows.filter((s) => s.action === 'WATCHLIST').length;
  const moviesWatchlisted = movies.filter((m) => m.action === 'WATCHLIST').length;
  const showsWatched = shows.length - showsWatchlisted;
  const moviesWatched = movies.length - moviesWatchlisted;
  return {
    showsWatched,
    showsWatchlisted,
    moviesWatched,
    moviesWatchlisted,
    total: shows.length + movies.length,
  };
}

/** True when the compact show-progress step is needed (any show marked watched). */
export function needsProgressReview(draft: OnboardingDraft): boolean {
  return Object.values(draft.shows).some((s) => s.action !== 'WATCHLIST');
}

/**
 * Expected episode total for the review card, computed from metadata recorded
 * while the progress screen/sheet had episode data loaded. `unknown` counts
 * watched shows whose metadata was never loaded — the review shows the
 * "confirmed when your library is created" note when it is non-zero.
 */
export function expectedEpisodes(draft: OnboardingDraft): { known: number; unknown: number } {
  let known = 0;
  let unknown = 0;
  for (const s of Object.values(draft.shows)) {
    if (s.action === 'CAUGHT_UP') {
      if (s.airedCount != null) known += s.airedCount;
      else unknown++;
    } else if (s.action === 'WATCHED_THROUGH') {
      if (s.throughCount != null) known += s.throughCount;
      else unknown++;
    }
  }
  return { known, unknown };
}

export function buildApplyPayload(draft: OnboardingDraft): OnboardingApplyDto {
  return {
    shows: Object.entries(draft.shows).map(([mediaId, s]) => ({
      mediaId,
      action: s.action,
      ...(s.action === 'WATCHED_THROUGH'
        ? { throughSeasonNumber: s.throughSeasonNumber, throughEpisodeNumber: s.throughEpisodeNumber }
        : {}),
    })),
    movies: Object.entries(draft.movies).map(([mediaId, m]) => ({ mediaId, action: m.action })),
  };
}

// ---------------- Episode eligibility (mirrors the server convention) ----------------

export interface RawEpisode {
  number: number;
  title?: string | null;
  airDate?: string | null;
  watched?: boolean;
}

export interface RawSeason {
  number: number;
  title?: string | null;
  episodes?: RawEpisode[];
}

/**
 * Progress-eligible, non-special episodes in watch order. Specials are season 0
 * (the server-side `isSpecial` flag maps to S0); undated official episodes count,
 * while episodes explicitly dated in the future do not.
 */
export function eligibleAiredEpisodes(seasons: RawSeason[], now: Date = new Date()): (RawEpisode & { seasonNumber: number })[] {
  return seasons
    .filter((s) => s.number > 0)
    .flatMap((s) =>
      (s.episodes ?? [])
        .filter((episode) => isEpisodeProgressEligible(episode.airDate, now.getTime()))
        .map((e) => ({ ...e, seasonNumber: s.number })),
    )
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
}

/** Inclusive "watched through S{season} E{episode}" count over eligible episodes. */
export function countThrough(
  eligible: { seasonNumber: number; number: number }[],
  seasonNumber: number,
  episodeNumber: number,
): number {
  return eligible.filter(
    (e) => e.seasonNumber < seasonNumber || (e.seasonNumber === seasonNumber && e.number <= episodeNumber),
  ).length;
}

/** Gate predicate: onboarding is done only for terminal states at the current
 *  version. A future ONBOARDING_VERSION bump re-shows it to everyone. */
export function isOnboardingDone(
  status: OnboardingStatus | undefined,
  version: number | null | undefined,
): boolean {
  const terminal = status === 'COMPLETED' || status === 'SKIPPED';
  return terminal && (version ?? 0) >= ONBOARDING_VERSION;
}
