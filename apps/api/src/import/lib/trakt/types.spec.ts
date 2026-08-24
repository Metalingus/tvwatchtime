import { parseTraktIds, traktIdsKey } from './types';

describe('parseTraktIds authority hygiene', () => {
  it('keeps positive safe provider ids and normalizes IMDb/slug values', () => {
    expect(
      parseTraktIds({
        trakt: '123',
        tmdb: 456,
        tvdb: '789',
        imdb: 'TT0123456',
        slug: '  Some-Title  ',
      }),
    ).toEqual({
      trakt: 123,
      tmdb: 456,
      tvdb: 789,
      imdb: 'tt0123456',
      slug: 'some-title',
    });
  });

  it('drops sentinels, decimals, unsafe integers, and malformed IMDb ids', () => {
    expect(
      parseTraktIds({
        trakt: 0,
        tmdb: -1,
        tvdb: 12.5,
        imdb: '-1',
      }),
    ).toEqual({
      trakt: null,
      tmdb: null,
      tvdb: null,
      imdb: null,
    });
    expect(parseTraktIds({ tmdb: Number.MAX_SAFE_INTEGER + 1 }).tmdb).toBeNull();
  });

  it('keys the complete identity so a reused Trakt id cannot hide provider conflicts', () => {
    expect(traktIdsKey(parseTraktIds({ trakt: 10, tmdb: 20, tvdb: 30 }))).toBe(
      'trakt:10|tmdb:20|tvdb:30',
    );
    expect(traktIdsKey(parseTraktIds({ trakt: 10, tmdb: 21, tvdb: 30 }))).not.toBe(
      traktIdsKey(parseTraktIds({ trakt: 10, tmdb: 20, tvdb: 30 })),
    );
  });
});
