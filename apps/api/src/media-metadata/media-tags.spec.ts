import { MediaType } from '@tvwatch/shared';
import { deriveMediaTagSlugs, parseMediaTagSlugs } from './media-tags';

describe('media tag derivation', () => {
  it('derives regional drama tags from language/country plus drama evidence', () => {
    expect(
      deriveMediaTagSlugs({
        type: MediaType.SHOW,
        genres: ['Drama'],
        language: 'kor',
      }),
    ).toEqual(['k-drama']);
    expect(
      deriveMediaTagSlugs({
        type: MediaType.SHOW,
        genres: ['Drama'],
        countries: ['JP'],
      }),
    ).toEqual(['j-drama']);
    expect(
      deriveMediaTagSlugs({
        type: MediaType.SHOW,
        genres: ['Drama'],
        countries: ['TW'],
      }),
    ).toEqual(['c-drama']);
  });

  it('does not classify Japanese animation as j-drama', () => {
    expect(
      deriveMediaTagSlugs({
        type: MediaType.SHOW,
        genres: ['Drama', 'Animation'],
        language: 'ja',
        keywords: ['anime'],
      }),
    ).not.toContain('j-drama');
  });

  it('derives keyword-backed tags for shows and movies', () => {
    expect(
      deriveMediaTagSlugs({
        type: MediaType.MOVIE,
        keywords: ['True-Crime', 'Isekai'],
      }),
    ).toEqual(['isekai', 'true-crime']);
    expect(
      deriveMediaTagSlugs({
        type: MediaType.SHOW,
        genres: ['Sitcom'],
      }),
    ).toEqual(['sitcom']);
  });

  it('accepts only known, normalized, unique filter slugs', () => {
    expect(parseMediaTagSlugs(' J-Drama,unknown,j-drama,isekai ')).toEqual(['j-drama', 'isekai']);
  });
});
