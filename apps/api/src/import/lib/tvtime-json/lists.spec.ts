import { normalizeTvTimeJsonLists } from './lists';
import { normalizeTvTimeJsonRatings } from './ratings';
import { normalizeTvTimeWatchlistCsv } from './activity';

describe('normalizeTvTimeJsonLists', () => {
  const data = [
    {
      name: 'kdramas ',
      description: 'Corée du sud ',
      is_public: true,
      shows: [
        { id: { imdb: 'tt11769304', tvdb: 367083 }, title: 'Hospital Playlist', uuid: 'l1', added_at: '2025-11-29T17:00:00Z', seasons: [] },
        { id: { imdb: '-1', tvdb: 425787 }, title: 'Lovely Runner', uuid: 'l2', added_at: '2025-11-29T17:01:00Z', seasons: [] },
      ],
      movies: [],
    },
    {
      name: 'private one',
      is_public: false,
      shows: [{ id: { tvdb: 1, imdb: '-1' }, title: 'X', seasons: [] }],
      movies: [{ id: { tvdb: 19742, imdb: 'tt2072962' }, title: 'The Client', added_at: '2023-01-01T00:00:00Z' }],
    },
    { description: 'no name' },
  ];

  it('normalizes lists with visibility from is_public and a stable name-derived sourceKey', () => {
    const res = normalizeTvTimeJsonLists(data);
    expect(res.skippedLists).toBe(1);
    expect(res.lists).toHaveLength(2);
    const pub = res.lists[0];
    expect(pub.title).toBe('kdramas');
    expect(pub.visibility).toBe('PUBLIC');
    expect(pub.sourceKey).toBe('tvtime:list:kdramas');
    expect(pub.description).toBe('Corée du sud');
    expect(pub.items).toHaveLength(2);
    expect(pub.items[0]).toMatchObject({ mediaType: 'show', title: 'Hospital Playlist', order: 1 });
    expect(pub.items[0].createdAt?.toISOString()).toBe('2025-11-29T17:00:00.000Z');
    const priv = res.lists[1];
    expect(priv.visibility).toBe('PRIVATE');
    // shows first, then movies; order is continuous across both arrays
    expect(priv.items.map((i) => i.mediaType)).toEqual(['show', 'movie']);
    expect(priv.items[1].order).toBe(2);
  });

  it('never throws on garbage', () => {
    expect(normalizeTvTimeJsonLists(null).lists).toHaveLength(0);
    expect(normalizeTvTimeJsonLists({}).lists).toHaveLength(0);
    expect(normalizeTvTimeJsonLists([{ name: 'ok', shows: 'bad', movies: 42 }]).lists[0].items).toHaveLength(0);
  });
});

describe('normalizeTvTimeJsonRatings', () => {
  const shows = [
    {
      id: { tvdb: 328638, imdb: '-1' },
      title: 'Deception (2018)',
      seasons: [
        {
          number: 1,
          episodes: [
            { id: { tvdb: 6492386, imdb: '-1' }, number: 1, special: false, is_watched: true, watched_at: '2018-08-16T16:23:51.000Z', rating: 10 },
            { id: { tvdb: 6497624, imdb: '-1' }, number: 2, special: false, is_watched: true, watched_at: '2018-08-16T16:23:51.000Z', rating: null },
          ],
        },
      ],
    },
  ];
  const movies = [
    { id: { tvdb: 340843, imdb: 'tt13654226' }, title: 'The Gorge', watched_at: '2025-02-25T15:37:55Z', is_watched: true, rating: 8 },
    { id: { tvdb: 19742, imdb: 'tt2072962' }, title: 'The Client', is_watched: true, rating: 99 },
  ];
  const favorites = {
    name: 'Favorites',
    shows: [
      {
        id: { tvdb: 328638, imdb: '-1' },
        title: 'Deception (2018)',
        seasons: [{ number: 1, episodes: [{ id: { tvdb: 6492386, imdb: '-1' }, number: 1, special: false, is_watched: true, watched_at: '2018-08-16T16:23:51.000Z', rating: 10 }] }],
      },
    ],
    movies: [],
  };
  const lists = [
    {
      name: 'kdramas ',
      shows: [
        {
          id: { tvdb: 367083, imdb: 'tt11769304' },
          title: 'Hospital Playlist',
          seasons: [{ number: 1, episodes: [{ id: { tvdb: 7575530, imdb: '-1' }, number: 1, special: false, is_watched: true, watched_at: '2025-11-29T17:02:11.304Z', rating: 6 }] }],
        },
      ],
      movies: [],
    },
  ];

  it('maps 1–10 to 1–5, dedupes across files by episode id, keeps unique embedded ratings', () => {
    const res = normalizeTvTimeJsonRatings({ shows: [shows], movies: [movies], collections: [favorites, lists] });
    // detected: shows 1 + movies 1 (rating 99 out of range → ignored) + favorites dup 1 + lists unique 1
    expect(res.detected).toBe(4);
    expect(res.unsupported).toBe(0);
    expect(res.candidates).toHaveLength(3);

    const ep = res.candidates.find((c) => c.rating.targetType === 'episode' && c.rating.showTitle === 'Deception')!;
    expect(ep.rating.normalizedRating).toBe(5); // 10 → 5
    expect(ep.rating.seasonNumber).toBe(1);
    expect(ep.rating.episodeNumber).toBe(1);
    expect(ep.rating.externalEpisodeId).toBe(6492386);
    expect(ep.rating.voteKey).toBeNull(); // apply falls back to episode:<id> identity
    expect(ep.episodeIds?.tvdb).toBe(6492386);
    expect(ep.showIds?.tvdb).toBe(328638);
    expect(ep.rating.sourceCreatedAt?.toISOString()).toBe('2018-08-16T16:23:51.000Z');

    const movie = res.candidates.find((c) => c.rating.targetType === 'movie')!;
    expect(movie.rating.normalizedRating).toBe(4); // 8 → 4
    expect(movie.movieIds?.imdb).toBe('tt13654226');

    // the favorite's duplicate episode rating did NOT create a second candidate
    expect(res.candidates.filter((c) => c.episodeIds?.tvdb === 6492386)).toHaveLength(1);
    // the list-embedded rating (episode absent from shows.json) is kept
    const unique = res.candidates.find((c) => c.episodeIds?.tvdb === 7575530)!;
    expect(unique.rating.normalizedRating).toBe(3); // 6 → 3
    expect(unique.rating.sourceFile).toBe('lists.json');
  });

  it('never throws on garbage', () => {
    const res = normalizeTvTimeJsonRatings({ shows: [null, 'x', [1]], movies: [null], collections: [null, 42] });
    expect(res.candidates).toHaveLength(0);
  });
});

describe('normalizeTvTimeWatchlistCsv', () => {
  const rows = [
    { imdb_id: '-1', tvdb_id: '328638', type: 'show', title: 'Deception (2018)', is_watchlisted: 'true' },
    { imdb_id: 'tt11769304', tvdb_id: '367083', type: 'show', title: 'Hospital Playlist', is_watchlisted: 'true' },
    { imdb_id: 'tt11739304', tvdb_id: '999999', type: 'show', title: 'Suits, avocats sur mesure', is_watchlisted: 'true' },
    { imdb_id: '-1', tvdb_id: '425787', type: 'show', title: 'Lovely Runner', is_watchlisted: 'false' },
    { imdb_id: 'tt13141250', tvdb_id: '344867', type: 'movie', title: 'The Ritual Killer', is_watchlisted: 'true' },
    { imdb_id: '-1', tvdb_id: '6492386', type: 'episode', title: 'Deception (2018)', is_watchlisted: 'false' },
    { imdb_id: '-1', tvdb_id: '328638', type: 'show', title: 'Deception (2018)', is_watchlisted: 'true' }, // dupe
  ];

  it('keeps only watchlisted show rows, deduped by tvdb id', () => {
    const res = normalizeTvTimeWatchlistCsv(rows);
    expect(res.candidates).toHaveLength(3);
    expect(res.candidates.map((c) => c.title)).toEqual(['Deception', 'Hospital Playlist', 'Suits, avocats sur mesure']);
    expect(res.candidates[0].ids).toEqual({ tvdb: 328638, imdb: null });
    expect(res.candidates[0].year).toBe(2018);
    expect(res.candidates[1].ids.imdb).toBe('tt11769304');
    // movie rows never come from the CSV (movies.json owns the movie watchlist)
    expect(res.candidates.every((c) => c.type === 'show')).toBe(true);
  });

  it('skips title-less watchlisted rows and never throws', () => {
    const res = normalizeTvTimeWatchlistCsv([{ type: 'show', is_watchlisted: 'true' } as any]);
    expect(res.candidates).toHaveLength(0);
    expect(res.skipped).toBe(1);
    expect(normalizeTvTimeWatchlistCsv([]).candidates).toHaveLength(0);
  });
});
