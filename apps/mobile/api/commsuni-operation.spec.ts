import {
  commsUniOperationMessage,
  commsUniDeliveryMessage,
  patchCommsUniCache,
} from './commsuni-operation';
it.each([
  ['PENDING', undefined, null],
  ['SYNCED', undefined, 'synced'],
  ['DUPLICATE_REPORT', undefined, 'duplicateReport'],
  ['WAITING_REVIEW', undefined, 'awaitingReview'],
  ['FAILED', undefined, 'failed'],
  ['RETRY', 'actor_rate', 'throttled'],
  ['FAILED', 'actor_denied', 'throttled'],
])('presents %s / %s as %s', (state, reason, key) => {
  expect(commsUniOperationMessage({ state: state!, reason })).toBe(
    key === null ? null : 'comments:commsuni.' + key,
  );
});
it('patches the acknowledged action without dropping other pages or changing order', () => {
  const data = {
    pages: [
      {
        items: [
          { kind: 'commsuni', key: 'one', comment: { id: 'one', isSpoiler: false, replyCount: 2 } },
          { kind: 'local', key: 'two', comment: { id: 'two' } },
        ],
      },
    ],
  };
  const updated = patchCommsUniCache(data, 'one', { isSpoiler: true });
  expect(updated.pages[0].items[0].comment.isSpoiler).toBe(true);
  expect(updated.pages[0].items.map((item: any) => item.key)).toEqual(['one', 'two']);
  expect(data.pages[0].items[0].comment.isSpoiler).toBe(false);
  expect(patchCommsUniCache(data, 'one', { deleted: true }).pages[0].items).toHaveLength(2);
  expect(
    patchCommsUniCache(data, 'one', { deleted: true, replyCount: 0 }).pages[0].items,
  ).toHaveLength(1);
});

it('distinguishes report acceptance from moderator review and duplicate reports', () => {
  const delivery = { id: 'op', state: 'PENDING', action: 'report' };
  expect(commsUniDeliveryMessage(delivery, { id: 'op', state: 'SYNCED' } as any)).toBe(
    'comments:commsuni.reportSubmitted',
  );
  expect(commsUniDeliveryMessage(delivery, { id: 'op', state: 'DUPLICATE_REPORT' } as any)).toBe(
    'comments:commsuni.duplicateReport',
  );
  expect(commsUniDeliveryMessage(delivery, { id: 'other', state: 'SYNCED' } as any)).toBeNull();
});
