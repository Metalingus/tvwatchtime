import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { COMMSUNI_CANCELABLE_STATES } from '@tvwatch/shared';

/** Reserve cleanup for a locally deleted shared row, even while all provider writes are off. */
export async function prepareCommsUniCommentDeletion(
  tx: Prisma.TransactionClient,
  commentId: string,
): Promise<void> {
  const creation = await tx.commsUniOutbox.findUnique({
    where: { dedupeKey: 'comment:' + commentId },
  });
  if (!creation) return;
  if (!creation.remoteId) {
    await tx.commsUniOutbox.update({
      where: { id: creation.id },
      data: {
        state: creation.firstAttemptAt ? 'UNCERTAIN' : 'CANCELED',
        errorCode: 'comment_deleted',
      },
    });
    return;
  }
  const dedupeKey = 'comment-delete:' + creation.id;
  await tx.commsUniOutbox.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      identityId: creation.identityId,
      dedupeKey,
      method: 'DELETE',
      path: '/comments/' + creation.remoteId,
      payload: '',
      ...(creation.target ? { target: creation.target as Prisma.InputJsonValue } : {}),
      cleanup: true,
    },
  });
}

/** Called inside the existing anonymize-and-delete transaction. Never calls any provider. */
export async function prepareCommsUniDeletion(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const identities = await tx.commsUniIdentity.findMany({ where: { userId } });
  for (const identity of identities) {
    await tx.commsUniIdentity.update({
      where: { id: identity.id },
      data: { deleting: true, profileHash: null },
    });
    const operations = await tx.commsUniOutbox.findMany({ where: { identityId: identity.id } });
    const paths = new Map<string, Prisma.InputJsonValue | undefined>();
    for (const op of operations) {
      if (op.remoteId && op.commentId)
        paths.set('/comments/' + op.remoteId, op.target as Prisma.InputJsonValue | undefined);
      if (
        op.state === 'SYNCED' &&
        op.method === 'PUT' &&
        /^\/comments\/[0-9a-f-]+\/(like|spoiler)$/i.test(op.path)
      )
        paths.set(op.path, op.target as Prisma.InputJsonValue | undefined);
      if ((COMMSUNI_CANCELABLE_STATES as readonly string[]).includes(op.state) && !op.cleanup) {
        await tx.commsUniOutbox.update({
          where: { id: op.id },
          data: {
            state: op.firstAttemptAt ? 'UNCERTAIN' : 'CANCELED',
            errorCode: 'account_deleted',
          },
        });
      }
    }
    // Profile PUT can have succeeded just before deletion even if its acknowledgement was lost.
    paths.set('/authors/me/profile', undefined);
    await tx.commsUniOutbox.updateMany({
      where: { identityId: identity.id, state: { in: ['SYNCED', 'DUPLICATE_REPORT', 'CANCELED'] } },
      data: { payload: '' },
    });
    for (const [path, target] of paths) {
      const dedupeKey = 'account-delete:' + identity.id + ':' + path;
      await tx.commsUniOutbox.upsert({
        where: { dedupeKey },
        update: {},
        create: {
          id: randomUUID(),
          identityId: identity.id,
          dedupeKey,
          method: 'DELETE',
          path,
          payload: '',
          ...(target ? { target } : {}),
          cleanup: true,
        },
      });
    }
  }
}
