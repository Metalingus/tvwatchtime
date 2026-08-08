import { ImportService } from './import.service';

/**
 * applyCharacterVotes: fully local character resolution via media_cast.characterExternalId,
 * one bounded TVDB re-hydration per show for stale cast rows, ratings-style conflicts.
 */

type FnMap = Record<string, jest.Mock>;
function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function makeService(castRows: any[], existingVotes: any[]) {
  const prisma: any = {
    mediaCast: model(['findMany']),
    mediaCastExternalId: model(['findMany']),
    mediaItem: model(['findMany']),
    episode: model(['findMany']),
    episodeExternalId: model(['findFirst']),
    characterVote: model(['findMany']),
    externalId: model(['findFirst']),
    import: model(['update']),
    importItem: model(['findMany', 'update', 'updateMany']),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  prisma.mediaCast.findMany.mockResolvedValue(castRows);
  prisma.mediaCastExternalId.findMany.mockResolvedValue([]);
  prisma.mediaItem.findMany.mockImplementation(async ({ where }: any) =>
    (where?.id?.in ?? []).map((id: string) => ({ id, type: 'SHOW' })),
  );
  prisma.episode.findMany.mockResolvedValue([
    { id: 'ep-1', season: { show: { mediaId: 'media-1' } } },
  ]);
  prisma.episodeExternalId.findFirst.mockResolvedValue(null);
  prisma.characterVote.findMany.mockResolvedValue(existingVotes);
  const hydration = {
    enqueueTvdbRehydrate: jest.fn().mockResolvedValue(undefined),
    enqueueTvdbMovieCastEnrichment: jest.fn().mockResolvedValue(undefined),
  };
  const chunked: any[] = [];
  prisma.chunkedCapture = chunked;
  const service = new ImportService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any, // matcher (unused by applyCharacterVotes)
    {} as any,
    hydration as any,
  );
  // Spy the chunk writer so we can assert created rows without a real DB.
  (service as any).chunkedCreateMany = jest.fn(async (_tx: any, _model: string, rows: any[]) => {
    chunked.push(...rows);
  });
  return { service: service as any, prisma, hydration, chunked };
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'it1',
  sourceEntityType: 'EPISODE_CHARACTER_VOTE',
  status: 'MATCHED',
  matchedMediaId: 'media-1',
  matchedEpisodeId: 'ep-1',
  normalizedData: {
    showCharacterId: 64771402,
    externalEpisodeId: 75834,
    voteKey: 'episode:75834:char:64771402',
    sourceCreatedAt: '2019-08-17T09:45:00.000Z',
  },
  ...over,
});

describe('ImportService.applyCharacterVotes', () => {
  it('creates votes from local characterExternalId matches — zero provider calls', async () => {
    const { service, chunked, prisma } = makeService(
      [{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }],
      [],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 1, skipped: 0 });
    expect(chunked[0]).toMatchObject({
      userId: 'u1',
      episodeId: 'ep-1',
      castId: 'cast-1',
      source: 'TVTIME',
      sourceKey: 'episode:75834:char:64771402',
    });
    expect(new Date(chunked[0].createdAt).toISOString()).toBe('2019-08-17T09:45:00.000Z');
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: expect.objectContaining({ characterVotesImported: { increment: 1 } }),
    });
  });

  it('creates a movie vote through a title-scoped role alias without an episode', async () => {
    const { service, chunked, prisma, hydration } = makeService([], []);
    prisma.mediaCastExternalId.findMany.mockResolvedValue([
      { mediaId: 'movie-1', value: '64771402', castId: 'movie-cast-1' },
    ]);
    prisma.mediaCast.findMany.mockImplementation(async (args: any) =>
      args?.where?.id ? [{ id: 'movie-cast-1' }] : [],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [
      item({
        sourceEntityType: 'MOVIE_CHARACTER_VOTE',
        matchedMediaId: 'movie-1',
        matchedEpisodeId: null,
      }),
    ]);
    expect(res).toEqual({ created: 1, skipped: 0 });
    expect(chunked[0]).toMatchObject({
      userId: 'u1',
      mediaId: 'movie-1',
      castId: 'movie-cast-1',
    });
    expect(chunked[0].episodeId).toBeUndefined();
    expect(hydration.enqueueTvdbMovieCastEnrichment).not.toHaveBeenCalled();
  });

  it('enqueues ONE background re-hydration per missing show instead of blocking the import', async () => {
    const { service, prisma, hydration } = makeService([], []);
    prisma.externalId.findFirst.mockResolvedValue({ value: '73255' });
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    // Not resolved locally yet → counted unresolved and marked PENDING_MATCH ("scheduled
    // for match"), while the show is queued exactly once for background TVDB hydration.
    expect(res).toEqual({ created: 0, skipped: 0 });
    expect(hydration.enqueueTvdbRehydrate).toHaveBeenCalledTimes(1);
    expect(hydration.enqueueTvdbRehydrate).toHaveBeenCalledWith('media-1', 73255);
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['it1'] } },
      data: { status: 'PENDING_MATCH' },
    });
  });

  it('marks unresolvable items PENDING_MATCH (visible as scheduled) and counts unresolved', async () => {
    const { service, prisma } = makeService([], []);
    prisma.externalId.findFirst.mockResolvedValue(null); // no TVDB id — nothing to enqueue
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 0, skipped: 0 });
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['it1'] } },
      data: { status: 'PENDING_MATCH' },
    });
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: expect.objectContaining({ characterVotesSkippedUnresolved: { increment: 1 } }),
    });
  });

  it('never overwrites an existing vote (manual or different character)', async () => {
    const { service, chunked } = makeService(
      [{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }],
      [
        {
          id: 'v1',
          userId: 'u1',
          episodeId: 'ep-1',
          castId: 'other',
          source: null,
          sourceKey: null,
        },
      ],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(chunked).toHaveLength(0);
  });

  it('is idempotent for the same import sourceKey (skip, no duplicate)', async () => {
    const { service, chunked } = makeService(
      [{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }],
      [
        {
          id: 'v1',
          userId: 'u1',
          episodeId: 'ep-1',
          castId: 'cast-1',
          source: 'TVTIME',
          sourceKey: 'episode:75834:char:64771402',
        },
      ],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [item()]);
    expect(res).toEqual({ created: 0, skipped: 1 });
    expect(chunked).toHaveLength(0);
  });

  it('keeps one newest character choice when provider episodes converge', async () => {
    const { service, chunked, prisma } = makeService(
      [
        { id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 },
        { id: 'cast-2', mediaId: 'media-1', characterExternalId: 64771403 },
      ],
      [],
    );
    const res = await service.applyCharacterVotes('u1', 'imp1', [
      item(),
      item({
        id: 'it2',
        normalizedData: {
          showCharacterId: 64771403,
          externalEpisodeId: 75835,
          voteKey: 'episode:75835:char:64771403',
          sourceCreatedAt: '2019-08-17T10:45:00.000Z',
        },
      }),
    ]);

    expect(res).toEqual({ created: 1, skipped: 1 });
    expect(chunked.filter((row: any) => row.episodeId === 'ep-1')).toEqual([
      expect.objectContaining({ castId: 'cast-2', sourceKey: 'episode:75835:char:64771403' }),
    ]);
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['it1', 'it2'] } },
      data: { status: 'APPLIED' },
    });
  });
});

describe('ImportService.reconcilePendingCharacterVotes', () => {
  it('replays a completed import after cast refresh and applies the vote', async () => {
    const { service, prisma, chunked } = makeService(
      [{ id: 'cast-1', mediaId: 'media-1', characterExternalId: 64771402 }],
      [],
    );
    prisma.importItem.findMany.mockResolvedValue([
      item({ status: 'PENDING_MATCH', import: { id: 'imp1', userId: 'u1', format: 'tvtime' } }),
    ]);

    const result = await service.reconcilePendingCharacterVotes({
      mediaId: 'media-1',
      terminalUnresolved: true,
    });

    expect(result).toEqual({ imports: 1, created: 1, skipped: 0 });
    expect(chunked[0]).toMatchObject({ episodeId: 'ep-1', castId: 'cast-1' });
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['it1'] } },
      data: { status: 'APPLIED' },
    });
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: { characterVotesImported: { increment: 1 } },
    });
  });

  it('terminally skips a character absent from the refreshed authoritative cast', async () => {
    const { service, prisma, hydration } = makeService([], []);
    prisma.importItem.findMany.mockResolvedValue([
      item({ status: 'PENDING_MATCH', import: { id: 'imp1', userId: 'u1', format: 'tvtime' } }),
    ]);

    const result = await service.reconcilePendingCharacterVotes({
      mediaId: 'media-1',
      terminalUnresolved: true,
    });

    expect(result).toEqual({ imports: 1, created: 0, skipped: 0 });
    expect(hydration.enqueueTvdbRehydrate).not.toHaveBeenCalled();
    expect(prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['it1'] } },
      data: {
        status: 'SKIPPED',
        errorMessage: 'TVDB character id not present after cast refresh',
      },
    });
    expect(prisma.import.update).toHaveBeenCalledWith({
      where: { id: 'imp1' },
      data: { characterVotesImported: { increment: 0 } },
    });
  });
});
