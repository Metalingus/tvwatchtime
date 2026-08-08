import { StructureRemapService } from './structure-remap.service';

const D = new Date('2024-01-05T00:00:00Z');
const D2 = new Date('2024-01-12T00:00:00Z');

function mockPrisma() {
  const p: any = {
    show: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    externalId: { findFirst: jest.fn().mockResolvedValue(null) },
    userEpisodeStatus: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    watchHistory: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    rating: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    reaction: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    characterVote: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
    comment: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'cloned-comment' }),
    },
    commentLike: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    commentSpoilerReport: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    commentImage: { create: jest.fn().mockResolvedValue({}) },
    externalReview: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    episode: {
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    episodeExternalId: {
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    season: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userShowStatus: { upsert: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  // Transactions run against the same mock (tx exposes the same model API); array form
  // (used by the absoluteNumber backfill) just awaits all statements.
  p.$transaction = jest.fn((arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(p)));
  return p;
}

const ep = (over: Record<string, unknown>) => ({
  id: 'e1',
  number: 1,
  title: 'Episode',
  airDate: null,
  structureState: 'ACTIVE',
  externalIds: [{ provider: 'TMDB' }],
  ...over,
});

const showWith = (seasons: any[]) => ({ id: 'sh1', mediaId: 'm1', seasons });
const season = (id: string, number: number, episodes: any[], isSpecial = false) => ({
  id,
  number,
  isSpecial,
  episodes,
});

describe('StructureRemapService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: StructureRemapService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new StructureRemapService(prisma);
  });

  it('is a no-op when no stale TMDB-only episodes exist', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ externalIds: [{ provider: 'TMDB' }, { provider: 'THE_TVDB' }] })]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.stale).toBe(0);
    expect(prisma.episode.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('previews against fresh provider metadata instead of a stale stored canonical row', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s-old', 5, [
          ep({
            id: 'old-s5e16',
            number: 16,
            title: "It's a Hard Doc Life",
            airDate: new Date('2020-04-18T00:00:00.000Z'),
            externalIds: [{ provider: 'THE_TVDB', value: 'tvdb-old' }],
          }),
        ]),
        season('s-canonical', 5, [
          ep({
            id: 'stored-target',
            number: 14,
            title: 'The Great McStuffins Meltdown (1)',
            airDate: new Date('2020-03-07T00:00:00.000Z'),
            externalIds: [{ provider: 'TMDB', value: '2699192' }],
          }),
        ]),
      ]),
    );

    const storedOnly = await service.remapShow('m1', { dryRun: true, canonical: 'tmdb' });
    const livePreview = await service.previewShowAgainstSnapshot('m1', 'tmdb', [
      {
        tmdbId: 5,
        number: 5,
        title: 'Season 5',
        episodeCount: 1,
        isSpecial: false,
        episodes: [
          {
            tmdbId: 2699192,
            number: 14,
            title: "It's a Hard Doc Life",
            airDate: '2020-04-18T00:00:00.000Z',
            isFinale: false,
          },
        ],
      },
    ]);

    expect(storedOnly).toMatchObject({ stale: 1, mapped: 0, episodesRemoved: 1 });
    expect(livePreview).toMatchObject({
      stale: 1,
      mapped: 1,
      episodesRemoved: 0,
      matchRules: { 'absolute+date': 1 },
      dryRun: true,
    });
  });

  it('previews collapsed TVDB aliases and TMDB specials against separate official rows', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'tmdb-special-red-bath', has_data: true },
      { id: 'tmdb-magic-snow', has_data: true },
    ]);
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season(
          'tmdb-specials',
          0,
          [
            ep({
              id: 'tmdb-special-red-bath',
              number: 1,
              title: 'Red, Bath and Beyond',
              airDate: new Date('2010-01-19T00:00:00.000Z'),
              externalIds: [{ provider: 'TMDB', value: 'tmdb-special-1' }],
            }),
            ep({
              id: 'tmdb-special-pampered',
              number: 2,
              title: 'Pampered and Tampered',
              airDate: new Date('2010-02-14T00:00:00.000Z'),
              externalIds: [
                { provider: 'TMDB', value: 'tmdb-special-2' },
                { provider: 'THE_TVDB', value: '1411321' },
              ],
            }),
          ],
          true,
        ),
        season('tmdb-regular', 1, [
          ep({
            id: 'tmdb-magic-snow',
            number: 11,
            title: 'Magic Snow and Creepy Gene',
            airDate: new Date('2009-12-30T00:00:00.000Z'),
            externalIds: [
              { provider: 'TMDB', value: 'tmdb-regular-11' },
              { provider: 'THE_TVDB', value: '1408781' },
              { provider: 'THE_TVDB', value: '1408771' },
            ],
          }),
        ]),
      ]),
    );

    const result = await service.previewShowAgainstSnapshot('m1', 'tvdb', [
      {
        tmdbId: 1,
        number: 1,
        title: 'Season 1',
        episodeCount: 3,
        isSpecial: false,
        episodes: [
          {
            tmdbId: 1408781,
            number: 11,
            title: 'Red, Bath and Beyond',
            airDate: '2010-01-19T00:00:00.000Z',
            isFinale: false,
          },
          {
            tmdbId: 1408771,
            number: 12,
            title: 'Magic Snow and Creepy Gene',
            airDate: '2009-12-30T00:00:00.000Z',
            isFinale: false,
          },
          {
            tmdbId: 1411321,
            number: 13,
            title: 'Pampered and Tampered',
            airDate: '2010-02-14T00:00:00.000Z',
            isFinale: true,
          },
        ],
      },
    ]);

    expect(result).toMatchObject({
      stale: 2,
      mapped: 2,
      unmapped: 0,
      legacyQuarantined: 0,
      matchRules: { 'specialDate+titleCrossOrder': 1, externalId: 1 },
      dryRun: true,
    });
  });

  it('maps a batch of TVDB aliases to TMDB-canonical episodes with one routing snapshot', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn(
        async () =>
          new Map([
            [9001, { airDate: '2024-01-05', seasonNumber: 1, episodeNumber: 1, absoluteNumber: 1 }],
            [9002, { airDate: '2024-01-12', seasonNumber: 1, episodeNumber: 2, absoluteNumber: 2 }],
          ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.show.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.structureProvider) return { structureProvider: 'TMDB' };
      return showWith([
        season('s1', 1, [
          ep({
            id: 'tmdb-1',
            number: 1,
            absoluteNumber: 1,
            airDate: D,
            externalIds: [{ provider: 'TMDB', value: '101' }],
          }),
          ep({
            id: 'tmdb-2',
            number: 2,
            absoluteNumber: 2,
            airDate: D2,
            externalIds: [{ provider: 'TMDB', value: '102' }],
          }),
        ]),
      ]);
    });
    prisma.externalId.findFirst.mockResolvedValue({ value: '777' });

    const result = await service.resolveTvdbEpisodeAliasesToCanonical('m1', ['9001', '9002']);

    expect(result.mappings).toEqual(
      new Map([
        ['9001', 'tmdb-1'],
        ['9002', 'tmdb-2'],
      ]),
    );
    expect(result.verifiedValues).toEqual(new Set(['9001', '9002']));
    expect(tvdb.getEpisodeRoutingIndex).toHaveBeenCalledTimes(1);
    expect(tvdb.getEpisodeRoutingIndex).toHaveBeenCalledWith(777);
    expect(prisma.episode.update).not.toHaveBeenCalled();
    expect(prisma.episode.updateMany).not.toHaveBeenCalled();
  });

  it('revalidates an existing TVDB alias instead of trusting its stored TMDB target', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn(
        async () =>
          new Map([
            [
              9001,
              {
                airDate: '2024-01-05',
                seasonNumber: 1,
                episodeNumber: 1,
                absoluteNumber: 1,
                runtimeMinutes: 45,
              },
            ],
          ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.show.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.structureProvider) return { structureProvider: 'TMDB' };
      return showWith([
        season('s1', 1, [
          ep({
            id: 'wrong-stored-target',
            number: 2,
            absoluteNumber: 2,
            airDate: D2,
            externalIds: [
              { provider: 'TMDB', value: '102' },
              { provider: 'THE_TVDB', value: '9001' },
            ],
          }),
          ep({
            id: 'correct-canonical-target',
            number: 1,
            absoluteNumber: 1,
            airDate: D,
            externalIds: [{ provider: 'TMDB', value: '101' }],
          }),
        ]),
      ]);
    });
    prisma.externalId.findFirst.mockResolvedValue({ value: '777' });

    const result = await service.resolveTvdbEpisodeAliasesToCanonical('m1', ['9001']);

    expect(result.mappings).toEqual(new Map([['9001', 'correct-canonical-target']]));
  });

  it('does not collapse a distinct same-day TVDB episode onto an occupied TMDB episode', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn(
        async () =>
          new Map([
            [
              9002,
              {
                airDate: '2024-01-05',
                seasonNumber: 1,
                episodeNumber: 10,
                absoluteNumber: 10,
                runtimeMinutes: 45,
              },
            ],
          ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.show.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.structureProvider) return { structureProvider: 'TMDB' };
      return showWith([
        season('s1', 1, [
          ep({
            id: 'tmdb-9',
            number: 9,
            absoluteNumber: 9,
            runtimeMinutes: 45,
            airDate: D,
            externalIds: [
              { provider: 'TMDB', value: '109' },
              { provider: 'THE_TVDB', value: '9001' },
            ],
          }),
        ]),
      ]);
    });
    prisma.externalId.findFirst.mockResolvedValue({ value: '777' });

    const result = await service.resolveTvdbEpisodeAliasesToCanonical('m1', ['9002']);

    expect(result.mappings.size).toBe(0);
    expect(result.verifiedValues).toEqual(new Set(['9002']));
  });

  it('allows a shorter same-day TVDB part to reuse an occupied combined TMDB episode', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn(
        async () =>
          new Map([
            [
              9002,
              {
                airDate: '2024-01-05',
                seasonNumber: 1,
                episodeNumber: 2,
                absoluteNumber: 2,
                runtimeMinutes: 30,
              },
            ],
          ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.show.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.structureProvider) return { structureProvider: 'TMDB' };
      return showWith([
        season('s1', 1, [
          ep({
            id: 'tmdb-combined',
            number: 1,
            absoluteNumber: 1,
            runtimeMinutes: 60,
            airDate: D,
            externalIds: [
              { provider: 'TMDB', value: '101' },
              { provider: 'THE_TVDB', value: '9001' },
            ],
          }),
        ]),
      ]);
    });
    prisma.externalId.findFirst.mockResolvedValue({ value: '777' });

    const result = await service.resolveTvdbEpisodeAliasesToCanonical('m1', ['9002']);

    expect(result.mappings).toEqual(new Map([['9002', 'tmdb-combined']]));
  });

  it('allows a verified split part to reuse a combined episode across UTC day rollover', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn(
        async () =>
          new Map([
            [
              9002,
              {
                airDate: '2024-01-05',
                seasonNumber: 1,
                episodeNumber: 2,
                absoluteNumber: 2,
                runtimeMinutes: 30,
              },
            ],
          ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.show.findUnique.mockImplementation(async (args: any) => {
      if (args?.select?.structureProvider) return { structureProvider: 'TMDB' };
      return showWith([
        season('s1', 1, [
          ep({
            id: 'tmdb-combined',
            number: 1,
            absoluteNumber: 1,
            runtimeMinutes: 60,
            airDate: new Date('2024-01-06T01:00:00.000Z'),
            externalIds: [
              { provider: 'TMDB', value: '101' },
              { provider: 'THE_TVDB', value: '9001' },
            ],
          }),
        ]),
      ]);
    });
    prisma.externalId.findFirst.mockResolvedValue({ value: '777' });

    const result = await service.resolveTvdbEpisodeAliasesToCanonical('m1', ['9002']);

    expect(result.mappings).toEqual(new Map([['9002', 'tmdb-combined']]));
  });

  it('never bridges TVDB-authoritative anime through the TMDB structure', async () => {
    const tvdb = { getEpisodeRoutingIndex: jest.fn() };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.show.findUnique.mockResolvedValue({ structureProvider: 'TVDB' });

    const result = await service.resolveTvdbEpisodeAliasesToCanonical('anime-1', ['46146801']);

    expect(result.mappings.size).toBe(0);
    expect(result.verifiedValues.size).toBe(0);
    expect(tvdb.getEpisodeRoutingIndex).not.toHaveBeenCalled();
    expect(prisma.externalId.findFirst).not.toHaveBeenCalled();
  });

  it('transfers all user data from a stale row to the airDate-matched fresh row', async () => {
    const redis = { delByPattern: jest.fn().mockResolvedValue(1) };
    service = new StructureRemapService(prisma, redis as any);
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'old', number: 30, title: 'The Forest', airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'new',
            number: 5,
            title: 'The Forest',
            airDate: D,
            externalIds: [{ provider: 'TMDB' }, { provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.findMany.mockResolvedValue([
      {
        id: 'ues1',
        userId: 'u1',
        episodeId: 'old',
        watched: true,
        watchedAt: D2,
        watchCount: 2,
        device: 'TV',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-02-01'),
      },
    ]);
    prisma.watchHistory.updateMany.mockResolvedValue({ count: 3 });
    prisma.rating.findMany.mockResolvedValue([
      {
        id: 'r1',
        userId: 'u1',
        episodeId: 'old',
        rating: 5,
        source: 'TVTIME',
        createdAt: new Date('2024-03-01'),
        updatedAt: new Date('2024-03-01'),
      },
    ]);
    prisma.rating.findFirst.mockResolvedValue({
      id: 'r-target',
      source: 'MANUAL',
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    }); // manual target wins even when the imported source is newer
    prisma.reaction.findMany.mockResolvedValue([
      { id: 're1', userId: 'u1', episodeId: 'old', reaction: 'HAPPY' },
    ]);
    prisma.characterVote.findMany.mockResolvedValue([
      { id: 'v1', userId: 'u1', episodeId: 'old', castId: 'c1' },
    ]);
    prisma.comment.updateMany.mockResolvedValue({ count: 2 });
    prisma.externalReview.updateMany.mockResolvedValue({ count: 1 });

    const res = await service.remapShow('m1');

    expect(res).toMatchObject({
      stale: 1,
      mapped: 1,
      unmapped: 0,
      statusesMoved: 1,
      historiesMoved: 3,
      ratingsMoved: 1,
      reactionsMoved: 1,
      votesMoved: 1,
      commentsMoved: 2,
      externalReviewsMoved: 1,
      episodesRemoved: 1,
    });
    // Status re-pointed (no target row), watch history re-pointed with the new S/E numbers.
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'ues1' },
      data: { episodeId: 'new' },
    });
    expect(prisma.watchHistory.updateMany).toHaveBeenCalledWith({
      where: { episodeId: 'old' },
      data: { episodeId: 'new', seasonNumber: 2, episodeNumber: 5 },
    });
    // Target rating wins; stale rating deleted.
    expect(prisma.rating.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(prisma.rating.update).not.toHaveBeenCalled();
    // Reaction/vote re-pointed (no conflict).
    expect(prisma.reaction.update).toHaveBeenCalledWith({
      where: { id: 're1' },
      data: { episodeId: 'new' },
    });
    expect(prisma.characterVote.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { episodeId: 'new' },
    });
    // Comments re-threaded, stale row gone, progress cache recomputed for the touched user.
    expect(prisma.comment.updateMany).toHaveBeenCalledWith({
      where: { threadType: 'EPISODE', threadId: 'old' },
      data: { threadId: 'new' },
    });
    expect(prisma.externalReview.updateMany).toHaveBeenCalledWith({
      where: { episodeId: 'old' },
      data: { episodeId: 'new' },
    });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'old' } });
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_mediaId: { userId: 'u1', mediaId: 'm1' } } }),
    );
    expect(redis.delByPattern).toHaveBeenCalledWith('watchnext:u1:*');
    expect(redis.delByPattern).toHaveBeenCalledWith('upcoming:u1:*');
    expect(redis.delByPattern).toHaveBeenCalledWith('showsprogress:u1:*');
  });

  it('copies watched state and user choices to both official parts of a combined episode', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('old-season', 1, [
          ep({
            id: 'combined',
            number: 9,
            absoluteNumber: 10,
            airDate: D,
            runtimeMinutes: 60,
            externalIds: [{ provider: 'TMDB', value: 'tmdb-combined' }],
          }),
        ]),
        season('official-season', 2, [
          ep({
            id: 'part-1',
            number: 1,
            absoluteNumber: 10,
            airDate: D,
            runtimeMinutes: 30,
            externalIds: [{ provider: 'THE_TVDB', value: 'tvdb-part-1' }],
          }),
          ep({
            id: 'part-2',
            number: 2,
            absoluteNumber: 11,
            airDate: D,
            runtimeMinutes: 30,
            externalIds: [{ provider: 'THE_TVDB', value: 'tvdb-part-2' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.findMany.mockResolvedValue([
      {
        id: 'status-combined',
        userId: 'u1',
        watched: true,
        watchedAt: D,
        watchCount: 1,
        device: null,
        createdAt: D,
        updatedAt: D,
      },
    ]);
    prisma.watchHistory.findMany.mockResolvedValue([
      {
        id: 'history-combined',
        userId: 'u1',
        mediaId: 'm1',
        mediaType: 'SHOW',
        episodeId: 'combined',
        seasonNumber: 1,
        episodeNumber: 9,
        runtimeMinutes: 60,
        watchedAt: D,
        createdAt: D,
      },
    ]);
    prisma.rating.findMany.mockResolvedValue([
      {
        id: 'rating-combined',
        userId: 'u1',
        rating: 8,
        source: 'TVTIME',
        sourceKey: 'rating:combined',
        createdAt: D,
        updatedAt: D,
      },
    ]);
    prisma.characterVote.findMany.mockResolvedValue([
      {
        id: 'vote-combined',
        userId: 'u1',
        castId: 'cast-1',
        source: 'TVTIME',
        sourceKey: 'vote:combined',
        createdAt: D,
      },
    ]);
    prisma.comment.findMany.mockResolvedValue([
      {
        id: 'comment-root',
        userId: 'u1',
        parentId: null,
        rootId: null,
        depth: 0,
        threadType: 'EPISODE',
        threadId: 'combined',
        body: 'Root',
        likes: [{ userId: 'u2', createdAt: D }],
        spoilerReports: [],
        image: null,
      },
      {
        id: 'comment-reply',
        userId: 'u2',
        parentId: 'comment-root',
        rootId: 'comment-root',
        depth: 1,
        threadType: 'EPISODE',
        threadId: 'combined',
        body: 'Reply',
        likes: [],
        spoilerReports: [],
        image: null,
      },
    ]);
    prisma.comment.create
      .mockResolvedValueOnce({ id: 'cloned-root' })
      .mockResolvedValueOnce({ id: 'cloned-reply' });
    prisma.comment.updateMany.mockResolvedValue({ count: 2 });

    const result = await service.remapShow('m1', {
      canonical: 'tvdb',
      requireCompleteUserDataMapping: true,
      preserveUnmappedSpecials: true,
    });

    expect(result).toMatchObject({
      mapped: 1,
      legacyQuarantined: 0,
      matchRules: { 'airDate+combinedRuntime': 1 },
      blocked: false,
    });
    expect(prisma.userEpisodeStatus.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', episodeId: 'part-2', watched: true }),
    });
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'status-combined' },
      data: { episodeId: 'part-1' },
    });
    expect(prisma.watchHistory.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ episodeId: 'part-2', seasonNumber: 2, episodeNumber: 2 })],
    });
    expect(prisma.watchHistory.updateMany).toHaveBeenCalledWith({
      where: { episodeId: 'combined' },
      data: { episodeId: 'part-1', seasonNumber: 2, episodeNumber: 1 },
    });
    expect(prisma.rating.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ episodeId: 'part-2', rating: 8 }),
    });
    expect(prisma.characterVote.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ episodeId: 'part-2', castId: 'cast-1' }),
    });
    expect(prisma.comment.updateMany).toHaveBeenCalledWith({
      where: { threadType: 'EPISODE', threadId: 'combined' },
      data: { threadId: 'part-1' },
    });
    expect(prisma.comment.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ threadId: 'part-2', parentId: null, rootId: null }),
      select: { id: true },
    });
    expect(prisma.comment.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        threadId: 'part-2',
        parentId: 'cloned-root',
        rootId: 'cloned-root',
      }),
      select: { id: true },
    });
    expect(prisma.commentLike.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'u2', commentId: 'cloned-root', createdAt: D }],
    });
  });

  it('merges two provider parts into one official episode without losing either comment thread', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('parts-season', 1, [
          ep({
            id: 'part-a',
            number: 1,
            absoluteNumber: 1,
            airDate: D,
            runtimeMinutes: 30,
            externalIds: [{ provider: 'TMDB', value: 'tmdb-part-a' }],
          }),
          ep({
            id: 'part-b',
            number: 2,
            absoluteNumber: 2,
            airDate: D,
            runtimeMinutes: 30,
            externalIds: [{ provider: 'TMDB', value: 'tmdb-part-b' }],
          }),
        ]),
        season('official-season', 1, [
          ep({
            id: 'combined',
            number: 1,
            absoluteNumber: 1,
            airDate: D,
            runtimeMinutes: 60,
            externalIds: [{ provider: 'THE_TVDB', value: 'tvdb-combined' }],
          }),
        ]),
      ]),
    );
    const statuses: Record<string, any> = {
      'part-a': {
        id: 'status-a',
        userId: 'u1',
        watched: false,
        watchedAt: null,
        watchCount: 0,
        device: null,
        createdAt: D,
      },
      'part-b': {
        id: 'status-b',
        userId: 'u1',
        watched: true,
        watchedAt: D,
        watchCount: 1,
        device: 'TV',
        createdAt: D,
      },
    };
    prisma.userEpisodeStatus.findMany.mockImplementation(async ({ where }: any) => [
      statuses[where.episodeId],
    ]);
    prisma.userEpisodeStatus.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...statuses['part-a'], episodeId: 'combined' });
    prisma.watchHistory.updateMany.mockResolvedValue({ count: 1 });
    prisma.watchHistory.findMany.mockResolvedValue([{ userId: 'u1' }]);

    const ratings: Record<string, any> = {
      'part-a': { id: 'rating-a', userId: 'u1', rating: 7, createdAt: D, updatedAt: D },
      'part-b': { id: 'rating-b', userId: 'u1', rating: 9, createdAt: D2, updatedAt: D2 },
    };
    prisma.rating.findMany.mockImplementation(async ({ where }: any) => [ratings[where.episodeId]]);
    prisma.rating.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...ratings['part-a'], episodeId: 'combined' });

    const votes: Record<string, any> = {
      'part-a': { id: 'vote-a', userId: 'u1', castId: 'cast-a', createdAt: D },
      'part-b': { id: 'vote-b', userId: 'u1', castId: 'cast-b', createdAt: D2 },
    };
    prisma.characterVote.findMany.mockImplementation(async ({ where }: any) => [
      votes[where.episodeId],
    ]);
    prisma.characterVote.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...votes['part-a'], episodeId: 'combined' });
    prisma.comment.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.remapShow('m1', {
      canonical: 'tvdb',
      requireCompleteUserDataMapping: true,
    });

    expect(result).toMatchObject({
      mapped: 2,
      legacyQuarantined: 0,
      matchRules: { 'airDate+partsRuntime': 2 },
      blocked: false,
    });
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'status-a' },
      data: { watched: true, watchedAt: D, watchCount: 1, device: 'TV' },
    });
    expect(prisma.userEpisodeStatus.delete).toHaveBeenCalledWith({ where: { id: 'status-b' } });
    expect(prisma.rating.delete).toHaveBeenCalledWith({ where: { id: 'rating-b' } });
    expect(prisma.characterVote.delete).toHaveBeenCalledWith({ where: { id: 'vote-b' } });
    expect(prisma.comment.updateMany).toHaveBeenCalledWith({
      where: { threadType: 'EPISODE', threadId: 'part-a' },
      data: { threadId: 'combined' },
    });
    expect(prisma.comment.updateMany).toHaveBeenCalledWith({
      where: { threadType: 'EPISODE', threadId: 'part-b' },
      data: { threadId: 'combined' },
    });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'part-a' } });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'part-b' } });
  });

  it('blocks a strict authority migration before writes when user data cannot be mapped', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('legacy', 1, [
          ep({ id: 'unmapped', absoluteNumber: 50, externalIds: [{ provider: 'TMDB' }] }),
        ]),
        season('official', 2, [
          ep({ id: 'official-1', absoluteNumber: 1, externalIds: [{ provider: 'THE_TVDB' }] }),
        ]),
      ]),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: 'unmapped', has_data: true }]);

    const result = await service.remapShow('m1', {
      canonical: 'tvdb',
      requireCompleteUserDataMapping: true,
    });

    expect(result).toMatchObject({
      blocked: true,
      blockedReason: 'UNMAPPED_USER_DATA',
      legacyQuarantined: 1,
    });
    expect(prisma.userEpisodeStatus.update).not.toHaveBeenCalled();
    expect(prisma.episode.updateMany).not.toHaveBeenCalled();
    expect(prisma.episode.deleteMany).not.toHaveBeenCalled();
    expect(prisma.show.update).not.toHaveBeenCalled();
  });

  it('maps verified shared specials and preserves provider-only S0 user data', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'shared-special', has_data: true },
      { id: 'provider-only-special', has_data: true },
    ]);
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season(
          'tmdb-specials',
          0,
          [
            ep({
              id: 'shared-special',
              number: 1,
              title: 'Complications of the Heart',
              airDate: new Date('2006-09-21T00:00:00.000Z'),
              externalIds: [{ provider: 'TMDB', value: '9001' }],
            }),
            ep({
              id: 'provider-only-special',
              number: 2,
              title: 'DVD Featurette',
              airDate: new Date('2006-10-01T00:00:00.000Z'),
              externalIds: [{ provider: 'TMDB', value: '9002' }],
            }),
          ],
          true,
        ),
      ]),
    );
    const tmdbSpecials = [
      {
        tmdbId: 90,
        number: 0,
        title: 'Specials',
        episodeCount: 2,
        isSpecial: true,
        episodes: [
          {
            tmdbId: 9001,
            number: 1,
            title: 'Complications of the Heart',
            airDate: '2006-09-21',
            isFinale: false,
          },
          {
            tmdbId: 9002,
            number: 2,
            title: 'DVD Featurette',
            airDate: '2006-10-01',
            isFinale: false,
          },
        ],
      },
    ] as any;
    const tvdbSpecials = [
      {
        tmdbId: 70,
        number: 0,
        title: 'Specials',
        episodeCount: 1,
        isSpecial: true,
        episodes: [
          {
            tmdbId: 7001,
            number: 1,
            title: 'Complications of the Heart',
            airDate: '2006-09-21',
            isFinale: false,
          },
        ],
      },
    ] as any;

    const result = await service.previewShowAgainstSnapshot('m1', 'tvdb', tvdbSpecials, {
      foreignSeasons: tmdbSpecials,
      preserveUnmappedSpecials: true,
    });

    expect(result).toMatchObject({
      stale: 2,
      mapped: 1,
      unmapped: 1,
      legacyQuarantined: 0,
      specialsPreserved: 1,
      matchRules: { 'verifiedSpecialDate+seasonEpisode': 1 },
    });
  });

  it('correlates an ID-less legacy duplicate with one canonical special using all stored signals', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'legacy-white-christmas', has_data: true }]);
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season(
          'legacy-specials',
          0,
          [
            ep({
              id: 'legacy-white-christmas',
              number: 1,
              title: 'White Christmas',
              airDate: new Date('2014-12-16T00:00:00.000Z'),
              runtimeMinutes: 75,
              structureState: 'LEGACY_UNMAPPED',
              externalIds: [],
            }),
          ],
          true,
        ),
        season('tmdb-season-2', 2, [
          ep({
            id: 'active-white-christmas',
            number: 4,
            title: 'White Christmas',
            airDate: new Date('2014-12-16T00:00:00.000Z'),
            runtimeMinutes: 74,
            externalIds: [
              { provider: 'TMDB', value: '7014792' },
              { provider: 'THE_TVDB', value: '5057304' },
            ],
          }),
        ]),
      ]),
    );

    const result = await service.previewShowAgainstSnapshot('m1', 'tvdb', [
      {
        tmdbId: 0,
        number: 0,
        title: 'Specials',
        episodeCount: 1,
        isSpecial: true,
        episodes: [
          {
            tmdbId: 5057304,
            number: 1,
            title: 'White Christmas',
            airDate: '2014-12-16',
            runtimeMinutes: 75,
            isFinale: false,
          },
        ],
      },
    ] as any);

    expect(result).toMatchObject({
      stale: 1,
      mapped: 1,
      unmapped: 0,
      legacyQuarantined: 0,
      matchRules: { 'legacySpecialDate+seasonEpisode+title+runtime': 1 },
      blocked: false,
    });
  });

  it('lets a protected stale row claim a target before a data-free staging duplicate', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('mixed', 1, [
          ep({ id: 'data-free-duplicate', number: 1, absoluteNumber: 1 }),
          ep({ id: 'protected-source', number: 1, absoluteNumber: 1 }),
          ep({
            id: 'canonical-target',
            number: 1,
            absoluteNumber: 1,
            externalIds: [{ provider: 'THE_TVDB', value: '80001' }],
          }),
        ]),
      ]),
    );
    prisma.$queryRaw.mockResolvedValue([
      { id: 'data-free-duplicate', has_data: false },
      { id: 'protected-source', has_data: true },
    ]);

    const result = await service.remapShow('m1', {
      canonical: 'tvdb',
      dryRun: true,
      requireCompleteUserDataMapping: true,
    });

    expect(result).toMatchObject({
      mapped: 1,
      unmapped: 0,
      legacyQuarantined: 0,
      episodesRemoved: 1,
    });
  });

  it('merges into the target status row when the user already has one', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'old', number: 30, title: 'The Forest', airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'new',
            number: 5,
            title: 'The Forest',
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.findMany.mockResolvedValue([
      {
        id: 'ues-old',
        userId: 'u1',
        episodeId: 'old',
        watched: true,
        watchedAt: D2,
        watchCount: 2,
        device: 'TV',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-02-01'),
      },
    ]);
    prisma.userEpisodeStatus.findUnique.mockResolvedValue({
      id: 'ues-new',
      userId: 'u1',
      episodeId: 'new',
      watched: false,
      watchedAt: null,
      watchCount: 1,
      device: null,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-15'),
    });

    const res = await service.remapShow('m1');

    expect(res.mapped).toBe(1);
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'ues-new' },
      data: { watched: true, watchedAt: D2, watchCount: 2, device: 'TV' },
    });
    expect(prisma.userEpisodeStatus.delete).toHaveBeenCalledWith({ where: { id: 'ues-old' } });
  });

  it('maps specials only through an exact external id', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season(
          's0',
          0,
          [
            ep({
              id: 'old',
              number: 3,
              title: 'OVA: Memory Snow',
              externalIds: [{ provider: 'TMDB', value: 'special-1' }],
            }),
          ],
          true,
        ),
        season(
          's0',
          0,
          [
            ep({
              id: 'new',
              number: 1,
              title: 'OVA: Memory Snow',
              externalIds: [
                { provider: 'TMDB', value: 'special-1' },
                { provider: 'THE_TVDB', value: 'tvdb-special-1' },
              ],
            }),
          ],
          true,
        ),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.mapped).toBe(1);
    expect(res.matchRules).toEqual({ externalId: 1 });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'old' } });
  });

  it('maps a verified special by date plus coordinates but keeps a same-day ambiguous special', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn().mockResolvedValue(
        new Map([
          [
            8999264,
            {
              airDate: '2017-06-09',
              seasonNumber: 0,
              episodeNumber: 1,
              absoluteNumber: null,
            },
          ],
          [
            6135398,
            {
              airDate: '2017-03-10',
              seasonNumber: 0,
              episodeNumber: 2,
              absoluteNumber: null,
            },
          ],
        ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.externalId.findFirst.mockResolvedValue({ value: '330134' });
    prisma.$queryRaw.mockResolvedValue([{ id: 'tvdb-meet-dewey', has_data: true }]);
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season(
          'legacy-specials',
          0,
          [
            ep({
              id: 'tvdb-meet-dewey',
              number: 1,
              title: 'Meet Dewey!',
              airDate: new Date('2017-06-09T00:00:00.000Z'),
              structureState: 'LEGACY_UNMAPPED',
              externalIds: [{ provider: 'THE_TVDB', value: '8999264' }],
            }),
            ep({
              id: 'tvdb-donald-tales',
              number: 2,
              title: "Donald Duck's Tales",
              airDate: new Date('2017-03-10T00:00:00.000Z'),
              structureState: 'LEGACY_UNMAPPED',
              externalIds: [{ provider: 'THE_TVDB', value: '6135398' }],
            }),
          ],
          true,
        ),
        season(
          'canonical-specials',
          0,
          [
            ep({
              id: 'tmdb-first-look',
              number: 1,
              title: 'DuckTales: First Look',
              airDate: new Date('2017-03-02T00:00:00.000Z'),
              externalIds: [{ provider: 'TMDB', value: '2777289' }],
            }),
            ep({
              id: 'tmdb-donald-tales',
              number: 2,
              title: "Donald Duck's Tales",
              airDate: new Date('2017-03-10T00:00:00.000Z'),
              externalIds: [{ provider: 'TMDB', value: '2777292' }],
            }),
            ep({
              id: 'tmdb-donald-birthday',
              number: 3,
              title: "Donald's Birthday",
              airDate: new Date('2017-06-09T00:00:00.000Z'),
              externalIds: [{ provider: 'TMDB', value: '2777294' }],
            }),
            ep({
              id: 'tmdb-meet-webby',
              number: 4,
              title: 'Meet Webby Vanderquack!',
              airDate: new Date('2017-06-09T00:00:00.000Z'),
              externalIds: [{ provider: 'TMDB', value: '2777295' }],
            }),
          ],
          true,
        ),
      ]),
    );

    const result = await service.remapShow('m1', { dryRun: true, canonical: 'tmdb' });

    expect(result).toMatchObject({ stale: 2, mapped: 1, unmapped: 1, legacyQuarantined: 1 });
    expect(result.matchRules).toEqual({ 'verifiedSpecialDate+seasonEpisode': 1 });
  });

  it('refuses ambiguous airDate groups and keeps rows that carry user data', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'old', number: 30, title: 'Old Title', airDate: D })]),
        season('s2', 2, [
          ep({
            id: 'n1',
            number: 1,
            title: 'Other A',
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
          ep({
            id: 'n2',
            number: 2,
            title: 'Other B',
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    // Stale row has user data (batched EXISTS classifier).
    prisma.$queryRaw.mockResolvedValue([{ id: 'old', has_data: true }]);

    const res = await service.remapShow('m1');

    expect(res).toMatchObject({
      stale: 1,
      mapped: 0,
      unmapped: 1,
      legacyQuarantined: 1,
      episodesRemoved: 0,
    });
    expect(prisma.episode.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old'] } },
      data: { structureState: 'LEGACY_UNMAPPED' },
    });
    expect(prisma.episode.delete).not.toHaveBeenCalled(); // kept — never lose watch data
    expect(prisma.episode.deleteMany).not.toHaveBeenCalled();
    // No transfer ran (only the absoluteNumber backfill touches the DB in this test).
    expect(prisma.userEpisodeStatus.update).not.toHaveBeenCalled();
    expect(prisma.watchHistory.updateMany).not.toHaveBeenCalled();
  });

  it('does not use an exact title as episode identity proof', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s-old', 5, [
          ep({
            id: 'old',
            number: 15,
            absoluteNumber: 99,
            title: 'The Same Localized Title',
            externalIds: [{ provider: 'THE_TVDB', value: '8432761' }],
          }),
        ]),
        season('s-new', 5, [
          ep({
            id: 'new',
            number: 13,
            absoluteNumber: 13,
            title: 'The Same Localized Title',
            externalIds: [{ provider: 'TMDB', value: '2699191' }],
          }),
        ]),
      ]),
    );

    const result = await service.remapShow('m1', { canonical: 'tmdb' });

    expect(result.mapped).toBe(0);
    expect(result.matchRules).toEqual({});
  });

  it('reconsiders legacy rows using a TVDB-verified date and canonical show identity', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn().mockResolvedValue(
        new Map([
          [
            8432761,
            {
              airDate: '2020-03-07',
              seasonNumber: 5,
              episodeNumber: 15,
              absoluteNumber: 115,
            },
          ],
          [
            7602682,
            {
              airDate: '2020-03-07',
              seasonNumber: 5,
              episodeNumber: 14,
              absoluteNumber: 114,
            },
          ],
        ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.externalId.findFirst.mockResolvedValue({ value: '258111' });
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s-old', 5, [
          ep({
            id: 'legacy-part-2',
            number: 15,
            absoluteNumber: 99,
            title: 'Un titre traduit sans correspondance',
            airDate: new Date('2020-12-04T00:00:00.000Z'),
            structureState: 'LEGACY_UNMAPPED',
            externalIds: [{ provider: 'THE_TVDB', value: '8432761' }],
          }),
        ]),
        season('s-new', 5, [
          ep({
            id: 'canonical-combined',
            number: 13,
            absoluteNumber: 13,
            title: 'The Great McStuffins Meltdown',
            airDate: new Date('2020-03-07T00:00:00.000Z'),
            externalIds: [
              { provider: 'TMDB', value: '2699191' },
              { provider: 'THE_TVDB', value: '8080762' },
            ],
          }),
        ]),
      ]),
    );

    const result = await service.remapShow('m1', { canonical: 'tmdb' });

    expect(tvdb.getEpisodeRoutingIndex).toHaveBeenCalledWith(258111);
    expect(result).toMatchObject({ stale: 1, mapped: 1, unmapped: 0 });
    expect(result.matchRules).toEqual({ verifiedProviderAirDate: 1 });
    expect(prisma.episodeExternalId.create).toHaveBeenCalledWith({
      data: {
        episodeId: 'canonical-combined',
        provider: 'THE_TVDB',
        providerEntityKind: 'EPISODE',
        value: '8432761',
      },
    });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'legacy-part-2' } });
  });

  it('aborts before writes when the verified TVDB routing snapshot fails', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn().mockRejectedValue(new Error('TVDB snapshot incomplete')),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.externalId.findFirst.mockResolvedValue({ value: '258111' });
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('legacy', 1, [
          ep({
            id: 'legacy-tvdb',
            number: 1,
            title: 'Pilot',
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB', value: '900001' }],
          }),
        ]),
        season('canonical', 1, [
          ep({
            id: 'canonical-tmdb',
            number: 1,
            title: 'Pilot',
            airDate: D,
            externalIds: [{ provider: 'TMDB', value: '1001' }],
          }),
        ]),
      ]),
    );

    await expect(service.remapShow('m1', { canonical: 'tmdb' })).rejects.toThrow(
      'TVDB snapshot incomplete',
    );
    expect(prisma.episode.updateMany).not.toHaveBeenCalled();
    expect(prisma.episode.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userEpisodeStatus.update).not.toHaveBeenCalled();
  });

  it('does not treat an all-default unwatched status as protected episode data', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('legacy', 1, [ep({ id: 'empty-status', externalIds: [] })]),
        season('canonical', 1, [
          ep({ id: 'canonical', externalIds: [{ provider: 'TMDB', value: '1001' }] }),
        ]),
      ]),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: 'empty-status', has_data: false }]);

    const result = await service.remapShow('m1', { canonical: 'tmdb' });

    expect(result).toMatchObject({ legacyQuarantined: 0, episodesRemoved: 1 });
    expect(prisma.episode.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['empty-status'] } },
    });
    const sql = (prisma.$queryRaw.mock.calls[0][0] as any).strings.join(' ');
    expect(sql).toContain('u.watched = true');
    expect(sql).toContain('u.watch_count > 0');
  });

  it('uses verified aired order for a same-day batch across different season layouts', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn().mockResolvedValue(
        new Map([
          [
            900001,
            {
              airDate: '2024-06-01',
              seasonNumber: 2,
              episodeNumber: 1,
              absoluteNumber: 13,
            },
          ],
        ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.externalId.findFirst.mockResolvedValue({ value: '12345' });
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('tvdb-s2', 2, [
          ep({
            id: 'tvdb-s2e1',
            number: 1,
            absoluteNumber: 99,
            title: '完全に異なる翻訳タイトル',
            airDate: new Date('2024-12-01T00:00:00.000Z'),
            structureState: 'LEGACY_UNMAPPED',
            externalIds: [{ provider: 'THE_TVDB', value: '900001' }],
          }),
        ]),
        season('tmdb-s1', 1, [
          ep({
            id: 'tmdb-s1e13',
            number: 13,
            absoluteNumber: 13,
            title: 'Thirteenth Episode',
            airDate: new Date('2024-06-01T00:00:00.000Z'),
            externalIds: [{ provider: 'TMDB', value: '1300' }],
          }),
          ep({
            id: 'tmdb-s1e14',
            number: 14,
            absoluteNumber: 14,
            title: 'Fourteenth Episode',
            airDate: new Date('2024-06-01T00:00:00.000Z'),
            externalIds: [{ provider: 'TMDB', value: '1400' }],
          }),
        ]),
      ]),
    );

    const result = await service.remapShow('m1', { canonical: 'tmdb' });

    expect(result.mapped).toBe(1);
    expect(result.matchRules).toEqual({ 'verifiedDate+absolute': 1 });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'tvdb-s2e1' } });
  });

  it('uses article-tolerant title similarity only inside a verified same-day group', async () => {
    const tvdb = {
      getEpisodeRoutingIndex: jest.fn().mockResolvedValue(
        new Map([
          [
            900002,
            {
              airDate: '2024-06-02',
              seasonNumber: 9,
              episodeNumber: 9,
              absoluteNumber: null,
            },
          ],
        ]),
      ),
    };
    service = new StructureRemapService(prisma, undefined, tvdb as any);
    prisma.externalId.findFirst.mockResolvedValue({ value: '12345' });
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('legacy', 9, [
          ep({
            id: 'legacy-title',
            number: 9,
            absoluteNumber: 99,
            title: 'Great McStuffins Meltdown (2)',
            structureState: 'LEGACY_UNMAPPED',
            externalIds: [{ provider: 'THE_TVDB', value: '900002' }],
          }),
        ]),
        season('canonical', 1, [
          ep({
            id: 'right-title',
            number: 3,
            absoluteNumber: 3,
            title: 'The Great McStuffins Meltdown',
            airDate: new Date('2024-06-02T00:00:00.000Z'),
            externalIds: [{ provider: 'TMDB', value: '300' }],
          }),
          ep({
            id: 'wrong-title',
            number: 4,
            absoluteNumber: 4,
            title: 'A Completely Different Episode',
            airDate: new Date('2024-06-02T00:00:00.000Z'),
            externalIds: [{ provider: 'TMDB', value: '400' }],
          }),
        ]),
      ]),
    );

    const result = await service.remapShow('m1', { canonical: 'tmdb' });

    expect(result.mapped).toBe(1);
    expect(result.matchRules).toEqual({ 'verifiedDate+title': 1 });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'legacy-title' } });
  });

  it('deletes unmapped stale rows that carry no user data and drops emptied seasons', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s9', 9, [ep({ id: 'old', number: 1, title: 'Phantom' })]),
        season('s1', 1, [
          ep({ id: 'new', number: 1, title: 'Real', externalIds: [{ provider: 'THE_TVDB' }] }),
        ]),
      ]),
    );
    prisma.season.deleteMany.mockResolvedValue({ count: 1 });

    const res = await service.remapShow('m1');

    expect(res).toMatchObject({
      stale: 1,
      mapped: 0,
      unmapped: 0,
      episodesRemoved: 1,
      seasonsRemoved: 1,
    });
    expect(prisma.episode.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['old'] } } });
    expect(prisma.season.deleteMany).toHaveBeenCalledWith({
      where: { showId: 'sh1', episodes: { none: {} } },
    });
  });

  it('remapEpisodesToMedia moves user data across entities (contamination split)', async () => {
    prisma.show.findUnique.mockImplementation(({ where: { mediaId } }: any) =>
      Promise.resolve(
        mediaId === 'movie-1'
          ? showWith([season('s1', 1, [ep({ id: 'old', number: 1, title: 'Pilot', airDate: D })])])
          : showWith([
              season('s2', 1, [
                ep({
                  id: 'new',
                  number: 1,
                  title: 'Pilot',
                  airDate: D,
                  externalIds: [{ provider: 'THE_TVDB' }],
                }),
              ]),
            ]),
      ),
    );
    prisma.userEpisodeStatus.findMany.mockResolvedValue([
      {
        id: 'ues1',
        userId: 'u1',
        episodeId: 'old',
        watched: true,
        watchedAt: D2,
        watchCount: 1,
        device: null,
      },
    ]);

    const res = await service.remapEpisodesToMedia('movie-1', 'show-new');

    expect(res).toMatchObject({ stale: 1, mapped: 1, statusesMoved: 1, episodesRemoved: 1 });
    expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'ues1' },
      data: { episodeId: 'new' },
    });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'old' } });
    // Progress cache recomputed on the TARGET show.
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_mediaId: { userId: 'u1', mediaId: 'show-new' } } }),
    );
  });

  // ---- Matching ladder v2 (absoluteNumber) — the Dragon Ball regression ----

  it('maps a flattened TMDB row onto the split TVDB structure via absoluteNumber', async () => {
    // Dragon Ball shape: TMDB S1 = 153 eps; TVDB S1 = 35, S2 = 15, … — stale TMDB
    // S1E36.. predate the absoluteNumber column (null); TVDB rows carry provider values.
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          // Fresh merged rows: TVDB S1E1..E3 (TVDB absolute 1..3) — have TMDB + TVDB ids.
          ...[1, 2, 3].map((n) =>
            ep({
              id: `fresh-s1e${n}`,
              number: n,
              title: `DB ep ${n}`,
              absoluteNumber: n,
              externalIds: [{ provider: 'TMDB' }, { provider: 'THE_TVDB' }],
            }),
          ),
          // Stale flattened TMDB rows S1E4.. (absoluteNumber unknown — backfilled).
          ep({ id: 'stale-e4', number: 4, title: 'DB ep 4 (tmdb title)', absoluteNumber: null }),
          ep({ id: 'stale-e5', number: 5, title: 'DB ep 5 (tmdb title)', absoluteNumber: null }),
        ]),
        season('s2', 2, [
          // TVDB S2E1/E2 = absolute 4/5.
          ep({
            id: 'fresh-s2e1',
            number: 1,
            title: 'DB ep 4 (tvdb title)',
            absoluteNumber: 4,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
          ep({
            id: 'fresh-s2e2',
            number: 2,
            title: 'DB ep 5 (tvdb title)',
            absoluteNumber: 5,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1');

    expect(res.stale).toBe(2);
    expect(res.mapped).toBe(2);
    expect(res.unmapped).toBe(0);
    expect(res.matchRules).toEqual({ absolute: 2 });
    // Backfill assigned 4/5 to the stale rows (never overwrote provider values).
    expect(prisma.episode.update).toHaveBeenCalledWith({
      where: { id: 'stale-e4' },
      data: { absoluteNumber: 4 },
    });
    expect(prisma.episode.update).toHaveBeenCalledWith({
      where: { id: 'stale-e5' },
      data: { absoluteNumber: 5 },
    });
    // Stale rows deleted after their (empty) user-data transfer.
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale-e4' } });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale-e5' } });
  });

  it('trusts a unique absolute match even when provider airDates conflict', async () => {
    // Real data: TMDB S1E36 "Major Metallitron" (1986-10-29) vs TVDB S3E8 (1987-06-10) —
    // same episode, provider dates months apart. Unique absolute correspondence wins.
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({ id: 'stale', number: 7, title: 'X', absoluteNumber: 7, airDate: D }),
        ]),
        season('s2', 2, [
          ep({
            id: 'fresh-conflict',
            number: 1,
            title: 'Y',
            absoluteNumber: 7,
            airDate: D2,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    prisma.userEpisodeStatus.count.mockResolvedValue(1);

    const res = await service.remapShow('m1');
    expect(res).toMatchObject({ stale: 1, mapped: 1, unmapped: 0 });
    expect(res.matchRules).toEqual({ absolute: 1 });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale' } });
  });

  it('remaps stale rows that have NO provider ids at all (Dragon Ball: ids lost)', async () => {
    // Flattened S1 rows whose TMDB ids were lost entirely: externalIds = [].
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({
            id: 'fresh-e1',
            number: 1,
            title: 'Ep 1',
            absoluteNumber: 1,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
          ep({ id: 'stale-e2', number: 2, title: 'Ep 2', absoluteNumber: null, externalIds: [] }),
        ]),
        season('s2', 2, [
          ep({
            id: 'fresh-e2',
            number: 1,
            title: 'Ep 2',
            absoluteNumber: 2,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1');
    expect(res.stale).toBe(1);
    expect(res.mapped).toBe(1);
    expect(res.matchRules).toEqual({ absolute: 1 });
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'stale-e2' } });
  });

  it('never deletes into the void when no TVDB-linked rows exist', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({ id: 'e1', number: 1, title: 'A' }),
          ep({ id: 'e2', number: 2, title: 'B' }),
        ]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res).toMatchObject({ stale: 0, mapped: 0, episodesRemoved: 0 });
    expect(prisma.episode.delete).not.toHaveBeenCalled();
  });

  it('matches via absolute+date when both signals agree', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({ id: 'stale', number: 7, title: 'Old', absoluteNumber: 7, airDate: D }),
        ]),
        season('s2', 2, [
          ep({
            id: 'fresh',
            number: 1,
            title: 'New',
            absoluteNumber: 7,
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.mapped).toBe(1);
    expect(res.matchRules).toEqual({ 'absolute+date': 1 });
  });

  it('refuses to guess when two fresh rows share an absolute number', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [ep({ id: 'stale', number: 7, title: 'Old', absoluteNumber: 7 })]),
        season('s2', 2, [
          ep({
            id: 'f1',
            number: 1,
            title: 'A',
            absoluteNumber: 7,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
          ep({
            id: 'f2',
            number: 2,
            title: 'B',
            absoluteNumber: 7,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    const res = await service.remapShow('m1');
    expect(res.mapped).toBe(0);
    expect(res.unmapped).toBe(0); // no user data → deleted, but never mis-mapped
    expect(res.episodesRemoved).toBe(1);
  });

  it('dry-run computes matches and kept/deleted counts without any writes', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({ id: 'stale-mapped', number: 4, title: 'M', absoluteNumber: 4 }),
          ep({ id: 'stale-unmapped', number: 99, title: 'U', absoluteNumber: 99 }),
        ]),
        season('s2', 2, [
          ep({
            id: 'fresh',
            number: 1,
            title: 'M2',
            absoluteNumber: 4,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1', { dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.stale).toBe(2);
    expect(res.mapped).toBe(1);
    expect(res.matchRules).toEqual({ absolute: 1 });
    expect(res.episodesRemoved).toBe(1); // would-be deletion of the data-free unmapped row
    // No writes at all: no transferPair, no backfill persist, no deletes.
    expect(prisma.episode.delete).not.toHaveBeenCalled();
    expect(prisma.episode.update).not.toHaveBeenCalled();
    expect(prisma.watchHistory.updateMany).not.toHaveBeenCalled();
    expect(prisma.season.deleteMany).not.toHaveBeenCalled();
  });

  // ---- Reverse direction (canonical='tmdb'): daily shows with a stray TVDB structure ----

  it('canonical=tmdb: stale = rows WITHOUT a TMDB id; TVDB-linked rows are the anchor', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          // Canonical TMDB rows (fresh in reverse direction).
          ep({
            id: 'tmdb-e1',
            number: 1,
            title: 'Pilot',
            absoluteNumber: 1,
            airDate: D,
            externalIds: [{ provider: 'TMDB' }],
          }),
          // Stray TVDB-only duplicate of the same episode (stale in reverse direction).
          ep({
            id: 'tvdb-e1',
            number: 1,
            title: 'Pilot',
            absoluteNumber: 1,
            airDate: D,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1', { canonical: 'tmdb' });

    expect(res.stale).toBe(1);
    expect(res.mapped).toBe(1);
    expect(res.episodesRemoved).toBe(1);
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'tvdb-e1' } });
    expect(prisma.episode.delete).not.toHaveBeenCalledWith({ where: { id: 'tmdb-e1' } });
  });

  it('canonical=tmdb with default (tvdb) direction would treat the TMDB rows as stale instead', async () => {
    // Sanity guard for the direction parameter: same fixture, default canonical.
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({
            id: 'tmdb-e1',
            number: 1,
            title: 'Pilot',
            absoluteNumber: 1,
            externalIds: [{ provider: 'TMDB' }],
          }),
          ep({
            id: 'tvdb-e1',
            number: 1,
            title: 'Pilot',
            absoluteNumber: 1,
            externalIds: [{ provider: 'THE_TVDB' }],
          }),
        ]),
      ]),
    );
    const res = await service.remapShow('m1'); // default canonical = tvdb
    expect(res.stale).toBe(1);
    expect(prisma.episode.delete).toHaveBeenCalledWith({ where: { id: 'tmdb-e1' } });
  });

  it('moves the stale row’s REAL provider id value onto the target row', async () => {
    prisma.show.findUnique.mockResolvedValue(
      showWith([
        season('s1', 1, [
          ep({
            id: 'fresh',
            number: 1,
            title: 'Same',
            absoluteNumber: 5,
            externalIds: [{ provider: 'THE_TVDB', value: 'tvdb-555' }],
          }),
          ep({
            id: 'stale',
            number: 5,
            title: 'Same',
            absoluteNumber: 5,
            externalIds: [{ provider: 'TMDB', value: 'tmdb-777' }],
          }),
        ]),
      ]),
    );

    const res = await service.remapShow('m1');
    expect(res.mapped).toBe(1);
    expect(prisma.episodeExternalId.deleteMany).toHaveBeenCalledWith({
      where: { episodeId: 'stale', provider: 'TMDB' },
    });
    expect(prisma.episodeExternalId.create).toHaveBeenCalledWith({
      data: {
        episodeId: 'fresh',
        provider: 'TMDB',
        providerEntityKind: 'EPISODE',
        value: 'tmdb-777',
      },
    });
  });
});
