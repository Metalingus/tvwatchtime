import { ConversationsController } from './conversations.controller';

it.each(['SHOW', 'MOVIE', 'EPISODE'] as const)(
  'loads %s counts independently using the canonical thread and visible local roots',
  async (threadType) => {
    const resolver = { canonicalThread: jest.fn().mockResolvedValue('canonical') };
    const reads = {
      commentCount: jest.fn().mockResolvedValue({
        total: 43,
        approximate: true,
        source: 'commsuni',
      }),
    };
    const prisma = { comment: { count: jest.fn().mockResolvedValue(3) } };
    const controller = new ConversationsController(
      {} as any,
      reads as any,
      resolver as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      {} as any,
    );
    await expect(
      controller.counts('viewer', {
        threadType,
        threadId: 'alias',
        sort: 'LATEST',
      }),
    ).resolves.toEqual({
      threadType,
      threadId: 'canonical',
      total: 43,
      approximate: true,
      source: 'commsuni',
    });
    expect(resolver.canonicalThread).toHaveBeenCalledWith(threadType, 'alias');
    expect(prisma.comment.count).toHaveBeenCalledWith({
      where: {
        threadType,
        threadId: 'canonical',
        parentId: null,
        commsUniParentId: null,
        externalReviewId: null,
        hidden: false,
        adminDeleted: false,
        deletedByUser: false,
      },
    });
    expect(reads.commentCount).toHaveBeenCalledWith('viewer', threadType, 'canonical', 3);
  },
);
