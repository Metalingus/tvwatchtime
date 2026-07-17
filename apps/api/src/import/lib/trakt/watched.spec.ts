import { normalizeTraktWatched } from './watched';

const SHOW = {
  ids: { trakt: 386, slug: 'spongebob-squarepants', tvdb: 75886, imdb: 'tt0206512', tmdb: 387 },
  year: 1999,
  title: 'SpongeBob SquarePants',
  aired_episodes: 638,
};

const MOVIE = {
  ids: { trakt: 3470, slug: 'carlito-s-way-1993', imdb: 'tt0106519', tmdb: 6075 },
  year: 1993,
  title: "Carlito's Way",
};

const epPlay = (id: number, season: number, number: number, watchedAt: string) => ({
  id,
  watched_at: watchedAt,
  action: 'watch',
  type: 'episode',
  episode: {
    ids: { trakt: 4900000 + number, tvdb: 3400000 + number, imdb: null, tmdb: 1200000 + number },
    title: `Episode ${number}`,
    number,
    season,
  },
  show: SHOW,
});

const moviePlay = (id: number, watchedAt: string) => ({
  id,
  watched_at: watchedAt,
  action: 'watch',
  type: 'movie',
  movie: MOVIE,
});

const empty = { history: [], watchedMovies: [], watchedShows: [] };

describe('normalizeTraktWatched — history', () => {
  it('collapses plays of the same S/E with watchCount and the EARLIEST watchedAt', () => {
    const r = normalizeTraktWatched({
      ...empty,
      history: [
        [
          epPlay(1, 7, 50, '2024-05-02T10:00:00.000Z'),
          epPlay(2, 7, 50, '2024-05-01T10:00:00.000Z'), // earlier play
          epPlay(3, 7, 43, '2024-05-03T10:00:00.000Z'),
        ],
      ],
    });
    expect(r.invalid).toBe(0);
    expect(r.episodes).toHaveLength(2);
    const e50 = r.episodes.find((e) => e.episode === 50)!;
    expect(e50.watchCount).toBe(2);
    expect(e50.watchedAt?.toISOString()).toBe('2024-05-01T10:00:00.000Z');
    expect(e50.showTitle).toBe('SpongeBob SquarePants');
    expect(e50.year).toBe(1999);
    expect(e50.showIds.trakt).toBe(386);
    expect(e50.episodeIds.tmdb).toBe(1200050);
    const e43 = r.episodes.find((e) => e.episode === 43)!;
    expect(e43.watchCount).toBe(1);
  });

  it('dedupes plays by entry id across pages', () => {
    const r = normalizeTraktWatched({
      ...empty,
      history: [
        [epPlay(1, 7, 50, '2024-05-01T10:00:00.000Z')],
        [
          epPlay(1, 7, 50, '2024-05-01T10:00:00.000Z'),
          epPlay(2, 7, 50, '2024-05-02T10:00:00.000Z'),
        ],
      ],
    });
    expect(r.episodes).toHaveLength(1);
    expect(r.episodes[0].watchCount).toBe(2); // id 1 counted once
  });

  it('splits movie plays into movie candidates with the same collapse rules', () => {
    const r = normalizeTraktWatched({
      ...empty,
      history: [
        [
          moviePlay(10, '2024-06-01T10:00:00.000Z'),
          moviePlay(11, '2024-05-01T10:00:00.000Z'),
          epPlay(1, 1, 1, '2024-05-01T10:00:00.000Z'),
        ],
      ],
    });
    expect(r.episodes).toHaveLength(1);
    expect(r.movies).toHaveLength(1);
    expect(r.movies[0].movieTitle).toBe("Carlito's Way");
    expect(r.movies[0].watchCount).toBe(2);
    expect(r.movies[0].watchedAt?.toISOString()).toBe('2024-05-01T10:00:00.000Z');
    expect(r.movies[0].movieIds.tmdb).toBe(6075);
  });

  it('keeps specials (season 0) as candidates', () => {
    const r = normalizeTraktWatched({
      ...empty,
      history: [[epPlay(1, 0, 1, '2024-05-01T10:00:00.000Z')]],
    });
    expect(r.invalid).toBe(0);
    expect(r.episodes).toHaveLength(1);
    expect(r.episodes[0].season).toBe(0);
  });

  it('counts invalid rows: missing season/number/title, unknown type, garbage entries', () => {
    const missingSeason = {
      ...epPlay(1, 7, 50, '2024-05-01T10:00:00.000Z'),
      episode: { number: 50 },
    };
    const missingNumber = {
      ...epPlay(2, 7, 50, '2024-05-01T10:00:00.000Z'),
      episode: { season: 7 },
    };
    const missingTitle = {
      ...epPlay(3, 7, 50, '2024-05-01T10:00:00.000Z'),
      show: { ids: SHOW.ids, year: 1999 },
    };
    const unknownType = { id: 4, watched_at: '2024-05-01T10:00:00.000Z', type: 'scrobble' };
    const r = normalizeTraktWatched({
      ...empty,
      history: [[missingSeason, missingNumber, missingTitle, unknownType, null, 42, 'x', []]],
    });
    expect(r.invalid).toBe(8);
    expect(r.episodes).toHaveLength(0);
  });

  it('skips non-array history elements silently', () => {
    const r = normalizeTraktWatched({
      ...empty,
      history: ['garbage', null, [epPlay(1, 7, 50, '2024-05-01T10:00:00.000Z')]],
    });
    expect(r.invalid).toBe(0);
    expect(r.episodes).toHaveLength(1);
  });

  it('invalid watched_at → null but the play still counts', () => {
    const r = normalizeTraktWatched({
      ...empty,
      history: [[epPlay(1, 7, 50, 'not-a-date'), epPlay(2, 7, 50, '2024-05-01T10:00:00.000Z')]],
    });
    expect(r.episodes[0].watchCount).toBe(2);
    expect(r.episodes[0].watchedAt?.toISOString()).toBe('2024-05-01T10:00:00.000Z');
    const onlyBad = normalizeTraktWatched({
      ...empty,
      history: [[epPlay(1, 7, 50, 'not-a-date')]],
    });
    expect(onlyBad.episodes[0].watchCount).toBe(1);
    expect(onlyBad.episodes[0].watchedAt).toBeNull();
  });

  it('groups by normalized title when no usable ids exist', () => {
    const noIds = {
      ...epPlay(1, 2, 3, '2024-05-01T10:00:00.000Z'),
      episode: { title: 'X', number: 3, season: 2, ids: {} },
      show: { title: 'SpongeBob SquarePants!', year: 1999, ids: {} },
    };
    const noIdsDup = {
      ...epPlay(2, 2, 3, '2024-05-02T10:00:00.000Z'),
      episode: { title: 'X', number: 3, season: 2, ids: {} },
      show: { title: 'spongebob squarepants', year: 1999, ids: {} },
    };
    const r = normalizeTraktWatched({ ...empty, history: [[noIds, noIdsDup]] });
    expect(r.episodes).toHaveLength(1);
    expect(r.episodes[0].watchCount).toBe(2);
  });
});

describe('normalizeTraktWatched — aggregate fallback', () => {
  const watchedMovies = [
    [
      {
        last_updated_at: '2024-07-15T23:26:24.000Z',
        last_watched_at: '2024-07-15T01:39:00.000Z',
        movie: MOVIE,
        plays: 3,
        total_count: 834,
      },
      {
        last_updated_at: '2024-07-15T23:26:24.000Z',
        last_watched_at: '2024-07-12T07:27:00.000Z',
        movie: {
          ids: { trakt: 86, slug: 'the-untouchables-1987', tmdb: 117 },
          year: 1987,
          title: 'The Untouchables',
        },
        plays: 1,
        total_count: 834,
      },
    ],
  ];
  const watchedShows = [
    [
      {
        plays: 268,
        last_watched_at: '2024-07-16T05:29:00.000Z',
        last_updated_at: null,
        reset_at: null,
        show: SHOW,
      },
      {
        plays: 24,
        last_watched_at: '2024-07-16T01:31:00.000Z',
        last_updated_at: null,
        reset_at: null,
        show: SHOW,
      },
    ],
  ];

  it('parses aggregate movies (plays → watchCount) and counts show rows as skippedNoEpisodeData', () => {
    const r = normalizeTraktWatched({ history: [], watchedMovies, watchedShows });
    expect(r.episodes).toHaveLength(0); // never fabricated
    expect(r.movies).toHaveLength(2);
    const carlito = r.movies.find((m) => m.movieTitle === "Carlito's Way")!;
    expect(carlito.watchCount).toBe(3);
    expect(carlito.watchedAt?.toISOString()).toBe('2024-07-15T01:39:00.000Z');
    expect(r.skippedNoEpisodeData).toBe(2);
    expect(r.invalid).toBe(0);
  });

  it('ignores aggregates completely when history exists', () => {
    const r = normalizeTraktWatched({
      history: [[epPlay(1, 7, 50, '2024-05-01T10:00:00.000Z')]],
      watchedMovies,
      watchedShows,
    });
    expect(r.episodes).toHaveLength(1);
    expect(r.movies).toHaveLength(0);
    expect(r.skippedNoEpisodeData).toBe(0);
  });

  it('does NOT fall back when history arrays were provided but contain no valid entries', () => {
    const r = normalizeTraktWatched({ history: [[null]], watchedMovies, watchedShows });
    expect(r.invalid).toBe(1);
    expect(r.movies).toHaveLength(0); // aggregates superseded, not parsed
    expect(r.skippedNoEpisodeData).toBe(0);
  });
});
