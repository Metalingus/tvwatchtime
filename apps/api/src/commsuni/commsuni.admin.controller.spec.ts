import 'reflect-metadata';
import { CommsUniAdminController } from './commsuni.admin.controller';
import { ROLES_KEY } from '../admin/roles.decorator';
import { seal } from './commsuni.crypto';

it.each([
  'backfillReadiness',
  'previewBackfill',
  'enqueueBackfill',
  'backfillReport',
  'resumeBudget',
])('requires ADMIN for %s', (method) => {
  expect(
    Reflect.getMetadata(ROLES_KEY, (CommsUniAdminController.prototype as any)[method]),
  ).toEqual(['ADMIN']);
});
it('exposes encrypted provider reasons to admin support for a vote without a local comment', async () => {
  const secret = 'test-admin-diagnostic-secret-only-123456';
  const db: any = {
    commsUniOutbox: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: 'op',
          commentId: null,
          state: 'RETRY',
          target: {
            lastError: {
              code: 'quota_exceeded',
              reason: 'daily_budget',
              messageEncrypted: seal(secret, 'Quota exhausted'),
            },
          },
        }),
    },
    comment: { findUnique: jest.fn() },
  };
  const controller = new CommsUniAdminController(
    db,
    {} as any,
    {} as any,
    {} as any,
    { get: () => secret } as any,
  );
  const result = await controller.reviewOperation('op');
  expect(result).toMatchObject({
    id: 'op',
    comment: null,
    providerError: { reason: 'daily_budget', message: 'Quota exhausted' },
  });
  expect(result).not.toHaveProperty('target');
  expect(db.comment.findUnique).not.toHaveBeenCalled();
});
it('does not clear a budget pause when the write gate is disabled', async () => {
  const redis: any = { del: jest.fn(), delByPattern: jest.fn() };
  const controller = new CommsUniAdminController(
    {} as any,
    redis,
    {
      assertWrites: () => {
        throw Error('disabled');
      },
    } as any,
    {} as any,
    {} as any,
  );
  await expect(controller.resumeBudget('admin')).rejects.toThrow('disabled');
  expect(redis.del).not.toHaveBeenCalled();
});
