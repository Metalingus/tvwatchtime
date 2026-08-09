import { MediaType } from '@tvwatch/shared';
import type { RecommendationItem } from '../providers/tmdb.provider';

function validRecommendation(value: unknown): value is RecommendationItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RecommendationItem>;
  return (
    Number.isSafeInteger(item.tmdbId) &&
    Number(item.tmdbId) > 0 &&
    typeof item.title === 'string' &&
    item.title.trim().length > 0 &&
    (item.type === MediaType.SHOW || item.type === MediaType.MOVIE)
  );
}

export function recommendationItems(value: unknown): RecommendationItem[] {
  return Array.isArray(value) ? value.filter(validRecommendation) : [];
}

/**
 * Merge recommendation lists from every verified TMDB member of one canonical family.
 * Items recommended by several members rank first; provider order, rating and TMDB id
 * provide deterministic tie-breakers. The family itself is always excluded.
 */
export function mergeCanonicalRecommendations(
  sources: readonly RecommendationItem[][],
  familyTmdbIds: ReadonlySet<number>,
  limit = 20,
): RecommendationItem[] {
  const merged = new Map<
    number,
    {
      item: RecommendationItem;
      appearances: number;
      rankScore: number;
      bestRank: number;
    }
  >();
  for (const source of sources) {
    const seenInSource = new Set<number>();
    for (let rank = 0; rank < source.length; rank++) {
      const item = source[rank];
      if (
        familyTmdbIds.has(item.tmdbId) ||
        seenInSource.has(item.tmdbId) ||
        item.type !== MediaType.SHOW
      ) {
        continue;
      }
      seenInSource.add(item.tmdbId);
      const current = merged.get(item.tmdbId);
      if (!current) {
        merged.set(item.tmdbId, {
          item,
          appearances: 1,
          rankScore: 1 / (rank + 1),
          bestRank: rank,
        });
        continue;
      }
      current.appearances++;
      current.rankScore += 1 / (rank + 1);
      current.bestRank = Math.min(current.bestRank, rank);
      if ((item.rating ?? -1) > (current.item.rating ?? -1)) current.item = item;
    }
  }
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.appearances - a.appearances ||
        b.rankScore - a.rankScore ||
        (b.item.rating ?? -1) - (a.item.rating ?? -1) ||
        a.bestRank - b.bestRank ||
        a.item.tmdbId - b.item.tmdbId,
    )
    .slice(0, Math.max(0, limit))
    .map((row) => row.item);
}
