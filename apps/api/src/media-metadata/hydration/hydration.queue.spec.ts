import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { HydrationQueue } from './hydration.queue';

/** Build a HydrationQueue with a fake queue.add capture (onModuleInit not called). */
function makeQueue() {
  const q = new HydrationQueue({} as any);
  const calls: Array<{ name: string; data: any; opts: any }> = [];
  (q as any).queue = {
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
    expect(calls[0].opts.jobId).toBe('classify-candidate:media:m1');
  });

  it('keys classify-candidate by namespace-aware identity when no mediaId', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueClassifyCandidate({
      provider: ExternalProvider.THE_TVDB,
      providerEntityKind: ProviderEntityKind.SERIES,
      value: '123',
    });
    expect(calls[0].opts.jobId).toBe('classify-candidate:THE_TVDB:SERIES:123');
  });

  it('produces the same jobId for equivalent tvdb-search enqueues (dedup)', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueTvdbSearch('Foo Bar', 'SHOW', 'en');
    await q.enqueueTvdbSearch('foo bar', 'SHOW', 'en'); // normalized query → same id
    expect(calls[0].opts.jobId).toBe('tvdb-search:foo bar:SHOW:en');
    expect(calls[0].opts.jobId).toBe(calls[1].opts.jobId);
  });

  it('keys anime-hydrate by media id', async () => {
    const { q, calls } = makeQueue();
    await q.enqueueAnimeHydrate('m9');
    expect(calls[0].name).toBe('anime-hydrate');
    expect(calls[0].opts.jobId).toBe('anime-hydrate:media:m9');
  });
});
