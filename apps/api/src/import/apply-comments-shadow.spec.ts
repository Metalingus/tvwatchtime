jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
import { ImportService } from './import.service';
import { DELETED_USER_EMAIL } from '../users/lib/deleted-user';

/**
 * Full-thread comment import: shadow authors, deferred parent linkage, reconciliation.
 */
describe('ImportService.applyComments — shadow users + parent reconciliation', () => {
  function makeService(opts: { existingComments?: any[]; users?: Map<string, any> }) {
    const createdUsers: any[] = [];
    const deletedUsers: string[] = [];
    const commentCreates: any[] = [];
    const commentUpdates: { where: any; data: any }[] = [];
    let comments = [...(opts.existingComments ?? [])];
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      comment: {
        findMany: jest.fn(async (args: any) => {
          const where = args?.where ?? {};
          if (where.parentSourceKey != null) {
            return comments
              .filter((c) => c.parentSourceKey === where.parentSourceKey && c.parentId == null)
              .map((c) => ({ id: c.id }));
          }
          return comments
            .filter((c) => {
              if (where.sourceKey?.in && !where.sourceKey.in.includes(c.sourceKey)) return false;
              if (where.userId?.in && !where.userId.in.includes(c.userId)) return false;
              if (typeof where.userId === 'string' && c.userId !== where.userId) return false;
              if (where.source && c.source !== where.source) return false;
              return true;
            })
            .map((c) => ({
              ...c,
              user:
                [...(opts.users?.values() ?? [])].find((u) => u.id === c.userId) ??
                createdUsers.find((u) => u.id === c.userId) ??
                null,
            }));
        }),
        update: jest.fn(async (args: any) => {
          commentUpdates.push(args);
          const c = comments.find((x) => x.id === args.where.id);
          if (c && args.data.repliesCount?.increment) {
            c.repliesCount = (c.repliesCount ?? 0) + args.data.repliesCount.increment;
          } else if (c && typeof args.data.repliesCount === 'number') {
            c.repliesCount = args.data.repliesCount;
          }
          return c;
        }),
        updateMany: jest.fn(async (args: any) => {
          for (const c of comments) {
            if (args.where.id?.in?.includes(c.id)) Object.assign(c, args.data);
            else if (args.where.parentId != null && c.parentId === args.where.parentId)
              Object.assign(c, args.data);
          }
          return { count: 1 };
        }),
        deleteMany: jest.fn(async (args: any) => {
          // In-place removal so the shared `comments` array reflects deletions.
          for (let i = comments.length - 1; i >= 0; i--) {
            if (args.where.id?.in?.includes(comments[i].id)) comments.splice(i, 1);
          }
          return { count: 1 };
        }),
        count: jest.fn(async (args: any) => {
          return comments.filter((c) => c.parentId === args?.where?.parentId).length;
        }),
      },
      user: {
        findUnique: jest.fn(async (args: any) => {
          const email = args.where.email;
          return opts.users?.get(email) ?? createdUsers.find((u) => u.email === email) ?? null;
        }),
        create: jest.fn(async (args: any) => {
          const u = { id: `shadow-${createdUsers.length + 1}`, ...args.data };
          createdUsers.push(u);
          return u;
        }),
        delete: jest.fn(async (args: any) => {
          deletedUsers.push(args.where.id);
          for (const [k, v] of opts.users ?? []) {
            if (v.id === args.where.id) opts.users!.delete(k);
          }
          return {};
        }),
      },
      import: {
        findUnique: jest.fn().mockResolvedValue({ status: 'IMPORTING', format: 'trakt' }),
        findFirst: jest.fn(async () => ({ id: 'imp1', userId: 'u1' })),
        update: jest.fn(async () => ({})),
      },
      importItem: { updateMany: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { importFromUrl: jest.fn() } as any,
      {} as any,
    );
    (service as any).chunkedCreateMany = jest.fn(async (_tx: any, model: string, rows: any[]) => {
      if (model === 'comment') {
        commentCreates.push(...rows);
        for (const r of rows) comments.push({ ...r, repliesCount: 0 });
      }
    });
    return {
      service,
      prisma,
      createdUsers,
      deletedUsers,
      commentCreates,
      commentUpdates,
      comments,
    };
  }

  const replyItem = (parentKey: string) => ({
    id: 'it-reply',
    rowNumber: 2,
    sourceEntityType: 'MOVIE_COMMENT',
    status: 'MATCHED',
    matchedMediaId: 'm1',
    normalizedData: {
      text: 'reply text',
      sourceKey: 'tvtime|reply-1',
      sourceCommentId: 'reply-1',
      sourceAuthorId: 'ext-999',
      authorIsOwner: false,
      isReply: true,
      parentSourceCommentId: parentKey,
      spoiler: false,
      spoilerCount: null,
    },
  });

  const parentItem = {
    id: 'it-parent',
    rowNumber: 1,
    sourceEntityType: 'MOVIE_COMMENT',
    status: 'MATCHED',
    matchedMediaId: 'm1',
    normalizedData: {
      text: 'parent text',
      sourceKey: 'tvtime|parent-1',
      sourceCommentId: 'parent-1',
      sourceAuthorId: 'ext-999',
      authorIsOwner: false,
      isReply: false,
      parentSourceCommentId: null,
      spoiler: false,
      spoilerCount: null,
    },
  };

  it('creates a deterministic shadow user for third-party authors and reuses it', async () => {
    const { service, createdUsers, commentCreates } = makeService({});

    await (service as any).applyComments('u1', 'imp1', [parentItem], 'TVTIME');

    expect(createdUsers).toHaveLength(1);
    expect(createdUsers[0].email).toBe('shadow+tvtime-ext-999@shadow.local');
    expect(createdUsers[0].isShadow).toBe(true);
    expect(createdUsers[0].username).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d+$/);
    // The comment belongs to the shadow, not the importing user.
    expect(commentCreates[0].userId).toBe(createdUsers[0].id);
    expect(commentCreates[0].userId).not.toBe('u1');

    // Re-apply: no second shadow account, and the comment is deduped.
    const res2 = await (service as any).applyComments('u1', 'imp1', [parentItem], 'TVTIME');
    expect(createdUsers).toHaveLength(1);
    expect(res2.created).toBe(0);
  });

  it('links a stray reply when its parent arrives in a later import', async () => {
    const { service, comments } = makeService({});

    // Import 1: only the reply (parent unknown) → stored as a stray.
    await (service as any).applyComments('u1', 'imp1', [replyItem('parent-1')], 'TVTIME');
    const stray = comments.find((c) => c.sourceKey === 'tvtime|reply-1');
    expect(stray.parentId).toBeNull();
    expect(stray.parentSourceKey).toBe('tvtime|parent-1');

    // Import 2: the parent arrives (another user's archive, same shadow author).
    await (service as any).applyComments('u2', 'imp2', [parentItem], 'TVTIME');
    const parent = comments.find((c) => c.sourceKey === 'tvtime|parent-1');
    const linked = comments.find((c) => c.sourceKey === 'tvtime|reply-1');
    expect(linked.parentId).toBe(parent.id);
    expect(linked.parentSourceKey).toBe('tvtime|parent-1'); // identity kept
    expect(linked.depth).toBe(1);
    expect(linked.rootId).toBe(parent.id);
    expect(parent.repliesCount).toBe(1);
  });

  it('resolves in-batch parents in order (reply rows get parentId directly)', async () => {
    const { service, commentCreates } = makeService({});
    // Reply first in the array — the pass loop must still link it to the later parent.
    await (service as any).applyComments(
      'u1',
      'imp1',
      [replyItem('parent-1'), parentItem],
      'TVTIME',
    );
    const parent = commentCreates.find((c) => c.sourceKey === 'tvtime|parent-1');
    const reply = commentCreates.find((c) => c.sourceKey === 'tvtime|reply-1');
    expect(reply.parentId).toBe(parent.id);
    expect(reply.depth).toBe(1);
    expect(reply.parentSourceKey).toBeNull();
  });

  it('never duplicates a comment the REAL author already imported (global sourceKey dedupe)', async () => {
    // The real author (u-real) already imported their own archive — their comment exists
    // under their account. Another user's archive carries the SAME comment as a blob reply
    // (shadow candidate, same uuid): it must be deduped, not re-created under the shadow.
    const { service, commentCreates, createdUsers } = makeService({
      existingComments: [
        { id: 'real-c', userId: 'u-real', source: 'TVTIME', sourceKey: 'tvtime|parent-1' },
      ],
    });
    const res = await (service as any).applyComments('u1', 'imp1', [parentItem], 'TVTIME');
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(commentCreates).toHaveLength(0);
    // The shadow account may still be created (claiming later removes it), but no comment.
    expect(createdUsers.length).toBeLessThanOrEqual(1);
  });

  it('imports a leftover reply as a stray when its in-batch parent is never created', async () => {
    // The parent item fails a guard (empty body) → never created. The reply must survive
    // as a stray (parentSourceKey kept) instead of being dropped as a "parent cycle".
    const badParent = {
      ...parentItem,
      normalizedData: { ...parentItem.normalizedData, text: '', image: null },
    };
    const { service, comments } = makeService({});
    const res = await (service as any).applyComments(
      'u1',
      'imp1',
      [badParent, replyItem('parent-1')],
      'TVTIME',
    );
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1); // only the invalid parent
    const reply = comments.find((c) => c.sourceKey === 'tvtime|reply-1');
    expect(reply).toBeDefined();
    expect(reply.parentId).toBeNull();
    expect(reply.parentSourceKey).toBe('tvtime|parent-1');
  });

  it('still skips a TRUE self-cycle (parent key == own source key)', async () => {
    const selfCycle = {
      ...replyItem('parent-1'),
      normalizedData: {
        ...replyItem('parent-1').normalizedData,
        parentSourceCommentId: 'reply-1', // references its own uuid — corrupt source data
      },
    };
    const { service, commentCreates } = makeService({});
    const res = await (service as any).applyComments('u1', 'imp1', [selfCycle], 'TVTIME');
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(commentCreates).toHaveLength(0);
  });

  it('reclaims owner comments that survived a previous account deletion', async () => {
    // The user deleted their account (comments moved to the system deleted-user account),
    // re-registered, and re-imports the same archive: their own comments come back.
    const ownerItem = {
      ...parentItem,
      id: 'it-owner',
      normalizedData: {
        ...parentItem.normalizedData,
        sourceAuthorId: 'owner-ext',
        authorIsOwner: true,
      },
    };
    const { service, commentCreates, comments } = makeService({
      users: new Map([[DELETED_USER_EMAIL, { id: 'deleted-sys', email: DELETED_USER_EMAIL }]]),
      existingComments: [
        { id: 'old-c', userId: 'deleted-sys', source: 'TVTIME', sourceKey: 'tvtime|parent-1' },
      ],
    });
    const res = await (service as any).applyComments('u1', 'imp1', [ownerItem], 'TVTIME');
    expect(res.created).toBe(1); // the reclaim counts as imported
    expect(res.skipped).toBe(0);
    expect(commentCreates).toHaveLength(0); // no second copy
    expect(comments.find((c) => c.id === 'old-c').userId).toBe('u1');
  });

  it('never reclaims third-party (shadow) comments to the importing user', async () => {
    // Another user's archive carries the SAME comment as a blob reply — it must stay with
    // the deleted-user account, not move to the importer.
    const { service, comments } = makeService({
      users: new Map([[DELETED_USER_EMAIL, { id: 'deleted-sys', email: DELETED_USER_EMAIL }]]),
      existingComments: [
        { id: 'old-c', userId: 'deleted-sys', source: 'TVTIME', sourceKey: 'tvtime|parent-1' },
      ],
    });
    const res = await (service as any).applyComments('u-other', 'imp1', [parentItem], 'TVTIME');
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(comments.find((c) => c.id === 'old-c').userId).toBe('deleted-sys');
  });
});

describe('ImportService.claimShadowAccount — shadow → real-user linking', () => {
  function makeService(opts: { existingComments?: any[]; users?: Map<string, any> }) {
    const deletedUsers: string[] = [];
    let comments = [...(opts.existingComments ?? [])];
    const prisma: any = {
      comment: {
        findMany: jest.fn(async (args: any) => {
          const where = args?.where ?? {};
          return comments.filter((c) => {
            if (typeof where.userId === 'string' && c.userId !== where.userId) return false;
            if (where.source && c.source !== where.source) return false;
            if (where.sourceKey?.in && !where.sourceKey.in.includes(c.sourceKey)) return false;
            return true;
          });
        }),
        updateMany: jest.fn(async (args: any) => {
          for (const c of comments) {
            if (args.where.id?.in?.includes(c.id)) Object.assign(c, args.data);
            else if (args.where.parentId != null && c.parentId === args.where.parentId)
              Object.assign(c, args.data);
          }
          return { count: 1 };
        }),
        deleteMany: jest.fn(async (args: any) => {
          for (let i = comments.length - 1; i >= 0; i--) {
            if (args.where.id?.in?.includes(comments[i].id)) comments.splice(i, 1);
          }
          return { count: 1 };
        }),
        count: jest.fn(async (args: any) => {
          return comments.filter((c) => c.parentId === args?.where?.parentId).length;
        }),
        update: jest.fn(async (args: any) => {
          const c = comments.find((x) => x.id === args.where.id);
          if (c) Object.assign(c, args.data);
          return c;
        }),
      },
      user: {
        findUnique: jest.fn(async (args: any) => opts.users?.get(args.where.email) ?? null),
        delete: jest.fn(async (args: any) => {
          deletedUsers.push(args.where.id);
          for (const [k, v] of opts.users ?? []) {
            if (v.id === args.where.id) opts.users!.delete(k);
          }
          return {};
        }),
      },
    };
    const service = new ImportService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { importFromUrl: jest.fn() } as any,
      {} as any,
    );
    return { service, prisma, deletedUsers, comments };
  }

  const shadowUser = { id: 'shadow-1', email: 'shadow+tvtime-ext-999@shadow.local' };

  it('reassigns shadow comments to the real user and deletes the shadow', async () => {
    const { service, comments, deletedUsers } = makeService({
      users: new Map([[shadowUser.email, shadowUser]]),
      existingComments: [
        { id: 'c1', userId: 'shadow-1', source: 'TVTIME', sourceKey: 'tvtime|a' },
        { id: 'c2', userId: 'shadow-1', source: 'TVTIME', sourceKey: 'tvtime|b' },
      ],
    });

    await (service as any).claimShadowAccount('u1', 'imp1', 'ext-999', 'TVTIME');

    expect(comments.find((c) => c.id === 'c1').userId).toBe('u1');
    expect(comments.find((c) => c.id === 'c2').userId).toBe('u1');
    expect(deletedUsers).toEqual(['shadow-1']);
  });

  it('drops colliding duplicates and re-points their children to the real comment', async () => {
    const { service, comments, deletedUsers } = makeService({
      users: new Map([[shadowUser.email, shadowUser]]),
      existingComments: [
        // The real user already has this comment (their own archive contains it too).
        { id: 'real-b', userId: 'u1', source: 'TVTIME', sourceKey: 'tvtime|b', repliesCount: 0 },
        // The shadow's copy of the same comment, plus a shadow-only comment.
        { id: 'dup-b', userId: 'shadow-1', source: 'TVTIME', sourceKey: 'tvtime|b' },
        { id: 'only-shadow', userId: 'shadow-1', source: 'TVTIME', sourceKey: 'tvtime|c' },
        // A third party's reply attached to the shadow's copy.
        {
          id: 'child',
          userId: 'other',
          source: 'TVTIME',
          sourceKey: 'tvtime|r',
          parentId: 'dup-b',
        },
      ],
    });

    await (service as any).claimShadowAccount('u1', 'imp1', 'ext-999', 'TVTIME');

    // Duplicate dropped, shadow-only comment reassigned, child re-pointed, tally recomputed.
    expect(comments.find((c) => c.id === 'dup-b')).toBeUndefined();
    expect(comments.find((c) => c.id === 'only-shadow').userId).toBe('u1');
    expect(comments.find((c) => c.id === 'child').parentId).toBe('real-b');
    expect(comments.find((c) => c.id === 'real-b').repliesCount).toBe(1);
    expect(deletedUsers).toEqual(['shadow-1']);
  });

  it('is a no-op when no shadow exists, for TRAKT, or without an owner id', async () => {
    const { service, prisma, deletedUsers } = makeService({
      users: new Map(),
      existingComments: [],
    });
    await (service as any).claimShadowAccount('u1', 'imp1', 'ext-999', 'TVTIME');
    await (service as any).claimShadowAccount('u1', 'imp1', 'ext-999', 'TRAKT');
    await (service as any).claimShadowAccount('u1', 'imp1', null, 'TVTIME');
    expect(deletedUsers).toEqual([]);
    expect(prisma.comment.updateMany).not.toHaveBeenCalled();
  });
});
