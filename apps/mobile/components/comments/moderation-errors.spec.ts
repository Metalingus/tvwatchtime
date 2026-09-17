import { commentModerationErrorKey } from './moderation-errors';
it('maps moderation rejection and outage codes to localized user messages', () => {
  expect(commentModerationErrorKey({ data: { code: 'COMMENT_MODERATION_REJECTED' } })).toBe(
    'comments:moderationRejected',
  );
  expect(commentModerationErrorKey({ data: { code: 'COMMENT_MODERATION_UNAVAILABLE' } })).toBe(
    'comments:moderationUnavailable',
  );
});
it('leaves unrelated errors alone', () => {
  expect(commentModerationErrorKey(null)).toBeNull();
  expect(commentModerationErrorKey(new Error('offline'))).toBeNull();
  expect(commentModerationErrorKey({ data: { code: 'OTHER' } })).toBeNull();
});
