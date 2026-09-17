import type { CommentDto, CommentSort, MyCommentContextDto } from './social';

/** New clients opt into CommsUni behavior; an absent header keeps the legacy workflow. */
export const COMMSUNI_CLIENT_HEADER = 'X-TVWatch-CommsUni';
export const COMMSUNI_CLIENT_VERSION = '1';

export type ConversationType = 'SHOW' | 'MOVIE' | 'EPISODE';
export type CommsUniEntityType = 'show' | 'movie' | 'season' | 'episode';
export type CommsUniEngagementKind =
  'emotion' | 'star_rating' | 'cast_vote' | 'watch_device' | 'watch_platform' | 'movie_interest';

export interface CommsUniOrigin {
  sourceId?: number;
  kind: 'tvtime' | 'partner' | 'unknown';
  slug: string;
  displayName: string;
  iconUrl: string | null;
}

export interface CommsUniMention {
  userId: string | null;
  userName: string;
  start: number | null;
  end: number | null;
}

export interface CommsUniCommentDto {
  id: string;
  entityId: string;
  origin: CommsUniOrigin;
  text: string | null;
  deleted?: boolean;
  createdAt: string | null;
  author: { id: string; displayName: string; avatarUrl: string | null };
  parentCommentId: string | null;
  inReplyToCommentId: string | null;
  rootCommentId: string;
  depth: number;
  likeCount: number;
  replyCount: number;
  spoilerCount: number;
  isSpoiler: boolean;
  viewerLiked?: boolean;
  viewerMarkedSpoiler?: boolean;
  rating: number | null;
  language: string | null;
  mentions: CommsUniMention[];
  media: {
    kind: 'archive' | 'external';
    url?: string;
    contentType?: string;
    width?: number;
    height?: number;
  } | null;
  actions: {
    like: boolean;
    reply: boolean;
    delete: boolean;
    spoiler: boolean;
    authorSpoiler: boolean;
  };
  localCommentId?: string;
}

export type ConversationItemDto =
  | {
      kind: 'local';
      key: string;
      comment: CommentDto;
      sharedCopy?: boolean;
      localSource?: string | null;
    }
  | { kind: 'commsuni'; key: string; comment: CommsUniCommentDto };

export interface ConversationPageDto {
  items: ConversationItemDto[];
  nextCursor: string | null;
  thread: MyCommentContextDto | null;
  upstream: 'disabled' | 'available' | 'empty' | 'unmapped' | 'unavailable' | 'throttled';
  writesEnabled: boolean;
  sort: CommentSort;
}

export interface CommsUniThreadDto {
  comment: CommsUniCommentDto;
  localRevision?: CommentDto;
  thread: MyCommentContextDto | null;
  threadType: ConversationType;
  threadId: string;
}

export interface CommsUniOptionDto {
  key: string;
  label: string;
  count: number;
  archivedCount?: number;
  nativeCount?: number;
  role?: string | null;
  selected: boolean;
  localSelected?: boolean;
  imageUrl: string | null;
  localValue: string | null;
}

export interface CommsUniEngagementDto {
  entity?: { type: CommsUniEntityType; id: string; reference: string };
  available: boolean;
  writesEnabled: boolean;
  sections: { kind: CommsUniEngagementKind; options: CommsUniOptionDto[] }[];
  rating: { average: number | null; count: number; viewerRating: number | null } | null;
}

export interface CommsUniWriteMention {
  authorId: string;
  start: number;
  end: number;
  text: string;
}

export interface CommsUniWriteComment {
  text?: string | null;
  language?: string;
  isSpoiler?: boolean;
  createdAt: string;
  rating?: number | null;
  mentions?: CommsUniWriteMention[];
  attachments?: { url: string; contentType: string; provider: string }[];
  entity?: { title?: string; showTitle?: string };
}

/** Delivery state is shared by the worker, operators, and user-facing status UI. */
export const COMMSUNI_PENDING_STATES = [
  'PENDING',
  'RETRY',
  'SENDING',
  'WAITING_ATTACHMENT',
  'WAITING_PARENT',
  'BACKFILL_PAUSED',
] as const;
export const COMMSUNI_REVIEW_STATES = [
  'WAITING_REVIEW',
  'BLOCKED_MAPPING',
  'BLOCKED_PARENT',
  'BLOCKED_OPTION',
  'UNCERTAIN',
] as const;
export const COMMSUNI_SUCCESS_STATES = ['SYNCED', 'DUPLICATE_REPORT'] as const;
export const COMMSUNI_CANCELABLE_STATES = [
  ...COMMSUNI_PENDING_STATES,
  ...COMMSUNI_REVIEW_STATES,
  'FAILED',
] as const;
export type CommsUniOperationState =
  | (typeof COMMSUNI_CANCELABLE_STATES)[number]
  | (typeof COMMSUNI_SUCCESS_STATES)[number]
  | 'CANCELED';
export function isCommsUniPending(state: string | null | undefined): boolean {
  return (COMMSUNI_PENDING_STATES as readonly string[]).includes(state ?? '');
}
export interface CommsUniOperationDto {
  id: string;
  state: string;
  errorCode: string | null;
  reason?: string | null;
  nextAttemptAt?: string | null;
  commentId?: string | null;
  remoteId?: string | null;
}

/** Independently loaded comment total; local fallback does not erase a cached shared total. */
export interface ConversationCountDto {
  threadType: ConversationType;
  threadId: string;
  total: number;
  approximate: boolean;
  source: 'local' | 'commsuni';
}
