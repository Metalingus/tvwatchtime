import type { NormalizedSeason } from './providers/tmdb.provider';

export interface StructureComparison {
  equivalent: boolean;
  comparedAt: Date;
  tmdbEpisodeCount: number;
  tvdbEpisodeCount: number;
  tmdbOnlyCount: number;
  tvdbOnlyCount: number;
  /** Bounded diagnostics for Metadata Health; counts above remain authoritative. */
  tmdbOnlyCoordinates: string[];
  tvdbOnlyCoordinates: string[];
}

const DIAGNOSTIC_LIMIT = 100;

/**
 * Compare both providers' complete regular-episode graphs. Provider failures and partial
 * pagination are rejected before this function; future official episodes still count because
 * the authority decision concerns the full structure, not today's progress denominator.
 */
export function compareCompleteRegularStructures(
  tmdbSeasons: readonly NormalizedSeason[],
  tvdbOfficialSeasons: readonly NormalizedSeason[],
): StructureComparison {
  const coordinates = (seasons: readonly NormalizedSeason[]) => {
    const result = new Set<string>();
    for (const season of seasons) {
      if (season.isSpecial || season.number === 0) continue;
      for (const episode of season.episodes) {
        if (episode.number <= 0) continue;
        result.add(`S${season.number}E${episode.number}`);
      }
    }
    return result;
  };

  const tmdb = coordinates(tmdbSeasons);
  const tvdb = coordinates(tvdbOfficialSeasons);
  const tmdbOnly = [...tmdb].filter((coordinate) => !tvdb.has(coordinate)).sort();
  const tvdbOnly = [...tvdb].filter((coordinate) => !tmdb.has(coordinate)).sort();

  return {
    equivalent: tmdbOnly.length === 0 && tvdbOnly.length === 0,
    comparedAt: new Date(),
    tmdbEpisodeCount: tmdb.size,
    tvdbEpisodeCount: tvdb.size,
    tmdbOnlyCount: tmdbOnly.length,
    tvdbOnlyCount: tvdbOnly.length,
    tmdbOnlyCoordinates: tmdbOnly.slice(0, DIAGNOSTIC_LIMIT),
    tvdbOnlyCoordinates: tvdbOnly.slice(0, DIAGNOSTIC_LIMIT),
  };
}
