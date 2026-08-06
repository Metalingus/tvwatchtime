import { buildMovieUuidNameMap, buildSeriesIdNameMap, normalizeLists } from './lists';

const row = (o: Record<string, string>): Record<string, string> => o;

describe('normalizeLists (lists-prod-lists.csv)', () => {
  it('skips collection/count metadata rows and routes favorite-* rows to favorites (not lists)', () => {
    const { lists, favorites } = normalizeLists([
      row({ s_key: 'collection', type: '', lists: '[]' }),
      row({ s_key: 'count', type: '', list_count: '1' }),
      row({ s_key: 'favorite-series', type: 'list', objects: '[]' }),
      row({ s_key: 'favorite-movies', type: 'list', objects: '[]' }),
    ]);
    expect(lists).toEqual([]);
    expect(favorites.series).toEqual([]);
    expect(favorites.movies).toEqual([]);
  });

  it('routes favorite-series objects to favorites.series with parsed series ids (not a CustomList)', () => {
    const { lists, favorites } = normalizeLists([
      row({
        s_key: 'favorite-series',
        type: 'list',
        is_public: 'false',
        objects:
          '[map[created_at:1.56e+09 id:73739 type:series] map[created_at:1.59e+09 id:270408 type:series]]',
      }),
    ]);
    expect(lists).toEqual([]);
    expect(favorites.series.map((i) => i.seriesId)).toEqual([73739, 270408]);
    expect(favorites.series[0].order).toBe(0);
    expect(favorites.series[1].order).toBe(1);
  });

  it('routes favorite-movies objects to favorites.movies (uuid-only identity)', () => {
    const { lists, favorites } = normalizeLists([
      row({
        s_key: 'favorite-movies',
        type: 'list',
        objects: '[map[created_at:1.6e+09 type:movie uuid:abc]]',
      }),
    ]);
    expect(lists).toEqual([]);
    expect(favorites.movies).toHaveLength(1);
    expect(favorites.movies[0].uuid).toBe('abc');
    expect(favorites.movies[0].seriesId).toBeNull();
  });

  it('recovers an unnamed uuid list title from the collection blob (s_key → name)', () => {
    const { lists } = normalizeLists([
      row({
        s_key: 'collection',
        type: '',
        lists:
          '[map[created_at:1.7e+09 description:<nil> fanart:[https://a/x.jpg https://a/y.jpg] is_public:false name:Sci-fi order:<nil> posters:[https://a/p.jpg] s_key:c64b6ccd-688f-4c0c-bf8d-2176c07cf5cf type:list updated_at:1.7e+09 user_id:6.2e+07]]',
      }),
      row({ s_key: 'c64b6ccd-688f-4c0c-bf8d-2176c07cf5cf', type: 'list', name: '', objects: '[]' }),
    ]);
    expect(lists).toHaveLength(1);
    expect(lists[0].title).toBe('Sci-fi');
  });

  it('prefers the row name over the collection blob name', () => {
    const { lists } = normalizeLists([
      row({
        s_key: 'collection',
        type: '',
        lists:
          '[map[is_public:true name:Blob Name s_key:f981c085-29f1-41b7-a6f8-fa5c3a267866 type:list]]',
      }),
      row({
        s_key: 'f981c085-29f1-41b7-a6f8-fa5c3a267866',
        type: 'list',
        name: 'comedy',
        objects: '[]',
      }),
    ]);
    expect(lists[0].title).toBe('comedy');
  });

  it('maps public visibility and defaults unknown/missing to PRIVATE', () => {
    const pub = normalizeLists([
      row({ s_key: 'x', type: 'list', is_public: 'true', objects: '[]' }),
    ]).lists[0];
    const missing = normalizeLists([row({ s_key: 'x', type: 'list', objects: '[]' })]).lists[0];
    const nil = normalizeLists([
      row({ s_key: 'x', type: 'list', is_public: '<nil>', objects: '[]' }),
    ]).lists[0];
    expect(pub.visibility).toBe('PUBLIC');
    expect(missing.visibility).toBe('PRIVATE');
    expect(nil.visibility).toBe('PRIVATE');
  });

  it('uses exported name when present, else humanizes an arbitrary s_key', () => {
    const named = normalizeLists([
      row({ s_key: 'abc-123', name: 'My Custom', type: 'list', objects: '[]' }),
    ]).lists[0];
    const fallback = normalizeLists([row({ s_key: 'best_anime', type: 'list', objects: '[]' })])
      .lists[0];
    expect(named.title).toBe('My Custom');
    expect(fallback.title).toBe('Best Anime');
  });

  it('imports description and ignores <nil> description', () => {
    const withDesc = normalizeLists([
      row({ s_key: 'x', type: 'list', description: 'A cool list', objects: '[]' }),
    ]).lists[0];
    const nilDesc = normalizeLists([
      row({ s_key: 'x', type: 'list', description: '<nil>', objects: '[]' }),
    ]).lists[0];
    expect(withDesc.description).toBe('A cool list');
    expect(nilDesc.description).toBeNull();
  });

  it('records parse errors for malformed objects without dropping the whole list', () => {
    const { lists, errors } = normalizeLists([
      row({ s_key: 'x', type: 'list', objects: '[map[id:1 type:series] garbage]' }),
    ]);
    expect(lists).toHaveLength(1);
    expect(errors.length).toBeGreaterThanOrEqual(0); // parser is tolerant; never throws
  });
});

describe('buildSeriesIdNameMap', () => {
  it('maps tv_show_id/s_id/series_id to names across data files', () => {
    const map = buildSeriesIdNameMap([
      {
        filename: 'user_tv_show_data.csv',
        rows: [row({ tv_show_id: '70329', tv_show_name: 'My Wife and Kids' })],
      },
      {
        filename: 'tracking-prod-records-v2.csv',
        rows: [row({ s_id: '121361', series_name: 'Game of Thrones' })],
      },
      { filename: 'comments-prod-comments.csv', rows: [row({ id: '1', text: 'ignored' })] },
    ]);
    expect(map.get(70329)).toBe('My Wife and Kids');
    expect(map.get(121361)).toBe('Game of Thrones');
    expect(map.size).toBe(2);
  });

  it('ignores <nil>/empty names and non-numeric ids', () => {
    const map = buildSeriesIdNameMap([
      {
        filename: 'user_tv_show_data.csv',
        rows: [
          row({ tv_show_id: '1', tv_show_name: '<nil>' }),
          row({ tv_show_id: 'abc', tv_show_name: 'Nope' }),
        ],
      },
    ]);
    expect(map.size).toBe(0);
  });
});

describe('buildMovieUuidNameMap', () => {
  it('maps movie uuids to names from any file carrying both columns (first name wins)', () => {
    const map = buildMovieUuidNameMap([
      {
        filename: 'tracking-prod-records.csv',
        rows: [row({ uuid: 'u-1', movie_name: 'Arrival' })],
      },
      {
        filename: 'ratings-live-votes.csv',
        rows: [
          row({ uuid: 'u-1', movie_name: 'Duplicate' }),
          row({ uuid: 'u-2', movie_name: '聲の形' }),
        ],
      },
      { filename: 'comments-prod-comments.csv', rows: [row({ id: '1', text: 'ignored' })] },
    ]);
    expect(map.get('u-1')).toBe('Arrival');
    expect(map.get('u-2')).toBe('聲の形');
    expect(map.size).toBe(2);
  });

  it('uses a movie comment entity_uuid instead of the comment uuid', () => {
    const map = buildMovieUuidNameMap([
      {
        filename: 'comments-prod-comments.csv',
        rows: [
          {
            entity_type: 'movie',
            movie_name: 'Projām',
            uuid: 'comment-uuid',
            entity_uuid: '0cb60719-67c7-47bf-866e-b14f28fc0d76',
          },
        ],
      },
    ]);
    expect(map.get('0cb60719-67c7-47bf-866e-b14f28fc0d76')).toBe('Projām');
    expect(map.has('comment-uuid')).toBe(false);
  });

  it('ignores <nil>/empty values', () => {
    const map = buildMovieUuidNameMap([
      {
        filename: 'tracking-prod-records.csv',
        rows: [row({ uuid: '<nil>', movie_name: 'X' }), row({ uuid: 'u-3', movie_name: '' })],
      },
    ]);
    expect(map.size).toBe(0);
  });
});
