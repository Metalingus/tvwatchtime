import { normalizeTvTimeJsonShows } from './shows';
import { normalizeTvTimeJsonMovies } from './movies';
import { normalizeTvTimeJsonFavorites } from './favorites';
import { parseTvTimeIds } from './types';

describe('parseTvTimeIds', () => {
  it('coerces tvdb and normalizes the "-1" imdb sentinel to null', () => {
    expect(parseTvTimeIds({ tvdb: 328638, imdb: '-1' })).toEqual({ tvdb: 328638, imdb: null });
    expect(parseTvTimeIds({ tvdb: 340843, imdb: 'tt13654226' })).toEqual({ tvdb: 340843, imdb: 'tt13654226' });
    expect(parseTvTimeIds({ tvdb: '372898', imdb: -1 })).toEqual({ tvdb: 372898, imdb: null });
    expect(parseTvTimeIds(null)).toEqual({});
    expect(parseTvTimeIds('garbage')).toEqual({});
  });
});

describe('normalizeTvTimeJsonShows', () => {
  const data = [
    {
      uuid: 'u1',
      id: { tvdb: 328638, imdb: '-1' },
      created_at: '2018-08-16T16:23:37Z',
      title: 'Deception (2018)',
      status: 'up_to_date',
      seasons: [
        {
          number: 1,
          episodes: [
            { id: { tvdb: 6492386, imdb: '-1' }, number: 1, special: false, is_watched: true, watched_at: '2018-08-16T16:23:51.000Z', rating: 10 },
            { id: { tvdb: 6497624, imdb: '-1' }, number: 2, special: false, is_watched: true, watched_at: '2018-08-16T16:23:51.000Z', rating: null },
            { id: { tvdb: 5110835, imdb: '-1' }, number: 9, special: true, is_watched: true, watched_at: '2018-09-01T10:00:00.000Z', rating: null },
            { id: { tvdb: 6497625, imdb: '-1' }, number: 3, special: false, is_watched: false, watched_at: null, rating: null },
          ],
        },
      ],
    },
    {
      uuid: 'u2',
      id: { tvdb: 367083, imdb: 'tt11769304' },
      created_at: '2025-01-01T00:00:00Z',
      title: 'Hospital Playlist',
      status: 'not_started_yet',
      seasons: [{ number: 1, episodes: [{ id: { tvdb: 7575530, imdb: '-1' }, number: 1, special: false, is_watched: false, watched_at: null, rating: null }] }],
    },
  ];

  it('keeps watched episodes only, specials flagged, titles year-split', () => {
    const res = normalizeTvTimeJsonShows(data);
    expect(res.invalid).toBe(0);
    expect(res.episodes).toHaveLength(3);
    const special = res.episodes.find((e) => e.special)!;
    expect(special.season).toBe(1);
    expect(special.episode).toBe(9);
    expect(special.episodeIds.tvdb).toBe(5110835);
    const first = res.episodes.find((e) => !e.special && e.episode === 1)!;
    expect(first.showTitle).toBe('Deception');
    expect(first.year).toBe(2018);
    expect(first.showIds).toEqual({ tvdb: 328638, imdb: null });
    expect(first.watchedAt?.toISOString()).toBe('2018-08-16T16:23:51.000Z');
  });

  it('builds a non-special structural footprint per show', () => {
    const res = normalizeTvTimeJsonShows(data);
    const fp = res.footprints.get('tvdb:328638')!;
    expect(fp.maxSeason).toBe(1);
    // special E9 must NOT inflate the regular-episode footprint (max is E3)
    expect(fp.seasonEpisodes).toEqual([{ season: 1, maxEpisode: 3 }]);
    expect(fp.showTitle).toBe('Deception');
    const hp = res.footprints.get('tvdb:367083')!;
    expect(hp.maxSeason).toBe(1);
  });

  it('dedupes by show|season|episode|special (special and regular share S/E keys)', () => {
    const dup = JSON.parse(JSON.stringify(data));
    dup[0].seasons[0].episodes.push({ id: { tvdb: 7000001, imdb: '-1' }, number: 1, special: false, is_watched: true, watched_at: '2018-08-16T16:23:51.000Z', rating: null });
    dup[0].seasons[0].episodes.push({ id: { tvdb: 7000002, imdb: '-1' }, number: 1, special: true, is_watched: true, watched_at: '2018-08-16T16:23:51.000Z', rating: null });
    const res = normalizeTvTimeJsonShows(dup);
    // regular S1E1 dupe dropped; special S1E1 is a DIFFERENT entry from the existing special E9
    expect(res.episodes).toHaveLength(4);
    expect(res.episodes.filter((e) => e.special)).toHaveLength(2);
  });

  it('never throws on garbage', () => {
    expect(normalizeTvTimeJsonShows(null).episodes).toHaveLength(0);
    expect(normalizeTvTimeJsonShows({ nope: 1 }).episodes).toHaveLength(0);
    const res = normalizeTvTimeJsonShows([{ id: { tvdb: 1 } }, { title: 'Ok', seasons: 'bad' }]);
    expect(res.invalid).toBe(1);
    expect(res.episodes).toHaveLength(0);
  });
});

describe('normalizeTvTimeJsonMovies', () => {
  const data = [
    { id: { tvdb: 340843, imdb: 'tt13654226' }, created_at: '2025-02-25T15:37:47Z', uuid: 'm1', title: 'The Gorge', watched_at: '2025-02-25T15:37:55Z', is_watched: true, rating: 8 },
    { id: { tvdb: 19742, imdb: 'tt2072962' }, created_at: '2026-03-28T14:27:02Z', uuid: 'm2', title: 'The Client', watched_at: '2026-03-28T14:27:36Z', is_watched: true, rating: null },
    { id: { tvdb: 344867, imdb: 'tt13141250' }, created_at: '2024-10-09T17:22:06Z', uuid: 'm3', title: 'The Ritual Killer', is_watched: false, rating: null },
  ];

  it('splits watched vs watchlist (is_watched=false → watchlist, listedAt=created_at)', () => {
    const res = normalizeTvTimeJsonMovies(data);
    expect(res.invalid).toBe(0);
    expect(res.watched).toHaveLength(2);
    expect(res.watchlist).toHaveLength(1);
    expect(res.watched[0].movieTitle).toBe('The Gorge');
    expect(res.watched[0].movieIds.imdb).toBe('tt13654226');
    expect(res.watched[0].watchedAt?.toISOString()).toBe('2025-02-25T15:37:55.000Z');
    expect(res.watchlist[0]).toMatchObject({ type: 'movie', title: 'The Ritual Killer' });
    expect(res.watchlist[0].listedAt?.toISOString()).toBe('2024-10-09T17:22:06.000Z');
  });

  it('dedupes by external id and never throws on garbage', () => {
    const res = normalizeTvTimeJsonMovies([...data, data[0], { title: null }, 'junk']);
    expect(res.watched).toHaveLength(2);
    expect(res.invalid).toBe(2);
    expect(normalizeTvTimeJsonMovies(undefined).watched).toHaveLength(0);
  });
});

describe('normalizeTvTimeJsonFavorites', () => {
  it('collects show/movie membership with added_at; skips malformed entries', () => {
    const res = normalizeTvTimeJsonFavorites({
      name: 'Favorites',
      is_public: true,
      movies: [{ id: { tvdb: 19742, imdb: 'tt2072962' }, title: 'The Client', added_at: '2023-01-01T00:00:00Z' }],
      shows: [
        { id: { imdb: '-1', tvdb: 328638 }, title: 'Deception (2018)', uuid: 'u1', added_at: '2023-03-27T12:20:18Z', seasons: [] },
        { id: { tvdb: 1 } },
      ],
    });
    expect(res.skipped).toBe(1);
    expect(res.candidates).toHaveLength(2);
    const show = res.candidates.find((c) => c.type === 'show')!;
    expect(show.title).toBe('Deception');
    expect(show.year).toBe(2018);
    expect(show.listedAt?.toISOString()).toBe('2023-03-27T12:20:18.000Z');
    expect(res.candidates.find((c) => c.type === 'movie')!.title).toBe('The Client');
  });

  it('tolerates a non-object root', () => {
    expect(normalizeTvTimeJsonFavorites([1, 2]).candidates).toHaveLength(0);
    expect(normalizeTvTimeJsonFavorites(null).candidates).toHaveLength(0);
  });
});
