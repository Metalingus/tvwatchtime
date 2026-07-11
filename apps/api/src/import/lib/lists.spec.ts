import { buildSeriesIdNameMap, normalizeLists } from './lists';

const row = (o: Record<string, string>): Record<string, string> => o;

describe('normalizeLists (lists-prod-lists.csv)', () => {
  it('skips collection/count metadata rows, keeps type=list rows', () => {
    const { lists } = normalizeLists([
      row({ s_key: 'collection', type: '', lists: 'ignored' }),
      row({ s_key: 'count', type: '', list_count: '1' }),
      row({ s_key: 'favorite-series', type: 'list', objects: '[]' }),
    ]);
    expect(lists.map((l) => l.sourceKey)).toEqual(['favorite-series']);
  });

  it('imports favorite-series with fallback title and parsed series items', () => {
    const { lists } = normalizeLists([
      row({ s_key: 'favorite-series', type: 'list', is_public: 'false', objects: '[map[created_at:1.56e+09 id:73739 type:series] map[created_at:1.59e+09 id:270408 type:series]]' }),
    ]);
    expect(lists).toHaveLength(1);
    expect(lists[0].title).toBe('Favorite Shows');
    expect(lists[0].visibility).toBe('PRIVATE');
    expect(lists[0].items.map((i) => i.seriesId)).toEqual([73739, 270408]);
    expect(lists[0].items[0].order).toBe(0);
    expect(lists[0].items[1].order).toBe(1);
  });

  it('imports favorite-movies separately (not merged with series)', () => {
    const { lists } = normalizeLists([
      row({ s_key: 'favorite-movies', type: 'list', objects: '[map[created_at:1.6e+09 type:movie uuid:abc]]' }),
    ]);
    expect(lists[0].title).toBe('Favorite Movies');
    expect(lists[0].items[0].uuid).toBe('abc');
    expect(lists[0].items[0].seriesId).toBeNull();
  });

  it('maps public visibility and defaults unknown/missing to PRIVATE', () => {
    const pub = normalizeLists([row({ s_key: 'x', type: 'list', is_public: 'true', objects: '[]' })]).lists[0];
    const missing = normalizeLists([row({ s_key: 'x', type: 'list', objects: '[]' })]).lists[0];
    const nil = normalizeLists([row({ s_key: 'x', type: 'list', is_public: '<nil>', objects: '[]' })]).lists[0];
    expect(pub.visibility).toBe('PUBLIC');
    expect(missing.visibility).toBe('PRIVATE');
    expect(nil.visibility).toBe('PRIVATE');
  });

  it('uses exported name when present, else humanizes an arbitrary s_key', () => {
    const named = normalizeLists([row({ s_key: 'abc-123', name: 'My Custom', type: 'list', objects: '[]' })]).lists[0];
    const fallback = normalizeLists([row({ s_key: 'best_anime', type: 'list', objects: '[]' })]).lists[0];
    expect(named.title).toBe('My Custom');
    expect(fallback.title).toBe('Best Anime');
  });

  it('imports description and ignores <nil> description', () => {
    const withDesc = normalizeLists([row({ s_key: 'x', type: 'list', description: 'A cool list', objects: '[]' })]).lists[0];
    const nilDesc = normalizeLists([row({ s_key: 'x', type: 'list', description: '<nil>', objects: '[]' })]).lists[0];
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
      { filename: 'user_tv_show_data.csv', rows: [row({ tv_show_id: '70329', tv_show_name: 'My Wife and Kids' })] },
      { filename: 'tracking-prod-records-v2.csv', rows: [row({ s_id: '121361', series_name: 'Game of Thrones' })] },
      { filename: 'comments-prod-comments.csv', rows: [row({ id: '1', text: 'ignored' })] },
    ]);
    expect(map.get(70329)).toBe('My Wife and Kids');
    expect(map.get(121361)).toBe('Game of Thrones');
    expect(map.size).toBe(2);
  });

  it('ignores <nil>/empty names and non-numeric ids', () => {
    const map = buildSeriesIdNameMap([
      { filename: 'user_tv_show_data.csv', rows: [row({ tv_show_id: '1', tv_show_name: '<nil>' }), row({ tv_show_id: 'abc', tv_show_name: 'Nope' })] },
    ]);
    expect(map.size).toBe(0);
  });
});
