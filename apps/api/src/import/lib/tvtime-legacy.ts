import { ImportEntityType } from '@prisma/client';
import { normTitle, normalizeNumericExternalId, type NormalizedItem } from './inference';

const DELETED_PLACEHOLDER_NORM = 'will be deleted';
const FATEFUL_CONSEQUENCES_NORM = 'arrested development fateful consequences';
const ARRESTED_DEVELOPMENT_NORM = 'arrested development';
const FATEFUL_CONSEQUENCES_TVDB_ID = '349062';
const ARRESTED_DEVELOPMENT_TVDB_ID = '72173';

export const DRAGON_BALL_MOVIES_LEGACY_GROUP = {
  normalizedTitle: 'dragon ball movies',
  tvdbSeriesId: '352423',
  axis: 'episode' as const,
  season: 1,
  tmdbMovieIds: [
    28609, // Dead Zone
    39100, // The World's Strongest
    39101, // The Tree of Might
    39102, // Lord Slug
    24752, // Cooler's Revenge
    39103, // The Return of Cooler
    39104, // Super Android 13!
    34433, // Broly – The Legendary Super Saiyan
    39105, // Bojack Unbound
    44251, // Broly – Second Coming
    39106, // Bio-Broly
    39107, // Fusion Reborn
    39108, // Wrath of the Dragon
  ],
} as const;

export function isIgnoredTvTimePlaceholderTitle(title: string | null | undefined): boolean {
  return !!title && normTitle(title) === DELETED_PLACEHOLDER_NORM;
}

export type LegacyMainItemReconciliation = {
  items: NormalizedItem[];
  ignoredCount: number;
  /** Exact show titles whose episode interactions cannot be mapped honestly to canonical cuts. */
  suppressedExtraShowNorms: Set<string>;
};

/**
 * Handle two known TV Time catalogue artifacts before provider matching:
 *
 * - discard the literal deleted-record placeholder;
 * - convert a complete 22-part Fateful Consequences footprint into a completed canonical
 *   Arrested Development season 4. The recut is a many-to-many edit of the original 15
 *   episodes, so its per-episode interactions are deliberately suppressed instead of being
 *   attached to arbitrary canonical episodes.
 */
export function reconcileTvTimeLegacyMainItems(
  input: NormalizedItem[],
): LegacyMainItemReconciliation {
  let ignoredCount = 0;
  const withoutPlaceholders = input.filter((item) => {
    if (!isIgnoredTvTimePlaceholderTitle(item.title)) return true;
    ignoredCount++;
    return false;
  });

  const fatefulRows = withoutPlaceholders.filter(
    (item) => item.normTitle === FATEFUL_CONSEQUENCES_NORM,
  );
  const hasAuthoritativeIdentity = fatefulRows.some(
    (item) => normalizeNumericExternalId(item.rawTvdbSeriesId) === FATEFUL_CONSEQUENCES_TVDB_ID,
  );
  const watchedCoordinates = new Set(
    fatefulRows
      .filter(
        (item) =>
          item.entityType === ImportEntityType.WATCHED_EPISODE &&
          item.season === 4 &&
          item.episode != null &&
          item.episode >= 1 &&
          item.episode <= 22,
      )
      .map((item) => item.episode!),
  );
  const hasOnlyKnownWatchedCoordinates = fatefulRows
    .filter((item) => item.entityType === ImportEntityType.WATCHED_EPISODE)
    .every(
      (item) =>
        item.season === 4 && item.episode != null && item.episode >= 1 && item.episode <= 22,
    );
  const completeRecut =
    hasAuthoritativeIdentity &&
    hasOnlyKnownWatchedCoordinates &&
    watchedCoordinates.size === 22 &&
    Array.from({ length: 22 }, (_, index) => index + 1).every((episode) =>
      watchedCoordinates.has(episode),
    );

  if (!completeRecut) {
    return {
      items: withoutPlaceholders,
      ignoredCount,
      suppressedExtraShowNorms: new Set(),
    };
  }

  const sourceWatched = fatefulRows.filter(
    (item) => item.entityType === ImportEntityType.WATCHED_EPISODE,
  );
  const latestWatchedAt = sourceWatched.reduce<Date | null>((latest, item) => {
    if (!item.watchedAt) return latest;
    return !latest || item.watchedAt > latest ? item.watchedAt : latest;
  }, null);
  const sourceRaw = sourceWatched[0]?.raw ?? {};
  const sourceEntityTypes = new Set(fatefulRows.map((item) => item.entityType));
  const result = withoutPlaceholders.filter((item) => {
    if (item.normTitle !== FATEFUL_CONSEQUENCES_NORM) return true;
    ignoredCount++;
    return false;
  });

  const existingCanonicalEpisodes = new Set(
    result
      .filter(
        (item) =>
          item.entityType === ImportEntityType.WATCHED_EPISODE &&
          item.normTitle === ARRESTED_DEVELOPMENT_NORM &&
          item.season === 4 &&
          item.episode != null,
      )
      .map((item) => item.episode!),
  );
  for (let episode = 1; episode <= 15; episode++) {
    if (existingCanonicalEpisodes.has(episode)) continue;
    result.push({
      entityType: ImportEntityType.WATCHED_EPISODE,
      title: 'Arrested Development',
      normTitle: ARRESTED_DEVELOPMENT_NORM,
      season: 4,
      episode,
      watchedAt: latestWatchedAt,
      watchCount: 1,
      rawTvdbSeriesId: ARRESTED_DEVELOPMENT_TVDB_ID,
      rawTvdbEpisodeId: null,
      isUnitary: false,
      raw: {
        ...sourceRaw,
        legacy_mapping: 'fateful-consequences-complete-season-4',
      },
    });
  }

  for (const entityType of [ImportEntityType.WATCHLIST_SHOW, ImportEntityType.FAVORITE_SHOW]) {
    if (!sourceEntityTypes.has(entityType)) continue;
    const alreadyPresent = result.some(
      (item) => item.entityType === entityType && item.normTitle === ARRESTED_DEVELOPMENT_NORM,
    );
    if (alreadyPresent) continue;
    result.push({
      entityType,
      title: 'Arrested Development',
      normTitle: ARRESTED_DEVELOPMENT_NORM,
      rawTvdbSeriesId: ARRESTED_DEVELOPMENT_TVDB_ID,
      isUnitary: false,
      raw: {
        ...sourceRaw,
        legacy_mapping: 'fateful-consequences-canonical-show',
      },
    });
  }

  return {
    items: result,
    ignoredCount,
    suppressedExtraShowNorms: new Set([FATEFUL_CONSEQUENCES_NORM]),
  };
}

export function shouldSuppressLegacyExtraTitle(
  title: string | null | undefined,
  suppressedExtraShowNorms: Set<string>,
): boolean {
  if (!title) return false;
  return isIgnoredTvTimePlaceholderTitle(title) || suppressedExtraShowNorms.has(normTitle(title));
}
