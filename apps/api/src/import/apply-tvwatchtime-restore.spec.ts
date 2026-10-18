jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./lib/tvwatchtime/restore', () => ({
  ...jest.requireActual('./lib/tvwatchtime/restore'),
  reclaimDeletedAccount: jest.fn(async () => ({
    ratings: 1,
    reactions: 0,
    characterVotes: 0,
    deviceVotes: 0,
    comments: 1,
  })),
  applyAccountRestore: jest.fn(async () => ({ tracking: 1 })),
}));
jest.mock('../media-metadata/util/identity-write-guard', () => ({
  ...jest.requireActual('../media-metadata/util/identity-write-guard'),
  assertMediaIdentityWrite: jest.fn(async () => undefined),
}));
jest.mock('../media-metadata/util/canonical-media', () => ({
  ...jest.requireActual('../media-metadata/util/canonical-media'),
  canonicalMediaId: jest.fn(async (_db: unknown, id: string) => id),
}));
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ImportService } from './import.service';
import { assertMediaIdentityWrite } from '../media-metadata/util/identity-write-guard';
import { canonicalMediaId } from '../media-metadata/util/canonical-media';
import { applyAccountRestore, reclaimDeletedAccount } from './lib/tvwatchtime/restore';
import { signAccountRestoreToken } from '../users/lib/restore-token';

const D1 = '2024-01-02T03:04:05.000Z';
const D2 = '2024-03-04T05:06:07.000Z';
const SECRET = 'test-secret-value-1234';

function makeService(prisma: any, config: any = { get: jest.fn() }) {
  if (!prisma.$transaction) prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const service: any = new ImportService(
    prisma,
    { delete: jest.fn(async () => undefined) } as any,
    {} as any,
    { emit: jest.fn() } as any,
    config,
    {} as any,
    {} as any,
    { importFromUrl: jest.fn() } as any,
    {} as any,
  );
  const writes: Record<string, any[]> = {};
  service.chunkedCreateMany = jest.fn(async (_tx: any, model: string, rows: any[]) => {
    (writes[model] ??= []).push(...rows);
  });
  return { service, writes };
}

describe('native restore apply', () => {
  function libraryPrisma() {
    return {
      mediaItem: { findMany: jest.fn(async () => [{ id: 'movie', type: 'MOVIE' }]) },
      movie: { findMany: jest.fn(async () => [{ mediaId: 'movie', runtimeMinutes: 100 }]) },
      episode: { findMany: jest.fn(async () => []) },
      userMovieStatus: { findMany: jest.fn(async () => []) },
      watchlistItem: { findMany: jest.fn(async () => []) },
      favorite: { findMany: jest.fn(async () => []) },
      import: {
        update: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => ({ status: 'IMPORTING', format: 'tvwatchtime' })),
      },
      importItem: { updateMany: jest.fn(async () => ({})) },
      $queryRaw: jest.fn(async () => []),
    };
  }

  it('writes one history row per exported view and keeps original dates and priority', async () => {
    const { service, writes } = makeService(libraryPrisma());
    const base = { status: 'MATCHED', matchedMediaId: 'movie', matchedEpisodeId: null };
    await service.applyBatch(
      'user',
      'import',
      [
        {
          ...base,
          id: 'watched',
          sourceEntityType: 'WATCHED_MOVIE',
          normalizedData: {
            voteKey: 'tvwatchtime:movie:movie',
            watchCount: 2,
            watchedAt: D2,
            watchDates: [D1, D2],
            device: 'TV',
          },
        },
        {
          ...base,
          id: 'watchlist',
          sourceEntityType: 'WATCHLIST_MOVIE',
          normalizedData: { voteKey: 'tvwatchtime:watchlist:movie', addedAt: D1, priority: 2 },
        },
        {
          ...base,
          id: 'favorite',
          sourceEntityType: 'FAVORITE_MOVIE',
          normalizedData: { voteKey: 'tvwatchtime:favorite:movie', addedAt: D2 },
        },
      ],
      'MANUAL',
    );

    expect(writes.userMovieStatus).toEqual([
      expect.objectContaining({
        source: 'MANUAL',
        watchCount: 2,
        watchedAt: new Date(D2),
        device: 'TV',
      }),
    ]);
    expect(writes.watchHistory.map((row: any) => row.watchedAt)).toEqual([
      new Date(D1),
      new Date(D2),
    ]);
    expect(writes.watchlistItem).toEqual([
      expect.objectContaining({ createdAt: new Date(D1), priority: 2 }),
    ]);
    expect(writes.favorite).toEqual([expect.objectContaining({ createdAt: new Date(D2) })]);
  });

  it('leaves other formats on the single-history-row path with default dates', async () => {
    const { service, writes } = makeService(libraryPrisma());
    await service.applyBatch(
      'user',
      'import',
      [
        {
          id: 'watched',
          status: 'MATCHED',
          sourceEntityType: 'WATCHED_MOVIE',
          matchedMediaId: 'movie',
          normalizedData: { watchCount: 3, watchedAt: D1 },
        },
        {
          id: 'watchlist',
          status: 'MATCHED',
          sourceEntityType: 'WATCHLIST_MOVIE',
          matchedMediaId: 'movie',
          normalizedData: { watchedAt: D2 },
        },
      ],
      'TRAKT',
    );
    expect(writes.watchHistory).toHaveLength(1);
    expect(writes.userMovieStatus[0]).not.toHaveProperty('device');
    expect(writes.watchlistItem[0]).not.toHaveProperty('createdAt');
    expect(writes.watchlistItem[0]).not.toHaveProperty('priority');
  });
});

describe('exact same-server restore identity', () => {
  beforeEach(() => jest.clearAllMocks());

  function guardPrisma(format: string) {
    return {
      mediaCanonicalLink: {},
      mediaItem: { findMany: jest.fn(async () => [{ id: 'show', type: 'SHOW' }]) },
      episode: { findMany: jest.fn(async () => []) },
      userEpisodeStatus: { findMany: jest.fn(async () => []) },
      watchlistItem: { findMany: jest.fn(async () => []) },
      import: {
        update: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => ({ status: 'IMPORTING', format })),
      },
      importItem: { updateMany: jest.fn(async () => ({})) },
      $queryRaw: jest.fn(async () => []),
    };
  }
  const watched = (exportMediaId: string) => ({
    id: 'item',
    status: 'MATCHED',
    sourceEntityType: 'WATCHLIST_SHOW',
    matchedMediaId: 'show',
    normalizedData: { exportMediaId },
  });
  const tolerated = () =>
    (assertMediaIdentityWrite as jest.Mock).mock.calls.map((call) => call[5]?.exactRestore);

  it('tolerates a row awaiting repair only on the exact exported row', async () => {
    await makeService(guardPrisma('tvwatchtime')).service.applyBatch(
      'user',
      'import',
      [watched('show')],
      'MANUAL',
    );
    expect(tolerated()).toEqual([true]);
  });

  it('keeps the full check for a provider-matched or re-resolved target', async () => {
    await makeService(guardPrisma('tvwatchtime')).service.applyBatch(
      'user',
      'import',
      [watched('other-server-show')],
      'MANUAL',
    );
    expect(tolerated()).toEqual([false]);
  });

  it('keeps the full check after a canonical redirect', async () => {
    (canonicalMediaId as jest.Mock).mockResolvedValueOnce('canonical-show');
    await makeService(guardPrisma('tvwatchtime')).service.applyBatch(
      'user',
      'import',
      [watched('show')],
      'MANUAL',
    );
    expect(tolerated()).toEqual([false]);
  });

  it('never applies to other formats', async () => {
    await makeService(guardPrisma('trakt')).service.applyBatch(
      'user',
      'import',
      [watched('show')],
      'TRAKT',
    );
    expect(tolerated()).toEqual([false]);
  });
});

describe('resolving after completion', () => {
  function resolvePrisma(imp: any) {
    const items = [
      {
        id: 'review-1',
        status: 'NEEDS_REVIEW',
        sourceEntityType: 'WATCHED_EPISODE',
        normalizedData: { title: 'The Haunting', season: 2, episode: 1 },
      },
    ];
    return {
      import: {
        findFirst: jest.fn(async () => imp),
        update: jest.fn(async () => ({})),
      },
      mediaItem: { findUnique: jest.fn(async () => ({ type: 'SHOW' })) },
      importItem: {
        findMany: jest.fn(async (args: any) =>
          args.where.status === 'MATCHED'
            ? [{ ...items[0], status: 'MATCHED', matchedMediaId: 'bly-manor' }]
            : items,
        ),
        update: jest.fn(async () => ({})),
        groupBy: jest.fn(async () => []),
      },
    };
  }
  function resolveService(imp: any) {
    const { service } = makeService(resolvePrisma(imp));
    service.matcher = {
      ensureShowHydrated: jest.fn(async () => undefined),
      reconcileStructureForMissingEpisodes: jest.fn(async () => undefined),
      resolveEpisode: jest.fn(async () => 'bly-manor-s1e1'),
    };
    jest.spyOn(service, 'applyBatch').mockResolvedValue({ created: 1, skipped: 0 });
    jest.spyOn(service, 'rebuildShowStatuses').mockResolvedValue(undefined);
    jest.spyOn(service, 'invalidateImportedLibrary').mockResolvedValue(undefined);
    return service;
  }

  it('applies rows resolved on a completed import immediately', async () => {
    const service = resolveService({ id: 'import', status: 'COMPLETED', format: 'tvwatchtime' });
    const result = await service.resolveAllForShow(
      'user',
      'import',
      'bly-manor',
      'The Haunting',
      2,
    );
    expect(result).toMatchObject({ matched: 1, applied: 1 });
    expect(service.applyBatch).toHaveBeenCalledWith(
      'user',
      'import',
      [expect.objectContaining({ id: 'review-1', matchedMediaId: 'bly-manor' })],
      'MANUAL',
    );
    expect(service.rebuildShowStatuses).toHaveBeenCalled();
    expect(service.invalidateImportedLibrary).toHaveBeenCalledWith('user', 'MANUAL', ['bly-manor']);
  });

  it.each([
    ['before confirmation', { id: 'import', status: 'READY_FOR_REVIEW', format: 'tvwatchtime' }],
    ['for a completed TV Time import', { id: 'import', status: 'COMPLETED', format: 'tvtime' }],
  ])('leaves applying to confirm %s', async (_label, imp) => {
    const service = resolveService(imp);
    const result = await service.resolveAllForShow(
      'user',
      'import',
      'bly-manor',
      'The Haunting',
      2,
    );
    expect(result).toMatchObject({ matched: 1, applied: 0 });
    expect(service.applyBatch).not.toHaveBeenCalled();
  });
});

describe('native restore comments', () => {
  function commentPrisma(existing: any[]) {
    return {
      comment: {
        findMany: jest.fn(async (args: any) => {
          const where = args?.where ?? {};
          if (where.id?.in) return existing.filter((row) => where.id.in.includes(row.id));
          return [];
        }),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      import: {
        update: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => ({ status: 'IMPORTING', format: 'tvwatchtime' })),
      },
      importItem: { updateMany: jest.fn(async () => ({})) },
      $queryRaw: jest.fn(async () => []),
    };
  }
  const comment = (id: string, parentId: string | null) => ({
    id: `item-${id}`,
    status: 'MATCHED',
    sourceEntityType: 'EPISODE_COMMENT',
    matchedMediaId: 'show',
    matchedEpisodeId: 'episode',
    normalizedData: {
      text: `text ${id}`,
      sourceKey: `tvwatchtime:comment:${id}`,
      authorIsOwner: true,
      parentSourceKey: parentId ? `tvwatchtime:comment:${parentId}` : null,
      parentCommentId: parentId,
      sourceCreatedAt: D1,
    },
  });

  it('never recreates live comments and threads replies under live or restored parents', async () => {
    const prisma = commentPrisma([
      // Reclaimed from the deleted account's ghost (same id as in the export).
      { id: 'reclaimed', depth: 0, rootId: null },
      // Written by someone else and still on the server.
      { id: 'theirs', depth: 1, rootId: 'root' },
    ]);
    const { service, writes } = makeService(prisma);
    const result = await service.applyComments(
      'user',
      'import',
      [
        comment('reclaimed', null),
        comment('reply-to-theirs', 'theirs'),
        comment('reply-to-mine', 'reclaimed'),
        comment('reply-to-new', 'new-top'),
        comment('new-top', null),
      ],
      'MANUAL',
    );

    const rows = writes.comment;
    const bySourceKey = new Map(rows.map((row: any) => [row.sourceKey, row]));
    expect(rows).toHaveLength(4);
    expect(bySourceKey.has('tvwatchtime:comment:reclaimed')).toBe(false);
    expect(bySourceKey.get('tvwatchtime:comment:reply-to-theirs')).toMatchObject({
      userId: 'user',
      parentId: 'theirs',
      depth: 2,
      rootId: 'root',
      source: 'MANUAL',
      createdAt: new Date(D1),
    });
    expect(bySourceKey.get('tvwatchtime:comment:reply-to-mine')).toMatchObject({
      parentId: 'reclaimed',
      depth: 1,
      rootId: 'reclaimed',
    });
    const top: any = bySourceKey.get('tvwatchtime:comment:new-top');
    expect(top).toMatchObject({ parentId: null, depth: 0 });
    expect(bySourceKey.get('tvwatchtime:comment:reply-to-new')).toMatchObject({
      parentId: top.id,
      depth: 1,
    });
    expect(result).toEqual({ created: 4, skipped: 1 });
  });
});

describe('native restore confirm', () => {
  beforeEach(() => jest.clearAllMocks());

  function confirmPrisma(restoreData: any) {
    return {
      import: {
        findFirst: jest.fn(async () => ({
          id: 'import',
          userId: 'user',
          status: 'READY_FOR_REVIEW',
          format: 'tvwatchtime',
          storageKey: 'key',
          restoreData,
        })),
        update: jest.fn(async () => ({})),
      },
      importItem: {
        findMany: jest.fn(async (args: any) =>
          args.where.status?.in?.includes('APPLIED')
            ? [
                // An anthology episode routed elsewhere must not redirect the show itself.
                {
                  sourceEntityType: 'WATCHED_EPISODE',
                  rawData: { exportMediaId: 'old-show' },
                  matchedMediaId: 'anthology-show',
                },
                {
                  sourceEntityType: 'WATCHLIST_SHOW',
                  rawData: { exportMediaId: 'old-show' },
                  matchedMediaId: 'reviewed-show',
                },
              ]
            : [],
        ),
      },
    };
  }

  function stubConfirmSteps(service: any) {
    for (const method of [
      'reconcileSkippedStructureItemsForImport',
      'claimShadowAccount',
      'enqueuePendingStructureEvaluations',
      'reconcilePendingCharacterVotes',
      'rebuildShowStatuses',
    ]) {
      jest.spyOn(service, method).mockResolvedValue(undefined);
    }
    jest.spyOn(service, 'applyBatch').mockResolvedValue({ created: 3, skipped: 0 });
  }

  it('reclaims before apply, restores account state after, then drops the staged copy', async () => {
    const restoreData = {
      version: 1,
      restoreToken: signAccountRestoreToken(SECRET, 'old-user'),
      tracking: [],
      providerAlerts: [],
      social: { following: [], blocked: [], listSubscriptions: [], likedLists: [] },
    };
    const prisma = confirmPrisma(restoreData);
    const { service } = makeService(prisma, {
      get: jest.fn((key: string) => (key === 'jwt.secret' ? SECRET : undefined)),
    });
    stubConfirmSteps(service);

    await service.confirm('user', 'import');

    expect(reclaimDeletedAccount).toHaveBeenCalledWith(prisma, 'user', 'old-user');
    expect((reclaimDeletedAccount as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      service.applyBatch.mock.invocationCallOrder[0],
    );
    expect(service.applyBatch).toHaveBeenCalledWith('user', 'import', [], 'MANUAL');
    expect((applyAccountRestore as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
      service.rebuildShowStatuses.mock.invocationCallOrder[0],
    );
    const mediaIdFor = (applyAccountRestore as jest.Mock).mock.calls[0][4];
    expect(mediaIdFor('old-show', 'staged')).toBe('reviewed-show');
    expect(mediaIdFor('unknown', 'staged')).toBe('staged');
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'import' },
      data: { restoreData: Prisma.DbNull },
    });
  });

  it('never reclaims with a token this server did not sign', async () => {
    const prisma = confirmPrisma({
      version: 1,
      restoreToken: signAccountRestoreToken('someone-elses-secret', 'old-user'),
      tracking: [],
      providerAlerts: [],
      social: { following: [], blocked: [], listSubscriptions: [], likedLists: [] },
    });
    const { service } = makeService(prisma, {
      get: jest.fn((key: string) => (key === 'jwt.secret' ? SECRET : undefined)),
    });
    stubConfirmSteps(service);

    await service.confirm('user', 'import');

    expect(reclaimDeletedAccount).not.toHaveBeenCalled();
    expect(service.applyBatch).toHaveBeenCalled();
    expect(applyAccountRestore).toHaveBeenCalled();
  });
});

describe('apply-time identity recheck', () => {
  beforeEach(() => jest.clearAllMocks());

  function run(format: string, error: Error) {
    (assertMediaIdentityWrite as jest.Mock).mockRejectedValueOnce(error);
    const prisma: any = {
      mediaCanonicalLink: {},
      mediaItem: { findMany: jest.fn(async () => [{ id: 'show', type: 'SHOW' }]) },
      episode: { findMany: jest.fn(async () => []) },
      userEpisodeStatus: { findMany: jest.fn(async () => []) },
      watchlistItem: { findMany: jest.fn(async () => []) },
      import: {
        update: jest.fn(async () => ({})),
        findUnique: jest.fn(async () => ({ status: 'IMPORTING', format })),
      },
      importItem: { updateMany: jest.fn(async () => ({})) },
      $queryRaw: jest.fn(async () => []),
    };
    const { service, writes } = makeService(prisma);
    service.hydration = { enqueueIdentityRepair: jest.fn(async () => undefined) };
    const items = [1, 2].map((n) => ({
      id: 'item-' + n,
      status: 'MATCHED',
      sourceEntityType: 'WATCHLIST_SHOW',
      matchedMediaId: 'show',
      normalizedData: {},
    }));
    return { prisma, service, writes, done: service.applyBatch('user', 'import', items, 'TRAKT') };
  }

  it('parks rows awaiting catalog repair with their target and queues one repair', async () => {
    const { prisma, service, writes, done } = run(
      'trakt',
      new ConflictException('Conflicting provider identities require an identity repair'),
    );
    await expect(done).resolves.toMatchObject({ created: 0, skipped: 2 });
    for (const id of ['item-1', 'item-2'])
      expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
        where: { id, importId: 'import' },
        data: {
          status: 'PENDING_MATCH',
          errorMessage: 'Awaiting background media identity repair',
        },
      });
    expect(
      prisma.importItem.updateMany.mock.calls.some(
        ([arg]: any) => arg.data.status === 'NEEDS_REVIEW',
      ),
    ).toBe(false);
    expect(service.hydration.enqueueIdentityRepair).toHaveBeenCalledTimes(1);
    expect(service.hydration.enqueueIdentityRepair).toHaveBeenCalledWith('show', 'import');
    expect(writes.watchlistItem).toBeUndefined();
  });

  it('keeps the review fallback for TV Time imports and non-identity failures', async () => {
    for (const [format, error] of [
      [
        'tvtime',
        new ConflictException('Conflicting provider identities require an identity repair'),
      ],
      ['trakt', new Error('Cyclic canonical redirect')],
    ] as const) {
      jest.clearAllMocks();
      const { prisma, service, done } = run(format, error);
      await done;
      expect(prisma.importItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'NEEDS_REVIEW', matchedMediaId: null }),
        }),
      );
      expect(service.hydration.enqueueIdentityRepair).not.toHaveBeenCalled();
    }
  });
});
