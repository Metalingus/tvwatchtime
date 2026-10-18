import { ImportProcessor } from './import.processor';

const D1 = '2024-01-02T03:04:05.000Z';
const D2 = '2024-03-04T05:06:07.000Z';

/** A v5 native export as written by users/export.service.ts. */
const exportDocument = () => ({
  format: 'tvwatchtime-library',
  version: 5,
  exportedAt: D2,
  user: {
    username: 'tester',
    joinedAt: D1,
    restoreToken: 'v1.old-user.sig',
    profile: { displayName: 'Tess', theme: 'LIGHT' },
  },
  shows: [
    {
      id: 'local-show',
      title: 'Local Show',
      year: 2020,
      ids: { tmdb: 1 },
      watchlisted: { addedAt: D1, priority: 2 },
      tracking: { watchedEpisodes: 1, totalEpisodes: 3, dropped: true, pausedAt: null },
      comments: [{ id: 'c-show', parentId: null, text: 'Show thoughts', createdAt: D1 }],
    },
    { id: 'remote-show', title: 'Remote Show', year: 2019, ids: { tvdb: 99 } },
  ],
  movies: [
    {
      id: 'local-movie',
      title: 'Local Movie',
      year: 2021,
      ids: { tmdb: 2 },
      favorite: { addedAt: D2 },
      views: { count: 2, dates: [D1, D2], device: 'TV' },
      rating: { value: 5, ratedAt: D2 },
      emotions: [{ value: 'TOUCHED', at: D2 }],
      characterVote: { characterIds: { tvdb: 4242 }, votedAt: D2 },
    },
  ],
  episodes: [
    {
      id: 'local-episode',
      showId: 'local-show',
      season: 1,
      number: 1,
      ids: { tvdb: 11 },
      views: { count: 1, dates: [D1] },
      comments: [
        { id: 'c-reply', parentId: 'someone-elses', text: 'Agreed', spoiler: true, createdAt: D2 },
      ],
    },
    {
      id: 'remote-episode',
      showId: 'remote-show',
      season: 2,
      number: 3,
      ids: { tvdb: 23 },
      views: { count: 1, dates: [D2] },
    },
  ],
  lists: [
    {
      id: 'list-1',
      title: 'Later',
      visibility: 'PUBLIC',
      createdAt: D1,
      items: [{ mediaId: 'local-movie', addedAt: D2 }],
    },
  ],
  providerAlerts: [
    { mediaId: 'local-movie', offerType: 'STREAM', country: 'US', providerIds: [8] },
  ],
  social: {
    following: [{ username: 'friend' }],
    blocked: [],
    listSubscriptions: [],
    likedLists: [],
  },
});

function harness() {
  const stagedItems: any[] = [];
  const importUpdates: any[] = [];
  const prisma: any = {
    import: { update: jest.fn(async (args: any) => importUpdates.push(args.data)) },
    importFile: { create: jest.fn(async () => ({})) },
    // Only the "local" rows exist on this server; "remote" ones came from another server.
    mediaItem: {
      findMany: jest.fn(async () => [
        { id: 'local-show', type: 'SHOW' },
        { id: 'local-movie', type: 'MOVIE' },
      ]),
    },
    episode: {
      findMany: jest.fn(async () => [
        { id: 'local-episode', season: { show: { mediaId: 'local-show' } } },
      ]),
    },
    importItem: { createMany: jest.fn(async (args: any) => stagedItems.push(...args.data)) },
  };
  const matcher: any = {
    prefetchMediaExternalIds: jest.fn(async () => undefined),
    matchByExternalIds: jest.fn(async () => ({ mediaId: 'matched-remote-show', confidence: 0.95 })),
    ensureShowHydrated: jest.fn(async () => undefined),
    resolveEpisodeByExternalIds: jest.fn(async () => 'matched-remote-episode'),
    isStructureEvaluationPending: jest.fn(() => false),
    classify: jest.fn((confidence: number) => (confidence >= 0.7 ? 'matched' : 'unmatched')),
  };
  const processor = new ImportProcessor({} as any, prisma, {} as any, matcher, {} as any);
  const finished: any[] = [];
  jest.spyOn(processor as any, 'setStatus').mockResolvedValue(undefined);
  jest.spyOn(processor as any, 'reportProgress').mockResolvedValue(undefined);
  jest.spyOn(processor as any, 'enqueueClassificationOnce').mockResolvedValue(undefined);
  jest.spyOn(processor as any, 'statusCounts').mockResolvedValue({});
  jest
    .spyOn(processor as any, 'finishProcessing')
    .mockImplementation(async (_id: any, payload: any) => finished.push(payload));
  const run = (document: unknown) => {
    const bytes = Buffer.from(JSON.stringify(document));
    const entry = (processor as any).tvWatchTimeEntryFor(
      { sourceType: 'json', originalFilename: 'my-backup.json' },
      bytes,
    );
    return (processor as any).runTvWatchTimeBody('import-1', entry);
  };
  return { processor, prisma, matcher, stagedItems, importUpdates, finished, run };
}

const byType = (items: any[], type: string) =>
  items.filter((item) => item.sourceEntityType === type);

describe('tvwatchtime import pipeline (mocked DB)', () => {
  it('detects a renamed standalone export by its format marker only', () => {
    const { processor } = harness();
    const entryFor = (body: unknown) =>
      (processor as any).tvWatchTimeEntryFor(
        { sourceType: 'json', originalFilename: 'upload.json' },
        Buffer.from(JSON.stringify(body)),
      );
    expect(entryFor(exportDocument())).not.toBeNull();
    expect(entryFor([{ show: { title: 'Trakt-ish' } }])).toBeNull();
  });

  it('matches same-server rows by id and only sends foreign rows to the matcher', async () => {
    const { matcher, stagedItems, importUpdates, run } = harness();
    await run(exportDocument());

    expect(importUpdates[0]).toEqual({ format: 'tvwatchtime' });
    expect(matcher.matchByExternalIds).toHaveBeenCalledTimes(1);
    expect(matcher.matchByExternalIds.mock.calls[0].slice(0, 3)).toEqual([
      { tvdb: 99 },
      'SHOW',
      'Remote Show',
    ]);
    expect(matcher.ensureShowHydrated).toHaveBeenCalledWith('matched-remote-show');
    expect(matcher.resolveEpisodeByExternalIds).toHaveBeenCalledTimes(1);

    const episodes = byType(stagedItems, 'WATCHED_EPISODE');
    expect(episodes).toEqual([
      expect.objectContaining({
        status: 'MATCHED',
        matchedMediaId: 'local-show',
        matchedEpisodeId: 'local-episode',
        confidenceScore: 1,
      }),
      expect.objectContaining({
        status: 'MATCHED',
        matchedMediaId: 'matched-remote-show',
        matchedEpisodeId: 'matched-remote-episode',
      }),
    ]);
    expect(episodes[0].rawData).toMatchObject({ exportMediaId: 'local-show' });
  });

  it('never targets a retired episode row; it resolves through provider ids instead', async () => {
    const { prisma, matcher, stagedItems, run } = harness();
    // local-episode still exists but is LEGACY_UNMAPPED, so the ACTIVE-only lookup misses it.
    prisma.episode.findMany.mockResolvedValue([]);
    matcher.resolveEpisodeByExternalIds.mockResolvedValue('active-replacement');
    await run(exportDocument());

    expect(prisma.episode.findMany.mock.calls[0][0].where).toMatchObject({
      structureState: 'ACTIVE',
    });
    expect(matcher.resolveEpisodeByExternalIds).toHaveBeenCalledWith('local-show', { tvdb: 11 });
    expect(byType(stagedItems, 'WATCHED_EPISODE')[0]).toMatchObject({
      matchedMediaId: 'local-show',
      matchedEpisodeId: 'active-replacement',
      status: 'MATCHED',
    });
  });

  it('stages every view date, device, original add dates, and priority', async () => {
    const { stagedItems, run } = harness();
    await run(exportDocument());

    expect(byType(stagedItems, 'WATCHED_MOVIE')[0].normalizedData).toMatchObject({
      voteKey: 'tvwatchtime:movie:local-movie',
      watchCount: 2,
      watchedAt: D2,
      watchDates: [D1, D2],
      device: 'TV',
    });
    expect(byType(stagedItems, 'WATCHLIST_SHOW')[0].normalizedData).toMatchObject({
      addedAt: D1,
      priority: 2,
    });
    expect(byType(stagedItems, 'FAVORITE_MOVIE')[0].normalizedData).toMatchObject({ addedAt: D2 });
    expect(byType(stagedItems, 'LIST')[0].normalizedData).toMatchObject({
      sourceKey: 'tvwatchtime:list:list-1',
      visibility: 'PUBLIC',
    });
    expect(byType(stagedItems, 'LIST_ITEM')[0]).toMatchObject({
      matchedMediaId: 'local-movie',
      normalizedData: expect.objectContaining({ addedAt: D2 }),
    });
  });

  it('stages votes and comments with stable native identities', async () => {
    const { stagedItems, finished, run } = harness();
    await run(exportDocument());

    expect(byType(stagedItems, 'MOVIE_RATING')[0].normalizedData).toMatchObject({
      normalizedRating: 5,
      voteKey: 'tvwatchtime:rating:media:local-movie',
    });
    expect(byType(stagedItems, 'MOVIE_EMOTION')[0].normalizedData).toMatchObject({
      normalizedEmotion: 'TOUCHED',
    });
    expect(byType(stagedItems, 'MOVIE_CHARACTER_VOTE')[0]).toMatchObject({
      matchedMediaId: 'local-movie',
      normalizedData: expect.objectContaining({ showCharacterId: 4242 }),
    });
    expect(byType(stagedItems, 'SHOW_COMMENT')[0].normalizedData).toMatchObject({
      sourceKey: 'tvwatchtime:comment:c-show',
      authorIsOwner: true,
      parentSourceKey: null,
    });
    expect(byType(stagedItems, 'EPISODE_COMMENT')[0]).toMatchObject({
      matchedEpisodeId: 'local-episode',
      normalizedData: expect.objectContaining({
        sourceKey: 'tvwatchtime:comment:c-reply',
        parentSourceKey: 'tvwatchtime:comment:someone-elses',
        parentCommentId: 'someone-elses',
        spoiler: true,
      }),
    });
    expect(finished[0]).toMatchObject({
      ratingsDetected: 1,
      emotionsDetected: 1,
      commentRowsDetected: 2,
      characterVotesDetected: 1,
    });
  });

  it('stages account state for confirm with resolved media ids', async () => {
    const { importUpdates, run } = harness();
    await run(exportDocument());

    const restore = importUpdates.find((data) => data.restoreData)?.restoreData;
    expect(restore).toMatchObject({
      version: 1,
      restoreToken: 'v1.old-user.sig',
      profile: { displayName: 'Tess', theme: 'LIGHT' },
      tracking: [
        {
          mediaExportId: 'local-show',
          mediaId: 'local-show',
          dropped: true,
          pausedAt: null,
          rewatchStartedAt: null,
        },
      ],
      providerAlerts: [
        { mediaExportId: 'local-movie', mediaId: 'local-movie', offerType: 'STREAM' },
      ],
      social: { following: ['friend'] },
    });
  });

  it('fails the import with a readable error for a damaged export', async () => {
    const { processor, run } = harness();
    await run({ format: 'tvwatchtime-library', version: 1 });
    expect((processor as any).setStatus).toHaveBeenCalledWith(
      'import-1',
      'FAILED',
      expect.objectContaining({ errorMessage: expect.any(String) }),
    );
  });
});
