// TV Time emotion import: mapping resolution, normalization, and dedup.
//
// Emotion files carry NO literal `set` column. The emotion id lives in the final hyphen
// segment of `vote_key` (movie keys embed a UUID), or in an explicit `emotion_id` column.
// Modern episode/movie vote files use the verified `12_all` set. Legacy `episode_emotion.csv`
// uses old ids (1,3,6,7,…) that are NOT in `12_all` → skipped with a warning, never guessed.
//
// Stored values are the stable ReactionType enum identifiers (e.g. UNDERSTANDING), never
// English display labels; the UI i18n layer translates them.

import { parseDate } from './inference';

/**
 * Verified modern emotion set (order 28..39). NOTE: TV Time id 36 maps to the DB enum value
 * `UNDERSTANDING` (the internal identifier), not the label "UNDERSTOOD".
 */
export const TVTIME_EMOTION_MAPPINGS = {
  '12_all': {
    28: 'SHOCKED',
    29: 'FRUSTRATED',
    30: 'SAD',
    31: 'REFLECTIVE',
    32: 'TOUCHED',
    33: 'AMUSED',
    34: 'SCARED',
    35: 'BORED',
    36: 'UNDERSTANDING',
    37: 'THRILLED',
    38: 'CONFUSED',
    39: 'TENSE',
  },
} as const;

export type NormalizedEmotion = string; // ReactionType identifier

export type EmotionTargetType = 'episode' | 'movie';

export interface NormalizedImportedEmotion {
  targetType: EmotionTargetType;
  sourceFile: string;
  sourceRow: number;
  sourceSet: string | null;
  sourceEmotionId: number | null;
  idFromExplicitCol: boolean;
  normalizedEmotion: NormalizedEmotion | null; // null = unsupported
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

export interface EmotionFileResult {
  candidates: NormalizedImportedEmotion[];
  detected: number;
  unsupported: number;
  invalid: number;
}

/** Extract the integer id from the final `-` segment of a vote_key (safe for UUID keys). */
export function parseEmotionVoteId(voteKey: string | undefined | null): number | null {
  if (voteKey == null) return null;
  const s = String(voteKey).trim();
  if (!s || s === '<nil>') return null;
  const last = s.substring(s.lastIndexOf('-') + 1).trim();
  if (!/^\d+$/.test(last)) return null;
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

/** Map a (set, emotionId) pair to a stable emotion identifier using verified mappings only. */
export function mapEmotionId(set: string | null, emotionId: number | null): NormalizedEmotion | null {
  if (emotionId == null) return null;
  const table = (TVTIME_EMOTION_MAPPINGS as Record<string, Record<number, string>>)[set ?? ''];
  if (!table) return null; // unknown set → never guess
  return table[emotionId] ?? null; // id not in this set → null
}

export type EmotionFileKind = 'vote' | 'legacy_explicit' | 'none';

/** Classify an emotion source file by name. Vote files imply `12_all`. */
export function detectEmotionFile(filename: string): EmotionFileKind {
  const f = (filename.replace(/\\/g, '/').split('/').pop() ?? filename).toLowerCase();
  // tv_show_user_emotion_count.csv is an aggregate count table, not votes → out of scope.
  if (f.includes('tv_show_user_emotion_count')) return 'none';
  if (f.startsWith('episode_emotion')) return 'legacy_explicit';
  if (f.startsWith('emotions-')) return 'vote';
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

export function normalizeEmotions(filename: string, rows: Record<string, string>[]): EmotionFileResult {
  const kind = detectEmotionFile(filename);
  const candidates: NormalizedImportedEmotion[] = [];
  let detected = 0;
  let unsupported = 0;
  let invalid = 0;

  if (kind === 'none') return { candidates, detected, unsupported, invalid };

  rows.forEach((row, idx) => {
    const sourceRow = idx + 1;
    try {
      if (kind === 'legacy_explicit') {
        // episode_emotion.csv: explicit emotion_id, but the set is legacy (not 12_all).
        const emotionId = toInt(pick(row, ['emotion_id']));
        if (emotionId == null) {
          invalid++;
          return;
        }
        const mapped = mapEmotionId('12_all', emotionId); // legacy ids are not in 12_all → null
        if (!mapped) {
          unsupported++;
          candidates.push({
            targetType: 'episode',
            sourceFile: filename,
            sourceRow,
            sourceSet: 'legacy',
            sourceEmotionId: emotionId,
            idFromExplicitCol: true,
            normalizedEmotion: null,
            supported: false,
            skipReason: `unsupported_legacy_emotion_id:${emotionId}`,
            sourceCreatedAt: toDate(pick(row, ['created_at'])),
            sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
            voteKey: null,
            externalEpisodeId: toInt(pick(row, ['episode_id'])),
            showTitle: pick(row, ['tv_show_name', 'series_name']),
            seasonNumber: toInt(pick(row, ['episode_season_number', 'season_number', 'season'])),
            episodeNumber: toInt(pick(row, ['episode_number', 'episode'])),
          });
          return;
        }
        detected++;
        candidates.push({
          targetType: 'episode',
          sourceFile: filename,
          sourceRow,
          sourceSet: '12_all',
          sourceEmotionId: emotionId,
          idFromExplicitCol: true,
          normalizedEmotion: mapped,
          supported: true,
          sourceCreatedAt: toDate(pick(row, ['created_at'])),
          sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
          voteKey: null,
          externalEpisodeId: toInt(pick(row, ['episode_id'])),
          showTitle: pick(row, ['tv_show_name', 'series_name']),
          seasonNumber: toInt(pick(row, ['episode_season_number', 'season_number', 'season'])),
          episodeNumber: toInt(pick(row, ['episode_number', 'episode'])),
        });
        return;
      }

      // vote file → 12_all
      const explicitId = toInt(pick(row, ['emotion_id', 'vote_id']));
      const voteKey = pick(row, ['vote_key']);
      const emotionId = explicitId ?? parseEmotionVoteId(voteKey);
      const idFromExplicitCol = explicitId != null;
      if (emotionId == null) {
        invalid++;
        return;
      }
      const mapped = mapEmotionId('12_all', emotionId);
      if (!mapped) {
        unsupported++;
        candidates.push({
          targetType: 'episode',
          sourceFile: filename,
          sourceRow,
          sourceSet: '12_all',
          sourceEmotionId: emotionId,
          idFromExplicitCol,
          normalizedEmotion: null,
          supported: false,
          skipReason: `unsupported_emotion_id:${emotionId}`,
          sourceCreatedAt: toDate(pick(row, ['created_at', 'updated_at'])),
          sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
          voteKey: voteKey ?? null,
        });
        return;
      }
      detected++;

      const movieName = pick(row, ['movie_name', 'movie_title']);
      const seriesName = pick(row, ['series_name', 'tv_show_name', 'show_name']);
      const episodeIdNum = toInt(pick(row, ['episode_id']));
      const season = toInt(pick(row, ['season_number', 'season']));
      const episode = toInt(pick(row, ['episode_number', 'episode']));
      const isMovie = !!movieName && (!episodeIdNum || episodeIdNum === 0) && !seriesName;

      if (isMovie) {
        candidates.push({
          targetType: 'movie',
          sourceFile: filename,
          sourceRow,
          sourceSet: '12_all',
          sourceEmotionId: emotionId,
          idFromExplicitCol,
          normalizedEmotion: mapped,
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
          sourceSet: '12_all',
          sourceEmotionId: emotionId,
          idFromExplicitCol,
          normalizedEmotion: mapped,
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

/** Stable identity for an emotion candidate: target + emotion (a user may have many emotions per target). */
export function emotionIdentity(c: NormalizedImportedEmotion): string {
  let target: string;
  if (c.targetType === 'movie') {
    target = `movie|${(c.movieTitle ?? '').toLowerCase().trim()}`;
  } else if (c.externalEpisodeId != null) {
    target = `episode|ext:${c.externalEpisodeId}`;
  } else {
    target = `episode|${(c.showTitle ?? '').toLowerCase().trim()}|${c.seasonNumber ?? ''}|${c.episodeNumber ?? ''}`;
  }
  return `${target}|${c.normalizedEmotion}`;
}

export interface EmotionDedupeResult {
  unique: NormalizedImportedEmotion[];
  duplicates: number;
}

/**
 * Dedupe by target + normalized emotion (NOT by target alone — multiple emotions per target
 * are retained). On a duplicate, keep the candidate with the most appropriate timestamp.
 */
export function dedupeEmotions(all: NormalizedImportedEmotion[]): EmotionDedupeResult {
  const byKey = new Map<string, NormalizedImportedEmotion>();
  let duplicates = 0;
  for (const c of all) {
    if (!c.supported) continue; // unsupported candidates are not import candidates
    const key = emotionIdentity(c);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
    } else {
      duplicates++;
      const aTime = c.sourceUpdatedAt?.getTime() ?? c.sourceCreatedAt?.getTime() ?? 0;
      const bTime = prev.sourceUpdatedAt?.getTime() ?? prev.sourceCreatedAt?.getTime() ?? 0;
      if (aTime >= bTime) byKey.set(key, c);
    }
  }
  return { unique: [...byKey.values()], duplicates };
}
