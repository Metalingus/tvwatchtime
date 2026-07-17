// Trakt rating normalization.
//
// `ratings-{shows,episodes,movies}.json` rows: { rated_at, rating (1..10 int), type, … }.
// Trakt rates on a 1..10 scale; we map to 1..5 via min(5, max(1, round(r / 2))).
// `ratings-seasons.json` has no target in our model — every row counts as unsupported.
//
// voteKey identity: 'trakt:<type>:<trakt id ?? tmdb id>' — for EPISODE ratings the
// episode's own ids are used, never the show's. Null when neither id exists.

import { parseDate } from '../inference';
import type { NormalizedImportedRating } from '../ratings';
import type { TraktFileKind } from './detect';
import { parseTraktIds, type TraktRatingCandidate } from './types';

export interface TraktRatingsResult {
  candidates: TraktRatingCandidate[];
  detected: number;
  unsupported: number;
}

const TARGET_BY_KIND: Partial<Record<TraktFileKind, 'show' | 'episode' | 'movie'>> = {
  ratings_show: 'show',
  ratings_episode: 'episode',
  ratings_movie: 'movie',
};

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

const dateOrNull = (v: unknown): Date | null => (typeof v === 'string' ? parseDate(v) : null);

export function normalizeTraktRatings(
  files: { filename: string; kind: TraktFileKind; data: unknown }[],
): TraktRatingsResult {
  const candidates: TraktRatingCandidate[] = [];
  let detected = 0;
  let unsupported = 0;

  for (const file of files) {
    if (file.kind === 'ratings_season') {
      // Season ratings are out of scope — counted, never imported.
      if (Array.isArray(file.data)) unsupported += file.data.length;
      continue;
    }
    const targetType = TARGET_BY_KIND[file.kind];
    if (!targetType || !Array.isArray(file.data)) continue;

    file.data.forEach((row, idx) => {
      detected++;
      const r = asObj(row);
      const value = r?.rating;
      if (!r || typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
        unsupported++;
        return;
      }
      const base: NormalizedImportedRating = {
        targetType,
        sourceFile: file.filename,
        sourceRow: idx + 1,
        sourceSet: 'trakt',
        sourceRatingId: null,
        idFromExplicitCol: false,
        normalizedRating: Math.min(5, Math.max(1, Math.round(value / 2))),
        supported: true,
        sourceCreatedAt: dateOrNull(r.rated_at),
        sourceUpdatedAt: null,
        voteKey: null,
      };

      if (targetType === 'episode') {
        const ep = asObj(r.episode);
        const show = asObj(r.show);
        const season = numOrNull(ep?.season);
        const number = numOrNull(ep?.number);
        if (season == null || number == null) {
          unsupported++;
          return;
        }
        const episodeIds = parseTraktIds(ep?.ids);
        const showIds = parseTraktIds(show?.ids);
        const idPart = episodeIds.trakt ?? episodeIds.tmdb ?? null;
        candidates.push({
          rating: {
            ...base,
            voteKey: idPart != null ? `trakt:episode:${idPart}` : null,
            externalEpisodeId: episodeIds.tmdb ?? episodeIds.tvdb ?? null,
            showTitle: strOrNull(show?.title),
            seasonNumber: season,
            episodeNumber: number,
          },
          showIds,
          episodeIds,
        });
      } else if (targetType === 'show') {
        const show = asObj(r.show);
        const showIds = parseTraktIds(show?.ids);
        const idPart = showIds.trakt ?? showIds.tmdb ?? null;
        candidates.push({
          rating: {
            ...base,
            voteKey: idPart != null ? `trakt:show:${idPart}` : null,
            showTitle: strOrNull(show?.title),
          },
          showIds,
        });
      } else {
        const movie = asObj(r.movie);
        const movieIds = parseTraktIds(movie?.ids);
        const idPart = movieIds.trakt ?? movieIds.tmdb ?? null;
        candidates.push({
          rating: {
            ...base,
            voteKey: idPart != null ? `trakt:movie:${idPart}` : null,
            movieTitle: strOrNull(movie?.title),
          },
          movieIds,
        });
      }
    });
  }

  return { candidates, detected, unsupported };
}
