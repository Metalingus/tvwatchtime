import { hasExplicitTvdbAnimeGenre } from './tvdb-anime';

describe('hasExplicitTvdbAnimeGenre', () => {
  it.each([
    [[{ id: 27, name: 'Anime', slug: 'anime' }]],
    [[{ tmdbId: 27, name: 'Anime' }]],
    [[{ name: ' anime ' }]],
    [[{ slug: 'ANIME' }]],
    [['Anime']],
  ])('accepts explicit TVDB Anime evidence: %p', (genres) => {
    expect(hasExplicitTvdbAnimeGenre(genres)).toBe(true);
  });

  it('does not infer anime from Animation or missing genres', () => {
    expect(hasExplicitTvdbAnimeGenre([{ id: 16, name: 'Animation' }])).toBe(false);
    expect(hasExplicitTvdbAnimeGenre(undefined)).toBe(false);
  });
});
