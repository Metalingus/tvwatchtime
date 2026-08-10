import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { HydrationQueue } from './hydration.queue';

/** Build a HydrationQueue with a fake queue.add capture (onModuleInit not called). */
function makeQueue() {
  const q = new HydrationQueue({} as any);
  const calls: Array<{ name: string; data: any; opts: any }> = [];
  (q as any).queue = {
    getJob: async () => null,
    add: async (name: string, data: any, opts: any) => {
      calls.push({ name, data, opts });
      return {};
    },
  };
  return { q, calls };
}

describe('HydrationQueue — stable deterministic job ids (dedup)', () => {
  it('keys classify-candidate by media id', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueClassifyCandidate({ mediaId: 'm1' });
    expect(calls[0].name).toBe('classify-candidate');
    expect(calls[0].opts.jobId).toBe('classify-candidate-media-m1');
  });

  it('keys classify-candidate by namespace-aware identity when no mediaId', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueClassifyCandidate({
      provider: ExternalProvider.THE_TVDB,
      providerEntityKind: ProviderEntityKind.SERIES,
      value: '123',
    });
    expect(calls[0].opts.jobId).toBe('classify-candidate-THE_TVDB-SERIES-123');
  });

  it('produces the same jobId for equivalent tvdb-search enqueues (dedup)', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueTvdbSearch('Foo Bar', 'SHOW', 'en');
    await q.enqueueTvdbSearch('foo bar', 'SHOW', 'en'); // normalized query → same id
    expect(calls[0].opts.jobId).toBe('tvdb-search-foo bar-SHOW-en');
    expect(calls[0].opts.jobId).toBe(calls[1].opts.jobId);
  });

  it('keys anime-hydrate by media id', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueAnimeHydrate('m9');
    expect(calls[0].name).toBe('anime-hydrate');
    expect(calls[0].opts.jobId).toBe('anime-hydrate-media-m9');
    // Transient anime-match failures retry instead of persisting a degraded classification.
    expect(calls[0].opts.attempts).toBe(5);
    expect(calls[0].opts.backoff).toEqual({ type: 'exponential', delay: 120000 });
  });

  it('deduplicates new TVDB show anime hydration by the newly created media id', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueNewTvdbShowHydration('m-new', 456);

    expect(calls[0]).toMatchObject({
      name: 'new-tvdb-show-hydrate',
      data: { mediaId: 'm-new', tvdbId: 456 },
      opts: {
        jobId: 'new-tvdb-show-hydrate-media-m-new',
        attempts: 5,
      },
    });
  });

  it('re-enqueues a retained completed TVDB cast refresh job', async () => {
    const { q, calls } = makeQueue();
    const remove = jest.fn(async () => undefined);
    (q as any).queue.getJob = jest.fn(async () => ({
      getState: jest.fn(async () => 'completed'),
      remove,
    }));

    await q.enqueueTvdbRehydrate('m9', 123);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      name: 'tvdb-rehydrate',
      data: { mediaId: 'm9', tvdbId: 123 },
      opts: { jobId: 'tvdb-rehydrate-media-m9' },
    });
  });

  it('keeps active TVDB cast refresh jobs deduplicated', async () => {
    const { q } = makeQueue();
    const remove = jest.fn(async () => undefined);
    (q as any).queue.getJob = jest.fn(async () => ({
      getState: jest.fn(async () => 'active'),
      remove,
    }));

    await q.enqueueTvdbRehydrate('m9', 123);

    expect(remove).not.toHaveBeenCalled();
  });

  it('deduplicates TMDB show supplements by TVDB metadata version', async () => {
    const { q, calls } = makeQueue();

    await q.enqueueTmdbShowSupplement('m9', '1723334400000');
    await q.enqueueTmdbShowSupplement('m9', '1723334400000');

    expect(calls[0]).toMatchObject({
      name: 'tmdb-show-supplement',
      data: { mediaId: 'm9' },
      opts: {
        jobId: 'tmdb-show-supplement-media-m9-v1723334400000',
        attempts: 5,
        backoff: { type: 'exponential', delay: 120000 },
      },
    });
    expect(calls[1].opts.jobId).toBe(calls[0].opts.jobId);
  });

  it('removes a retained failed TMDB supplement before re-enqueueing it', async () => {
    const { q, calls } = makeQueue();
    const remove = jest.fn(async () => undefined);
    (q as any).queue.getJob = jest.fn(async () => ({
      getState: jest.fn(async () => 'failed'),
      remove,
    }));

    await q.enqueueTmdbShowSupplement('m9', '1723334400000');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(calls[0].opts.jobId).toBe('tmdb-show-supplement-media-m9-v1723334400000');
  });

  it('removes a retained failed structure job before re-enqueueing it', async () => {
    const { q, calls } = makeQueue();
    const remove = jest.fn(async () => undefined);
    (q as any).queue.getJob = jest.fn(async () => ({
      getState: jest.fn(async () => 'failed'),
      remove,
    }));

    await q.enqueueStructureEvaluation('m-structure');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      name: 'structure-evaluate',
      data: { mediaId: 'm-structure' },
      opts: {
        jobId: 'structure-evaluate-media-m-structure',
        attempts: 5,
        backoff: { type: 'exponential', delay: 120000 },
      },
    });
  });

  it('supports a delayed provider retry without changing the stable structure job id', async () => {
    const { q, calls } = makeQueue();

    await q.enqueueStructureEvaluation('m-provider-down', 30 * 60_000);

    expect(calls[0]).toMatchObject({
      name: 'structure-evaluate',
      data: { mediaId: 'm-provider-down' },
      opts: {
        jobId: 'structure-evaluate-media-m-provider-down',
        delay: 30 * 60_000,
        attempts: 5,
      },
    });
  });

  it('returns an existing delayed structure job without resetting its retry delay', async () => {
    const { q, calls } = makeQueue();
    const existing = {
      getState: jest.fn(async () => 'delayed'),
      remove: jest.fn(),
    };
    (q as any).queue.getJob = jest.fn(async () => existing);

    await expect(q.enqueueStructureEvaluation('m-provider-down')).resolves.toBe(existing);

    expect(existing.remove).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
