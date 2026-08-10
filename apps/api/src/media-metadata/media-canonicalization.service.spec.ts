import {
  CommentThreadType,
  ExternalProvider,
  MediaCanonicalRelation,
  MediaCanonicalStatus,
} from '@prisma/client';
import { MediaCanonicalizationService } from './media-canonicalization.service';
import { ProviderError } from './providers/shared/provider-errors';

function episode(id: string, seasonNumber: number, number: number, title: string, airDate: string) {
  return {
    id,
    seasonNumber,
    number,
    title,
    airDate: new Date(`${airDate}T00:00:00.000Z`),
    runtimeMinutes: 45,
    isSpecial: false,
    externalIds: [],
  };
}

function graph(id: string, seasons: Array<{ number: number; episodes: any[] }>): any {
  return {
    id,
    title: id,
    normalizedTitle: id,
    structureProvider: 'TVDB',
    externalIds: [],
    seasons: seasons.map((season) => ({ ...season, isSpecial: false })),
  };
}

describe('MediaCanonicalizationService', () => {
  const mediaCanonicalLink = {
    count: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  };
  const mediaCanonicalCopy = {
    findFirst: jest.fn(),
  };
  const externalId = { findMany: jest.fn() };
  const mediaItem = { findMany: jest.fn() };
  const prisma = {
    mediaCanonicalLink,
    mediaCanonicalCopy,
    externalId,
    mediaItem,
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  const tmdb = {
    findByExternalIdStrict: jest.fn(),
    getShowRoutingProfile: jest.fn(),
  };
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };
  const service = new MediaCanonicalizationService(
    prisma as any,
    tmdb as any,
    redis as any,
    { emit: jest.fn() } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mediaCanonicalLink.findUnique.mockReset().mockResolvedValue(null);
    mediaCanonicalLink.count.mockReset().mockResolvedValue(0);
    mediaCanonicalLink.findMany.mockReset();
    mediaCanonicalLink.findMany.mockResolvedValue([]);
    externalId.findMany.mockResolvedValue([]);
    mediaItem.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([]);
    redis.get.mockReset().mockResolvedValue(null);
    redis.set.mockReset().mockResolvedValue(undefined);
    redis.del.mockReset().mockResolvedValue(undefined);
  });

  it('redirects media only after the link is ACTIVE', async () => {
    mediaCanonicalLink.findUnique.mockImplementation(({ where }: any) => {
      if (where.sourceMediaId === 'old') {
        return { targetMediaId: 'canonical', status: MediaCanonicalStatus.ACTIVE };
      }
      return null;
    });

    await expect(service.resolveMediaId('old')).resolves.toBe('canonical');

    mediaCanonicalLink.findUnique.mockResolvedValue({
      targetMediaId: 'canonical',
      status: MediaCanonicalStatus.COPYING,
    });
    await expect(service.resolveMediaId('old')).resolves.toBe('old');
  });

  it('redirects episodes only through an ACTIVE copy ledger', async () => {
    mediaCanonicalCopy.findFirst.mockResolvedValue({ targetId: 'canonical-episode' });

    await expect(service.resolveEpisodeId('old-episode')).resolves.toBe('canonical-episode');
    expect(mediaCanonicalCopy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: 'old-episode',
          link: { status: MediaCanonicalStatus.ACTIVE },
        }),
      }),
    );
  });

  it('reports an already-active targeted source without rediscovering or copying it', async () => {
    mediaCanonicalLink.findUnique.mockResolvedValue({
      targetMediaId: 'canonical',
      relation: MediaCanonicalRelation.EXACT_DUPLICATE,
      targetSeasonNumber: null,
      status: MediaCanonicalStatus.ACTIVE,
      evidence: { rootProof: 'complete-transitive-episode-identity' },
    });
    const loadGraph = jest.spyOn(service as any, 'loadGraph');

    const result = await service.evaluateTvdbAggregate('old-source', 'repair');

    expect(result).toEqual(
      expect.objectContaining({
        changed: false,
        candidates: 1,
        activated: 0,
        blocked: 0,
        reason: 'already-active',
      }),
    );
    expect(result.links[0]).toEqual(
      expect.objectContaining({ sourceMediaId: 'old-source', targetMediaId: 'canonical' }),
    );
    expect(loadGraph).not.toHaveBeenCalled();
    loadGraph.mockRestore();
  });

  it('reports cumulative batch progress before and after every aggregate', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'aggregate-1' }, { id: 'aggregate-2' }]);
    const evaluate = jest
      .spyOn(service, 'evaluateTvdbAggregate')
      .mockImplementation(async (mediaId) => ({
        mediaId,
        evaluated: true,
        changed: true,
        candidates: mediaId === 'aggregate-1' ? 2 : 1,
        activated: mediaId === 'aggregate-1' ? 2 : 0,
        blocked: mediaId === 'aggregate-1' ? 0 : 1,
        links: [],
      }));
    const onProgress = jest.fn();

    const result = await service.run({ mode: 'dry-run', count: 2, onProgress });

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        processed: 0,
        total: 2,
        current: 'aggregate-1',
        candidates: 0,
        activated: 0,
        blocked: 0,
      },
      {
        processed: 1,
        total: 2,
        current: 'aggregate-1',
        candidates: 2,
        activated: 2,
        blocked: 0,
      },
      {
        processed: 1,
        total: 2,
        current: 'aggregate-2',
        candidates: 2,
        activated: 2,
        blocked: 0,
      },
      {
        processed: 2,
        total: 2,
        current: 'aggregate-2',
        candidates: 3,
        activated: 2,
        blocked: 1,
      },
    ]);
    expect(result).toEqual(
      expect.objectContaining({ scanned: 2, candidates: 3, activated: 2, blocked: 1 }),
    );
    evaluate.mockRestore();
  });

  it('persists a repair cursor beyond the Redis default TTL', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'aggregate-1' }, { id: 'aggregate-2' }]);
    const evaluate = jest.spyOn(service, 'evaluateTvdbAggregate').mockResolvedValue({
      mediaId: 'aggregate',
      evaluated: true,
      changed: false,
      candidates: 0,
      activated: 0,
      blocked: 0,
      reason: 'no-candidates',
      links: [],
    });

    const result = await service.run({ mode: 'repair', count: 2 });

    expect(result.nextCursor).toBe('aggregate-2');
    expect(redis.set).toHaveBeenCalledWith(
      'media-canonicalization:scan-cursor',
      'aggregate-2',
      365 * 24 * 60 * 60,
    );
    expect(redis.del).toHaveBeenCalledWith('media-canonicalization:scan-complete');
    evaluate.mockRestore();
  });

  it('reports the remaining repair-pass backlog separately from total eligible inventory', async () => {
    redis.get.mockResolvedValueOnce('aggregate-050').mockResolvedValueOnce(null);
    mediaCanonicalLink.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.$queryRaw.mockResolvedValue([{ total: 3452n, remaining: 3402n }]);

    const stats = await service.getStats();

    expect(stats).toEqual(
      expect.objectContaining({
        active: 7,
        scanEligible: 3452,
        scanRemaining: 3402,
        scanProcessed: 50,
        scanCursor: 'aggregate-050',
        scanPassComplete: false,
      }),
    );
  });

  it('keeps a completed pass at zero until the next repair explicitly starts a new pass', async () => {
    redis.get
      .mockResolvedValueOnce('aggregate-last')
      .mockResolvedValueOnce('2026-08-10T00:00:00.000Z');
    prisma.$queryRaw.mockResolvedValue([]);

    const result = await service.run({ mode: 'repair', count: 50 });

    expect(result.repairPassRestarted).toBe(true);
    expect(result.passComplete).toBe(true);
    expect(redis.del).toHaveBeenCalledWith('media-canonicalization:scan-cursor');
    expect(redis.del).toHaveBeenCalledWith('media-canonicalization:scan-complete');
    expect(redis.set).toHaveBeenCalledWith(
      'media-canonicalization:scan-complete',
      expect.any(String),
      365 * 24 * 60 * 60,
    );
  });

  it('accepts a complete episode-equivalent graph as an exact duplicate', () => {
    const source = graph('source', [
      { number: 1, episodes: [episode('s1', 1, 1, 'Pilot', '2020-01-01')] },
      { number: 2, episodes: [episode('s2', 2, 1, 'Return', '2021-01-01')] },
    ]);
    const target = graph('target', [
      { number: 1, episodes: [episode('t1', 1, 1, 'Pilot', '2020-01-01')] },
      { number: 2, episodes: [episode('t2', 2, 1, 'Return', '2021-01-01')] },
    ]);

    const match = (service as any).matchGraph(source, target);
    expect(match.relation).toBe(MediaCanonicalRelation.EXACT_DUPLICATE);
    expect(match.targetSeasonNumber).toBeNull();
    expect(match.pairs.map((pair: any) => [pair.source.id, pair.target.id])).toEqual([
      ['s1', 't1'],
      ['s2', 't2'],
    ]);
  });

  it('maps a one-season TMDB component to exactly one aggregate season', () => {
    const source = graph('source', [
      { number: 1, episodes: [episode('s1', 1, 1, 'Return', '2021-01-01')] },
    ]);
    const target = graph('target', [
      { number: 1, episodes: [episode('t1', 1, 1, 'Pilot', '2020-01-01')] },
      { number: 2, episodes: [episode('t2', 2, 1, 'Return', '2021-01-01')] },
    ]);

    const match = (service as any).matchGraph(source, target);
    expect(match.relation).toBe(MediaCanonicalRelation.SEASON_COMPONENT);
    expect(match.targetSeasonNumber).toBe(2);
    expect(match.pairs[0].target.id).toBe('t2');
  });

  it('fails closed when an episode title or air date differs', () => {
    const source = graph('source', [
      { number: 1, episodes: [episode('s1', 1, 1, 'Pilot', '2020-01-01')] },
    ]);
    const target = graph('target', [
      { number: 1, episodes: [episode('t1', 1, 1, 'Different', '2020-01-01')] },
      { number: 2, episodes: [episode('t2', 2, 1, 'Return', '2021-01-01')] },
    ]);

    expect((service as any).matchGraph(source, target)).toBeNull();
  });

  it('merges watched state without losing the earliest timestamp or highest watch count', async () => {
    const sourceStatus = {
      id: 'source-status',
      userId: 'user-1',
      watched: true,
      watchedAt: new Date('2020-01-01T00:00:00.000Z'),
      watchCount: 2,
      device: 'TV',
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    };
    const targetStatus = {
      ...sourceStatus,
      id: 'target-status',
      watched: false,
      watchedAt: new Date('2021-01-01T00:00:00.000Z'),
      watchCount: 1,
      device: null,
    };
    const tx = {
      mediaCanonicalCopy: { upsert: jest.fn().mockResolvedValue({}) },
      userEpisodeStatus: {
        findMany: jest.fn().mockResolvedValue([sourceStatus]),
        findUnique: jest.fn().mockResolvedValue(targetStatus),
        update: jest.fn().mockResolvedValue(targetStatus),
        create: jest.fn(),
      },
      watchHistory: { findMany: jest.fn().mockResolvedValue([]) },
      rating: { findMany: jest.fn().mockResolvedValue([]) },
      reaction: { findMany: jest.fn().mockResolvedValue([]) },
      characterVote: { findMany: jest.fn().mockResolvedValue([]) },
      externalReview: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const clone = jest.spyOn(service as any, 'cloneComments').mockResolvedValue(undefined);

    await (service as any).copyEpisode(
      tx,
      'link-1',
      'source-media',
      'target-media',
      {
        source: episode('source-episode', 1, 1, 'Pilot', '2020-01-01'),
        target: episode('target-episode', 1, 1, 'Pilot', '2020-01-01'),
      },
      new Set<string>(),
    );

    expect(tx.userEpisodeStatus.update).toHaveBeenCalledWith({
      where: { id: 'target-status' },
      data: {
        watched: true,
        watchedAt: new Date('2020-01-01T00:00:00.000Z'),
        watchCount: 2,
        device: 'TV',
      },
    });
    clone.mockRestore();
  });

  it('clones comment trees into an independent target thread', async () => {
    const base = {
      userId: 'user-1',
      threadType: CommentThreadType.EPISODE,
      threadId: 'source-episode',
      body: 'body',
      imageUrl: null,
      gifUrl: null,
      mediaType: 'SHOW',
      mediaId: 'source-media',
      listId: null,
      isSpoiler: false,
      spoilerCount: 0,
      externalReviewId: 'review-1',
      parentSourceKey: null,
      language: null,
      translations: {},
      source: 'MANUAL',
      sourceKey: null,
      likesCount: 0,
      repliesCount: 0,
      hidden: false,
      adminDeleted: false,
      deletedByUser: false,
      editedAt: null,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      updatedAt: new Date('2020-01-01T00:00:00.000Z'),
      likes: [],
      spoilerReports: [],
      image: null,
    };
    const rows = [
      { ...base, id: 'source-root', parentId: null, rootId: null, depth: 0 },
      {
        ...base,
        id: 'source-reply',
        parentId: 'source-root',
        rootId: 'source-root',
        depth: 1,
      },
    ];
    const create = jest
      .fn()
      .mockResolvedValueOnce({ id: 'target-root' })
      .mockResolvedValueOnce({ id: 'target-reply' });
    const tx = {
      comment: { findMany: jest.fn().mockResolvedValue(rows), findUnique: jest.fn(), create },
      mediaCanonicalCopy: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      commentLike: { createMany: jest.fn() },
      commentSpoilerReport: { createMany: jest.fn() },
      commentImage: { create: jest.fn() },
    };
    const affected = new Set<string>();

    await (service as any).cloneComments(
      tx,
      'link-1',
      CommentThreadType.EPISODE,
      'source-episode',
      'target-episode',
      'source-media',
      'target-media',
      affected,
      new Set(['review-1']),
    );

    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          parentId: null,
          threadId: 'target-episode',
          mediaId: 'target-media',
          externalReviewId: 'review-1',
        }),
      }),
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'target-root', rootId: 'target-root' }),
      }),
    );
    expect(affected).toEqual(new Set(['user-1']));
  });

  it('does not manufacture a media-card attachment while cloning a plain thread comment', async () => {
    const sourceComment = {
      id: 'source-comment',
      userId: 'user-1',
      parentId: null,
      rootId: null,
      depth: 0,
      threadType: CommentThreadType.SHOW,
      threadId: 'source-media',
      body: 'Nice',
      imageUrl: null,
      gifUrl: null,
      mediaType: null,
      mediaId: null,
      listId: null,
      isSpoiler: false,
      spoilerCount: 0,
      externalReviewId: null,
      parentSourceKey: null,
      language: null,
      translations: {},
      source: 'MANUAL',
      sourceKey: null,
      likesCount: 0,
      repliesCount: 0,
      hidden: false,
      adminDeleted: false,
      deletedByUser: false,
      editedAt: null,
      createdAt: new Date('2026-08-09T20:40:15.923Z'),
      updatedAt: new Date('2026-08-09T20:40:15.923Z'),
      likes: [],
      spoilerReports: [],
      image: null,
    };
    const create = jest.fn().mockResolvedValue({ id: 'target-comment' });
    const tx = {
      comment: {
        findMany: jest.fn().mockResolvedValue([sourceComment]),
        findUnique: jest.fn(),
        create,
      },
      mediaCanonicalCopy: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      commentLike: { createMany: jest.fn() },
      commentSpoilerReport: { createMany: jest.fn() },
      commentImage: { create: jest.fn() },
    };

    await (service as any).cloneComments(
      tx,
      'link-1',
      CommentThreadType.SHOW,
      'source-media',
      'target-media',
      'source-media',
      'target-media',
      new Set<string>(),
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: 'target-media',
          mediaType: null,
          mediaId: null,
        }),
      }),
    );
  });

  it('moves review roots and includes review interactions in cache invalidation', async () => {
    const tx = {
      externalReview: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'review-1',
            likes: [{ userId: 'liker' }],
            comments: [{ userId: 'replier' }],
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const affected = new Set<string>();

    const ids = await (service as any).relinkExternalReviews(
      tx,
      'media',
      'source-media',
      'target-media',
      affected,
    );

    expect(tx.externalReview.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['review-1'] } },
      data: { mediaId: 'target-media', episodeId: null },
    });
    expect(ids).toEqual(new Set(['review-1']));
    expect(affected).toEqual(new Set(['liker', 'replier']));
  });

  it('selects one equivalent TMDB aggregate through a complete transitive episode proof', async () => {
    const aggregate = graph('tvdb-aggregate', [
      { number: 1, episodes: [episode('tvdb-1', 1, 1, 'Dahmer', '2022-09-21')] },
      { number: 2, episodes: [episode('tvdb-2', 2, 1, 'Menendez', '2024-09-19')] },
      { number: 3, episodes: [episode('tvdb-3', 3, 1, 'Ed Gein', '2025-10-03')] },
    ]);
    aggregate.title = 'Monster';
    aggregate.externalIds = [
      { provider: ExternalProvider.THE_TVDB, providerEntityKind: 'SERIES', value: '389492' },
    ];
    aggregate.seasons.forEach((season: any) => {
      season.episodes[0].externalIds = [
        {
          provider: ExternalProvider.THE_TVDB,
          value: `tvdb-episode-${season.number}`,
        },
      ];
    });

    const root = graph('tmdb-root', [
      { number: 1, episodes: [episode('root-1', 1, 1, 'Dahmer', '2022-09-21')] },
      { number: 2, episodes: [episode('root-2', 2, 1, 'Menendez', '2024-09-19')] },
      { number: 3, episodes: [episode('root-3', 3, 1, 'Ed Gein', '2025-10-03')] },
    ]);
    root.structureProvider = 'TMDB';
    root.externalIds = [
      { provider: ExternalProvider.TMDB, providerEntityKind: 'SERIES', value: '329491' },
    ];
    const components = [
      ['component-1', '113988', 'Dahmer', '2022-09-21'],
      ['component-2', '225634', 'Menendez', '2024-09-19'],
      ['component-3', '286801', 'Ed Gein', '2025-10-03'],
    ].map(([id, tmdbId, title, airDate], index) => {
      const component = graph(id, [
        { number: 1, episodes: [episode(`${id}-episode`, 1, 1, title, airDate)] },
      ]);
      component.structureProvider = 'TMDB';
      component.externalIds = [
        { provider: ExternalProvider.TMDB, providerEntityKind: 'SERIES', value: tmdbId },
      ];
      return { component, showId: Number(tmdbId), tvdbEpisodeId: `tvdb-episode-${index + 1}` };
    });
    const graphs = new Map([
      [aggregate.id, aggregate],
      [root.id, root],
      ...components.map(({ component }) => [component.id, component] as const),
    ]);
    const loadGraph = jest
      .spyOn(service as any, 'loadGraph')
      .mockImplementation((...args: unknown[]) =>
        Promise.resolve(graphs.get(String(args[0])) ?? null),
      );
    // Provider episode routing discovers only the three component parents. The full
    // low-popularity anthology must enter through the structural-shape query.
    externalId.findMany.mockResolvedValue(
      components
        .map(({ component }) => component)
        .map((candidate) => ({
          mediaId: candidate.id,
        })),
    );
    prisma.$queryRaw.mockResolvedValue([{ media_id: root.id }]);
    tmdb.getShowRoutingProfile.mockResolvedValue({ tvdbId: null });
    tmdb.findByExternalIdStrict.mockImplementation((tvdbEpisodeId: string) => {
      const match = components.find((row) => row.tvdbEpisodeId === tvdbEpisodeId);
      return Promise.resolve(
        match ? { episode: { showId: match.showId, season: 1, episode: 1 } } : null,
      );
    });

    const result = await service.evaluateTvdbAggregate(aggregate.id, 'dry-run');

    expect(result.reason).toBeUndefined();
    expect(result.candidates).toBe(4);
    expect(result.evidence).toEqual(
      expect.objectContaining({
        rootMediaId: root.id,
        rootProof: 'complete-transitive-episode-identity',
        completeComponentSet: true,
        componentSetVerified: true,
      }),
    );
    expect(result.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceMediaId: aggregate.id, targetMediaId: root.id }),
        ...components.map(({ component }, index) =>
          expect.objectContaining({
            sourceMediaId: component.id,
            targetMediaId: root.id,
            targetSeasonNumber: index + 1,
          }),
        ),
      ]),
    );
    loadGraph.mockRestore();
  });

  it('folds an episode-identical dead TMDB aggregate into TVDB when every component is verified', async () => {
    const aggregate = graph('tvdb-aggregate', [
      { number: 1, episodes: [episode('tvdb-1', 1, 1, 'Dahmer', '2022-09-21')] },
      { number: 2, episodes: [episode('tvdb-2', 2, 1, 'Menendez', '2024-09-19')] },
    ]);
    aggregate.title = 'Monster';
    aggregate.externalIds = [
      { provider: ExternalProvider.THE_TVDB, providerEntityKind: 'SERIES', value: '389492' },
    ];
    aggregate.seasons.forEach((season: any) => {
      season.episodes[0].externalIds = [
        {
          provider: ExternalProvider.THE_TVDB,
          value: `tvdb-episode-${season.number}`,
        },
      ];
    });

    const deadAggregate = graph('dead-tmdb-aggregate', [
      { number: 1, episodes: [episode('dead-1', 1, 1, 'Dahmer', '2022-09-21')] },
      { number: 2, episodes: [episode('dead-2', 2, 1, 'Menendez', '2024-09-19')] },
    ]);
    deadAggregate.title = 'Monster (2022)';
    deadAggregate.structureProvider = 'TMDB';
    deadAggregate.externalIds = [
      { provider: ExternalProvider.TMDB, providerEntityKind: 'SERIES', value: '329491' },
    ];

    const components = [
      ['component-1', '113988', 'Dahmer', '2022-09-21'],
      ['component-2', '225634', 'Menendez', '2024-09-19'],
    ].map(([id, tmdbId, title, airDate], index) => {
      const component = graph(id, [
        { number: 1, episodes: [episode(`${id}-episode`, 1, 1, title, airDate)] },
      ]);
      component.structureProvider = 'TMDB';
      component.externalIds = [
        { provider: ExternalProvider.TMDB, providerEntityKind: 'SERIES', value: tmdbId },
      ];
      return { component, showId: Number(tmdbId), tvdbEpisodeId: `tvdb-episode-${index + 1}` };
    });
    const graphs = new Map([
      [aggregate.id, aggregate],
      [deadAggregate.id, deadAggregate],
      ...components.map(({ component }) => [component.id, component] as const),
    ]);
    const loadGraph = jest
      .spyOn(service as any, 'loadGraph')
      .mockImplementation((...args: unknown[]) =>
        Promise.resolve(graphs.get(String(args[0])) ?? null),
      );
    externalId.findMany.mockResolvedValue(
      components.map(({ component }) => ({ mediaId: component.id })),
    );
    prisma.$queryRaw.mockResolvedValue([{ media_id: deadAggregate.id }]);
    tmdb.getShowRoutingProfile.mockRejectedValue(
      new ProviderError('not_found', 'tmdb cached 404', 404),
    );
    tmdb.findByExternalIdStrict.mockImplementation((tvdbEpisodeId: string) => {
      const match = components.find((row) => row.tvdbEpisodeId === tvdbEpisodeId);
      return Promise.resolve(
        match ? { episode: { showId: match.showId, season: 1, episode: 1 } } : null,
      );
    });

    const result = await service.evaluateTvdbAggregate(aggregate.id, 'dry-run');

    expect(result.reason).toBeUndefined();
    expect(result.candidates).toBe(3);
    expect(result.evidence).toEqual(
      expect.objectContaining({
        rootMediaId: aggregate.id,
        rootProof: 'tvdb-aggregate-fallback',
        exactCandidates: [{ id: deadAggregate.id, state: 'dead' }],
        completeComponentSet: true,
        componentSetVerified: true,
      }),
    );
    expect(result.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceMediaId: deadAggregate.id,
          targetMediaId: aggregate.id,
          relation: MediaCanonicalRelation.EXACT_DUPLICATE,
        }),
        ...components.map(({ component }, index) =>
          expect.objectContaining({
            sourceMediaId: component.id,
            targetMediaId: aggregate.id,
            targetSeasonNumber: index + 1,
          }),
        ),
      ]),
    );
    loadGraph.mockRestore();
  });

  it('creates a canonical S0 supplement for an unmatched special carrying user data', async () => {
    const source = graph('source', [
      { number: 1, episodes: [episode('source-regular', 1, 1, 'Episode One', '2022-09-21')] },
      {
        number: 0,
        episodes: [
          episode(
            'source-special',
            0,
            1,
            'Making DAHMER: A conversation with the cast and Ryan Murphy',
            '2022-11-28',
          ),
        ],
      },
    ]);
    source.seasons[1].isSpecial = true;
    source.seasons[1].episodes[0].isSpecial = true;
    const target = graph('target', [
      { number: 1, episodes: [episode('target-regular', 1, 1, 'Episode One', '2022-09-21')] },
    ]);
    const createdTarget = {
      id: 'target-special',
      number: 1,
      title: source.seasons[1].episodes[0].title,
      airDate: source.seasons[1].episodes[0].airDate,
      runtimeMinutes: 45,
    };
    const tx = {
      userEpisodeStatus: { count: jest.fn().mockResolvedValue(3) },
      watchHistory: { count: jest.fn().mockResolvedValue(3) },
      rating: { count: jest.fn().mockResolvedValue(0) },
      reaction: { count: jest.fn().mockResolvedValue(0) },
      characterVote: { count: jest.fn().mockResolvedValue(0) },
      comment: { count: jest.fn().mockResolvedValue(0) },
      externalReview: { count: jest.fn().mockResolvedValue(0) },
      show: { findUnique: jest.fn().mockResolvedValue({ id: 'target-show' }) },
      season: {
        upsert: jest.fn().mockResolvedValue({ id: 'target-special-season' }),
        update: jest.fn().mockResolvedValue({}),
      },
      episode: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'source-special',
          number: 1,
          absoluteNumber: null,
          title: createdTarget.title,
          overview: 'Behind the scenes',
          stillUrl: null,
          runtimeMinutes: 45,
          airDate: createdTarget.airDate,
          airTime: null,
          rating: null,
          isFinale: false,
          titles: null,
          overviews: null,
          stillUrls: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(createdTarget),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const plan = {
      source,
      target,
      match: {
        relation: MediaCanonicalRelation.SEASON_COMPONENT,
        targetSeasonNumber: 1,
        pairs: [{ source: source.seasons[0].episodes[0], target: target.seasons[0].episodes[0] }],
      },
    };

    const pairs = await (service as any).ensureSupplementalSpecialPairs(tx, plan);

    expect(tx.season.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { showId_number: { showId: 'target-show', number: 0 } },
        create: expect.objectContaining({ number: 0, isSpecial: true }),
      }),
    );
    expect(tx.episode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seasonId: 'target-special-season',
          number: 1,
          title: createdTarget.title,
          structureState: 'ACTIVE',
        }),
      }),
    );
    expect(pairs).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ id: 'source-special' }),
        target: expect.objectContaining({
          id: 'target-special',
          seasonNumber: 0,
          isSpecial: true,
        }),
      }),
    ]);
  });

  it('seeds a TVDB canonical target from retained component recommendations', async () => {
    const tx: any = {
      mediaItem: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'target', recommendations: null, externalIds: [] },
          {
            id: 'component-1',
            recommendations: [
              { tmdbId: 500, type: 'SHOW', title: 'Shared', rating: 7 },
              { tmdbId: 202, type: 'SHOW', title: 'Family component' },
            ],
            externalIds: [{ value: '101' }],
          },
          {
            id: 'component-2',
            recommendations: [
              { tmdbId: 500, type: 'SHOW', title: 'Shared', rating: 8 },
              { tmdbId: 600, type: 'SHOW', title: 'Other' },
            ],
            externalIds: [{ value: '202' }],
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await (service as any).seedCanonicalRecommendations(tx, 'target', [
      'component-1',
      'component-2',
    ]);

    expect(tx.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'target' },
      data: {
        recommendations: [
          { tmdbId: 500, type: 'SHOW', title: 'Shared', rating: 8 },
          { tmdbId: 600, type: 'SHOW', title: 'Other' },
        ],
        recommendationsSyncedAt: expect.any(Date),
      },
    });
  });

  it('keeps direct TMDB recommendations authoritative on a canonical target', async () => {
    const tx: any = {
      mediaItem: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'target', recommendations: [], externalIds: [{ value: '999' }] },
          {
            id: 'component',
            recommendations: [{ tmdbId: 500, type: 'SHOW', title: 'Component result' }],
            externalIds: [{ value: '101' }],
          },
        ]),
        update: jest.fn(),
      },
    };

    await (service as any).seedCanonicalRecommendations(tx, 'target', ['component']);

    expect(tx.mediaItem.update).not.toHaveBeenCalled();
  });

  it('activates every family link only after every source copy verifies', async () => {
    const target = graph('target', [
      { number: 1, episodes: [episode('target-1', 1, 1, 'One', '2020-01-01')] },
      { number: 2, episodes: [episode('target-2', 2, 1, 'Two', '2021-01-01')] },
    ]);
    const source1 = graph('source-1', [
      { number: 1, episodes: [episode('source-1-episode', 1, 1, 'One', '2020-01-01')] },
    ]);
    const source2 = graph('source-2', [
      { number: 1, episodes: [episode('source-2-episode', 1, 1, 'Two', '2021-01-01')] },
    ]);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      mediaItem: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      mediaCanonicalLink: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest
          .fn()
          .mockResolvedValueOnce({ id: 'link-1' })
          .mockResolvedValueOnce({ id: 'link-2' }),
        update: jest.fn().mockResolvedValue({}),
      },
      show: {
        findUnique: jest.fn().mockResolvedValue({ id: 'target-show' }),
        update: jest.fn().mockResolvedValue({}),
      },
      season: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'target-season-1' }, { id: 'target-season-2' }]),
      },
      episode: {
        count: jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(2),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: any) => callback(tx));
    const copyEpisode = jest.spyOn(service as any, 'copyEpisode').mockResolvedValue(undefined);
    const copyMediaData = jest.spyOn(service as any, 'copyMediaData').mockResolvedValue(undefined);
    const recompute = jest
      .spyOn(service as any, 'recomputeShowStatuses')
      .mockResolvedValue(undefined);
    const verify = jest
      .spyOn(service as any, 'verifyCopy')
      .mockResolvedValueOnce({ rows: 2, byType: {} })
      .mockResolvedValueOnce({ rows: 3, byType: {} });
    const plans = [
      {
        source: source1,
        target,
        match: {
          relation: MediaCanonicalRelation.SEASON_COMPONENT,
          targetSeasonNumber: 1,
          pairs: [
            { source: source1.seasons[0].episodes[0], target: target.seasons[0].episodes[0] },
          ],
        },
      },
      {
        source: source2,
        target,
        match: {
          relation: MediaCanonicalRelation.SEASON_COMPONENT,
          targetSeasonNumber: 2,
          pairs: [
            { source: source2.seasons[0].episodes[0], target: target.seasons[1].episodes[0] },
          ],
        },
      },
    ];

    await expect((service as any).consolidatePlan(plans, { proof: 'test' })).resolves.toBe(2);

    expect(copyEpisode).toHaveBeenCalledTimes(2);
    expect(copyMediaData).toHaveBeenCalledTimes(2);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(tx.show.update).toHaveBeenCalledWith({
      where: { id: 'target-show' },
      data: { seasonsCount: 2, episodesCount: 2 },
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(tx.mediaCanonicalLink.update).toHaveBeenCalledTimes(2);
    expect(tx.mediaCanonicalLink.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ status: MediaCanonicalStatus.ACTIVE }),
      }),
    );
    expect(verify.mock.invocationCallOrder[1]).toBeLessThan(
      tx.mediaCanonicalLink.update.mock.invocationCallOrder[0],
    );
    copyEpisode.mockRestore();
    copyMediaData.mockRestore();
    recompute.mockRestore();
    verify.mockRestore();
  });

  it('marks a failed copy as FAILED and never exposes an ACTIVE redirect', async () => {
    mediaCanonicalLink.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockRejectedValue(new Error('copy exploded'));
    const source = graph('source', [
      { number: 1, episodes: [episode('source-episode', 1, 1, 'Pilot', '2020-01-01')] },
    ]);
    const target = graph('target', [
      { number: 1, episodes: [episode('target-episode', 1, 1, 'Pilot', '2020-01-01')] },
    ]);

    await expect(
      (service as any).consolidatePlan(
        [
          {
            source,
            target,
            match: {
              relation: MediaCanonicalRelation.EXACT_DUPLICATE,
              targetSeasonNumber: null,
              pairs: [
                { source: source.seasons[0].episodes[0], target: target.seasons[0].episodes[0] },
              ],
            },
          },
        ],
        { proof: 'test' },
      ),
    ).rejects.toThrow('copy exploded');

    expect(mediaCanonicalLink.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sourceMediaId: 'source',
          status: { not: MediaCanonicalStatus.ACTIVE },
        },
        data: expect.objectContaining({
          targetMediaId: 'target',
          status: MediaCanonicalStatus.FAILED,
          lastError: 'copy exploded',
        }),
      }),
    );
    expect(mediaCanonicalLink.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MediaCanonicalStatus.ACTIVE }),
      }),
    );
  });
});
