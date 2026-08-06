// TV Time comment import: owner resolution, reply/activity filtering,
// text validation, normalization, and dedup.
//
// PRIVACY: comment text is personal content. This module NEVER logs text, usernames,
// emails, or full rows. Diagnostics use filename + row number + char count + reason only.
//
// Scope: media comments (episode/movie/show), top-level AND replies. Rows authored by the
// archive owner import under the real user; third-party authors become deterministic
// shadow users at apply time. Third-party content almost never appears as CSV rows in real
// exports — it lives inside the v2 `replies` blob on the parent's row, so embedded replies
// are parsed into reply candidates (see parseEmbeddedReplies). Likes, reports, read
// markers, translations, and profile-wall comments are skipped.

import { safeLangPref, type SupportedLocale } from '@tvwatch/shared';
import { parseDate } from './inference';

export type CommentTargetType = 'episode' | 'movie' | 'show';

export interface NormalizedImportedComment {
  targetType: CommentTargetType;
  sourceFile: string;
  sourceRow: number;
  sourceCommentId: string | null;
  /** TV Time's canonical numeric comment id (v2 `comment_id` column — present only on
   *  legacy-era rows, but then it's the exact cross-file merge key vs legacy `id`). */
  legacyCommentId: string | null;
  sourceAuthorId: string | null;
  /** True when the author is the archive owner (vs a shadow-imported third party). */
  authorIsOwner: boolean;
  /** Reply linkage: the PARENT comment's source id (comment_uuid). Deferred when the
   *  parent is not in the export — the apply links it once the parent arrives. */
  isReply: boolean;
  parentSourceCommentId: string | null;
  /** Source thread depth (0 = top-level) when the export carries it. */
  depth: number | null;
  text: string;
  textLength: number;
  spoiler: boolean;
  /** Legacy spoiler-flag tally (TV Time spoiler_count) — seeds Comment.spoilerCount. */
  spoilerCount: number | null;
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
  /** TV Time movie identity (`entity_uuid`) shared with tracking/ratings/emotions. */
  movieUuid?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

export interface CommentFileResult {
  candidates: NormalizedImportedComment[];
  rowsDetected: number;
  topLevelDetected: number; // all staged candidates (top-level + replies + embedded blob replies)
  repliesSkipped: number; // embedded blob entries that could not be parsed
  activityRowsSkipped: number; // likes, reports, read markers, translations, profile-wall, out-of-scope
  otherUsersSkipped: number; // comment-type rows skipped because the owner is unresolved
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
  if (f === 'comments-prod-comments.csv' || f.includes('comments-prod-comments'))
    return 'comments_prod';
  if (
    f === 'episode_comment.csv' ||
    (f.includes('episode_comment') && !f.includes('like') && !f.includes('read'))
  )
    return 'episode_comment';
  // show_comment.csv → show-page comments; exclude show_comment_like / show_comments_last_read_date.
  if (
    f === 'show_comment.csv' ||
    (f.includes('show_comment') && !f.includes('like') && !f.includes('read'))
  )
    return 'show_comment';
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
export function resolveArchiveOwner(
  files: { filename: string; rows: Record<string, string>[] }[],
): string | null {
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
  // Fallback: no identity file in the archive. Every data file in a GDPR export belongs
  // to the SAME account, so the majority user_id across per-user files IS the owner —
  // without it, comment attribution is impossible and no comments import at all.
  const OWNER_HINT_FILES = [
    'user_tv_show_data',
    'followed_tv_show',
    'tracking-prod-records',
    'seen_episode',
    'watched_on_episode',
    'ratings-',
    'emotions-',
    'show_character_episode_vote',
  ];
  const counts = new Map<string, number>();
  for (const f of files) {
    const base = (f.filename.replace(/\\/g, '/').split('/').pop() ?? f.filename).toLowerCase();
    if (!OWNER_HINT_FILES.some((h) => base.includes(h))) continue;
    for (const r of f.rows) {
      const id = tryId(r['user_id']);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let best: { id: string; n: number } | null = null;
  for (const [id, n] of counts) {
    if (!best || n > best.n) best = { id, n };
  }
  return best?.id ?? null;
}

/**
 * Resolve the archive's TV Time account language from user.csv / user_personal_data.csv.
 * Used as a fallback matching language when the request-language TMDb search fails.
 * Returns a SupportedLocale ('fr', 'es', …) or null.
 */
export function resolveArchiveLanguage(
  files: { filename: string; rows: Record<string, string>[] }[],
): SupportedLocale | null {
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

// ---- Embedded replies blobs (v2 `replies` column) ----
// Go `%v` map dumps with alphabetically sorted keys. Values may contain spaces (comment
// text), so the generic space-terminated parser in list-objects.ts cannot be used: a
// scalar value ends at the NEXT KNOWN KEY (sorted-key order is the hard constraint) or at
// the enclosing map's closing bracket.
const REPLY_BLOB_KEYS = new Set([
  'comment_id',
  'comment_uuid',
  'created_at',
  'entity_type',
  'entity_uuid',
  'image',
  'is_spoiler',
  'lang',
  'like_count',
  'replies',
  'reply_count',
  'report_count',
  'spoiler_count',
  'text',
  'type',
  'updated_at',
  'user_id',
  'uuid',
]);

/** Consume a bracket-balanced group starting at s[i] === '['. Returns index past ']'. */
function skipBrackets(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** True when the ']' at s[i] closes the current map (vs a ']' inside free text). */
function isMapEnd(s: string, i: number): boolean {
  let j = i + 1;
  while (j < s.length && s[j] === ' ') j++;
  return j >= s.length || s[j] === ']' || s.startsWith('map[', j);
}

/** Parse one `map[...]` entry of a replies blob, known-key aware. Never throws. */
function parseReplyMapAt(
  s: string,
  start: number,
): { fields: Record<string, string>; next: number } {
  const fields: Record<string, string> = {};
  let i = start;
  const n = s.length;
  while (i < n) {
    while (i < n && s[i] === ' ') i++;
    if (i >= n) break;
    if (s[i] === ']') return { fields, next: i + 1 };
    const keyStart = i;
    while (i < n && s[i] !== ':' && s[i] !== ' ' && s[i] !== ']') i++;
    if (i >= n || s[i] !== ':') {
      while (i < n && s[i] !== ' ' && s[i] !== ']') i++;
      continue;
    }
    const key = s.slice(keyStart, i);
    i++; // consume ':'
    if (s.startsWith('map[', i)) {
      const valStart = i;
      i = skipBrackets(s, i + 3);
      fields[key] = s.slice(valStart, i);
      continue;
    }
    if (s[i] === '[') {
      const valStart = i;
      i = skipBrackets(s, i);
      fields[key] = s.slice(valStart, i);
      continue;
    }
    // Scalar: runs until the next known key (` <key>:`) or the map's closing bracket.
    const valStart = i;
    let end = -1;
    while (i < n) {
      if (s[i] === ']' && isMapEnd(s, i)) {
        end = i;
        break;
      }
      if (s[i] === ' ') {
        let j = i + 1;
        const kStart = j;
        while (j < n && /[a-z_]/.test(s[j])) j++;
        if (j > kStart && s[j] === ':' && REPLY_BLOB_KEYS.has(s.slice(kStart, j))) {
          end = i;
          break;
        }
      }
      i++;
    }
    if (end === -1) {
      fields[key] = s.slice(valStart);
      i = n;
    } else {
      fields[key] = s.slice(valStart, end);
      i = end;
    }
  }
  return { fields, next: i };
}

/** TV Time user id from a blob: plain digits, or Go float form (`2.1270298e+07` — Go's
 *  shortest-round-trip `%v` formatting converts back exactly). Missing/`0` = deleted
 *  account → the shared '0' identity (one deterministic shadow for all deleted authors). */
function normalizeBlobAuthorId(raw: string | undefined): string | null {
  if (isAbsent(raw)) return '0';
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return s;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0 && n < 1e15) return String(Math.trunc(n));
  return null;
}

/** Epoch seconds/ms (incl. float/scientific form) from a blob field. */
function blobEpochDate(raw: string | undefined): Date | null {
  if (isAbsent(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n > 1e12 ? n : n * 1000);
  return isNaN(d.getTime()) ? null : d;
}

export interface EmbeddedRepliesParseResult {
  replies: NormalizedImportedComment[];
  unparseable: number;
}

export interface BlobParentContext {
  /** The parent comment's own source id (its `uuid`/`comment_uuid`). */
  parentSourceCommentId: string;
  parentDepth: number;
  sourceRow: number;
  sourceFile: string;
  targetType: CommentTargetType;
  showTitle: string | null;
  movieTitle: string | null;
  movieUuid?: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  externalEpisodeId: string | number | null;
}

/**
 * Parse a v2 `replies` blob into reply candidates. Blob replies share the parent's target
 * (their entity_type/entity_uuid match the parent row), so target fields are inherited.
 * Nested `replies` lists are walked recursively, chained by the reply's own `uuid`.
 * Never throws; malformed entries are counted in `unparseable`.
 */
export function parseEmbeddedReplies(
  rawBlob: string | undefined,
  parent: BlobParentContext,
  ownerId: string | null,
): EmbeddedRepliesParseResult {
  const out: NormalizedImportedComment[] = [];
  let unparseable = 0;
  if (isAbsent(rawBlob)) return { replies: out, unparseable };
  let s = String(rawBlob).trim();
  if (s === '[]') return { replies: out, unparseable };
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

  const walk = (blob: string, parentId: string, depth: number) => {
    let i = 0;
    const n = blob.length;
    while (i < n) {
      const at = blob.indexOf('map[', i);
      if (at === -1) break;
      let fields: Record<string, string>;
      let next: number;
      try {
        ({ fields, next } = parseReplyMapAt(blob, at + 4));
      } catch {
        unparseable++;
        break;
      }
      i = next;
      if (!Object.keys(fields).length) {
        unparseable++;
        continue;
      }
      const authorId = normalizeBlobAuthorId(fields.user_id);
      const uuid = isAbsent(fields.uuid) ? null : fields.uuid.trim();
      const { text, ok } = validateText(isAbsent(fields.text) ? undefined : fields.text);
      const image = parseImageField(fields.image);
      if (authorId == null || (!ok && !image) || text.length > MAX_COMMENT_LENGTH) {
        unparseable++;
        continue;
      }
      const spoilerCount = toInt(isAbsent(fields.spoiler_count) ? undefined : fields.spoiler_count);
      const spoiler = fields.is_spoiler === 'true' || (spoilerCount != null && spoilerCount > 0);
      out.push({
        targetType: parent.targetType,
        sourceFile: parent.sourceFile,
        sourceRow: parent.sourceRow,
        sourceCommentId: uuid,
        legacyCommentId: isAbsent(fields.comment_id) ? null : fields.comment_id,
        sourceAuthorId: authorId,
        authorIsOwner: authorId === ownerId,
        isReply: true,
        parentSourceCommentId: parentId,
        depth,
        text,
        textLength: text.length,
        spoiler,
        spoilerCount,
        language: isAbsent(fields.lang) ? null : fields.lang,
        sourceCreatedAt: blobEpochDate(fields.created_at),
        sourceUpdatedAt: blobEpochDate(fields.updated_at),
        image,
        externalEpisodeId: parent.externalEpisodeId,
        showTitle: parent.showTitle,
        movieTitle: parent.movieTitle,
        movieUuid: parent.movieUuid ?? null,
        seasonNumber: parent.seasonNumber,
        episodeNumber: parent.episodeNumber,
      });
      if (!isAbsent(fields.replies) && fields.replies !== '[]') {
        // Nested replies chain off THIS reply's uuid; without it they can't be linked.
        if (uuid) walk(fields.replies, uuid, depth + 1);
        else unparseable++;
      }
    }
  };
  walk(s, parent.parentSourceCommentId, parent.parentDepth + 1);
  return { replies: out, unparseable };
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
export function parseImageField(
  raw: string | undefined | null,
): { url: string; format: string } | null {
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

    // Classify the row type. sort_key prefixes: like-*, report-*, user-read-*, comment-*, reply-*.
    const isReplyByType = rawType === 'reply' || sortStartsWith('reply-');
    const isActivityType =
      KNOWN_ACTIVITY_TYPES.has(rawType) ||
      ['like-', 'report-', 'user-read-', 'read-'].some(sortStartsWith);
    const isCommentType = rawType === 'comment' || sortStartsWith('comment-');

    // The row's own source id — needed up front to detect SELF-referencing parents.
    const sourceCommentId = field(row, ['comment_uuid', 'uuid', 'id']) ?? null;

    // Parent indicators (any present value → this is a reply).
    // v2 reply rows: `parent_uuid` is often a SELF-reference (the row's own uuid) — the real
    // parent uuid lives in the sort_key (`reply-<own-uuid>-<epoch>-<parent-uuid>`). Prefer
    // the sort_key parent; otherwise keep a parent field value that is not the row itself.
    const rawParentVal = PARENT_FIELDS.map((p) => field(row, [p])).find((v) => v != null) ?? null;
    const sortKeyParent = sortKey.match(/^reply-[0-9a-f-]{36}-\d+-([0-9a-f-]{36})$/)?.[1] ?? null;
    const parentVal =
      sortKeyParent && sortKeyParent !== sourceCommentId
        ? sortKeyParent
        : rawParentVal && rawParentVal !== sourceCommentId
          ? rawParentVal
          : null;
    const depth = toInt(field(row, ['depth']));
    const hasParent = parentVal != null || (depth != null && depth > 0);

    // Activity rows (likes/reports/read markers) — not comments.
    if (isActivityType) {
      result.activityRowsSkipped++;
      return;
    }

    // Not a recognized comment row AND not a recognized activity row → ambiguous; skip safely.
    if (!isCommentType && !isReplyByType && !hasParent) {
      result.invalid++;
      return;
    }

    // Ownership: the archive owner's comments are imported under the real user; other
    // authors become deterministic SHADOW users at apply time (nothing is dropped).
    // Legacy files (episode_comment/show_comment) carry no user_id — they are single-user
    // exports, so a missing author id means the owner.
    // When the owner can't be resolved, the old scope can't be distinguished — skip safely.
    const authorIdRaw = field(row, ['user_id']);
    if (ownerId == null) {
      result.otherUsersSkipped++;
      return;
    }
    const authorId = authorIdRaw ?? ownerId;
    const authorIsOwner = authorId === ownerId;

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
    if (
      entityType === 'movie' ||
      (movieName && !seriesName && (!episodeIdNum || episodeIdNum === 0))
    ) {
      targetType = 'movie';
    } else if (kind === 'show_comment' || entityType === 'show' || entityType === 'series') {
      targetType = 'show';
    } else {
      targetType = 'episode';
    }

    const spoilerRaw = field(row, ['is_spoiler']);
    const spoilerCount = toInt(field(row, ['spoiler_count']));
    const spoiler =
      spoilerRaw === 'true' || spoilerRaw === '1' || (spoilerCount != null && spoilerCount > 0);

    const language = field(row, ['lang', 'language']) ?? null;
    const legacyCommentId = field(row, ['comment_id']) ?? null;
    const movieUuid = targetType === 'movie' ? (field(row, ['entity_uuid']) ?? null) : null;

    const parentDepth = depth ?? (isReplyByType || hasParent ? 1 : 0);
    result.topLevelDetected++;
    result.candidates.push({
      targetType,
      sourceFile: filename,
      sourceRow,
      sourceCommentId,
      legacyCommentId,
      sourceAuthorId: authorId,
      authorIsOwner,
      isReply: isReplyByType || hasParent,
      parentSourceCommentId: parentVal ?? null,
      depth: parentDepth,
      text,
      textLength: text.length,
      spoiler,
      spoilerCount,
      language,
      sourceCreatedAt: toDate(field(row, ['created_at'])),
      sourceUpdatedAt: toDate(field(row, ['updated_at'])),
      image,
      externalEpisodeId: targetType === 'episode' ? (episodeIdNum ?? null) : null,
      showTitle: seriesName ?? null,
      movieTitle: movieName ?? null,
      movieUuid,
      seasonNumber: season,
      episodeNumber: episode,
    });

    // Embedded replies (v2 `replies` blob): replies TO this comment, usually authored by
    // third parties (shadow candidates). They share this row's target and link via its
    // source id — unparseable entries are counted, never silently dropped.
    if (sourceCommentId) {
      const emb = parseEmbeddedReplies(
        field(row, ['replies']),
        {
          parentSourceCommentId: sourceCommentId,
          parentDepth,
          sourceRow,
          sourceFile: filename,
          targetType,
          showTitle: seriesName ?? null,
          movieTitle: movieName ?? null,
          movieUuid,
          seasonNumber: season,
          episodeNumber: episode,
          externalEpisodeId: targetType === 'episode' ? (episodeIdNum ?? null) : null,
        },
        ownerId,
      );
      result.repliesSkipped += emb.unparseable;
      for (const reply of emb.replies) {
        result.topLevelDetected++;
        result.candidates.push(reply);
      }
    }
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
      ? c.movieUuid
        ? `movie|uuid:${c.movieUuid.toLowerCase().trim()}`
        : `movie|${(c.movieTitle ?? '').toLowerCase().trim()}`
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

/** Content fingerprint: same target + exact text + created MINUTE (exports from
 *  different files can disagree on the second). Catches the SAME comment exported twice
 *  with DIFFERENT id spaces (legacy episode_comment.csv `id` vs v2 `comment_uuid`). */
function commentFingerprint(c: NormalizedImportedComment): string {
  const target =
    c.targetType === 'movie'
      ? c.movieUuid
        ? `movie|uuid:${c.movieUuid.toLowerCase().trim()}`
        : `movie|${(c.movieTitle ?? '').toLowerCase().trim()}`
      : c.targetType === 'show'
        ? `show|${(c.showTitle ?? '').toLowerCase().trim()}`
        : `episode|${(c.showTitle ?? '').toLowerCase().trim()}|${c.seasonNumber ?? ''}|${c.episodeNumber ?? ''}|${c.externalEpisodeId ?? ''}`;
  const created = c.sourceCreatedAt ? Math.floor(c.sourceCreatedAt.getTime() / 60000) : 0;
  return `${target}|${hashText(c.text)}|${created}`;
}

function commentKeys(c: NormalizedImportedComment): string[] {
  const canonicalId =
    c.legacyCommentId ?? (/^\d+$/.test(c.sourceCommentId ?? '') ? c.sourceCommentId : null);
  return [
    commentIdentity(c),
    canonicalId ? `tvtime|cid:${canonicalId}` : null,
    commentFingerprint(c),
  ].filter(Boolean) as string[];
}

function targetIdentityScore(c: NormalizedImportedComment): number {
  if (c.targetType === 'movie') return (c.movieUuid ? 8 : 0) + (c.movieTitle ? 2 : 0);
  if (c.targetType === 'show') return c.showTitle ? 3 : 0;
  return (
    (c.externalEpisodeId != null ? 8 : 0) +
    (c.showTitle ? 3 : 0) +
    (c.seasonNumber != null ? 1 : 0) +
    (c.episodeNumber != null ? 1 : 0)
  );
}

function laterDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function earlierDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/** Merge duplicate exports instead of choosing one row wholesale. The v2 row has the UUID,
 * image/replies and fresher timestamps, while the legacy row often has the only episode id,
 * title and S/E coordinate. Keeping both halves is what makes the canonical comment_id join
 * useful for matching. */
function mergeComments(
  a: NormalizedImportedComment,
  b: NormalizedImportedComment,
): NormalizedImportedComment {
  const aTime = a.sourceUpdatedAt?.getTime() ?? a.sourceCreatedAt?.getTime() ?? 0;
  const bTime = b.sourceUpdatedAt?.getTime() ?? b.sourceCreatedAt?.getTime() ?? 0;
  const fresher = bTime >= aTime ? b : a;
  const older = fresher === b ? a : b;
  const target = targetIdentityScore(b) > targetIdentityScore(a) ? b : a;
  const otherTarget = target === b ? a : b;
  const nonNumericSourceId = [b.sourceCommentId, a.sourceCommentId].find(
    (value) => value && !/^\d+$/.test(value),
  );
  const numericSourceId = [a.sourceCommentId, b.sourceCommentId].find((value) =>
    /^\d+$/.test(value ?? ''),
  );

  return {
    ...older,
    ...fresher,
    targetType: target.targetType,
    sourceCommentId: nonNumericSourceId ?? fresher.sourceCommentId ?? older.sourceCommentId,
    legacyCommentId: a.legacyCommentId ?? b.legacyCommentId ?? numericSourceId ?? null,
    isReply: a.isReply || b.isReply,
    parentSourceCommentId: fresher.parentSourceCommentId ?? older.parentSourceCommentId ?? null,
    depth:
      fresher.depth != null && older.depth != null
        ? Math.max(fresher.depth, older.depth)
        : (fresher.depth ?? older.depth ?? null),
    spoiler: a.spoiler || b.spoiler,
    spoilerCount:
      a.spoilerCount != null || b.spoilerCount != null
        ? Math.max(a.spoilerCount ?? 0, b.spoilerCount ?? 0)
        : null,
    language: fresher.language ?? older.language ?? null,
    sourceCreatedAt: earlierDate(a.sourceCreatedAt, b.sourceCreatedAt),
    sourceUpdatedAt: laterDate(a.sourceUpdatedAt, b.sourceUpdatedAt),
    image: fresher.image ?? older.image ?? null,
    externalEpisodeId: target.externalEpisodeId ?? otherTarget.externalEpisodeId ?? null,
    showTitle: target.showTitle ?? otherTarget.showTitle ?? null,
    movieTitle: target.movieTitle ?? otherTarget.movieTitle ?? null,
    movieUuid: target.movieUuid ?? otherTarget.movieUuid ?? null,
    seasonNumber: target.seasonNumber ?? otherTarget.seasonNumber ?? null,
    episodeNumber: target.episodeNumber ?? otherTarget.episodeNumber ?? null,
  };
}

export function dedupeComments(all: NormalizedImportedComment[]): CommentDedupeResult {
  type Entry = { value: NormalizedImportedComment; keys: Set<string> };
  const byKey = new Map<string, Entry>();
  const entries = new Set<Entry>();
  let duplicates = 0;
  for (const c of all) {
    const keys = commentKeys(c);
    const collisions = new Set(keys.map((key) => byKey.get(key)).filter(Boolean) as Entry[]);
    if (!collisions.size) {
      const entry = { value: c, keys: new Set(keys) };
      entries.add(entry);
      for (const key of entry.keys) byKey.set(key, entry);
      continue;
    }

    duplicates++;
    const [primary, ...others] = [...collisions];
    primary.value = mergeComments(primary.value, c);
    for (const other of others) {
      primary.value = mergeComments(primary.value, other.value);
      for (const key of other.keys) primary.keys.add(key);
      entries.delete(other);
    }
    for (const key of keys) primary.keys.add(key);
    for (const key of commentKeys(primary.value)) primary.keys.add(key);
    for (const key of primary.keys) byKey.set(key, primary);
  }
  return { unique: [...entries].map((entry) => entry.value), duplicates };
}
