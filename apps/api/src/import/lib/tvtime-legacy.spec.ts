import { ImportEntityType } from '@prisma/client';
import { normTitle, type NormalizedItem } from './inference';
import {
  isIgnoredTvTimePlaceholderTitle,
  reconcileTvTimeLegacyMainItems,
  shouldSuppressLegacyExtraTitle,
} from './tvtime-legacy';

const item = (overrides: Partial<NormalizedItem>): NormalizedItem => ({
  entityType: ImportEntityType.WATCHED_EPISODE,
  title: 'Example',
  normTitle: 'example',
  raw: {},
  ...overrides,
});

describe('TV Time legacy catalogue reconciliation', () => {
  it('ignores only the exact deleted placeholder title', () => {
    expect(isIgnoredTvTimePlaceholderTitle('WILL BE DELETED)')).toBe(true);
    expect(isIgnoredTvTimePlaceholderTitle('A Show That Will Be Deleted')).toBe(false);

    const result = reconcileTvTimeLegacyMainItems([
      item({ title: 'WILL BE DELETED)', normTitle: normTitle('WILL BE DELETED)') }),
      item({ title: 'Real Show', normTitle: 'real show' }),
    ]);

    expect(result.items.map((candidate) => candidate.title)).toEqual(['Real Show']);
    expect(result.ignoredCount).toBe(1);
    expect(shouldSuppressLegacyExtraTitle('WILL BE DELETED)', new Set())).toBe(true);
  });

  it('converts a complete verified Fateful Consequences recut into canonical season 4', () => {
    const recut = Array.from({ length: 22 }, (_, index) =>
      item({
        title: 'Arrested Development: Fateful Consequences',
        normTitle: 'arrested development fateful consequences',
        season: 4,
        episode: index + 1,
        rawTvdbSeriesId: '349062',
        watchedAt: new Date('2019-09-24T12:00:00.000Z'),
      }),
    );
    recut.push(
      item({
        entityType: ImportEntityType.WATCHLIST_SHOW,
        title: 'Arrested Development: Fateful Consequences',
        normTitle: 'arrested development fateful consequences',
        rawTvdbSeriesId: '349062',
      }),
    );

    const result = reconcileTvTimeLegacyMainItems(recut);
    const canonicalEpisodes = result.items.filter(
      (candidate) => candidate.entityType === ImportEntityType.WATCHED_EPISODE,
    );

    expect(result.ignoredCount).toBe(23);
    expect(canonicalEpisodes).toHaveLength(15);
    expect(canonicalEpisodes.map((candidate) => candidate.episode)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(canonicalEpisodes.every((candidate) => candidate.rawTvdbSeriesId === '72173')).toBe(
      true,
    );
    expect(
      result.items.some((candidate) => candidate.entityType === ImportEntityType.WATCHLIST_SHOW),
    ).toBe(true);
    expect(
      shouldSuppressLegacyExtraTitle(
        'Arrested Development: Fateful Consequences',
        result.suppressedExtraShowNorms,
      ),
    ).toBe(true);
  });

  it('does not reinterpret a partial or unverified recut', () => {
    const partial = Array.from({ length: 21 }, (_, index) =>
      item({
        title: 'Arrested Development: Fateful Consequences',
        normTitle: 'arrested development fateful consequences',
        season: 4,
        episode: index + 1,
        rawTvdbSeriesId: '349062',
      }),
    );

    const result = reconcileTvTimeLegacyMainItems(partial);

    expect(result.items).toHaveLength(21);
    expect(result.ignoredCount).toBe(0);
    expect(result.suppressedExtraShowNorms.size).toBe(0);
  });

  it('does not duplicate canonical season rows already present in the archive', () => {
    const recut = Array.from({ length: 22 }, (_, index) =>
      item({
        title: 'Arrested Development: Fateful Consequences',
        normTitle: 'arrested development fateful consequences',
        season: 4,
        episode: index + 1,
        rawTvdbSeriesId: '349062',
      }),
    );
    const canonical = Array.from({ length: 15 }, (_, index) =>
      item({
        title: 'Arrested Development',
        normTitle: 'arrested development',
        season: 4,
        episode: index + 1,
        rawTvdbSeriesId: '72173',
      }),
    );

    const result = reconcileTvTimeLegacyMainItems([...recut, ...canonical]);

    expect(
      result.items.filter(
        (candidate) =>
          candidate.entityType === ImportEntityType.WATCHED_EPISODE &&
          candidate.normTitle === 'arrested development' &&
          candidate.season === 4,
      ),
    ).toHaveLength(15);
  });
});
