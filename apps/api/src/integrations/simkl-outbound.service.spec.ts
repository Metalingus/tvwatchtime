import { buildSimklIds, desiredSimklStatus, simklRatingFromStars } from './simkl-outbound.service';

const localState = (overrides: Record<string, unknown> = {}) =>
  ({
    mediaId: 'media-1',
    mediaType: 'SHOW',
    title: 'Example',
    year: 2024,
    externalIds: [],
    watchedMovie: false,
    watchedAt: null,
    watchedEpisodes: [],
    inWatchlist: false,
    dropped: false,
    paused: false,
    watchedCount: 0,
    totalCount: 10,
    rating: null,
    ratingSource: null,
    ...overrides,
  }) as any;

describe('SIMKL outbound mapping', () => {
  it('sends every supported correctly-namespaced ID and omits unsafe aliases', () => {
    expect(
      buildSimklIds(
        'SHOW',
        [
          { provider: 'IMDB', providerEntityKind: 'SERIES', value: 'tt0944947' },
          { provider: 'TMDB', providerEntityKind: 'SERIES', value: '1399' },
          { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '121361' },
          { provider: 'MYANIME_LIST', providerEntityKind: 'ANIME', value: '16498' },
          { provider: 'KITSU', providerEntityKind: 'ANIME', value: '7446' },
          { provider: 'TRAKT', providerEntityKind: 'SERIES', value: 'game-of-thrones' },
          { provider: 'TMDB', providerEntityKind: 'MOVIE', value: '1399' },
        ],
        '17465',
      ),
    ).toEqual({
      imdb: 'tt0944947',
      tmdb: '1399',
      tvdb: '121361',
      mal: '16498',
      kitsu: '7446',
    });
  });

  it('maps five stars to the even SIMKL ten-point values', () => {
    expect([1, 2, 3, 4, 5].map(simklRatingFromStars)).toEqual([2, 4, 6, 8, 10]);
    expect(simklRatingFromStars(0)).toBeNull();
  });

  it('uses deterministic status precedence for shows and movies', () => {
    expect(desiredSimklStatus(localState({ inWatchlist: true }))).toBe('plantowatch');
    expect(desiredSimklStatus(localState({ watchedEpisodes: [{ season: 1, episode: 1 }] }))).toBe(
      'watching',
    );
    expect(desiredSimklStatus(localState({ paused: true, dropped: true }))).toBe('dropped');
    expect(desiredSimklStatus(localState({ watchedCount: 10, totalCount: 10 }))).toBe('completed');
    expect(desiredSimklStatus(localState({ mediaType: 'MOVIE', watchedMovie: true }))).toBe(
      'completed',
    );
  });
});
