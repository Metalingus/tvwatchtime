import { COMMENT_MODERATION_CODES } from '@tvwatch/shared';

export function commentModerationErrorKey(error: unknown) {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  if (code === COMMENT_MODERATION_CODES.rejected) return 'comments:moderationRejected';
  if (code === COMMENT_MODERATION_CODES.unavailable) return 'comments:moderationUnavailable';
  return null;
}
