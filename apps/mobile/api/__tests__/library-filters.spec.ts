import type { LibraryFilters } from '@tvwatch/shared';
import { libraryFilterKey, libraryFilterParams } from '../library-filters';

describe('personal-library filters', () => {
  const filters: LibraryFilters = {
    genres: ['drama', 'action'],
    excludeGenres: ['horror'],
    country: 'KR',
    tags: ['k-drama', 'true-crime'],
    sort: 'rating',
  };

  it('serializes every filter deterministically', () => {
    expect(libraryFilterParams(filters)).toEqual({
      genre: 'action,drama',
      excludeGenres: 'horror',
      country: 'KR',
      tags: 'k-drama,true-crime',
      sort: 'rating',
    });
    expect(libraryFilterKey(filters)).toBe(
      libraryFilterKey({
        ...filters,
        genres: ['action', 'drama'],
        tags: ['true-crime', 'k-drama'],
      }),
    );
  });

  it('omits the default order and empty values', () => {
    expect(libraryFilterParams({ sort: 'addedDate' })).toEqual({
      genre: undefined,
      excludeGenres: undefined,
      country: undefined,
      tags: undefined,
      sort: undefined,
    });
  });
});
