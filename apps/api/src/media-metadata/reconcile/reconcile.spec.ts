import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { MediaReconciler, type IdentityRef } from './media-reconciler.service';

const tvdbSeries = (v: string): IdentityRef => ({
  provider: ExternalProvider.THE_TVDB,
  providerEntityKind: ProviderEntityKind.SERIES,
  value: v,
});
const tmdbSeries = (v: string): IdentityRef => ({
  provider: ExternalProvider.TMDB,
  providerEntityKind: ProviderEntityKind.SERIES,
  value: v,
});

/** Fake prisma: an in-memory external-id store + $transaction that runs inline. */
function fakePrisma(existing: IdentityRef[] = []) {
  const store = new Map<string, { mediaId: string; identity: IdentityRef }>();
  for (const e of existing)
    store.set(`${e.provider}:${e.providerEntityKind}:${e.value}`, {
      mediaId: 'm-existing',
      identity: e,
    });
  const tx = {
    mediaItem: {
      findUnique: async () => ({
        type: 'SHOW',
        show: { id: 's' },
        movie: null,
        canonicalSource: null,
        externalIds: [...store.values()].map((v) => v.identity),
      }),
    },
    externalId: {
      findFirst: async (args: any) => {
        const w = args.where;
        const key = `${w.provider}:${w.providerEntityKind}:${w.value}`;
        const row = store.get(key);
        if (!row) return null;
        return args.include?.media
          ? { media: { id: row.mediaId, title: 'T', type: 'SHOW' } }
          : { id: key, mediaId: row.mediaId };
      },
      create: async (args: any) => {
        const d = args.data;
        store.set(`${d.provider}:${d.providerEntityKind}:${d.value}`, {
          mediaId: d.mediaId,
          identity: d,
        });
        return {};
      },
      upsert: async (args: any) => {
        const d = args.create;
        const key = `${d.provider}:${d.providerEntityKind}:${d.value}`;
        if (!store.has(key)) store.set(key, { mediaId: d.mediaId, identity: d });
        return { mediaId: store.get(key)!.mediaId };
      },
    },
  };
  return {
    ...tx,
    store,
    $transaction: async (fn: any) => fn(tx),
  };
}

const fakeLimiter = () => ({
  distinctLock: async (_k: string, _t: number, fn: () => Promise<any>) => fn(),
});

describe('MediaReconciler', () => {
  it('returns the existing record for an identity without calling the creator', async () => {
    const prisma = fakePrisma([tvdbSeries('123')]);
    const r = new MediaReconciler(prisma as any, fakeLimiter() as any);
    const creator = jest.fn(async () => 'should-not-run');
    const id = await r.getOrCreateByIdentity(tvdbSeries('123'), creator);
    expect(id).toBe('m-existing');
    expect(creator).not.toHaveBeenCalled();
  });

  it('does not create past an existing identity assigned to the wrong media type', async () => {
    const prisma = fakePrisma([tmdbSeries('456')]);
    const creator = jest.fn(async () => 'must-not-create');
    const reconciler = new MediaReconciler(prisma as any, fakeLimiter() as any);
    await expect(
      reconciler.getOrCreateByIdentity(
        {
          ...tmdbSeries('456'),
          providerEntityKind: ProviderEntityKind.MOVIE,
        },
        creator,
      ),
    ).resolves.toBe('must-not-create');
    // The separate movie namespace is legitimately new; a poisoned movie alias is not.
    prisma.store.set('TMDB:MOVIE:123', {
      mediaId: 'wrong-type',
      identity: { ...tmdbSeries('123'), providerEntityKind: ProviderEntityKind.MOVIE },
    });
    creator.mockClear();
    await expect(
      reconciler.getOrCreateByIdentity(
        {
          ...tmdbSeries('123'),
          providerEntityKind: ProviderEntityKind.MOVIE,
        },
        creator,
      ),
    ).rejects.toThrow('wrong media type');
    expect(creator).not.toHaveBeenCalled();
  });

  it('creates via the creator when no mapping exists', async () => {
    const prisma = fakePrisma([]);
    const r = new MediaReconciler(prisma as any, fakeLimiter() as any);
    const id = await r.getOrCreateByIdentity(tvdbSeries('123'), async () => 'm-new');
    expect(id).toBe('m-new');
  });

  it('produces a deterministic, order-independent reconcile lock key', () => {
    const a = MediaReconciler.reconcileLockKey([tmdbSeries('1'), tvdbSeries('2')]);
    const b = MediaReconciler.reconcileLockKey([tvdbSeries('2'), tmdbSeries('1')]);
    expect(a).toBe(b);
  });

  it('reconciles to an existing record and attaches the missing identity', async () => {
    const prisma = fakePrisma([tmdbSeries('456')]); // TMDB already mapped
    const r = new MediaReconciler(prisma as any, fakeLimiter() as any);
    const out = await r.crossProviderReconcile([tmdbSeries('456'), tvdbSeries('123')], {
      confidence: 0.9,
    });
    expect(out.mediaId).toBe('m-existing');
    expect(out.created).toBe(false);
    expect(out.attached?.some((i) => i.value === '123')).toBe(true);
  });

  it('flags review (no merge) when evidence is insufficient and no record exists', async () => {
    const prisma = fakePrisma([]);
    const r = new MediaReconciler(prisma as any, fakeLimiter() as any);
    const out = await r.crossProviderReconcile([tmdbSeries('456'), tvdbSeries('123')], {
      confidence: 0.4,
    });
    expect(out.mediaId).toBeNull();
    expect(out.needsReview).toBe(true);
  });

  it('refuses multiple existing owners and does not attach a third identity to the first', async () => {
    const prisma = fakePrisma([tmdbSeries('456')]);
    prisma.store.set('THE_TVDB:SERIES:123', { mediaId: 'other', identity: tvdbSeries('123') });
    const reconciler = new MediaReconciler(prisma as any, fakeLimiter() as any);
    expect(await reconciler.findByExternals([tmdbSeries('456'), tvdbSeries('123')])).toBeNull();
    const before = prisma.store.size;
    const result = await reconciler.crossProviderReconcile(
      [tmdbSeries('456'), tvdbSeries('123'), tvdbSeries('999')],
      { confidence: 0.99 },
    );
    expect(result).toMatchObject({ mediaId: null, reason: 'owned_elsewhere', needsReview: true });
    expect(prisma.store.size).toBe(before);
  });

  it('does not attach low-confidence evidence just because one local identity exists', async () => {
    const prisma = fakePrisma([tmdbSeries('456')]);
    const reconciler = new MediaReconciler(prisma as any, fakeLimiter() as any);
    expect(
      await reconciler.crossProviderReconcile([tmdbSeries('456'), tvdbSeries('123')], {
        confidence: 0.4,
      }),
    ).toMatchObject({ reason: 'insufficient_evidence' });
    expect(prisma.store.size).toBe(1);
  });

  it('rejects a movie/series namespace mixture', async () => {
    const prisma = fakePrisma([tmdbSeries('456')]);
    const reconciler = new MediaReconciler(prisma as any, fakeLimiter() as any);
    expect(
      await reconciler.crossProviderReconcile(
        [tmdbSeries('456'), { ...tvdbSeries('123'), providerEntityKind: ProviderEntityKind.MOVIE }],
        { confidence: 1 },
      ),
    ).toMatchObject({ reason: 'conflict' });
    expect(prisma.store.size).toBe(1);
  });

  it('returns a deferred result when another process owns the reconciliation lock', async () => {
    const reconciler = new MediaReconciler(
      fakePrisma() as any,
      { distinctLock: async () => undefined } as any,
    );
    expect(
      await reconciler.crossProviderReconcile([tmdbSeries('456')], { confidence: 1 }),
    ).toMatchObject({ reason: 'deferred', mediaId: null });
  });

  it('creates one record when confident and none exists', async () => {
    const prisma = fakePrisma([]);
    const r = new MediaReconciler(prisma as any, fakeLimiter() as any);
    const out = await r.crossProviderReconcile([tmdbSeries('456'), tvdbSeries('123')], {
      confidence: 0.9,
      creator: async () => 'm-created',
    });
    expect(out.mediaId).toBe('m-created');
    expect(out.created).toBe(true);
    expect(out.attached?.length).toBe(2);
  });
});
