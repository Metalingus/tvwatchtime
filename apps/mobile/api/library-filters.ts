import type { LibraryFilters } from '@tvwatch/shared';

export const libraryFilterParams = (filters?: LibraryFilters) => ({
  genre: filters?.genres?.length ? [...filters.genres].sort().join(',') : undefined,
  excludeGenres: filters?.excludeGenres?.length
    ? [...filters.excludeGenres].sort().join(',')
    : undefined,
  country: filters?.country || undefined,
  tags: filters?.tags?.length ? [...filters.tags].sort().join(',') : undefined,
  sort: filters?.sort && filters.sort !== 'addedDate' ? filters.sort : undefined,
});

export const libraryFilterKey = (filters?: LibraryFilters) =>
  [
    ...(filters?.genres ?? []).slice().sort(),
    '|',
    ...(filters?.excludeGenres ?? []).slice().sort(),
    '|',
    filters?.country ?? '',
    '|',
    ...(filters?.tags ?? []).slice().sort(),
    '|',
    filters?.sort ?? 'addedDate',
  ].join(',');
