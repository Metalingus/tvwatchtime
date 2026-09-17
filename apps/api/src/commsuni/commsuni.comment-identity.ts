import type { Comment } from '@prisma/client';
import { UUID } from './commsuni.client';

export function tvtimeUuid(source: string | null, sourceKey: string | null): string | null {
  if (source !== 'TVTIME') return null;
  const value = sourceKey?.replace(/^tvtime\|/, '') ?? '';
  return UUID.test(value) ? value.toLowerCase() : null;
}

/** A local edit must not mutate the already captured/published provider snapshot. */
export function hasSharedCommentSnapshot(
  comment: Partial<Pick<Comment, 'commsUniState' | 'commsUniCommentId' | 'source' | 'sourceKey'>>,
): boolean {
  return !!(
    comment.commsUniState ||
    comment.commsUniCommentId ||
    tvtimeUuid(comment.source ?? null, comment.sourceKey ?? null)
  );
}

/** User edits of imported content also stay local, even without a usable archive UUID. */
export function requiresLocalRevision(
  comment: Partial<Pick<Comment, 'commsUniState' | 'commsUniCommentId' | 'source' | 'sourceKey'>>,
): boolean {
  return (
    hasSharedCommentSnapshot(comment) ||
    !!comment.sourceKey ||
    (!!comment.source && comment.source !== 'MANUAL')
  );
}
