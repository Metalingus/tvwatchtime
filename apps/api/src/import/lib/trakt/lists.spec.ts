import { normalizeTraktFavorites, normalizeTraktLists, normalizeTraktWatchlist } from './lists';

const SHOW = {
  ids: { trakt: 386, slug: 'spongebob-squarepants', tvdb: 75886, imdb: 'tt0206512', tmdb: 387 },
  year: 1999,
  title: 'SpongeBob SquarePants',
};

const MOVIE = {
  ids: { trakt: 3470, slug: 'carlito-s-way-1993', imdb: 'tt0106519', tmdb: 6075 },
  year: 1993,
  title: "Carlito's Way",
};

describe('normalizeTraktWatchlist', () => {
  it('keeps movie and show rows with rank + listedAt', () => {
    const r = normalizeTraktWatchlist([
      {
        type: 'movie',
        movie: MOVIE,
        rank: 1,
        id: 1519688224,
        listed_at: '2024-07-16T01:08:46.000Z',
        notes: null,
        my_rating: null,
      },
      {
        type: 'show',
        show: SHOW,
        rank: 2,
        id: 1519688276,
        listed_at: '2024-07-16T01:08:54.000Z',
        notes: null,
        my_rating: null,
      },
    ]);
    expect(r.skipped).toBe(0);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toMatchObject({
      type: 'movie',
      title: "Carlito's Way",
      year: 1993,
      rank: 1,
    });
    expect(r.candidates[0].ids.tmdb).toBe(6075);
    expect(r.candidates[0].listedAt?.toISOString()).toBe('2024-07-16T01:08:46.000Z');
    expect(r.candidates[1]).toMatchObject({
      type: 'show',
      title: 'SpongeBob SquarePants',
      rank: 2,
    });
  });

  it('skips season/episode/person rows and garbage', () => {
    const r = normalizeTraktWatchlist([
      { type: 'season', season: { number: 1 }, rank: 3, id: 1, listed_at: null },
      { type: 'episode', episode: { season: 1, number: 2 }, rank: 4, id: 2, listed_at: null },
      { type: 'person', person: { name: 'Keanu Reeves' }, rank: 5, id: 3, listed_at: null },
      { type: 'show', show: { year: 1999 } }, // missing title
      null,
      42,
    ]);
    expect(r.skipped).toBe(6);
    expect(r.candidates).toHaveLength(0);
  });

  it('tolerates non-array input and null rank/listed_at', () => {
    expect(normalizeTraktWatchlist(null)).toEqual({ candidates: [], skipped: 0 });
    expect(normalizeTraktWatchlist({})).toEqual({ candidates: [], skipped: 0 });
    const r = normalizeTraktWatchlist([
      { type: 'show', show: SHOW, rank: null, id: 1, listed_at: 'bad' },
    ]);
    expect(r.candidates[0].rank).toBeNull();
    expect(r.candidates[0].listedAt).toBeNull();
  });
});

describe('normalizeTraktFavorites', () => {
  it('parses favorites rows (same shape as the watchlist)', () => {
    const r = normalizeTraktFavorites([
      { type: 'movie', movie: MOVIE, rank: 1, id: 1519692600, listed_at: '2026-07-16T01:17:18.000Z', notes: null, my_rating: null },
      { type: 'show', show: SHOW, rank: 2, id: 1519692668, listed_at: '2026-07-16T01:17:33.000Z', notes: null, my_rating: null },
      { type: 'person', person: { name: 'Keanu Reeves' }, rank: 3, id: 4, listed_at: null },
    ]);
    expect(r.skipped).toBe(1);
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toMatchObject({ type: 'movie', title: "Carlito's Way", year: 1993, rank: 1 });
    expect(r.candidates[1]).toMatchObject({ type: 'show', title: 'SpongeBob SquarePants', rank: 2 });
    expect(r.candidates[1].ids.tvdb).toBe(75886);
  });

  it('tolerates non-array input', () => {
    expect(normalizeTraktFavorites(undefined)).toEqual({ candidates: [], skipped: 0 });
  });
});

describe('normalizeTraktLists', () => {
  const listsPayload = [
    {
      name: 'My Favorites',
      description: 'Best stuff',
      privacy: 'public',
      created_at: '2024-01-05T10:00:00.000Z',
      updated_at: '2024-01-06T10:00:00.000Z',
      item_count: 3,
      ids: { trakt: 12345, slug: 'my-favorites' },
      items: [
        { type: 'movie', movie: MOVIE, listed_at: '2024-01-05T10:00:00.000Z' },
        { type: 'show', show: SHOW, listed_at: '2024-01-06T10:00:00.000Z' },
        { type: 'person', person: { name: 'Keanu Reeves' } },
      ],
    },
    {
      name: 'Private One',
      description: null,
      privacy: 'private',
      created_at: null,
      updated_at: null,
      item_count: 0,
      ids: { trakt: null, slug: 'private-one' },
      // no items key at all
    },
    { description: 'no name', ids: { trakt: 9 } }, // skipped
  ];

  it('parses lists with visibility, sourceKey, and ordered items', () => {
    const r = normalizeTraktLists(listsPayload);
    expect(r.skippedLists).toBe(1);
    expect(r.lists).toHaveLength(2);

    const pub = r.lists[0];
    expect(pub.sourceKey).toBe('trakt:list:12345');
    expect(pub.title).toBe('My Favorites');
    expect(pub.description).toBe('Best stuff');
    expect(pub.visibility).toBe('PUBLIC');
    expect(pub.createdAt?.toISOString()).toBe('2024-01-05T10:00:00.000Z');
    expect(pub.items).toHaveLength(2);
    expect(pub.items[0]).toMatchObject({ mediaType: 'movie', title: "Carlito's Way", order: 1 });
    expect(pub.items[0].createdAt?.toISOString()).toBe('2024-01-05T10:00:00.000Z');
    expect(pub.items[1]).toMatchObject({
      mediaType: 'show',
      title: 'SpongeBob SquarePants',
      order: 2,
    });
    expect(pub.skippedItems).toBe(1); // the person item
  });

  it('uses slug (then index) for sourceKey, defaults PRIVATE, tolerates missing items', () => {
    const r = normalizeTraktLists(listsPayload);
    const priv = r.lists[1];
    expect(priv.sourceKey).toBe('trakt:list:private-one');
    expect(priv.visibility).toBe('PRIVATE');
    expect(priv.description).toBeNull();
    expect(priv.createdAt).toBeNull();
    expect(priv.items).toEqual([]);
    expect(priv.skippedItems).toBe(0);

    const withIndex = normalizeTraktLists([{ name: 'No ids', privacy: 'friends' }]);
    expect(withIndex.lists[0].sourceKey).toBe('trakt:list:0');
    expect(withIndex.lists[0].visibility).toBe('PRIVATE'); // only 'public' is public
  });

  it('handles empty array and non-array input', () => {
    expect(normalizeTraktLists([])).toEqual({ lists: [], skippedLists: 0 });
    expect(normalizeTraktLists(null)).toEqual({ lists: [], skippedLists: 0 });
    expect(normalizeTraktLists('nope')).toEqual({ lists: [], skippedLists: 0 });
  });

  it('counts malformed items into skippedItems', () => {
    const r = normalizeTraktLists([
      {
        name: 'Mixed',
        ids: { trakt: 1 },
        items: [
          { type: 'movie', movie: { year: 1993 } }, // no title
          'garbage',
          { type: 'episode', episode: { season: 1, number: 1 } },
        ],
      },
    ]);
    expect(r.lists[0].items).toHaveLength(0);
    expect(r.lists[0].skippedItems).toBe(3);
  });
});
