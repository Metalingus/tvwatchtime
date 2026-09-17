import { prepareCommsUniCommentDeletion, prepareCommsUniDeletion } from './commsuni.cleanup';

const target = { threadType: 'SHOW', threadId: 'show', entityId: 'entity', reference: 'tvdb-1' };
it('retains the entity cache destination for a comment deletion', async () => {
  const db: any = {
    commsUniOutbox: {
      findUnique: async () => ({
        id: 'creation',
        identityId: 'identity',
        remoteId: 'remote',
        target,
      }),
      upsert: jest.fn(),
    },
  };
  await prepareCommsUniCommentDeletion(db, 'local');
  expect(db.commsUniOutbox.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({ path: '/comments/remote', target, cleanup: true }),
    }),
  );
});
it('cancels paused backfill and retains entity destinations for account cleanup', async () => {
  const db: any = {
    commsUniIdentity: { findMany: async () => [{ id: 'identity' }], update: jest.fn() },
    commsUniOutbox: {
      findMany: async () => [
        {
          id: 'posted',
          state: 'SYNCED',
          method: 'POST',
          commentId: 'local',
          remoteId: 'remote',
          target,
        },
        { id: 'paused', state: 'BACKFILL_PAUSED', firstAttemptAt: null, cleanup: false },
      ],
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
  };
  await prepareCommsUniDeletion(db, 'user');
  expect(db.commsUniOutbox.update).toHaveBeenCalledWith({
    where: { id: 'paused' },
    data: { state: 'CANCELED', errorCode: 'account_deleted' },
  });
  expect(db.commsUniOutbox.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({ path: '/comments/remote', target }),
    }),
  );
});
