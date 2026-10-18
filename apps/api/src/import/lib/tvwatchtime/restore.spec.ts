import { deletedGhostIdentity } from '../../../users/lib/deleted-user';
import { applyAccountRestore, reclaimDeletedAccount, type TvwRestoreData } from './restore';

const restoreData = (overrides: Partial<TvwRestoreData> = {}): TvwRestoreData => ({
  version: 1,
  restoreToken: null,
  profile: null,
  notificationPreferences: null,
  tracking: [],
  providerAlerts: [],
  social: { following: [], blocked: [], listSubscriptions: [], likedLists: [] },
  ...overrides,
});

const prismaMock = (overrides: Record<string, any> = {}) => ({
  mediaItem: { findMany: jest.fn(async () => []) },
  userShowStatus: {
    findMany: jest.fn(async () => []),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({ id: 'status-new' })),
  },
  importAppliedRecord: { createMany: jest.fn(async () => ({ count: 0 })) },
  watchProviderAlert: { createMany: jest.fn(async (args: any) => ({ count: args.data.length })) },
  userProfile: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
  notificationPreference: {
    findUnique: jest.fn(async () => null),
    upsert: jest.fn(async () => ({})),
  },
  user: { findMany: jest.fn(async () => []) },
  block: {
    createMany: jest.fn(async (args: any) => ({ count: args.data.length })),
    findMany: jest.fn(async () => []),
  },
  follow: { createMany: jest.fn(async (args: any) => ({ count: args.data.length })) },
  customList: { findMany: jest.fn(async () => []) },
  listSubscription: { createMany: jest.fn(async (args: any) => ({ count: args.data.length })) },
  listLike: { createMany: jest.fn(async (args: any) => ({ count: args.data.length })) },
  ...overrides,
});

const passThrough = (_exportId: string, staged: string | null) => staged;

describe('applyAccountRestore', () => {
  it('restores tracking state only where the new account has none', async () => {
    const prisma = prismaMock({
      mediaItem: {
        findMany: jest.fn(async () => [{ id: 'show-a' }, { id: 'show-b' }, { id: 'show-c' }]),
      },
      userShowStatus: {
        findMany: jest.fn(async () => [
          {
            id: 'status-a',
            mediaId: 'show-a',
            dropped: false,
            pausedAt: null,
            rewatchStartedAt: null,
          },
          // The person already paused this show on the new account; theirs wins.
          {
            id: 'status-b',
            mediaId: 'show-b',
            dropped: false,
            pausedAt: new Date(),
            rewatchStartedAt: null,
          },
        ]),
        update: jest.fn(async () => ({})),
        create: jest.fn(async () => ({ id: 'status-c' })),
      },
    });
    const result = await applyAccountRestore(
      prisma,
      'user-1',
      'import-1',
      restoreData({
        tracking: [
          {
            mediaExportId: 'a',
            mediaId: 'show-a',
            dropped: true,
            pausedAt: '2024-01-01T00:00:00.000Z',
            rewatchStartedAt: null,
          },
          {
            mediaExportId: 'b',
            mediaId: 'show-b',
            dropped: true,
            pausedAt: null,
            rewatchStartedAt: null,
          },
          {
            mediaExportId: 'c',
            mediaId: 'show-c',
            dropped: false,
            pausedAt: '2024-02-02T00:00:00.000Z',
            rewatchStartedAt: null,
          },
          // Unresolved targets are ignored.
          {
            mediaExportId: 'd',
            mediaId: null,
            dropped: true,
            pausedAt: null,
            rewatchStartedAt: null,
          },
        ],
      }),
      passThrough,
    );

    expect(result.tracking).toBe(2);
    // Dropped and paused are exclusive: a dropped show never keeps a pause date.
    expect(prisma.userShowStatus.update).toHaveBeenCalledWith({
      where: { id: 'status-a' },
      data: { dropped: true, pausedAt: null, rewatchStartedAt: null },
    });
    expect(prisma.userShowStatus.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        mediaId: 'show-c',
        dropped: false,
        pausedAt: new Date('2024-02-02T00:00:00.000Z'),
        rewatchStartedAt: null,
      },
      select: { id: true },
    });
    expect(prisma.importAppliedRecord.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ targetRecordId: 'status-a', action: 'updated' }),
        expect.objectContaining({ targetRecordId: 'status-c', action: 'created' }),
      ],
    });
  });

  it('prefers the reviewed import target over the staged match', async () => {
    const prisma = prismaMock({
      mediaItem: { findMany: jest.fn(async () => [{ id: 'reviewed-show' }]) },
    });
    await applyAccountRestore(
      prisma,
      'user-1',
      'import-1',
      restoreData({
        tracking: [
          {
            mediaExportId: 'a',
            mediaId: 'staged-show',
            dropped: true,
            pausedAt: null,
            rewatchStartedAt: null,
          },
        ],
      }),
      (exportId) => (exportId === 'a' ? 'reviewed-show' : null),
    );
    expect(prisma.userShowStatus.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mediaId: 'reviewed-show' }) }),
    );
  });

  it('fills empty profile fields and defaults without replacing chosen values', async () => {
    const prisma = prismaMock({
      userProfile: {
        findUnique: jest.fn(async () => ({
          displayName: 'Chosen on signup',
          bio: null,
          isPrivate: false,
          themePreference: 'DARK',
          languagePreference: 'EN',
          exploreSections: null,
        })),
        upsert: jest.fn(async () => ({})),
      },
    });
    const result = await applyAccountRestore(
      prisma,
      'user-1',
      'import-1',
      restoreData({
        profile: {
          displayName: 'Old name',
          bio: 'Old bio',
          location: null,
          isPrivate: true,
          hideAnimeInExplore: null,
          exploreDefaultFilters: null,
          exploreSections: { order: ['trending'] },
          theme: 'LIGHT',
          language: 'FR',
        },
      }),
      passThrough,
    );
    expect(result.profileFields).toBe(4);
    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: expect.any(Object),
      update: {
        bio: 'Old bio',
        isPrivate: true,
        exploreSections: { order: ['trending'] },
        themePreference: 'LIGHT',
      },
    });
  });

  it('restores blocks before follows and never follows across a block', async () => {
    const prisma = prismaMock({
      user: {
        findMany: jest.fn(async () => [
          { id: 'u-friend', username: 'friend' },
          { id: 'u-troll', username: 'troll' },
          { id: 'u-blocker', username: 'blocker' },
        ]),
      },
      block: {
        createMany: jest.fn(async (args: any) => ({ count: args.data.length })),
        findMany: jest.fn(async () => [
          { blockerId: 'user-1', blockedId: 'u-troll' },
          { blockerId: 'u-blocker', blockedId: 'user-1' },
        ]),
      },
    });
    const result = await applyAccountRestore(
      prisma,
      'user-1',
      'import-1',
      restoreData({
        social: {
          following: ['friend', 'troll', 'blocker', 'gone'],
          blocked: ['troll'],
          listSubscriptions: [],
          likedLists: [],
        },
      }),
      passThrough,
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isShadow: false, id: { not: 'user-1' } }),
      }),
    );
    expect(prisma.block.createMany).toHaveBeenCalledWith({
      data: [{ blockerId: 'user-1', blockedId: 'u-troll' }],
      skipDuplicates: true,
    });
    expect(prisma.follow.createMany).toHaveBeenCalledWith({
      data: [{ followerId: 'user-1', targetId: 'u-friend' }],
      skipDuplicates: true,
    });
    expect(result).toMatchObject({ following: 1, blocked: 1 });
  });

  it('only re-subscribes to lists that still exist publicly and belong to someone else', async () => {
    const prisma = prismaMock({
      customList: { findMany: jest.fn(async () => [{ id: 'public-list' }]) },
    });
    const result = await applyAccountRestore(
      prisma,
      'user-1',
      'import-1',
      restoreData({
        social: {
          following: [],
          blocked: [],
          listSubscriptions: [
            { listId: 'public-list', notifyOnAdd: true },
            { listId: 'deleted-or-private', notifyOnAdd: false },
          ],
          likedLists: ['public-list', 'deleted-or-private'],
        },
      }),
      passThrough,
    );
    expect(prisma.customList.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['public-list', 'deleted-or-private'] },
        visibility: 'PUBLIC',
        userId: { not: 'user-1' },
      },
      select: { id: true },
    });
    expect(result).toMatchObject({ listSubscriptions: 1, likedLists: 1 });
  });
});

describe('reclaimDeletedAccount', () => {
  const ghostEmail = deletedGhostIdentity('old-user').email;

  it('does nothing while the original account still exists', async () => {
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 'old-user' })) },
      $transaction: jest.fn(),
    };
    await expect(reclaimDeletedAccount(prisma, 'new-user', 'old-user')).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an account that is not the deterministic deleted-account ghost', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(async (args: any) =>
          args.where.email === ghostEmail
            ? { id: 'ghost', email: 'someone@example.test', username: 'someone', isShadow: true }
            : null,
        ),
      },
      $transaction: jest.fn(),
    };
    await expect(reclaimDeletedAccount(prisma, 'new-user', 'old-user')).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('moves the ghost rows to the new account inside one locked transaction', async () => {
    const executeRaw = jest.fn(async () => 2);
    const tx = {
      $queryRaw: jest.fn(async () => [{ acquired: true }]),
      $executeRaw: executeRaw,
    };
    const prisma = {
      user: {
        findUnique: jest.fn(async (args: any) =>
          args.where.email === ghostEmail
            ? { id: 'ghost', email: ghostEmail, username: 'deleted-x', isShadow: true }
            : null,
        ),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const result = await reclaimDeletedAccount(prisma, 'new-user', 'old-user');
    expect(result).toEqual({
      ratings: 2,
      reactions: 2,
      characterVotes: 2,
      deviceVotes: 4,
      comments: 2,
    });
    const statements = executeRaw.mock.calls.map((call: any[]) => call[0].join('?'));
    expect(statements.some((sql: string) => sql.includes('UPDATE comments SET user_id'))).toBe(
      true,
    );
    // Superseded ghost copies are removed so aggregates count the person once.
    expect(statements.filter((sql: string) => sql.includes('DELETE FROM'))).toHaveLength(5);
  });

  it('skips when another reclaim holds the ghost lock', async () => {
    const tx = { $queryRaw: jest.fn(async () => [{ acquired: false }]), $executeRaw: jest.fn() };
    const prisma = {
      user: {
        findUnique: jest.fn(async (args: any) =>
          args.where.email === ghostEmail
            ? { id: 'ghost', email: ghostEmail, username: 'deleted-x', isShadow: true }
            : null,
        ),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    await expect(reclaimDeletedAccount(prisma, 'new-user', 'old-user')).resolves.toBeNull();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
