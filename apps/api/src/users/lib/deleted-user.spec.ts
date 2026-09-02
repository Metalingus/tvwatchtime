import {
  anonymizeAndDeleteUser,
  AccountDeletionInProgressError,
  getOrCreateDeletedUser,
  isDeletedUserAccount,
  isReservedUserEmail,
  DELETED_USER_EMAIL,
  DELETED_USER_USERNAME,
} from './deleted-user';

function model(count = 1) {
  return {
    updateMany: jest.fn(async () => ({ count })),
    deleteMany: jest.fn(async () => ({ count })),
  };
}

type OwnedComment = { id: string; parentId: string | null };

function makePrisma(
  opts: {
    existingDeletedUser?: boolean;
    userExists?: boolean;
    protectedCommentIds?: string[];
    ownedComments?: OwnedComment[];
  } = {},
) {
  const users: any[] = [];
  if (opts.userExists !== false) {
    users.push({ id: 'u1', email: 'real@example.com', username: 'real-user' });
  }
  if (opts.existingDeletedUser) {
    users.push({ id: 'deleted-sys', email: DELETED_USER_EMAIL, username: DELETED_USER_USERNAME });
  }
  const calls = {
    commentUpdateMany: [] as any[],
    userCreate: [] as any[],
  };
  const protectedCommentIds = opts.protectedCommentIds ?? ['c-thread-root', 'c-thread-middle'];
  const ownedComments =
    opts.ownedComments ??
    ([
      { id: 'c-thread-root', parentId: null },
      { id: 'c-thread-middle', parentId: 'c-thread-root' },
      { id: 'c-self-leaf', parentId: 'c-thread-middle' },
    ] satisfies OwnedComment[]);
  let queryRawCall = 0;
  const prisma: any = {
    user: {
      findUnique: jest.fn(async (args: any) => {
        if (args.where.email) return users.find((u) => u.email === args.where.email) ?? null;
        if (args.where.id) return users.find((u) => u.id === args.where.id) ?? null;
        return null;
      }),
      create: jest.fn(async (args: any) => {
        calls.userCreate.push(args);
        const isLegacy = args.data.email === DELETED_USER_EMAIL;
        const u = { id: isLegacy ? 'deleted-sys' : 'deleted-ghost', ...args.data };
        users.push(u);
        return { id: u.id };
      }),
      delete: jest.fn(async (args: any) => {
        const index = users.findIndex((u) => u.id === args.where.id);
        if (index >= 0) users.splice(index, 1);
        return {};
      }),
    },
    comment: {
      findMany: jest.fn(async () => ownedComments),
      updateMany: jest.fn(async (args: any) => {
        calls.commentUpdateMany.push(args);
        return { count: args.where?.id?.in?.length ?? 2 };
      }),
      deleteMany: jest.fn(async () => ({
        count: ownedComments.filter((comment) => !protectedCommentIds.includes(comment.id)).length,
      })),
    },
    commentImage: model(),
    rating: model(3),
    reaction: model(4),
    characterVote: model(5),
    userEpisodeStatus: model(6),
    userMovieStatus: model(1),
    passwordReset: model(),
    deletionRequest: model(),
    pushNotificationJob: model(),
    externalReview: model(),
    commentLike: {
      findMany: jest.fn(async () => [{ commentId: 'c-liked-1' }, { commentId: 'c-liked-2' }]),
    },
    commentSpoilerReport: {
      findMany: jest.fn(async () => [{ commentId: 'c-flagged-1' }]),
    },
    externalReviewLike: {
      findMany: jest.fn(async () => [{ externalReviewId: 'review-1' }]),
    },
    $queryRaw: jest.fn(async () => {
      queryRawCall += 1;
      if (queryRawCall === 1) return [{ acquired: true }];
      return protectedCommentIds.map((id) => ({ id }));
    }),
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, calls, users };
}

describe('deleted-user identities', () => {
  it('identifies legacy and per-deletion ghosts without classifying ordinary users', () => {
    expect(isDeletedUserAccount({ email: DELETED_USER_EMAIL })).toBe(true);
    expect(isDeletedUserAccount({ username: DELETED_USER_USERNAME })).toBe(true);
    expect(isDeletedUserAccount({ email: 'deleted+abc@shadow.local' })).toBe(true);
    expect(isDeletedUserAccount({ email: 'a@b.c', username: 'deleted-looking' })).toBe(false);
    expect(isReservedUserEmail('deleted+abc@shadow.local')).toBe(true);
  });

  it('creates the legacy system account once and reuses it', async () => {
    const { prisma, calls } = makePrisma({ userExists: false });
    const id1 = await getOrCreateDeletedUser(prisma);
    const id2 = await getOrCreateDeletedUser(prisma);
    expect(id1).toBe('deleted-sys');
    expect(id2).toBe('deleted-sys');
    expect(calls.userCreate).toHaveLength(1);
    expect(calls.userCreate[0].data.email).toBe(DELETED_USER_EMAIL);
  });

  it('returns the existing legacy system account without creating', async () => {
    const { prisma, calls } = makePrisma({ existingDeletedUser: true });
    expect(await getOrCreateDeletedUser(prisma)).toBe('deleted-sys');
    expect(calls.userCreate).toHaveLength(0);
  });
});

describe('anonymizeAndDeleteUser', () => {
  it('moves community contributions to a unique ghost and cascades the original user', async () => {
    const { prisma, calls, users } = makePrisma();
    const result = await anonymizeAndDeleteUser(prisma, 'u1');

    const ghostCreate = calls.userCreate.find((call) => call.data.isShadow === true);
    expect(ghostCreate).toBeDefined();
    expect(ghostCreate.data.email).toMatch(/^deleted\+[a-f0-9]{20}@shadow\.local$/);
    expect(ghostCreate.data.passwordHash).toBeNull();
    expect(ghostCreate.data.isSuspended).toBe(true);
    expect(users.some((u) => u.id === 'u1')).toBe(false);
    expect(users.some((u) => u.id === 'deleted-ghost')).toBe(true);

    expect(prisma.rating.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { userId: 'deleted-ghost' },
    });
    expect(prisma.reaction.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { userId: 'deleted-ghost' },
    });
    expect(prisma.characterVote.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { userId: 'deleted-ghost' },
    });
    expect(prisma.userEpisodeStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', device: { not: null } },
      data: {
        userId: 'deleted-ghost',
        watched: false,
        watchedAt: null,
        watchCount: 0,
      },
    });
    expect(prisma.userMovieStatus.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', device: { not: null } },
      data: {
        userId: 'deleted-ghost',
        watched: false,
        watchedAt: null,
        watchCount: 0,
      },
    });
    expect(prisma.passwordReset.deleteMany).toHaveBeenCalled();
    expect(prisma.deletionRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: null }) }),
    );
    expect(prisma.pushNotificationJob.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });

    expect(result).toEqual({
      ghostUserId: 'deleted-ghost',
      commentsPreserved: 2,
      commentsDeleted: 1,
      ratingsPreserved: 3,
      reactionsPreserved: 4,
      characterVotesPreserved: 5,
      deviceVotesPreserved: 7,
    });

    expect(
      calls.commentUpdateMany.some(
        (call) => call.where.id?.in?.includes('c-liked-1') && call.data.likesCount?.decrement === 1,
      ),
    ).toBe(true);
    expect(
      calls.commentUpdateMany.some(
        (call) =>
          call.where.id?.in?.includes('c-flagged-1') && call.data.spoilerCount?.decrement === 1,
      ),
    ).toBe(true);
    expect(prisma.externalReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['review-1'] } },
        data: { likesCount: { decrement: 1 } },
      }),
    );
    expect(prisma.comment.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        id: { in: ['c-thread-root', 'c-thread-middle'] },
      },
      data: { userId: 'deleted-ghost' },
    });
    expect(prisma.commentImage.updateMany).toHaveBeenCalledWith({
      where: { commentId: { in: ['c-thread-root', 'c-thread-middle'] } },
      data: { userId: 'deleted-ghost' },
    });
    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // Advisory try-lock + database-local timeouts + protected-comment tree query.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.$queryRaw.mock.calls[1][1]).toBe('30000');
    expect(prisma.$queryRaw.mock.calls[1][2]).toBe('840000');
  });

  it('deletes an all-self-authored branch instead of preserving unnecessary ghosts', async () => {
    const { prisma } = makePrisma({
      protectedCommentIds: [],
      ownedComments: [
        { id: 'root', parentId: 'surviving-parent' },
        { id: 'self-reply', parentId: 'root' },
      ],
    });

    const result = await anonymizeAndDeleteUser(prisma, 'u1');

    expect(result).toEqual(expect.objectContaining({ commentsPreserved: 0, commentsDeleted: 2 }));
    expect(
      prisma.comment.updateMany.mock.calls.some(
        ([args]: any[]) => args.data?.userId === 'deleted-ghost',
      ),
    ).toBe(false);
    expect(prisma.commentImage.updateMany).not.toHaveBeenCalled();
    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // Advisory try-lock + database-local timeouts + protected-comment tree query.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when the original user is already gone', async () => {
    const { prisma, calls } = makePrisma({ userExists: false });
    expect(await anonymizeAndDeleteUser(prisma, 'u1')).toBeNull();
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(calls.userCreate).toHaveLength(0);
  });

  it('rejects a concurrent deletion immediately without creating a ghost', async () => {
    const { prisma, calls } = makePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([{ acquired: false }]);

    await expect(anonymizeAndDeleteUser(prisma, 'u1')).rejects.toBeInstanceOf(
      AccountDeletionInProgressError,
    );
    expect(calls.userCreate).toHaveLength(0);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});
