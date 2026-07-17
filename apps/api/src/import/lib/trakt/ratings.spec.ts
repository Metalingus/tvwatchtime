import { classifyTraktFile } from './detect';
import { normalizeTraktRatings } from './ratings';

const SHOW = {
  title: 'SpongeBob SquarePants',
  year: 1999,
  ids: { trakt: 386, slug: 'spongebob-squarepants', tvdb: 75886, imdb: 'tt0206512', tmdb: 387 },
  aired_episodes: 638,
};

const file = (filename: string, data: unknown) => ({
  filename,
  kind: classifyTraktFile(filename),
  data,
});

const showRow = (rating: unknown, show: unknown = SHOW, ratedAt = '2024-07-16T14:50:46.000Z') => ({
  rated_at: ratedAt,
  rating,
  type: 'show',
  show,
});

describe('normalizeTraktRatings — scale mapping', () => {
  it('maps the 1..10 Trakt scale to 1..5 via round(r/2) clamped', () => {
    // JS Math.round rounds half UP: 9/2=4.5→5, 7/2=3.5→4.
    expect(Math.round(9 / 2)).toBe(5);
    expect(Math.round(7 / 2)).toBe(4);
    const rows = [10, 9, 8, 7, 6, 1].map((v) => showRow(v));
    const r = normalizeTraktRatings([file('ratings-shows.json', rows)]);
    expect(r.candidates.map((c) => c.rating.normalizedRating)).toEqual([5, 5, 4, 4, 3, 1]);
    expect(r.detected).toBe(6);
    expect(r.unsupported).toBe(0);
  });

  it('rejects out-of-range, non-integer, and non-number ratings as unsupported', () => {
    const rows = [showRow(0), showRow(11), showRow(7.5), showRow('8'), showRow(null), null, []];
    const r = normalizeTraktRatings([file('ratings-shows.json', rows)]);
    expect(r.candidates).toHaveLength(0);
    expect(r.detected).toBe(7);
    expect(r.unsupported).toBe(7);
  });
});

describe('normalizeTraktRatings — kinds', () => {
  it('counts every ratings-seasons row as unsupported and ignores other kinds', () => {
    const seasonRows = [
      {
        rated_at: '2024-07-16T01:31:34.000Z',
        rating: 8,
        type: 'season',
        season: { number: 3 },
        show: SHOW,
      },
      {
        rated_at: '2024-07-16T01:31:34.000Z',
        rating: 6,
        type: 'season',
        season: { number: 1 },
        show: SHOW,
      },
    ];
    const r = normalizeTraktRatings([
      file('ratings-seasons.json', seasonRows),
      file('ratings-shows.json', [showRow(8)]),
      file('lists-watchlist.json', [{ type: 'show', show: SHOW }]), // not a ratings file
    ]);
    expect(r.unsupported).toBe(2);
    expect(r.detected).toBe(1); // only the ratings-shows row
    expect(r.candidates).toHaveLength(1);
  });

  it('normalizes movie ratings with movieIds + movieTitle', () => {
    const movie = {
      title: 'Flow',
      year: 2024,
      ids: { trakt: 656016, slug: 'flow-2024', imdb: 'tt4772188', tmdb: 823219 },
    };
    const r = normalizeTraktRatings([
      file('ratings-movies.json', [
        { rated_at: '2024-07-16T02:25:48.000Z', rating: 8, type: 'movie', movie },
      ]),
    ]);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.rating.targetType).toBe('movie');
    expect(c.rating.movieTitle).toBe('Flow');
    expect(c.rating.voteKey).toBe('trakt:movie:656016');
    expect(c.movieIds?.tmdb).toBe(823219);
    expect(c.showIds).toBeUndefined();
  });
});

describe('normalizeTraktRatings — identity + fields', () => {
  it('builds voteKey from the EPISODE ids for episode ratings', () => {
    const episode = {
      season: 7,
      number: 50,
      title: 'Love That Squid',
      ids: { trakt: 4940040, tvdb: 3448811, imdb: null, tmdb: 1249456 },
    };
    const r = normalizeTraktRatings([
      file('ratings-episodes.json', [
        { rated_at: '2024-07-16T05:29:51.000Z', rating: 6, type: 'episode', episode, show: SHOW },
      ]),
    ]);
    const c = r.candidates[0];
    expect(c.rating.voteKey).toBe('trakt:episode:4940040');
    expect(c.rating.externalEpisodeId).toBe(1249456); // tmdb preferred over tvdb
    expect(c.rating.showTitle).toBe('SpongeBob SquarePants');
    expect(c.rating.seasonNumber).toBe(7);
    expect(c.rating.episodeNumber).toBe(50);
    expect(c.rating.normalizedRating).toBe(3);
    expect(c.showIds?.trakt).toBe(386);
    expect(c.episodeIds?.trakt).toBe(4940040);
  });

  it('falls back to tmdb in voteKey and null when no ids exist', () => {
    const tmdbOnly = { title: 'X', year: 2020, ids: { tmdb: 823219 } };
    const noIds = { title: 'Y', year: 2020, ids: {} };
    const r = normalizeTraktRatings([
      file('ratings-movies.json', [
        { rated_at: null, rating: 8, type: 'movie', movie: tmdbOnly },
        { rated_at: null, rating: 8, type: 'movie', movie: noIds },
      ]),
    ]);
    expect(r.candidates[0].rating.voteKey).toBe('trakt:movie:823219');
    expect(r.candidates[1].rating.voteKey).toBeNull();
  });

  it('requires season + number for episode ratings', () => {
    const noSeason = {
      rated_at: null,
      rating: 6,
      type: 'episode',
      episode: { number: 50 },
      show: SHOW,
    };
    const noNumber = {
      rated_at: null,
      rating: 6,
      type: 'episode',
      episode: { season: 7 },
      show: SHOW,
    };
    const r = normalizeTraktRatings([file('ratings-episodes.json', [noSeason, noNumber])]);
    expect(r.candidates).toHaveLength(0);
    expect(r.unsupported).toBe(2);
  });

  it('sets source bookkeeping fields and parses rated_at (invalid → null)', () => {
    const r = normalizeTraktRatings([
      file('ratings-shows.json', [showRow(10, SHOW, 'garbage-date'), showRow(7)]),
    ]);
    const [a, b] = r.candidates.map((c) => c.rating);
    expect(a.sourceFile).toBe('ratings-shows.json');
    expect(a.sourceRow).toBe(1);
    expect(b.sourceRow).toBe(2);
    expect(a.sourceSet).toBe('trakt');
    expect(a.sourceRatingId).toBeNull();
    expect(a.idFromExplicitCol).toBe(false);
    expect(a.supported).toBe(true);
    expect(a.sourceUpdatedAt).toBeNull();
    expect(a.sourceCreatedAt).toBeNull(); // invalid date tolerated
    expect(b.sourceCreatedAt?.toISOString()).toBe('2024-07-16T14:50:46.000Z');
    expect(b.normalizedRating).toBe(4);
  });
});
