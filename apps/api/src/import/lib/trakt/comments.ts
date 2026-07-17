// Trakt comment normalization.
//
// PRIVACY: comment text is personal content. This module NEVER logs text,
// usernames, or full rows — it only returns normalized candidates and counts.
//
// `comments-{episodes,movies,shows}.json` rows (Trakt docs shape):
//   { id, parent_id, comment, spoiler, review, created_at, updated_at,
//     episode?: { season, number, ids }, show?: { title, year, ids },
//     movie?: { title, year, ids } }
// Only TOP-LEVEL comments (parent_id falsy) are imported. `review === true`
// rows are still imported as comments. Season/list comment files are ignored.

import { parseDate } from '../inference';
import type { NormalizedImportedComment } from '../comments';
import type { TraktFileKind } from './detect';
import { parseTraktIds, type TraktCommentCandidate } from './types';

export interface TraktCommentsResult {
  candidates: TraktCommentCandidate[];
  rowsDetected: number;
  repliesSkipped: number;
  invalid: number;
}

const TARGET_BY_KIND: Partial<Record<TraktFileKind, 'episode' | 'movie' | 'show'>> = {
  comments_episode: 'episode',
  comments_movie: 'movie',
  comments_show: 'show',
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

export function normalizeTraktComments(
  files: { filename: string; kind: TraktFileKind; data: unknown }[],
): TraktCommentsResult {
  const candidates: TraktCommentCandidate[] = [];
  let rowsDetected = 0;
  let repliesSkipped = 0;
  let invalid = 0;

  for (const file of files) {
    const targetType = TARGET_BY_KIND[file.kind];
    if (!targetType || !Array.isArray(file.data)) continue;

    file.data.forEach((row, idx) => {
      rowsDetected++;
      const r = asObj(row);
      if (!r) {
        invalid++;
        return;
      }
      if (r.parent_id) {
        repliesSkipped++; // top-level comments only
        return;
      }
      if (r.id == null) {
        invalid++;
        return;
      }
      const text = typeof r.comment === 'string' ? r.comment : '';
      if (!text.trim()) {
        invalid++;
        return;
      }
      const base: NormalizedImportedComment = {
        targetType,
        sourceFile: file.filename,
        sourceRow: idx + 1,
        sourceCommentId: String(r.id),
        sourceAuthorId: null,
        text,
        textLength: text.length,
        spoiler: !!r.spoiler,
        language: null,
        sourceCreatedAt: dateOrNull(r.created_at),
        sourceUpdatedAt: dateOrNull(r.updated_at),
        image: null,
      };

      if (targetType === 'episode') {
        const ep = asObj(r.episode);
        const show = asObj(r.show);
        const season = numOrNull(ep?.season);
        const number = numOrNull(ep?.number);
        const showTitle = strOrNull(show?.title);
        if (season == null || number == null || !showTitle) {
          invalid++;
          return;
        }
        const episodeIds = parseTraktIds(ep?.ids);
        const showIds = parseTraktIds(show?.ids);
        candidates.push({
          comment: {
            ...base,
            externalEpisodeId: episodeIds.tmdb ?? episodeIds.tvdb ?? null,
            showTitle,
            seasonNumber: season,
            episodeNumber: number,
          },
          showIds,
          episodeIds,
        });
      } else if (targetType === 'movie') {
        const movie = asObj(r.movie);
        const movieIds = parseTraktIds(movie?.ids);
        candidates.push({
          comment: { ...base, movieTitle: strOrNull(movie?.title) },
          movieIds,
        });
      } else {
        const show = asObj(r.show);
        const showIds = parseTraktIds(show?.ids);
        candidates.push({
          comment: { ...base, showTitle: strOrNull(show?.title) },
          showIds,
        });
      }
    });
  }

  return { candidates, rowsDetected, repliesSkipped, invalid };
}
