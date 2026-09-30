import { IdentityAuditStore } from '../identity-audit.store';
import { ContentClassification } from '@prisma/client';
import { CandidateDetectorService } from '../classification/candidate-detector.service';
import { ClassifierService } from '../classification/classifier.service';
import { HydrationProcessor } from './hydration.processor';

describe('HydrationProcessor.animeHydrate', () => {
  let prisma: any;
  let animeMatch: any;
  let tmdb: any;
  let processor: HydrationProcessor;

  const media = {
    id: 'm1',
    title: 'Title',
    type: 'SHOW',
    manualClassification: false,
    manualCandidate: false,
    genres: [{ genre: { name: 'Animation' } }],
    externalIds: [{ provider: 'TMDB', providerEntityKind: 'SERIES', value: '20' }],
    show: {
      yearStart: 2020,
      originalLanguage: 'ja',
      originCountries: ['JP'],
      keywords: [],
    },
    movie: null,
  };

  beforeEach(() => {
    prisma = {
      mediaItem: {
        findUnique: jest.fn().mockResolvedValue(media),
        update: jest.fn().mockResolvedValue({}),
      },
      show: { update: jest.fn().mockResolvedValue({}) },
      movie: { update: jest.fn().mockResolvedValue({}) },
    };
    animeMatch = { matchAnime: jest.fn() };
    tmdb = {
      enabled: true,
      getShowRoutingProfile: jest.fn().mockResolvedValue({ genreIds: [16], keywords: [] }),
      getMovieRoutingProfile: jest.fn(),
    };
    processor = new HydrationProcessor(
      {} as any,
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any,
      tmdb,
      { enqueueAnimeHydrate: jest.fn() } as any,
      { ensureShowFullTvdb: jest.fn().mockResolvedValue('m1') } as any,
      { get: jest.fn().mockReturnValue(false) } as any,
    );
  });

  it('refreshes a clean split target while leaving its still-conflicted source reviewable', async () => {
    const result = {
      repaired: false,
      reason: 'choose-current-identity',
      mediaIds: ['m1', 'target'],
      followUps: [
        { mediaId: 'm1', operationId: 'op' },
        { mediaId: 'target', operationId: 'op' },
      ],
    };
    const events = { emitAsync: jest.fn().mockResolvedValue([]) };
    (processor as any).identityRepair = {
      repairAutomatically: jest.fn().mockResolvedValue(result),
    };
    (processor as any).events = events;
    prisma.mediaItem.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'm1'
        ? {
            type: 'MOVIE',
            externalIds: [
              { provider: 'TMDB', providerEntityKind: 'MOVIE', value: '1' },
              { provider: 'TMDB', providerEntityKind: 'MOVIE', value: '2' },
            ],
          }
        : { type: 'SHOW', show: { id: 'target-show' }, externalIds: [] },
    );
    const refresh = jest
      .spyOn(processor as any, 'identityRefresh')
      .mockResolvedValue({ refreshed: true });
    const follow = jest
      .spyOn(IdentityAuditStore.prototype, 'followUp')
      .mockResolvedValue(undefined);
    try {
      await (processor as any).dispatch('identity-repair', { mediaId: 'm1' });
      expect(refresh.mock.calls).toEqual([[{ mediaId: 'target', version: 'automatic' }]]);
      expect(follow).toHaveBeenCalledWith('op', 'm1', {
        status: 'blocked',
        reason: 'choose-current-identity',
      });
      expect(events.emitAsync).toHaveBeenCalledWith(
        'metadata.identity-repaired',
        expect.objectContaining({ repaired: false, mediaId: 'm1' }),
      );
    } finally {
      follow.mockRestore();
    }
  });

  it('records terminal identity worker failures without losing the operation reference', async () => {
    const state = jest.spyOn(IdentityAuditStore.prototype, 'state').mockResolvedValue(undefined);
    const followUp = jest
      .spyOn(IdentityAuditStore.prototype, 'followUp')
      .mockResolvedValue(undefined);
    try {
      await (processor as any).handleJobFailure(
        {
          name: 'identity-apply',
          data: { operationId: 'operation' },
          opts: { attempts: 1 },
          attemptsMade: 1,
        },
        new Error('worker stopped'),
      );
      expect(state).toHaveBeenCalledWith(
        'operation',
        'failed',
        expect.objectContaining({ error: expect.any(String) }),
      );
      await (processor as any).handleJobFailure(
        {
          name: 'identity-refresh',
          data: { operationId: 'operation', mediaId: 'm1' },
          opts: { attempts: 5 },
          attemptsMade: 5,
        },
        new Error('worker stopped'),
      );
      expect(followUp).toHaveBeenCalledWith(
        'operation',
        'm1',
        expect.objectContaining({ status: 'failed' }),
      );
    } finally {
      state.mockRestore();
      followUp.mockRestore();
    }
  });

  it('classifies Animation plus the persisted TMDB anime keyword as ANIME', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      show: { ...media.show, keywords: ['anime', 'isekai'] },
    });
    tmdb.getShowRoutingProfile.mockResolvedValue({ genreIds: [16], keywords: ['anime', 'isekai'] });
    await processor.animeHydrate('m1');
    expect(animeMatch.matchAnime).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({
        contentClassification: 'ANIME' as ContentClassification,
        classificationTier: 'confirmed',
        classificationConfidence: 0.95,
      }),
    });
  });

  it('preserves ANIME_TVDB authority without requiring TMDB keyword evidence', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      show: { ...media.show, structureReason: 'ANIME_TVDB' },
    });

    await processor.animeHydrate('m1');

    expect(tmdb.getShowRoutingProfile).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({
        contentClassification: 'ANIME' as ContentClassification,
        classificationTier: 'confirmed',
        classificationConfidence: 1,
      }),
    });
  });

  it('keeps Animation without the keyword as GENERAL and never calls Kitsu/Jikan', async () => {
    await processor.animeHydrate('m1');
    expect(animeMatch.matchAnime).not.toHaveBeenCalled();
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({
        contentClassification: 'GENERAL' as ContentClassification,
      }),
    });
  });

  it('backfills old TMDB keywords before applying the strict rule', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      show: { ...media.show, keywords: null },
    });
    tmdb.getShowRoutingProfile.mockResolvedValue({ genreIds: [16], keywords: ['anime'] });
    await processor.animeHydrate('m1');
    expect(tmdb.getShowRoutingProfile).toHaveBeenCalledWith(20);
    expect(prisma.show.update).toHaveBeenCalledWith({
      where: { mediaId: 'm1' },
      data: { keywords: ['anime'] },
    });
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ contentClassification: 'ANIME' }),
    });
  });

  it('does not persist a verdict when the TMDB routing profile cannot be fetched', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      show: { ...media.show, keywords: null },
    });
    tmdb.getShowRoutingProfile.mockRejectedValue(new Error('provider unavailable'));
    await processor.animeHydrate('m1');
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
    expect(animeMatch.matchAnime).not.toHaveBeenCalled();
  });

  it('re-evaluates an old Kitsu-confirmed ANIME row against TMDB evidence', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({
      ...media,
      contentClassification: 'ANIME',
      classificationTier: 'confirmed',
    });
    await processor.animeHydrate('m1');
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ contentClassification: 'GENERAL' }),
    });
  });

  it('never overwrites a manual classification', async () => {
    prisma.mediaItem.findUnique.mockResolvedValue({ ...media, manualClassification: true });
    await processor.animeHydrate('m1');
    expect(prisma.mediaItem.update).not.toHaveBeenCalled();
  });

  it('releases the metadata worker before asynchronous structure replay finishes', async () => {
    const events = {
      emit: jest.fn().mockReturnValue(true),
      emitAsync: jest.fn(() => new Promise(() => undefined)),
    };
    const structureProcessor = new HydrationProcessor(
      {} as any,
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any,
      tmdb,
      { enqueueAnimeHydrate: jest.fn() } as any,
      {
        evaluateShowStructureAuthority: jest.fn().mockResolvedValue({
          evaluated: true,
          changed: true,
          blocked: false,
          deferred: false,
        }),
      } as any,
      { get: jest.fn().mockReturnValue(false) } as any,
      events as any,
    );

    await expect(structureProcessor.structureEvaluate('m1')).resolves.toEqual(
      expect.objectContaining({ evaluated: true, changed: true }),
    );
    expect(events.emit).toHaveBeenCalledWith('metadata.structure-evaluated', {
      mediaId: 'm1',
      evaluated: true,
      changed: true,
      blocked: false,
    });
    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it('emits a blocked terminal outcome after deterministic structure retries are exhausted', async () => {
    const events = { emit: jest.fn() };
    const structureProcessor = new HydrationProcessor(
      {} as any,
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any,
      tmdb,
      { enqueueStructureEvaluation: jest.fn() } as any,
      {} as any,
      { get: jest.fn().mockReturnValue(false) } as any,
      events as any,
    );

    await (structureProcessor as any).handleJobFailure(
      {
        name: 'structure-evaluate',
        id: 'structure-evaluate-media-m1',
        data: { mediaId: 'm1' },
        attemptsMade: 5,
        opts: { attempts: 5 },
      },
      new Error('THE_TVDB episode id 5879285 belongs to another show'),
    );

    expect(events.emit).toHaveBeenCalledWith('metadata.structure-evaluated', {
      mediaId: 'm1',
      evaluated: false,
      changed: false,
      blocked: true,
      terminalFailure: true,
    });
  });

  it('keeps provider outages pending by scheduling a delayed retry after exhaustion', async () => {
    const events = { emit: jest.fn() };
    const queue = { enqueueStructureEvaluation: jest.fn().mockResolvedValue(undefined) };
    const structureProcessor = new HydrationProcessor(
      {} as any,
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any,
      tmdb,
      queue as any,
      {} as any,
      { get: jest.fn().mockReturnValue(false) } as any,
      events as any,
    );
    const error = new Error('Structure evaluation deferred for m1: provider unavailable');
    error.name = 'RetryableStructureEvaluationError';

    await (structureProcessor as any).handleJobFailure(
      {
        name: 'structure-evaluate',
        id: 'structure-evaluate-media-m1',
        data: { mediaId: 'm1' },
        attemptsMade: 5,
        opts: { attempts: 5 },
      },
      error,
    );

    expect(queue.enqueueStructureEvaluation).toHaveBeenCalledWith('m1', 30 * 60_000);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('runs automatic canonicalization only after the structure rollout gate is enabled', async () => {
    const canonical = {
      evaluateTvdbAggregate: jest.fn().mockResolvedValue({
        candidates: 1,
        activated: 1,
        blocked: 0,
      }),
    };
    const structureProcessor = new HydrationProcessor(
      {} as any,
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any,
      tmdb,
      { enqueueAnimeHydrate: jest.fn() } as any,
      {
        evaluateShowStructureAuthority: jest.fn().mockResolvedValue({
          evaluated: true,
          changed: false,
          blocked: false,
          deferred: false,
        }),
      } as any,
      { get: jest.fn().mockReturnValue(true) } as any,
      { emit: jest.fn() } as any,
      canonical as any,
    );

    await structureProcessor.structureEvaluate('m1');

    expect(canonical.evaluateTvdbAggregate).toHaveBeenCalledWith('m1', 'repair');
  });

  it('refreshes TMDB supplements on the active canonical TVDB owner', async () => {
    const meta = {
      refreshTmdbShowSupplements: jest.fn().mockResolvedValue({ refreshed: true, tmdbId: 20 }),
    };
    const canonical = {
      resolveMediaId: jest.fn().mockResolvedValue('canonical-m1'),
    };
    const supplementProcessor = new HydrationProcessor(
      {} as any,
      prisma,
      new CandidateDetectorService(),
      new ClassifierService(),
      animeMatch,
      {} as any,
      tmdb,
      {} as any,
      meta as any,
      { get: jest.fn().mockReturnValue(false) } as any,
      undefined,
      canonical as any,
    );

    await supplementProcessor.tmdbShowSupplement({ mediaId: 'source-m1' });

    expect(canonical.resolveMediaId).toHaveBeenCalledWith('source-m1');
    expect(meta.refreshTmdbShowSupplements).toHaveBeenCalledWith('canonical-m1');
  });
});
