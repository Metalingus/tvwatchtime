// TV Time rating import: mapping resolution, normalization, and dedup.
//
// TV Time rating files carry NO literal `set` column. The rating id always lives in the
// final hyphen-segment of `vote_key` (movie keys embed a UUID full of hyphens — only the
// LAST segment is the id), or in an explicit `rating_id` column when present. The "set" is
// implied by the source file: episode/movie vote files use `stars_wording_scalev2`;
// `tv_show_rate.csv` carries a direct 1..5 numeric `rating` for a whole show.
//
// Only the verified `stars_wording_scalev2` mapping is applied. Unknown ids / sets are
// skipped with a warning and counted — never guessed.

import { parseDate } from './inference';

export type RatingTargetType = 'episode' | 'movie' | 'show';

/** Verified modern rating set (order 1,27,28,29,3). */
export const TVTIME_RATING_MAPPINGS = {
  stars_wording_scalev2: { 1: 1, 27: 2, 28: 3, 29: 4, 3: 5 },
} as const;

export const STARS_V2_ORDER = [1, 27, 28, 29, 3] as const;

export interface NormalizedImportedRating {
  targetType: RatingTargetType;
  sourceFile: string;
  sourceRow: number;
  sourceSet: string | null;
  sourceRatingId: number | null;
  /** Whether the id came from an explicit `rating_id` column (preferred) vs vote_key fallback. */
  idFromExplicitCol: boolean;
  normalizedRating: number | null; // 1..5 once resolved; null = unsupported
  supported: boolean;
  skipReason?: string;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
  voteKey: string | null;
  // match inputs:
  externalEpisodeId?: string | number | null;
  showTitle?: string | null;
  movieTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

export interface RatingFileResult {
  candidates: NormalizedImportedRating[];
  detected: number;
  unsupported: number;
  invalid: number;
}

/** Extract the integer id from the final `-` segment of a vote_key (safe for UUID keys). */
export function parseVoteId(voteKey: string | undefined | null): number | null {
  if (voteKey == null) return null;
  const s = String(voteKey).trim();
  if (!s || s === '<nil>') return null;
  const last = s.substring(s.lastIndexOf('-') + 1).trim();
  if (!/^\d+$/.test(last)) return null;
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map a (set, ratingId) pair to a 1..5 star value using verified mappings only.
 * Returns null for unknown sets or ids — callers must skip + warn, never guess.
 */
export function mapRatingId(set: string | null, ratingId: number | null): number | null {
  if (ratingId == null) return null;
  if (set === 'stars_wording_scalev2') {
    const table = (TVTIME_RATING_MAPPINGS as Record<string, Record<number, number>>).stars_wording_scalev2;
    if (ratingId in table) return table[ratingId];
    // Position-derived fallback within this recognized set only (consistent with the table).
    const pos = STARS_V2_ORDER.indexOf(ratingId as (typeof STARS_V2_ORDER)[number]);
    if (pos >= 0) return pos + 1;
    return null; // unsupported id within the recognized set (e.g. id 20)
  }
  return null; // unknown set
}

export type RatingFileKind = 'vote' | 'direct_show' | 'none';

/** Classify a rating source file by name. Vote files imply `stars_wording_scalev2`. */
export function detectRatingFile(filename: string): RatingFileKind {
  const f = (filename.replace(/\\/g, '/').split('/').pop() ?? filename).toLowerCase();
  if (f.startsWith('tv_show_rate')) return 'direct_show';
  // ratings-prod-episode_votes, ratings-3-…, ratings-v2-prod-votes, ratings-live-votes
  if (f.startsWith('ratings-')) return 'vote';
  return 'none';
}

const pick = (row: Record<string, string>, keys: string[]): string | undefined => {
  for (const k of Object.keys(row)) {
    if (keys.includes(k.toLowerCase().trim())) {
      const v = row[k];
      const s = v == null ? undefined : String(v).trim();
      return !s || s === '<nil>' ? undefined : s;
    }
  }
  return undefined;
};

const toInt = (v: string | undefined): number | null => {
  if (v == null) return null;
  const digits = String(v).replace(/[^\d-]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
};

const toDate = (v: string | undefined): Date | null => parseDate(v);

/**
 * Normalize every row of a rating file into rating candidates.
 * Unsupported ids/sets and malformed rows are counted but never throw.
 */
export function normalizeRatings(filename: string, rows: Record<string, string>[]): RatingFileResult {
  const kind = detectRatingFile(filename);
  const candidates: NormalizedImportedRating[] = [];
  let detected = 0;
  let unsupported = 0;
  let invalid = 0;

  if (kind === 'none') return { candidates, detected, unsupported, invalid };

  rows.forEach((row, idx) => {
    const sourceRow = idx + 1;
    try {
      if (kind === 'direct_show') {
        const rating = toInt(pick(row, ['rating']));
        const showTitle = pick(row, ['tv_show_name', 'show_name', 'name']);
        if (rating == null || !showTitle) {
          invalid++;
          return;
        }
        if (rating < 1 || rating > 5) {
          unsupported++;
          candidates.push({
            targetType: 'show',
            sourceFile: filename,
            sourceRow,
            sourceSet: null,
            sourceRatingId: null,
            idFromExplicitCol: true,
            normalizedRating: null,
            supported: false,
            skipReason: `out_of_range_direct_rating:${rating}`,
            sourceCreatedAt: toDate(pick(row, ['created_at'])),
            sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
            voteKey: null,
            showTitle,
          });
          return;
        }
        detected++;
        candidates.push({
          targetType: 'show',
          sourceFile: filename,
          sourceRow,
          sourceSet: null,
          sourceRatingId: null,
          idFromExplicitCol: true,
          normalizedRating: rating,
          supported: true,
          sourceCreatedAt: toDate(pick(row, ['created_at'])),
          sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
          voteKey: null,
          showTitle,
        });
        return;
      }

      // vote file → stars_wording_scalev2
      const explicitId = toInt(pick(row, ['rating_id', 'vote_id']));
      const voteKey = pick(row, ['vote_key']);
      const ratingId = explicitId ?? parseVoteId(voteKey);
      const idFromExplicitCol = explicitId != null;
      if (ratingId == null) {
        invalid++;
        return;
      }
      const stars = mapRatingId('stars_wording_scalev2', ratingId);
      if (stars == null) {
        unsupported++;
        candidates.push({
          targetType: 'episode',
          sourceFile: filename,
          sourceRow,
          sourceSet: 'stars_wording_scalev2',
          sourceRatingId: ratingId,
          idFromExplicitCol,
          normalizedRating: null,
          supported: false,
          skipReason: `unsupported_rating_id:${ratingId}`,
          sourceCreatedAt: toDate(pick(row, ['created_at', 'updated_at'])),
          sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
          voteKey: voteKey ?? null,
        });
        return;
      }
      detected++;

      // Resolve target from columns. Movie when movie_name present (episode_id 0/absent);
      // episode when episode_id>0 or series_name+season+episode present.
      const movieName = pick(row, ['movie_name', 'movie_title']);
      const seriesName = pick(row, ['series_name', 'tv_show_name', 'show_name']);
      const episodeIdRaw = pick(row, ['episode_id']);
      const episodeIdNum = toInt(episodeIdRaw);
      const season = toInt(pick(row, ['season_number', 'season']));
      const episode = toInt(pick(row, ['episode_number', 'episode']));
      const isMovie = !!movieName && (!episodeIdNum || episodeIdNum === 0) && !seriesName;

      if (isMovie) {
        candidates.push({
          targetType: 'movie',
          sourceFile: filename,
          sourceRow,
          sourceSet: 'stars_wording_scalev2',
          sourceRatingId: ratingId,
          idFromExplicitCol,
          normalizedRating: stars,
          supported: true,
          sourceCreatedAt: toDate(pick(row, ['created_at', 'updated_at'])),
          sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
          voteKey: voteKey ?? null,
          movieTitle: movieName,
        });
      } else {
        candidates.push({
          targetType: 'episode',
          sourceFile: filename,
          sourceRow,
          sourceSet: 'stars_wording_scalev2',
          sourceRatingId: ratingId,
          idFromExplicitCol,
          normalizedRating: stars,
          supported: true,
          sourceCreatedAt: toDate(pick(row, ['created_at', 'updated_at'])),
          sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
          voteKey: voteKey ?? null,
          externalEpisodeId: episodeIdNum ?? null,
          showTitle: seriesName ?? null,
          seasonNumber: season,
          episodeNumber: episode,
        });
      }
    } catch {
      invalid++;
    }
  });

  return { candidates, detected, unsupported, invalid };
}

/** Source-file freshness priority for same-target rating dedup (no timestamps on vote files). */
export function ratingFilePriority(filename: string): number {
  const f = filename.toLowerCase();
  if (f.includes('ratings-live')) return 5;
  if (f.includes('ratings-v2')) return 4;
  if (f.includes('ratings-3')) return 3;
  if (f.includes('ratings-prod')) return 2;
  if (f.includes('tv_show_rate')) return 1;
  return 0;
}

/** Stable identity for a rating candidate, used to dedup before matching. */
export function ratingIdentity(c: NormalizedImportedRating): string {
  if (c.targetType === 'episode') {
    if (c.externalEpisodeId != null) return `episode|ext:${c.externalEpisodeId}`;
    const t = (c.showTitle ?? '').toLowerCase().trim();
    return `episode|${t}|${c.seasonNumber ?? ''}|${c.episodeNumber ?? ''}`;
  }
  if (c.targetType === 'movie') return `movie|${(c.movieTitle ?? '').toLowerCase().trim()}`;
  return `show|${(c.showTitle ?? '').toLowerCase().trim()}`;
}

/** True if `a` should win over `b` for the same target. */
function ratingBetter(a: NormalizedImportedRating, b: NormalizedImportedRating): boolean {
  // 1) supported (resolved) over unsupported
  if (a.supported !== b.supported) return a.supported;
  // 2) recognized set over none (direct show ratings are their own path)
  const aSet = a.sourceSet != null || a.targetType === 'show' ? 1 : 0;
  const bSet = b.sourceSet != null || b.targetType === 'show' ? 1 : 0;
  if (aSet !== bSet) return aSet > bSet;
  // 3) explicit rating id over vote-key fallback
  if (a.idFromExplicitCol !== b.idFromExplicitCol) return a.idFromExplicitCol;
  // 4) latest valid updated timestamp
  const au = a.sourceUpdatedAt?.getTime() ?? 0;
  const bu = b.sourceUpdatedAt?.getTime() ?? 0;
  if (au !== bu) return au > bu;
  // 5) latest valid created timestamp
  const ac = a.sourceCreatedAt?.getTime() ?? 0;
  const bc = b.sourceCreatedAt?.getTime() ?? 0;
  if (ac !== bc) return ac > bc;
  // 6) source-file priority
  return ratingFilePriority(a.sourceFile) > ratingFilePriority(b.sourceFile);
}

export interface RatingDedupeResult {
  unique: NormalizedImportedRating[];
  duplicates: number;
}

/** Keep at most one rating per target, choosing the winner by `ratingBetter`. */
export function dedupeRatings(all: NormalizedImportedRating[]): RatingDedupeResult {
  const byKey = new Map<string, NormalizedImportedRating>();
  let duplicates = 0;
  for (const c of all) {
    const key = ratingIdentity(c);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
    } else {
      duplicates++;
      if (ratingBetter(c, prev)) byKey.set(key, c);
    }
  }
  return { unique: [...byKey.values()], duplicates };
}
