// TV Time top-level comment import: owner resolution, reply/activity filtering,
// text validation, normalization, and dedup.
//
// PRIVACY: comment text is personal content. This module NEVER logs text, usernames,
// emails, or full rows. Diagnostics use filename + row number + char count + reason only.
//
// Scope: import ONLY top-level media comments (episode/movie/show) authored by the archive
// owner. Skip replies, nested replies, embedded replies, likes, reports, read markers,
// translations, profile-wall comments, and any comment not authored by the owner.

import { safeLangPref, type SupportedLocale } from '@tvwatch/shared';
import { parseDate } from './inference';
import { parseListObjects } from './list-objects';

export type CommentTargetType = 'episode' | 'movie' | 'show';

export interface NormalizedImportedComment {
  targetType: CommentTargetType;
  sourceFile: string;
  sourceRow: number;
  sourceCommentId: string | null;
  sourceAuthorId: string | null;
  text: string;
  textLength: number;
  spoiler: boolean;
  language: string | null;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
  /** Visual attachment from the `image` column (v2). GIFs are stored by URL; static images are
   *  downloaded + processed via the CommentImage pipeline at apply time. */
  image?: { url: string; format: string } | null;
  // match inputs
  externalEpisodeId?: string | number | null;
  showTitle?: string | null;
  movieTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

export interface CommentFileResult {
  candidates: NormalizedImportedComment[];
  rowsDetected: number;
  topLevelDetected: number;
  repliesSkipped: number; // reply rows + embedded replies inside a parent's `replies` blob
  activityRowsSkipped: number; // likes, reports, read markers, translations, profile-wall, out-of-scope
  otherUsersSkipped: number; // comment-type rows not authored by the owner
  invalid: number; // empty/<nil>/oversized text, ambiguous reply status
}

const PARENT_FIELDS = [
  'parent_comment_id',
  'parent_id',
  'parent_uuid',
  'parent_comment_uuid',
  'reply_to',
  'reply_to_uuid',
  'root_comment_id',
];

const ACTIVITY_FILES = [
  'episode_comment_like',
  'show_comment_like',
  'episode_comments_last_read_date',
  'show_comments_last_read_date',
  'object_like',
  'object_report',
  'comment_translation',
];

export type CommentFileKind =
  | 'comments_prod' // comments-prod-comments.csv (v1 or v2 schema)
  | 'episode_comment' // legacy episode_comment.csv
  | 'show_comment' // legacy show_comment.csv (show/movie main-page comments)
  | 'profile_comment' // profile_comment.csv (out of scope)
  | 'activity' // likes/reports/reads/translations
  | 'none';

/** Classify a comment-related source file by basename. */
export function detectCommentFile(filename: string): CommentFileKind {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename.toLowerCase();
  const f = base.toLowerCase();
  if (f === 'comments-prod-comments.csv' || f.includes('comments-prod-comments')) return 'comments_prod';
  if (f === 'episode_comment.csv' || (f.includes('episode_comment') && !f.includes('like') && !f.includes('read'))) return 'episode_comment';
  // show_comment.csv → show-page comments; exclude show_comment_like / show_comments_last_read_date.
  if (f === 'show_comment.csv' || (f.includes('show_comment') && !f.includes('like') && !f.includes('read'))) return 'show_comment';
  if (f.includes('profile_comment')) return 'profile_comment';
  if (ACTIVITY_FILES.some((a) => f.includes(a))) return 'activity';
  return 'none';
}

const isAbsent = (v: unknown): boolean => {
  if (v == null) return true;
  const s = String(v).trim();
  return s === '' || s === '<nil>';
};

const field = (row: Record<string, string>, keys: string[]): string | undefined => {
  for (const k of Object.keys(row)) {
    if (keys.includes(k.toLowerCase().trim())) {
      return isAbsent(row[k]) ? undefined : row[k];
    }
  }
  return undefined;
};

const toInt = (v: string | undefined): number | null => {
  if (v == null || isAbsent(v)) return null;
  const digits = String(v).replace(/[^\d-]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
};

const toDate = (v: string | undefined): Date | null => parseDate(v);

/** Resolve the archive owner's TV Time user id from user.csv / user_personal_data.csv. */
export function resolveArchiveOwner(files: { filename: string; rows: Record<string, string>[] }[]): string | null {
  const tryId = (v: string | undefined): string | null => {
    if (isAbsent(v)) return null;
    const s = String(v).trim();
    return /^\d+$/.test(s) ? s : null;
  };
  for (const f of files) {
    const base = (f.filename.replace(/\\/g, '/').split('/').pop() ?? f.filename).toLowerCase();
    if (base === 'user.csv') {
      for (const r of f.rows) {
        const id = tryId(r['id']) ?? tryId(r['name']);
        if (id) return id;
      }
    }
  }
  for (const f of files) {
    const base = (f.filename.replace(/\\/g, '/').split('/').pop() ?? f.filename).toLowerCase();
    if (base === 'user_personal_data.csv') {
      for (const r of f.rows) {
        const id = tryId(r['user_id']);
        if (id) return id;
      }
    }
  }
  return null;
}

/**
 * Resolve the archive's TV Time account language from user.csv / user_personal_data.csv.
 * Used as a fallback matching language when the request-language TMDb search fails.
 * Returns a SupportedLocale ('fr', 'es', …) or null.
 */
export function resolveArchiveLanguage(files: { filename: string; rows: Record<string, string>[] }[]): SupportedLocale | null {
  for (const target of ['user.csv', 'user_personal_data.csv']) {
    for (const f of files) {
      const base = (f.filename.replace(/\\/g, '/').split('/').pop() ?? f.filename).toLowerCase();
      if (base !== target) continue;
      for (const r of f.rows) {
        const raw = field(r, ['language', 'lang', 'locale']);
        if (!raw) continue;
        const norm = raw.trim().toLowerCase();
        // Try exact match against supported locales, then the base (e.g. 'fr-fr' → 'fr').
        const pref = safeLangPref(norm);
        if (pref !== 'system') return pref;
        const baseCode = norm.split(/[-_]/)[0];
        const pref2 = safeLangPref(baseCode);
        if (pref2 !== 'system') return pref2;
      }
    }
  }
  return null;
}

/** Count embedded replies inside a Go `[map[...]]` replies blob. Never throws. */
function countEmbeddedReplies(repliesField: string | undefined): number {
  if (isAbsent(repliesField)) return 0;
  try {
    const { objects } = parseListObjects(repliesField);
    return objects.length;
  } catch {
    return 0;
  }
}

/** Validate comment text: trim outer whitespace, preserve internal formatting, reject empty/<nil>. */
function validateText(raw: string | undefined): { text: string; ok: boolean } {
  if (isAbsent(raw)) return { text: '', ok: false };
  // trim only accidental surrounding whitespace; preserve line breaks, unicode, emoji, urls.
  const text = String(raw).replace(/^\s+|\s+$/g, '');
  return { text, ok: text.length > 0 };
}

/**
 * Parse a comment `image` field (Go single-map form: `map[format:png url:https://… width:576]`).
 * Returns { url, format } or null. GIFs are kept as a URL; static images are downloaded at apply.
 */
export function parseImageField(raw: string | undefined | null): { url: string; format: string } | null {
  if (isAbsent(raw)) return null;
  const s = String(raw).trim();
  if (!s || s === 'map[]' || s === '<nil>') return null;
  const urlMatch = s.match(/\burl:([^\s]+)/);
  if (!urlMatch) return null;
  const formatMatch = s.match(/\bformat:([^\s]+)/);
  return { url: urlMatch[1], format: (formatMatch?.[1] ?? '').toLowerCase() };
}

const KNOWN_ACTIVITY_TYPES = new Set(['like', 'report', 'read', 'user-read', 'translation']);
const MAX_COMMENT_LENGTH = 5000; // safety cap; @db.Text is effectively unlimited — skip oversized.

/**
 * Normalize a comment file. Filters to owner-authored, top-level, valid comments only.
 * `ownerId` is the archive owner's TV Time user id (null → no comment import).
 */
export function normalizeComments(
  filename: string,
  rows: Record<string, string>[],
  ownerId: string | null,
): CommentFileResult {
  const kind = detectCommentFile(filename);
  const result: CommentFileResult = {
    candidates: [],
    rowsDetected: 0,
    topLevelDetected: 0,
    repliesSkipped: 0,
    activityRowsSkipped: 0,
    otherUsersSkipped: 0,
    invalid: 0,
  };
  if (kind === 'none') return result;

  result.rowsDetected = rows.length;

  // Out-of-scope files: count rows as activity-skipped, produce no candidates.
  if (kind === 'profile_comment' || kind === 'activity') {
    result.activityRowsSkipped = rows.length;
    return result;
  }

  rows.forEach((row, idx) => {
    const sourceRow = idx + 1;
    const rawType = (field(row, ['type', 'comment_type']) ?? '').toLowerCase().trim();
    const sortKey = (field(row, ['sort_key']) ?? '').toLowerCase();
    const sortStartsWith = (p: string) => sortKey.startsWith(p);

    // Embedded replies (v2 `replies` blob) belong to a parent comment; count and discard.
    const embedded = countEmbeddedReplies(field(row, ['replies']));
    result.repliesSkipped += embedded;

    // Classify the row type. sort_key prefixes: like-*, report-*, user-read-*, comment-*, reply-*.
    const isReplyByType = rawType === 'reply' || sortStartsWith('reply-');
    const isActivityType =
      KNOWN_ACTIVITY_TYPES.has(rawType) ||
      ['like-', 'report-', 'user-read-', 'read-'].some(sortStartsWith);
    const isCommentType = rawType === 'comment' || sortStartsWith('comment-');

    // Parent indicators (any present value → this is a reply).
    const parentVal = PARENT_FIELDS.map((p) => field(row, [p])).find((v) => v != null);
    const depth = toInt(field(row, ['depth']));
    const hasParent = parentVal != null || (depth != null && depth > 0);

    // Activity rows (likes/reports/read markers) — not comments.
    if (isActivityType) {
      result.activityRowsSkipped++;
      return;
    }

    // Replies (own row type or any parent indicator) — skip, never import.
    if (isReplyByType || hasParent) {
      result.repliesSkipped++;
      return;
    }

    // Not a recognized comment row AND not a recognized activity row → ambiguous; skip safely.
    if (!isCommentType) {
      result.invalid++;
      return;
    }

    // Ownership: only the archive owner's authored comments.
    const authorId = field(row, ['user_id']) ?? null;
    if (ownerId == null || authorId !== ownerId) {
      result.otherUsersSkipped++;
      return;
    }

    // Text validation. A comment is valid if it has text OR a visual attachment (image/gif).
    const rawText = field(row, ['text', 'message', 'comment', 'body']);
    const { text, ok } = validateText(rawText);
    const image = parseImageField(field(row, ['image']));
    if (!ok && !image) {
      result.invalid++;
      return;
    }
    if (text.length > MAX_COMMENT_LENGTH) {
      // Decision: skip oversized comments with a warning (no silent truncation).
      result.invalid++;
      return;
    }

    // Target + metadata.
    const movieName = field(row, ['movie_name', 'movie_title']);
    const seriesName = field(row, ['series_name', 'tv_show_name', 'show_name']);
    const entityType = (field(row, ['entity_type']) ?? '').toLowerCase();
    const episodeIdNum = toInt(field(row, ['episode_id']));
    const season = toInt(field(row, ['season_number', 'episode_season_number', 'season']));
    const episode = toInt(field(row, ['episode_number', 'episode']));

    // Determine the comment target. `show_comment.csv` rows are show main-page comments; the
    // v2 unified file carries an explicit entity_type. Movie target from movie fields.
    let targetType: CommentTargetType;
    if (entityType === 'movie' || (movieName && !seriesName && (!episodeIdNum || episodeIdNum === 0))) {
      targetType = 'movie';
    } else if (kind === 'show_comment' || entityType === 'show' || entityType === 'series') {
      targetType = 'show';
    } else {
      targetType = 'episode';
    }

    const spoilerRaw = field(row, ['is_spoiler']);
    const spoilerCount = toInt(field(row, ['spoiler_count']));
    const spoiler = spoilerRaw === 'true' || spoilerRaw === '1' || (spoilerCount != null && spoilerCount > 0);

    const language = field(row, ['lang', 'language']) ?? null;
    const sourceCommentId = field(row, ['comment_uuid', 'uuid', 'id']) ?? null;

    result.topLevelDetected++;
    result.candidates.push({
      targetType,
      sourceFile: filename,
      sourceRow,
      sourceCommentId,
      sourceAuthorId: authorId,
      text,
      textLength: text.length,
      spoiler,
      language,
      sourceCreatedAt: toDate(field(row, ['created_at'])),
      sourceUpdatedAt: toDate(field(row, ['updated_at'])),
      image,
      externalEpisodeId: targetType === 'episode' ? episodeIdNum ?? null : null,
      showTitle: seriesName ?? null,
      movieTitle: movieName ?? null,
      seasonNumber: season,
      episodeNumber: episode,
    });
  });

  return result;
}

/**
 * Stable dedup identity for a comment. Prefer (source=TVTIME, sourceCommentId). When no
 * stable id exists, fall back to a conservative fingerprint (target + exact text + created
 * time) — never merges two comments merely because they share text.
 */
export function commentIdentity(c: NormalizedImportedComment): string {
  if (c.sourceCommentId && c.sourceCommentId.trim()) {
    return `tvtime|${c.sourceCommentId.trim()}`;
  }
  const target =
    c.targetType === 'movie'
      ? `movie|${(c.movieTitle ?? '').toLowerCase().trim()}`
      : c.targetType === 'show'
        ? `show|${(c.showTitle ?? '').toLowerCase().trim()}`
        : `episode|${(c.showTitle ?? '').toLowerCase().trim()}|${c.seasonNumber ?? ''}|${c.episodeNumber ?? ''}|${c.externalEpisodeId ?? ''}`;
  const created = c.sourceCreatedAt?.getTime() ?? 0;
  // Lightweight stable hash of the exact text (not stored/logged elsewhere).
  const textHash = hashText(c.text);
  return `${target}|${textHash}|${created}`;
}

function hashText(s: string): string {
  // FNV-1a — stable, non-cryptographic; avoids logging raw text.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export interface CommentDedupeResult {
  unique: NormalizedImportedComment[];
  duplicates: number;
}

export function dedupeComments(all: NormalizedImportedComment[]): CommentDedupeResult {
  const byKey = new Map<string, NormalizedImportedComment>();
  let duplicates = 0;
  for (const c of all) {
    const key = commentIdentity(c);
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
