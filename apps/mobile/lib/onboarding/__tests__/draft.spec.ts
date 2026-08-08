import {
  buildApplyPayload,
  countThrough,
  draftReducer,
  eligibleAiredEpisodes,
  emptyDraft,
  expectedEpisodes,
  isOnboardingDone,
  needsProgressReview,
  selectionCounts,
  RawSeason,
} from '../draft';

const meta = (type: 'SHOW' | 'MOVIE') => ({ title: 'Title', poster: null, year: 2020, type });
const PAST = new Date(Date.now() - 86400_000).toISOString();
const FUTURE = new Date(Date.now() + 86400_000 * 30).toISOString();

const watchedShow = (id = 's1') => [
  { type: 'toggleWatched', id, mediaType: 'SHOW', meta: meta('SHOW') } as const,
];

describe('watched / watchlist selection are separate', () => {
  it('toggleWatched selects as CAUGHT_UP (shows) / WATCHED (movies) and deselects on second tap', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggleWatched', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(d.shows.s1).toEqual({ action: 'CAUGHT_UP' });
    expect(d.movies.m1).toEqual({ action: 'WATCHED' });
    d = draftReducer(d, { type: 'toggleWatched', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(d.shows.s1).toBeUndefined();
    expect(d.movies.m1).toBeUndefined();
  });

  it('toggleWatchlist selects as WATCHLIST and deselects on second tap', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggleWatchlist', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(d.shows.s1.action).toBe('WATCHLIST');
    expect(d.movies.m1.action).toBe('WATCHLIST');
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    expect(d.shows.s1).toBeUndefined();
  });

  it('selections survive a Shows/Movies tab switch (single draft, both buckets)', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggleWatched', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    // User switches to the Movies tab and keeps selecting.
    d = draftReducer(d, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(selectionCounts(d)).toEqual({
      showsWatched: 1,
      showsWatchlisted: 0,
      moviesWatched: 1,
      moviesWatchlisted: 0,
      total: 2,
    });
  });
});

describe('watched and watchlist are mutually exclusive per title', () => {
  it('a title can never be both watched and watchlist in the draft', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggleWatched', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    // Watchlist tap on a watched title is refused (unchanged draft).
    const after = draftReducer(d, { type: 'toggleWatchlist', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    expect(after).toBe(d);
    expect(after.shows.s1.action).toBe('CAUGHT_UP');
  });

  it('the watched screen converts a watchlist pick into a watched pick', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggleWatched', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    expect(d.shows.s1.action).toBe('CAUGHT_UP');
  });
});

describe('show progress', () => {
  it('setCaughtUp clears a stale watched-through boundary but keeps loaded counts', () => {
    let d = emptyDraft();
    for (const a of watchedShow()) d = draftReducer(d, a);
    d = draftReducer(d, { type: 'setCounts', id: 's1', airedCount: 18 });
    d = draftReducer(d, {
      type: 'setThrough',
      id: 's1',
      seasonNumber: 2,
      episodeNumber: 5,
      label: 'S2 E5',
      count: 15,
    });
    expect(d.shows.s1).toEqual({
      action: 'WATCHED_THROUGH',
      throughSeasonNumber: 2,
      throughEpisodeNumber: 5,
      throughLabel: 'S2 E5',
      airedCount: 18,
      throughCount: 15,
    });
    d = draftReducer(d, { type: 'setCaughtUp', id: 's1' });
    expect(d.shows.s1).toEqual({ action: 'CAUGHT_UP', airedCount: 18 });
  });

  it('progress actions are no-ops for unselected or watchlist-only shows', () => {
    const d = emptyDraft();
    expect(draftReducer(d, { type: 'setCaughtUp', id: 'x' })).toBe(d);
    expect(draftReducer(d, { type: 'moveToWatchlist', id: 'x' })).toBe(d);
    expect(
      draftReducer(d, { type: 'setThrough', id: 'x', seasonNumber: 1, episodeNumber: 1, label: 'S1 E1' }),
    ).toBe(d);
    let wl = draftReducer(d, { type: 'toggleWatchlist', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    expect(draftReducer(wl, { type: 'setCaughtUp', id: 's1' })).toBe(wl);
  });

  it('moving a show to the watchlist removes it from watched progress', () => {
    let d = emptyDraft();
    for (const a of watchedShow()) d = draftReducer(d, a);
    d = draftReducer(d, { type: 'moveToWatchlist', id: 's1' });
    expect(d.shows.s1).toEqual({ action: 'WATCHLIST' });
    expect(needsProgressReview(d)).toBe(false);
    expect(selectionCounts(d)).toMatchObject({ showsWatched: 0, showsWatchlisted: 1 });
  });

  it('setCounts returns the same state object when nothing changed (no persist loop)', () => {
    let d = emptyDraft();
    for (const a of watchedShow()) d = draftReducer(d, a);
    const once = draftReducer(d, { type: 'setCounts', id: 's1', airedCount: 18 });
    expect(once.shows.s1.airedCount).toBe(18);
    expect(draftReducer(once, { type: 'setCounts', id: 's1', airedCount: 18 })).toBe(once);
  });
});

describe('episode eligibility + inclusive partial progress', () => {
  const seasons: RawSeason[] = [
    {
      number: 0, // specials — always excluded
      episodes: [{ number: 1, title: 'Special', airDate: PAST }],
    },
    {
      number: 1,
      episodes: [
        { number: 1, title: 'Pilot', airDate: PAST },
        { number: 2, title: 'Second', airDate: PAST },
        { number: 3, title: 'Unaired', airDate: FUTURE },
        { number: 4, title: 'No airdate', airDate: null },
      ],
    },
    {
      number: 2,
      episodes: [
        { number: 1, title: 'The Engineer', airDate: PAST },
        { number: 2, title: 'Finale', airDate: PAST },
      ],
    },
  ];

  it('excludes specials and explicit future episodes but includes undated official episodes', () => {
    const eligible = eligibleAiredEpisodes(seasons);
    expect(eligible.map((e) => `${e.seasonNumber}x${e.number}`)).toEqual([
      '1x1',
      '1x2',
      '1x4',
      '2x1',
      '2x2',
    ]);
    expect(eligible).toHaveLength(5);
  });

  it('a fully watched show displays the canonical eligible episode count', () => {
    expect(eligibleAiredEpisodes(seasons)).toHaveLength(5); // not 7
  });

  it('partial progress is inclusive of the selected episode and all earlier ones', () => {
    const eligible = eligibleAiredEpisodes(seasons);
    expect(countThrough(eligible, 2, 1)).toBe(4); // S1 E1-E2/E4 + S2 E1
    expect(countThrough(eligible, 1, 2)).toBe(2);
    expect(countThrough(eligible, 1, 3)).toBe(2); // unaired E3 is never counted
    expect(countThrough(eligible, 1, 4)).toBe(3); // undated official E4 counts
  });
});

describe('review totals', () => {
  it('expectedEpisodes sums loaded metadata and flags unknown shows', () => {
    let d = emptyDraft();
    for (const a of watchedShow('s1')) d = draftReducer(d, a);
    for (const a of watchedShow('s2')) d = draftReducer(d, a);
    d = draftReducer(d, { type: 'setCounts', id: 's1', airedCount: 18 });
    d = draftReducer(d, {
      type: 'setThrough',
      id: 's2',
      seasonNumber: 2,
      episodeNumber: 4,
      label: 'S2 E4',
      count: 14,
    });
    d = draftReducer(d, { type: 'toggleWatched', id: 's3', mediaType: 'SHOW', meta: meta('SHOW') }); // metadata never loaded
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's4', mediaType: 'SHOW', meta: meta('SHOW') }); // not counted
    expect(expectedEpisodes(d)).toEqual({ known: 32, unknown: 1 });
  });

  it('review selection counts split watched vs watchlist across media types', () => {
    let d = emptyDraft();
    for (const a of watchedShow('s1')) d = draftReducer(d, a);
    d = draftReducer(d, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's2', mediaType: 'SHOW', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggleWatchlist', id: 'm2', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(selectionCounts(d)).toEqual({
      showsWatched: 1,
      showsWatchlisted: 1,
      moviesWatched: 1,
      moviesWatchlisted: 1,
      total: 4,
    });
  });
});

describe('apply resilience', () => {
  it('keepOnly trims the draft to failed titles so a retry re-applies exactly those', () => {
    let d = emptyDraft();
    for (const a of watchedShow('s1')) d = draftReducer(d, a);
    d = draftReducer(d, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's2', mediaType: 'SHOW', meta: meta('SHOW') });
    const trimmed = draftReducer(d, { type: 'keepOnly', ids: ['m1'] });
    expect(Object.keys(trimmed.shows)).toEqual([]);
    expect(Object.keys(trimmed.movies)).toEqual(['m1']);
    // Meta survives so the review screen can still render the failed titles.
    expect(trimmed.meta.m1).toBeDefined();
    expect(trimmed.meta.s1).toBeDefined();
  });

  it('buildApplyPayload maps the draft to the API contract', () => {
    let d = emptyDraft();
    for (const a of watchedShow('s1')) d = draftReducer(d, a);
    d = draftReducer(d, {
      type: 'setThrough',
      id: 's1',
      seasonNumber: 1,
      episodeNumber: 8,
      label: 'S1 E8',
    });
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's2', mediaType: 'SHOW', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(buildApplyPayload(d)).toEqual({
      shows: [
        { mediaId: 's1', action: 'WATCHED_THROUGH', throughSeasonNumber: 1, throughEpisodeNumber: 8 },
        { mediaId: 's2', action: 'WATCHLIST' },
      ],
      movies: [{ mediaId: 'm1', action: 'WATCHED' }],
    });
  });

  it('the draft round-trips through JSON (AsyncStorage persistence for resume)', () => {
    let d = emptyDraft();
    for (const a of watchedShow('s1')) d = draftReducer(d, a);
    d = draftReducer(d, { type: 'setThrough', id: 's1', seasonNumber: 2, episodeNumber: 4, label: 'S2 E4' });
    const revived = JSON.parse(JSON.stringify(d));
    expect(draftReducer(emptyDraft(), { type: 'hydrate', draft: revived })).toEqual(d);
  });

  it('clear resets the draft', () => {
    let d = emptyDraft();
    for (const a of watchedShow()) d = draftReducer(d, a);
    expect(draftReducer(d, { type: 'clear' })).toEqual(emptyDraft());
  });
});

describe('flow routing helpers', () => {
  it('no progress step when the user selected no watched shows', () => {
    let d = emptyDraft();
    d = draftReducer(d, { type: 'toggleWatchlist', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    d = draftReducer(d, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(needsProgressReview(d)).toBe(false); // movies-only + watchlist
    d = draftReducer(d, { type: 'toggleWatched', id: 's2', mediaType: 'SHOW', meta: meta('SHOW') });
    expect(needsProgressReview(d)).toBe(true);
  });

  it('works with only movies, only watchlist titles, or nothing selected', () => {
    const counts = (d: ReturnType<typeof emptyDraft>) => selectionCounts(d).total;
    expect(counts(emptyDraft())).toBe(0);
    let moviesOnly = emptyDraft();
    moviesOnly = draftReducer(moviesOnly, { type: 'toggleWatched', id: 'm1', mediaType: 'MOVIE', meta: meta('MOVIE') });
    expect(counts(moviesOnly)).toBe(1);
    expect(needsProgressReview(moviesOnly)).toBe(false);
    let wlOnly = emptyDraft();
    wlOnly = draftReducer(wlOnly, { type: 'toggleWatchlist', id: 's1', mediaType: 'SHOW', meta: meta('SHOW') });
    expect(counts(wlOnly)).toBe(1);
    expect(needsProgressReview(wlOnly)).toBe(false);
  });
});

describe('isOnboardingDone', () => {
  it('is done only for terminal states at the current version', () => {
    expect(isOnboardingDone('COMPLETED', 1)).toBe(true);
    expect(isOnboardingDone('SKIPPED', 1)).toBe(true);
    expect(isOnboardingDone('COMPLETED', 0)).toBe(false); // older version re-shows
    expect(isOnboardingDone('IN_PROGRESS', 1)).toBe(false);
    expect(isOnboardingDone('NOT_STARTED', null)).toBe(false);
    expect(isOnboardingDone(undefined, undefined)).toBe(false);
  });
});
