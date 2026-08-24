import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService.claimStoreReviewPrompt', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-15T00:00:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('atomically claims an eligible account prompt', async () => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          appReviewPromptedAt: new Date('2026-01-08T00:00:00.000Z'),
          appReviewPromptCount: 1,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => unknown, options: unknown) => {
        expect(options).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
        return callback(tx);
      }),
    };
    const service = new UsersService(prisma as any, {} as any, {} as any, {} as any);

    await expect(service.claimStoreReviewPrompt('user-1', 'ANDROID')).resolves.toEqual({
      eligible: true,
      promptedAt: '2026-01-15T00:00:00.000Z',
      nextEligibleAt: null,
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        appReviewPromptedAt: new Date('2026-01-15T00:00:00.000Z'),
        appReviewPromptCount: 2,
      },
    });
  });

  it('does not write before the registration-age threshold', async () => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-01-12T00:00:00.000Z'),
          appReviewPromptedAt: null,
          appReviewPromptCount: 0,
        }),
        update: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new UsersService(prisma as any, {} as any, {} as any, {} as any);

    const result = await service.claimStoreReviewPrompt('user-1', 'IOS');
    expect(result).toEqual({
      eligible: false,
      nextEligibleAt: '2026-01-19T00:00:00.000Z',
    });
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
