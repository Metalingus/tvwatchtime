import { ImportService } from './import.service';

/**
 * Character-vote apply vs concurrent structure/cast rewrites: staged episode or cast ids can
 * vanish before insert. Replay must resolve the canonical replacement or degrade safely instead
 * of failing the event with an FK violation.
 */
describe('ImportService.applyCharacterVotes — stale castId race', () => {
  const voteItem = {
    id: 'it1',
    sourceEntityType: 'EPISODE_CHARACTER_VOTE',
    status: 'MATCHED',
    matchedMediaId: 'm1',
    matchedEpisodeId: 'e1',
    normalizedData: {
      showCharacterId: 42,
      externalEpisodeId: 1001,
      voteKey: 'episode:1001:char:42',
    },
  };

  function makeService(opts: {
    validateReturns: string[];
    firstInsertFails?: boolean;
    activeEpisodeIds?: string[];
    aliasEpisodeId?: string | null;
    positionEpisodeIds?: string[];
  }) {
    let castFindCalls = 0;
    const inserted: any[][] = [];
    const statusUpdates: any[] = [];
    const prisma: any = {
      mediaCast: {
        findMany: jest.fn(async (args: any) => {
          castFindCalls++;
          // Initial + retry loads resolve by media/character; in-transaction guards
          // validate the already-resolved primary keys.
          if (args?.where?.mediaId) {
            return [{ id: 'cast1', mediaId: 'm1', characterExternalId: 42 }];
          }
          return opts.validateReturns.map((id) => ({ id }));
        }),
      },
      mediaCastExternalId: { findMany: jest.fn(async () => []) },
      mediaItem: { findMany: jest.fn(async () => []) },
      episode: {
        findMany: jest.fn(async (args: any) => {
          if (args?.where?.id) {
            return (opts.activeEpisodeIds ?? ['e1']).map((id) => ({
              id,
              season: { show: { mediaId: 'm1' } },
            }));
          }
          return (opts.positionEpisodeIds ?? []).map((id) => ({ id }));
        }),
      },
      episodeExternalId: {
        findFirst: jest.fn(async () =>
          opts.aliasEpisodeId ? { episodeId: opts.aliasEpisodeId } : null,
        ),
      },
      characterVote: { findMany: jest.fn(async () => []) },
      importItem: {
        update: jest.fn(async (args: any) => {
          statusUpdates.push(args);
          return {};
        }),
        updateMany: jest.fn(async (args: any) => {
          statusUpdates.push(args);
          return {};
        }),
      },
      import: { update: jest.fn(async () => ({})) },
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
      {} as any,
      {
        enqueueTvdbRehydrate: jest.fn(async () => undefined),
        enqueueTvdbMovieCastEnrichment: jest.fn(async () => undefined),
      } as any,
    );
    let inserts = 0;
    (service as any).chunkedCreateMany = jest.fn(async (_tx: any, model: string, rows: any[]) => {
      if (model === 'characterVote') {
        inserts++;
        if (opts.firstInsertFails && inserts === 1) {
          const err: any = new Error('FK violated');
          err.code = 'P2003';
          throw err;
        }
        inserted.push(rows);
      }
    });
    return { service, inserted, statusUpdates, prisma };
  }

  it('drops votes whose castId vanished before the insert (→ PENDING_MATCH, no crash)', async () => {
    const { service, inserted, statusUpdates } = makeService({ validateReturns: [] });

    const res = await (service as any).applyCharacterVotes(
      'u1',
      'imp1',
      [{ ...voteItem, normalizedData: { ...voteItem.normalizedData } }],
      'TVTIME',
    );

    expect(res.created).toBe(0);
    // The vote insert ran with an empty set (nothing crashed).
    expect(inserted.every((rows) => rows.length === 0)).toBe(true);
    // Item marked PENDING_MATCH for a later confirm.
    expect(
      statusUpdates.some((u) => u.data.status === 'PENDING_MATCH' && u.where.id.in.includes('it1')),
    ).toBe(true);
  });

  it('uses an unambiguous active S/E fallback for a regular stale episode', async () => {
    const regularItem = {
      ...voteItem,
      normalizedData: { ...voteItem.normalizedData, seasonNumber: 2, episodeNumber: 4 },
    };
    const { service, inserted } = makeService({
      validateReturns: ['cast1'],
      activeEpisodeIds: [],
      aliasEpisodeId: null,
      positionEpisodeIds: ['e-canonical'],
    });

    const res = await (service as any).applyCharacterVotes('u1', 'imp1', [regularItem], 'TVTIME');

    expect(res).toEqual({ created: 1, skipped: 0 });
    expect(inserted[0][0]).toEqual(expect.objectContaining({ episodeId: 'e-canonical' }));
  });

  it('does not position-match a stale special when its exact alias is absent', async () => {
    const specialItem = {
      ...voteItem,
      normalizedData: { ...voteItem.normalizedData, seasonNumber: 0, episodeNumber: 1 },
    };
    const { service, inserted } = makeService({
      validateReturns: ['cast1'],
      activeEpisodeIds: [],
      aliasEpisodeId: null,
      positionEpisodeIds: ['wrong-special'],
    });

    const res = await (service as any).applyCharacterVotes('u1', 'imp1', [specialItem], 'TVTIME');

    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(inserted).toHaveLength(0);
  });

  it('retries the insert after an FK error with re-validated rows', async () => {
    const { service, inserted, prisma } = makeService({
      validateReturns: ['cast1'],
      firstInsertFails: true,
    });

    const res = await (service as any).applyCharacterVotes(
      'u1',
      'imp1',
      [{ ...voteItem, normalizedData: { ...voteItem.normalizedData } }],
      'TVTIME',
    );

    expect(res.created).toBe(1);
    const voteInserts = inserted.filter((rows) => rows.length > 0);
    expect(voteInserts).toHaveLength(1);
    expect(voteInserts[0][0]).toEqual(
      expect.objectContaining({ castId: 'cast1', episodeId: 'e1' }),
    );
    // The FK failure aborts transaction one; retry must start a fresh transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('remaps a stale episode through its TVDB alias before inserting the vote', async () => {
    const { service, inserted, statusUpdates } = makeService({
      validateReturns: ['cast1'],
      activeEpisodeIds: [],
      aliasEpisodeId: 'e2',
    });

    const res = await (service as any).applyCharacterVotes(
      'u1',
      'imp1',
      [{ ...voteItem, normalizedData: { ...voteItem.normalizedData } }],
      'TVTIME',
    );

    expect(res).toEqual({ created: 1, skipped: 0 });
    expect(inserted[0][0]).toEqual(expect.objectContaining({ episodeId: 'e2', castId: 'cast1' }));
    expect(
      statusUpdates.some((u) => u.where?.id === 'it1' && u.data?.matchedEpisodeId === 'e2'),
    ).toBe(true);
  });

  it('terminally skips a stale episode with no canonical replacement', async () => {
    const { service, inserted, statusUpdates } = makeService({
      validateReturns: ['cast1'],
      activeEpisodeIds: [],
      aliasEpisodeId: null,
    });

    const res = await (service as any).applyCharacterVotes(
      'u1',
      'imp1',
      [{ ...voteItem, normalizedData: { ...voteItem.normalizedData } }],
      'TVTIME',
    );

    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(inserted).toHaveLength(0);
    expect(
      statusUpdates.some(
        (u) =>
          u.data?.status === 'SKIPPED' &&
          u.data?.matchedEpisodeId === null &&
          u.where?.id?.in?.includes('it1'),
      ),
    ).toBe(true);
  });
});
