import type { MyCommentContextDto, PublicUserDto } from '@tvwatch/shared';
import type { CommentView as CommentDto } from '../../api/commsuni-presentation';
import { formatDateTime } from '@tvwatch/shared';
import type { TFunction } from 'i18next';

/** Localized display label for a thread context (group slugs resolve via `groups:names`). */
export function threadContextLabel(
  ctx: MyCommentContextDto | null | undefined,
  t: TFunction,
): string {
  if (!ctx) return '';
  if (ctx.threadType === 'GROUP') {
    return t(`groups:names.${ctx.groupId ?? ctx.label}`, { defaultValue: ctx.label });
  }
  return ctx.label;
}

/** Comment author display name — the system deleted-user account renders localized. */
export function authorDisplayName(
  author: Pick<PublicUserDto, 'username' | 'isDeletedUser'> | null | undefined,
  t: TFunction,
): string {
  if (!author) return '';
  return author.isDeletedUser ? t('common:deletedUser') : author.username;
}

/**
 * Helpers for the Reddit-style threaded comment screen.
 *
 * The server returns thread pages as a FLAT list (direct children of the requested
 * comment, optionally followed by each direct child's first children — depth=2).
 * `buildChildrenMap` groups them (plus locally expanded subtrees) by parentId;
 * the screen then renders the tree RECURSIVELY (each comment nests its children
 * container) — thread lines are full-height gutters inside that nesting, so
 * continuity comes from the structure instead of computed geometry.
 */

/** Locally fetched subtree of one node ("Show more replies" result, paginated). */
export interface ExpandedNode {
  items: CommentDto[];
  loading: boolean;
  /** Last loaded page of the node's direct children (0 = nothing fetched yet). */
  page: number;
  cursor?: string | null;
  exhausted?: boolean;
}

// ---------- Thread geometry ----------

/** Gutter width per nesting level — holds the thread lines + elbow connector. */
export const THREAD_GUTTER = 28;
/** Row avatar (its left edge sits on the own thread line). */
export const THREAD_AVATAR = 32;
/** Row top padding — avatar starts here. */
export const THREAD_ROW_PAD_TOP = 8;
/** Avatar center Y within a row (where the elbow meets the avatar). */
export const THREAD_CENTER_Y = THREAD_ROW_PAD_TOP + THREAD_AVATAR / 2;
/** Elbow corner radius. */
export const THREAD_ELBOW_R = 14;
/** Body offset from the avatar's left edge: avatar + gap — body aligns with the username. */
export const THREAD_CONTENT_INDENT = THREAD_AVATAR + 8;

/** "5h ago"-style compact relative time (falls back to the full date past a week). */
export function formatRelativeShort(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale: string,
): string {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return t('comments:timeJustNow');
  if (diffMin < 60) return t('comments:timeMinutesAgo', { count: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t('comments:timeHoursAgo', { count: diffH });
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return t('comments:timeDaysAgo', { count: diffD });
  return formatDateTime(iso, locale as any);
}

// ---------- Tree building ----------

/**
 * Merge the root page items with expanded subtrees (expanded wins per id, first
 * insert keeps its position) and group children by parentId, preserving order.
 * Returns the children map plus a by-id lookup for the whole merged set.
 */
export function buildChildrenMap(
  rootItems: CommentDto[],
  expanded: Record<string, ExpandedNode | undefined>,
) {
  const byId = new Map<string, CommentDto>();
  for (const c of rootItems) byId.set(c.id, c);
  for (const node of Object.values(expanded)) {
    if (!node) continue;
    for (const c of node.items) byId.set(c.id, c);
  }
  const childrenOf = new Map<string, CommentDto[]>();
  for (const c of byId.values()) {
    if (!c.parentId) continue;
    const list = childrenOf.get(c.parentId);
    if (list) list.push(c);
    else childrenOf.set(c.parentId, [c]);
  }
  return { childrenOf, byId };
}
